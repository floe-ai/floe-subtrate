/**
 * @invariant The bridge is the sole owner of effective runtime embodiment.
 * Adapter selection and runtime resolution happen here; callers may provide bindings and config,
 * but only the bridge decides the live adapter and the effective runtime passed into sessions.
 */
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Server } from "node:http";
import type { AgentRuntimeConfig } from "./auth.js";
import { RuntimeAuthError } from "./auth.js";
import { createBridgeAuthRuntime } from "./auth.js";
import type { LocalConfig } from "./config.js";
import { bridgeHttpBase, bridgeWsBase } from "./config.js";
import { BusClient, type DeliveryBundle } from "./bus-client.js";
import { ensureProjectTemplate, loadProject, materializeSavedConfig } from "./project.js";
import type { RuntimeAdapter } from "./adapters/runtime-adapter.js";
import { FakeRuntimeAdapter } from "./adapters/fake-runtime-adapter.js";
import { PiAgentCoreAdapter } from "./adapters/pi-agent-core-adapter.js";
import { TurnFailedError } from "./adapters/turn-failed-error.js";
import { loadExtensions, type LoadedExtension } from "./extension-loader.js";
import { HookRegistry } from "./hooks.js";
import { startExtensionRelayServer } from "./extension-relay.js";
import { runCommandNode, CommandInputMissingError, type CommandNodeConfig } from "./command-runner.js";
import { watchFolder } from "./folder-watcher.js";

const WEBHOOK_DEDUPE_MAX_EVENTS = 10_000;
const STREAM_INITIAL_BACKOFF_MS = 250;
const STREAM_MAX_BACKOFF_MS = 16_000;

type EndpointEntry = {
  config: AgentRuntimeConfig;
  instructions: string;
  workspace_locator?: string;
  agent_id?: string;
};

export class BridgeDaemon {
  readonly bridgeId: string;
  readonly bus: BusClient;
  readonly adapter: RuntimeAdapter;
  private endpointRuntime = new Map<string, EndpointEntry>();
  private workspaceExtensions = new Map<string, LoadedExtension[]>();
  private workspaceHooks = new Map<string, HookRegistry>();
  /** Command node config, keyed by endpoint_id — endpoints whose delivery runs a shell command instead of the LLM adapter. */
  private commandNodes = new Map<string, CommandNodeConfig>();
  /**
   * Node-specific instructions bindings, keyed by `${endpoint_id}:${context_id}` — an actor
   * node's own material, injected into that actor's turns arising from that node's Context
   * via the BeforeTurn hook (same inject-once mechanism extension overlays already use).
   * Never merged into the actor's general `.floe/agents/*.md` instructions.
   */
  private nodeInstructionBindings = new Map<string, string>();
  private workspaceWatchers = new Map<string, Array<() => void>>();
  private workspaceRelays = new Map<string, { server: Server; exitHandler: () => void }>();
  private attaching = false;
  private processingEndpoints = new Set<string>();
  private reportedAttachments = new Map<string, string>();
  private firedWebhookEvents = new Set<string>();
  // D1: reconnect state
  private streamCancelled = false;
  private streamSocket: { close(): void; send(data: string): void } | null = null;
  private streamRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private streamBackoffMs = STREAM_INITIAL_BACKOFF_MS;

  constructor(readonly configPath: string, readonly config: LocalConfig) {
    this.bridgeId = process.env.FLOE_BRIDGE_ID ?? "bridge:local";
    this.bus = new BusClient(bridgeHttpBase(config));
    this.adapter = chooseAdapter(configPath, config);
  }

  async start(): Promise<void> {
    await this.waitForBus();
    await this.bus.registerBridge(this.bridgeId, {
      runtime_adapters: [this.adapter.name],
      workspace_access: this.config.bridge.workspace_access,
      capabilities: ["workspace_attach", "project_template_init", "agent_endpoint_registration", "delivery_claim"]
    });
    this.openEventStream();
    await this.attachKnownWorkspaces();
    await this.processDeliveries();
  }

  async stop(): Promise<void> {
    // D1: cancel the event stream reconnect loop.
    this.streamCancelled = true;
    if (this.streamRetryTimer !== null) {
      clearTimeout(this.streamRetryTimer);
      this.streamRetryTimer = null;
    }
    if (this.streamSocket !== null) {
      try { this.streamSocket.close(); } catch { /* ignore */ }
      this.streamSocket = null;
    }
    this.firedWebhookEvents.clear();
    // Close all relay servers so ports are released on daemon shutdown
    for (const [, relay] of this.workspaceRelays) {
      process.off("exit", relay.exitHandler);
      relay.server.close();
    }
    this.workspaceRelays.clear();
    // Close all folder watchers so daemon shutdown leaves no dangling fs handles
    for (const [, stops] of this.workspaceWatchers) {
      for (const stop of stops) stop();
    }
    this.workspaceWatchers.clear();
    await this.adapter.dispose?.("bridge_shutdown");
  }

  private async waitForBus(): Promise<void> {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < 30_000) {
      try {
        await this.bus.health();
        return;
      } catch (error) {
        lastError = error;
        await sleep(500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Timed out waiting for floe-bus");
  }

  private openEventStream(): void {
    const WebSocketCtor = (globalThis as any).WebSocket as (new (url: string) => any) | undefined;
    if (!WebSocketCtor) return;

    const connect = (): void => {
      if (this.streamCancelled) return;
      const url = `${bridgeWsBase(this.config).replace(/\/$/, "")}/v1/events/stream`;
      let socket: any = null;
      try {
        socket = new WebSocketCtor(url);
      } catch {
        // WebSocket unavailable — schedule retry.
        this.scheduleStreamRetry(connect);
        return;
      }
      this.streamSocket = socket as { close(): void; send(data: string): void };

      socket.addEventListener("open", () => {
        if (this.streamCancelled) { try { socket?.close(); } catch { /* ignore */ } return; }
        // D4: send bridge_hello so the bus associates this socket with our bridge_id.
        try {
          socket?.send(JSON.stringify({ type: "bridge_hello", bridge_id: this.bridgeId }));
        } catch { /* ignore */ }
        // D1: reset backoff on successful connection.
        this.streamBackoffMs = STREAM_INITIAL_BACKOFF_MS;
        // D1: one-shot resync to pick up anything queued while disconnected.
        void this.attachKnownWorkspaces();
        void this.processDeliveries();
      });

      socket.addEventListener("message", (event: { data: string }) => {
        if (this.streamCancelled) return;
        try {
          const message = JSON.parse(String(event.data));
          this.handleEventStreamMessage(message);
        } catch {
          // ignore malformed frames
        }
      });

      socket.addEventListener("close", () => {
        this.streamSocket = null;
        if (this.streamCancelled) return;
        // D1: reconnect with exponential back-off.
        this.scheduleStreamRetry(connect);
      });

      socket.addEventListener("error", () => {
        // `close` fires after `error`, reconnect is handled there.
      });
    };

    connect();
  }

  /** Schedule the next WS reconnect attempt with exponential back-off (D1). */
  private scheduleStreamRetry(connect: () => void): void {
    if (this.streamCancelled) return;
    const delay = this.streamBackoffMs;
    this.streamBackoffMs = Math.min(this.streamBackoffMs * 2, STREAM_MAX_BACKOFF_MS);
    this.streamRetryTimer = setTimeout(() => {
      this.streamRetryTimer = null;
      connect();
    }, delay);
  }

  private handleEventStreamMessage(message: any): void {
    if (
      message.type === "workspace_registered" ||
      message.type === "workspace_selected" ||
      message.type === "workspace_attachment_requested" ||
      message.type === "config_snapshot_requested" ||
      message.type === "scope_graph_created" ||
      message.type === "scope_graph_deleted" ||
      message.type === "runtime_binding_updated" ||
      message.type === "runtime_binding_cleared"
    ) {
      void this.attachKnownWorkspaces();
      void this.processDeliveries();
    }
    if (message.type === "config_apply_requested" && message.payload?.workspace_id) {
      void this.applySavedConfig(String(message.payload.workspace_id), message.payload?.config_id ? String(message.payload.config_id) : null);
    }
    if (message.type === "delivery_bundle_available") {
      // D2: consume the pushed bundle directly when this bridge owns the endpoint.
      // The bus broadcasts the full DeliveryBundle at creation time with the lease
      // set server-side — no HTTP round-trip needed for the single-bridge case.
      const delivery = message.payload?.delivery as DeliveryBundle | undefined;
      if (
        delivery &&
        typeof delivery.endpoint_id === "string" &&
        this.endpointRuntime.has(delivery.endpoint_id) &&
        !this.processingEndpoints.has(delivery.endpoint_id)
      ) {
        this.processingEndpoints.add(delivery.endpoint_id);
        void (async () => {
          try {
            await this.handleDelivery(delivery);
          } finally {
            this.processingEndpoints.delete(delivery.endpoint_id);
          }
        })();
      } else {
        // Multi-bridge / race fallback: let the HTTP claim path sort it out.
        void this.processDeliveries();
      }
    }
    if (message.type === "config_snapshot_requested" && message.payload?.workspace_id) {
      void this.returnSnapshot(String(message.payload.workspace_id));
    }
    if (message.type === "event_submitted") {
      void this.fireWebhookReceived(message.payload?.event);
    }
    // Slice 0 — context lifecycle hooks
    if (message.type === "context_compacted" && message.payload?.context_id) {
      void this.fireContextLifecycleHook("ContextCompacted", message.payload);
    }
    if (message.type === "context_history_cleared" && message.payload?.context_id) {
      void this.fireContextLifecycleHook("ContextHistoryCleared", message.payload);
    }
    // Slice 1 — dynamic participant hooks
    if (message.type === "participant_added" && message.payload?.context_id) {
      void this.fireContextLifecycleHook("ParticipantAdded", message.payload);
    }
    if (message.type === "participant_removed" && message.payload?.context_id) {
      void this.fireContextLifecycleHook("ParticipantRemoved", message.payload);
    }
  }

  private async fireWebhookReceived(event: any): Promise<void> {
    if (!event || event.type !== "webhook_received" || event.metadata?.trigger_kind !== "webhook") return;
    if (event.source_endpoint_id !== null) return;
    if (typeof event.event_id !== "string" || !event.event_id) return;
    if (typeof event.workspace_id !== "string" || !event.workspace_id) return;
    if (typeof event.metadata?.route_id !== "string" || !event.metadata.route_id) return;
    if (this.firedWebhookEvents.has(event.event_id)) return;
    const hooks = this.workspaceHooks.get(event.workspace_id);
    if (!hooks?.hasHandlers("WebhookReceived")) return;
    const destination = event.destination_json;
    this.firedWebhookEvents.add(event.event_id);
    this.pruneWebhookDedupe();
    await hooks.fire("WebhookReceived", {
      workspace_id: event.workspace_id,
      route_id: event.metadata.route_id,
      event_id: event.event_id,
      context_id: event.context_id ?? null,
      target_endpoint_id: destination?.kind === "endpoint" ? destination.endpoint_id : null,
      content: event.content ?? {},
      metadata: event.metadata ?? {}
    });
  }

  private pruneWebhookDedupe(): void {
    while (this.firedWebhookEvents.size > WEBHOOK_DEDUPE_MAX_EVENTS) {
      const oldestEventId = this.firedWebhookEvents.keys().next().value;
      if (oldestEventId === undefined) break;
      this.firedWebhookEvents.delete(oldestEventId);
    }
  }

  /** (to every registered HookRegistry
   * for the workspace identified by `payload.workspace_id`, if present; or all
   * workspaces when the broadcast payload does not carry workspace_id).
   */
  private async fireContextLifecycleHook(hook: import("./hooks.js").HookName, payload: any): Promise<void> {
    const workspaceId: string | undefined = payload?.workspace_id;
    if (workspaceId) {
      const hooks = this.workspaceHooks.get(workspaceId);
      if (hooks) {
        try {
          await hooks.fire(hook as any, payload);
        } catch (err) {
          console.error(`[bridge] ${hook} hook failed`, err);
        }
      }
    } else {
      for (const [, hooks] of this.workspaceHooks) {
        try {
          await hooks.fire(hook as any, payload);
        } catch (err) {
          console.error(`[bridge] ${hook} hook failed`, err);
        }
      }
    }
  }

  private async attachKnownWorkspaces(): Promise<void> {
    if (this.attaching) return;
    this.attaching = true;
    try {
      const workspaces = await this.bus.listWorkspaces();
      for (const workspace of workspaces) {
        await this.attachWorkspace(workspace);
      }
    } catch (error) {
      console.error("[bridge] workspace attach scan failed", error);
    } finally {
      this.attaching = false;
    }
  }

  private async attachWorkspace(workspace: any): Promise<void> {
    if (!workspace?.workspace_id || !workspace?.locator) return;
    if (!workspace.init_authorized) return;

    const locator = resolve(String(workspace.locator));
    if (!this.config.bridge.workspace_access.local_paths || !existsSync(locator)) {
      await this.reportOnce(workspace.workspace_id, "workspace_inaccessible", "workspace_locator_inaccessible", null, {
        ok: false,
        warnings: [],
        errors: [`Workspace locator is inaccessible: ${locator}`]
      });
      return;
    }

    try {
      ensureProjectTemplate(locator, String(workspace.name ?? "Floe Project"));
      const project = loadProject(locator);
      if (!project.validation.ok) {
        await this.reportOnce(workspace.workspace_id, "config_invalid", null, project.config_hash, project.validation);
        return;
      }

      if (
        typeof workspace.active_config_hash === "string" &&
        workspace.active_config_hash.length > 0 &&
        workspace.active_config_hash !== project.config_hash
      ) {
        // Auto-reimport config when drift is detected — the disk state is authoritative
        console.log("[bridge] config drift detected, auto-reimporting", {
          workspace_id: workspace.workspace_id,
          observed_config_hash: project.config_hash,
          active_config_hash: workspace.active_config_hash
        });
        try {
          await this.bus.importConfigSnapshot(workspace.workspace_id, {
            config_hash: project.config_hash,
            agents: project.agents.map(a => ({
              agent_id: a.agent_id,
              label: a.name,
              body: a.body,
              runtime: a.frontmatter?.runtime ?? { engine: "pi" }
            }))
          });
        } catch (importErr) {
          console.error("[bridge] auto-reimport failed", importErr);
          await this.reportOnce(workspace.workspace_id, "config_drift", null, project.config_hash, {
            ...project.validation,
            observed_config_hash: project.config_hash,
            active_config_hash: workspace.active_config_hash
          });
          return;
        }
      }

      for (const agent of project.agents) {
        const endpointId = actorEndpointId(workspace.workspace_id, agent.agent_id);
        const runtimeConfig = extractRuntimeConfig(agent.frontmatter);
        this.endpointRuntime.set(endpointId, { config: runtimeConfig, instructions: agent.body, workspace_locator: locator, agent_id: agent.agent_id });
        const resolvedAuth = await this.resolveAuthProfile(workspace.workspace_id, endpointId, runtimeConfig);
        await this.bus.registerEndpoint({
          endpoint_id: endpointId,
          workspace_id: workspace.workspace_id,
          name: agent.name,
          agent_id: agent.agent_id,
          bridge_id: this.bridgeId,
          status: resolvedAuth.auth_profile ? "idle" : "runtime_unconfigured",
          metadata: {
            file: agent.file,
            runtime_adapter: this.adapter.name,
            frontmatter: agent.frontmatter,
            runtime_auth_profile: resolvedAuth.auth_profile ?? null,
            runtime_auth_source: resolvedAuth.source
          }
        });
      }

      // Register pulses defined in floe.yaml
      for (const pulseDef of project.pulses) {
        try {
          await this.bus.createPulse({
            pulse_id: pulseDef.id,
            workspace_id: workspace.workspace_id,
            persistence: pulseDef.persistence ?? "workspace",
            scope_id: pulseDef.scope_id,
            trigger: pulseDef.trigger,
            content: pulseDef.content,
            subscribers: pulseDef.subscribers ?? [],
          });
        } catch (error) {
          console.error("[bridge] pulse registration failed", { pulse_id: pulseDef.id, error });
        }
      }

      // Discover command nodes from this workspace's scope graphs and attach
      // them as bridge-owned endpoints — the SAME registration path project
      // agents already use. Nothing new is invented at the bus: a command
      // node is an ordinary participant/endpoint. The only new behaviour is
      // bridge-local (handleDelivery below runs the command instead of the
      // adapter for these endpoints); see command-runner.ts.
      let scopeGraphs: Array<{ graph_id: string; context_id: string; nodes: any[] }> = [];
      try {
        const { graphs } = await this.bus.listScopeGraphsForWorkspace(workspace.workspace_id);
        scopeGraphs = graphs as Array<{ graph_id: string; context_id: string; nodes: any[] }>;
        for (const graph of scopeGraphs) {
          for (const node of graph.nodes) {
            if (node.kind === "actor" && Array.isArray(node.bindings) && node.bindings.length > 0) {
              const text = node.bindings
                .filter((binding: any) => binding.kind === "instructions" && typeof binding.text === "string")
                .map((binding: any) => binding.text)
                .join("\n\n");
              if (text) this.nodeInstructionBindings.set(`${node.endpoint_id}:${graph.context_id}`, text);
            }
            if (node.kind !== "command") continue;
            const config: CommandNodeConfig = {
              graph_id: graph.graph_id,
              node_id: node.node_id,
              context_id: graph.context_id,
              endpoint_id: node.endpoint_id,
              command: node.command,
              inputs: node.inputs ?? [],
              outputs: node.outputs ?? [],
              result_event_type: node.result_event_type ?? "command.result",
              workspace_locator: locator
            };
            this.commandNodes.set(node.endpoint_id, config);
            await this.bus.registerEndpoint({
              endpoint_id: node.endpoint_id,
              workspace_id: workspace.workspace_id,
              name: node.label ?? node.node_id,
              bridge_id: this.bridgeId,
              status: "idle",
              metadata: { command_node: true, graph_id: graph.graph_id, node_id: node.node_id }
            });
          }
        }
      } catch (error) {
        console.error("[bridge] command node discovery failed", { workspace_id: workspace.workspace_id, error });
      }

      // Start folder Event sources. Legacy floe.yaml watchers remain readable,
      // while new sources are stored with the Event node that owns them.
      for (const stop of this.workspaceWatchers.get(workspace.workspace_id) ?? []) stop();
      const watcherStops: Array<() => void> = [];
      const startedWatchers = new Set<string>();
      const startWatcher = (watcherDef: { id: string; graph_id: string; node_id: string; path: string }): void => {
        const watchPath = resolve(locator, watcherDef.path);
        const workspaceRelative = relative(locator, watchPath);
        const watcherKey = `${watcherDef.graph_id}:${watcherDef.node_id}:${watchPath}`;
        if (workspaceRelative.startsWith("..") || isAbsolute(workspaceRelative)) {
          console.error("[bridge] watcher path escapes workspace — skipping", { watcher_id: watcherDef.id, path: watchPath });
          return;
        }
        if (!existsSync(watchPath) || startedWatchers.has(watcherKey)) {
          if (!existsSync(watchPath)) {
            console.error("[bridge] watcher path does not exist — skipping", { watcher_id: watcherDef.id, path: watchPath });
          }
          return;
        }
        startedWatchers.add(watcherKey);
        const stop = watchFolder(watchPath, arrival => {
          this.bus.fireScopeGraphTriggerNode(workspace.workspace_id, watcherDef.graph_id, watcherDef.node_id, {
            content: {
              file_name: arrival.file_name,
              file_path: arrival.file_path,
              channel: "watched_folder",
              locator: arrival.file_path,
              observed_at: arrival.observed_at,
              raw_reference: arrival.file_path,
            },
          }).catch(error => {
            console.error("[bridge] watcher trigger fire failed", { watcher_id: watcherDef.id, error });
          });
        });
        watcherStops.push(stop);
      };

      for (const watcherDef of project.watchers) startWatcher(watcherDef);
      for (const graph of scopeGraphs) {
        for (const node of graph.nodes) {
          if (node.kind !== "trigger" || node.source?.kind !== "folder" || typeof node.source.path !== "string") {
            continue;
          }
          startWatcher({
            id: `${graph.graph_id}:${node.node_id}`,
            graph_id: graph.graph_id,
            node_id: node.node_id,
            path: node.source.path,
          });
        }
      }
      this.workspaceWatchers.set(workspace.workspace_id, watcherStops);

      // Load extensions
      const extensionsDir = join(locator, ".floe", "extensions");
      try {
        const hookRegistry = new HookRegistry();
        this.registerNodeInstructionsHook(hookRegistry);
        const loaded = await loadExtensions(extensionsDir, {
          workspacePath: locator,
          busClient: this.bus,
          workspaceId: workspace.workspace_id
        }, hookRegistry);
        this.workspaceExtensions.set(workspace.workspace_id, loaded);
        this.workspaceHooks.set(workspace.workspace_id, hookRegistry);

        for (const ext of loaded) {
          if (ext.errors.length > 0) {
            console.error("[bridge] extension load errors", { extension: ext.name, errors: ext.errors });
          } else {
            console.log("[bridge] extension loaded", { extension: ext.name, tools: ext.tools.length, pulses: ext.pulses.length });
          }
        }

        // Register bundled extension agents as live endpoints (in-memory; no disk writes)
        for (const ext of loaded) {
          if (ext.errors.length > 0) continue; // skip broken extensions
          for (const agent of ext.bundledAgents) {
            const endpointId = actorEndpointId(workspace.workspace_id, agent.agent_id);
            // BundledAgentConfig.runtime uses { engine } not { provider }; map to an
            // empty AgentRuntimeConfig so auth falls through to workspace/global bindings.
            const runtimeConfig = extractRuntimeConfig({ runtime: agent.runtime ?? { engine: "pi" } });
            this.endpointRuntime.set(endpointId, {
              config: runtimeConfig,
              instructions: agent.body,
              workspace_locator: locator,
              agent_id: agent.agent_id,
            });
            const resolvedAuth = await this.resolveAuthProfile(workspace.workspace_id, endpointId, runtimeConfig);
            await this.bus.registerEndpoint({
              endpoint_id: endpointId,
              workspace_id: workspace.workspace_id,
              name: agent.label,
              agent_id: agent.agent_id,
              bridge_id: this.bridgeId,
              status: resolvedAuth.auth_profile ? "idle" : "runtime_unconfigured",
              metadata: {
                file: `[extension:${ext.name}]`,
                runtime_adapter: this.adapter.name,
                frontmatter: {
                  runtime: agent.runtime ?? { engine: "pi" },

                  pulse: agent.pulse ?? { inherit: true }
                },
                runtime_auth_profile: resolvedAuth.auth_profile ?? null,
                runtime_auth_source: resolvedAuth.source
              }
            });
            console.log(`[bridge] registered bundled agent endpoint: ${agent.agent_id}`);
          }
        }

        // Register extension-declared pulses (only pulses with explicit scope_id are supported;
        // per-board scope discovery was removed along with the acme heartbeat).
        for (const ext of loaded) {
          for (const pulseDef of ext.pulses) {
            if (!pulseDef.scope_id) {
              console.log("[bridge] extension pulse has no scope_id — skipping (scope_id is required)", { extension: ext.name, pulse_id: pulseDef.id });
              continue;
            }
            try {
              await this.bus.createPulse({
                pulse_id: `${ext.name}:${pulseDef.id}`,
                workspace_id: workspace.workspace_id,
                persistence: pulseDef.persistence ?? "workspace",
                scope_id: pulseDef.scope_id,
                trigger: pulseDef.trigger,
                content: pulseDef.content ?? {},
                subscribers: (pulseDef.subscribers ?? []).map(ref => ({ endpoint_ref: ref })),
              });
            } catch (error) {
              console.error("[bridge] extension pulse registration failed", { extension: ext.name, pulse_id: pulseDef.id, error });
            }
          }
        }

        // Start extension HTTP relay server (if any extensions have HTTP handlers)
        const extensionsWithHandlers = loaded.filter(ext => ext.httpHandlers.length > 0);
        let relayBaseUrl: string | null = null;
        if (extensionsWithHandlers.length > 0) {
          try {
            // Dispose the previous relay for this workspace before starting a new one.
            // Without this, reimports (triggered by genuine config changes) leak servers
            // and stack process.exit listeners.
            const previousRelay = this.workspaceRelays.get(workspace.workspace_id);
            if (previousRelay) {
              process.off("exit", previousRelay.exitHandler);
              previousRelay.server.close();
              this.workspaceRelays.delete(workspace.workspace_id);
            }
            const relay = await startExtensionRelayServer(
              extensionsWithHandlers.map(ext => ({ name: ext.name, handlers: ext.httpHandlers }))
            );
            relayBaseUrl = relay.baseUrl;
            const exitHandler = () => relay.server.close();
            process.once("exit", exitHandler);
            this.workspaceRelays.set(workspace.workspace_id, { server: relay.server, exitHandler });
          } catch (relayErr) {
            console.error("[bridge] extension relay server failed to start", relayErr);
          }
        }

        // Report extension metadata to the bus so GET /v1/extensions can serve it
        try {
          await this.bus.reportExtensions(workspace.workspace_id, loaded.map(ext => ({
            name: ext.name,
            views: ext.views,
            errors: ext.errors,
            // relay_url includes extension name as path prefix so the bus proxy
            // constructs: {relay_url}/{handlerPath} = http://host/extName/path
            relay_url: (relayBaseUrl && ext.httpHandlers.length > 0) ? `${relayBaseUrl}/${ext.name}` : null
          })));
        } catch (error) {
          console.error("[bridge] extension metadata report failed", error);
        }
      } catch (error) {
        console.error("[bridge] extension loading failed", error);
      }

      await this.reportOnce(workspace.workspace_id, "attached", null, project.config_hash, project.validation);
    } catch (error) {
      await this.reportOnce(workspace.workspace_id, "attach_failed", "bridge_attach_failed", null, {
        ok: false,
        warnings: [],
        errors: [(error as Error).message]
      });
    }
  }

  private async reportOnce(
    workspaceId: string,
    status: string,
    errorCode: string | null,
    configHash: string | null,
    validation: unknown
  ): Promise<void> {
    const key = JSON.stringify({ status, errorCode, configHash, validation });
    if (this.reportedAttachments.get(workspaceId) === key) return;
    this.reportedAttachments.set(workspaceId, key);
    await this.bus.reportAttachment(workspaceId, {
      bridge_id: this.bridgeId,
      status,
      config_hash: configHash,
      error_code: errorCode,
      validation
    });
  }

  private async returnSnapshot(workspaceId: string): Promise<void> {
    const workspaces = await this.bus.listWorkspaces();
    const workspace = workspaces.find((item) => item.workspace_id === workspaceId);
    if (!workspace) return;
    const locator = resolve(String(workspace.locator));
    if (!existsSync(locator)) return;
    const project = loadProject(locator);
    await this.bus.importConfigSnapshot(workspaceId, {
      config_hash: project.config_hash,
      agents: project.agents.map((agent) => ({
        agent_id: agent.agent_id,
        name: agent.name,
        file: agent.file,
        frontmatter: agent.frontmatter
      })),
      validation: project.validation
    });
  }

  private async applySavedConfig(workspaceId: string, configId: string | null): Promise<void> {
    const workspaces = await this.bus.listWorkspaces();
    const workspace = workspaces.find((item) => item.workspace_id === workspaceId);
    if (!workspace) return;
    const locator = resolve(String(workspace.locator));
    if (!existsSync(locator)) {
      await this.reportOnce(workspaceId, "workspace_inaccessible", "workspace_locator_inaccessible", null, {
        ok: false,
        warnings: [],
        errors: [`Workspace locator is inaccessible: ${locator}`]
      });
      return;
    }
    const configs = await this.bus.listConfigs();
    const record = configs.find((item) => item.config_id === configId);
    if (!record) {
      await this.reportOnce(workspaceId, "config_apply_failed", "saved_config_not_found", null, {
        ok: false,
        warnings: [],
        errors: [`Saved config not found: ${configId ?? "(none)"}`]
      });
      return;
    }
    const configJson = typeof record.config_json === "string" ? JSON.parse(record.config_json) : record.config_json;
    const project = materializeSavedConfig(locator, configJson);
    for (const agent of project.agents) {
      const endpointId = actorEndpointId(workspaceId, agent.agent_id);
      const runtimeConfig = extractRuntimeConfig(agent.frontmatter);
      this.endpointRuntime.set(endpointId, { config: runtimeConfig, instructions: agent.body, workspace_locator: locator, agent_id: agent.agent_id });
      const resolvedAuth = await this.resolveAuthProfile(workspaceId, endpointId, runtimeConfig);
      await this.bus.registerEndpoint({
        endpoint_id: endpointId,
        workspace_id: workspaceId,
        name: agent.name,
        agent_id: agent.agent_id,
        bridge_id: this.bridgeId,
        status: resolvedAuth.auth_profile ? "idle" : "runtime_unconfigured",
        metadata: {
          file: agent.file,
          runtime_adapter: this.adapter.name,
          frontmatter: agent.frontmatter,
          runtime_auth_profile: resolvedAuth.auth_profile ?? null,
          runtime_auth_source: resolvedAuth.source
        }
      });
    }
    await this.bus.importConfigSnapshot(workspaceId, {
      config_hash: project.config_hash,
      agents: project.agents.map((agent) => ({
        agent_id: agent.agent_id,
        name: agent.name,
        file: agent.file,
        frontmatter: agent.frontmatter
      })),
      validation: project.validation,
      applied_config_id: configId
    });
    this.reportedAttachments.delete(workspaceId);
    await this.attachWorkspace({ ...workspace, active_config_hash: project.config_hash });
  }

  private async processDeliveries(): Promise<void> {
    // HTTP-claim fallback path (multi-bridge / race case, startup resync).
    // Per-endpoint locking handled in the direct-consume path; here we just process
    // whatever the claim endpoint returns, skipping any endpoint already in-flight.
    try {
      const deliveries = await this.bus.claimDeliveries(this.bridgeId);
      for (const delivery of deliveries) {
        if (this.processingEndpoints.has(delivery.endpoint_id)) continue;
        this.processingEndpoints.add(delivery.endpoint_id);
        void (async () => {
          try {
            await this.handleDelivery(delivery);
          } finally {
            this.processingEndpoints.delete(delivery.endpoint_id);
          }
        })();
      }
    } catch (error) {
      console.error("[bridge] delivery processing failed", error);
    }
  }

  private async handleDelivery(delivery: DeliveryBundle): Promise<void> {
    console.log("[bridge] delivery claimed", {
      delivery_id: delivery.delivery_id,
      endpoint_id: delivery.endpoint_id,
      workspace_id: delivery.workspace_id,
      event_count: delivery.events.length
    });

    const commandConfig = this.commandNodes.get(delivery.endpoint_id);
    if (commandConfig) {
      await this.handleCommandDelivery(delivery, commandConfig);
      return;
    }

    try {
      const endpointEntry = this.endpointRuntime.get(delivery.endpoint_id);
      const runtimeConfig = endpointEntry?.config;
      const instructions = endpointEntry?.instructions;
      const resolvedAuth = await this.resolveAuthProfile(delivery.workspace_id, delivery.endpoint_id, runtimeConfig);
      const effectiveRuntime: AgentRuntimeConfig = {
        ...runtimeConfig,
        auth_profile: resolvedAuth.auth_profile ?? undefined,
        auth_profile_source: resolvedAuth.source ?? undefined,
        // Binding model takes priority over project-declared model
        model: resolvedAuth.model ?? runtimeConfig?.model ?? undefined,
        model_source: resolvedAuth.model_source ?? undefined,
        thinking_level: resolvedAuth.thinking_level ?? runtimeConfig?.thinking_level ?? undefined,
        instructions: instructions ?? undefined
      };
      console.log("[bridge] effective runtime resolved", {
        delivery_id: delivery.delivery_id,
        provider: effectiveRuntime.provider ?? "(none)",
        model: effectiveRuntime.model ?? "(none)",
        model_source: effectiveRuntime.model_source ?? "(none)",
        auth_profile: effectiveRuntime.auth_profile ?? "(none)",
        auth_profile_source: effectiveRuntime.auth_profile_source ?? "(none)",
        instructions_bytes: instructions?.length ?? 0
      });
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "injected_to_runtime");
      console.log("[bridge] delivery injected to runtime", { delivery_id: delivery.delivery_id, adapter: this.adapter.name });

      // Resolve extension tools for this agent — all workspace extensions reach every agent (no permission model)
      const workspaceExts = this.workspaceExtensions.get(delivery.workspace_id) ?? [];
      const agentExtensions = workspaceExts.filter(ext => ext.errors.length === 0);

      const hookRegistry = this.workspaceHooks.get(delivery.workspace_id);

      await this.adapter.handleBundle({
        bridge_id: this.bridgeId,
        bus: this.bus,
        workspace_locator: endpointEntry?.workspace_locator,
        agent_id: endpointEntry?.agent_id,
        extensions: agentExtensions,
        hooks: hookRegistry
      }, delivery, effectiveRuntime);
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "acknowledged");
      console.log("[bridge] delivery acknowledged", { delivery_id: delivery.delivery_id });
      await this.bus.reportTurnEnd(delivery.endpoint_id);
      console.log("[bridge] turn end reported", { endpoint_id: delivery.endpoint_id });
    } catch (error) {
      console.error("[bridge] adapter failed", error);
      const deferCodes = [
        "runtime_profile_required",
        "provider_auth_missing",
        "runtime_profile_provider_mismatch",
        "runtime_provider_required",
        "runtime_model_required",
        "runtime_model_unknown"
      ] as const;
      if (error instanceof RuntimeAuthError && (deferCodes as readonly string[]).includes(error.code)) {
        console.log("[bridge] delivery deferred", { delivery_id: delivery.delivery_id, code: error.code });
        await this.bus.appendRuntimeTelemetry({
          workspace_id: delivery.workspace_id,
          endpoint_id: delivery.endpoint_id,
          delivery_id: delivery.delivery_id,
          kind: error.code,
          payload: {
            code: error.code,
            message: error.message
          }
        });
        await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "deferred", `${error.code}: ${error.message}`);
        return;
      }

      // Runtime failures keep the existing bounded delivery retry. On the final
      // failed attempt, record a local failed turn result; if this delivery came
      // from request(), the bus resolves that exact dependency and resumes the
      // requester with the failure through the same causal return path.
      if (error instanceof TurnFailedError) {
        console.log("[bridge] turn failed", {
          delivery_id: error.delivery_id,
          source_endpoint_id: error.source_endpoint_id,
          model: error.model_id,
          http_status: error.http_status
        });
        const errorSummary =
          `Runtime turn failed for model '${error.model_id}' (provider: ${error.provider})` +
          (error.http_status ? `, HTTP ${error.http_status}` : "") +
          `: ${error.message}`;
        const failedDelivery = await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "failed", error.message);
        if (failedDelivery.state === "dead_lettered") {
          try {
            await this.bus.recordRuntimeTurnResult({
              delivery_id: delivery.delivery_id,
              outcome: "failed",
              text: errorSummary,
              metadata: {
                runtime: "pi-agent-core",
                origin: "turn_failed",
                model: error.model_id,
                provider: error.provider,
                http_status: error.http_status
              }
            });
          } catch (recordErr) {
            console.error("[bridge] failed to record terminal turn failure", recordErr);
          }
        }
        await this.bus.reportTurnEnd(delivery.endpoint_id);
        return;
      }

      console.log("[bridge] delivery failed", {
        delivery_id: delivery.delivery_id,
        error: (error as Error).message
      });
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "failed", (error as Error).message);
      await this.bus.updateEndpointStatus(delivery.endpoint_id, "error");
    }
  }

  /**
   * Registers the BeforeTurn handler that injects an actor node's own
   * instructions binding — node-specific material, distinct from the actor's
   * general `.floe/agents/*.md` instructions — using the exact inject-once
   * mechanism extension overlays already use (dedup happens in the adapter's
   * InjectionBaseline, keyed by context_id + this result's `source`). Keying
   * `source` by endpoint_id keeps each actor node's baseline independent
   * within a shared graph Context, so alternating actors don't stomp on each
   * other's dedup state.
   */
  private registerNodeInstructionsHook(hookRegistry: HookRegistry): void {
    hookRegistry.on("BeforeTurn", "_substrate_node_bindings", (payload) => {
      if (payload.origin?.kind !== "context") return;
      const text = this.nodeInstructionBindings.get(`${payload.endpoint_id}:${payload.origin.id}`);
      if (!text) return;
      return { inject: { source: `node_instructions:${payload.endpoint_id}`, content: text } };
    });
  }

  /**
   * Runs a command node's delivery: no LLM adapter involved. The bridge
   * substitutes what runs behind this endpoint — the substrate never learns
   * the difference (no `actor_kind`). The result is emitted with the SAME
   * `bus.emit` path any actor's `emit` tool uses, into the graph's Context,
   * so subscribed actors wake exactly as they would for any other message.
   */
  private async handleCommandDelivery(delivery: DeliveryBundle, config: CommandNodeConfig): Promise<void> {
    try {
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "injected_to_runtime");
      const triggerContent = delivery.events[delivery.events.length - 1]?.content ?? {};
      const resultContent = await runCommandNode(config, triggerContent);
      await this.bus.emit({
        type: config.result_event_type,
        workspace_id: delivery.workspace_id,
        source_endpoint_id: config.endpoint_id,
        destination: { kind: "context", context_id: config.context_id },
        context_id: config.context_id,
        thread_id: config.context_id,
        content: resultContent,
        metadata: { command_node: true, graph_id: config.graph_id, node_id: config.node_id }
      });
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "acknowledged");
      await this.bus.reportTurnEnd(delivery.endpoint_id);
    } catch (error) {
      const message = error instanceof CommandInputMissingError
        ? error.message
        : `command node execution failed: ${(error as Error).message}`;
      console.error("[bridge] command node delivery failed", { delivery_id: delivery.delivery_id, node_id: config.node_id, error: message });
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "failed", message);
      await this.bus.updateEndpointStatus(delivery.endpoint_id, "error");
    }
  }

  private async resolveAuthProfile(
    workspaceId: string,
    endpointId: string,
    runtimeConfig: AgentRuntimeConfig | undefined
  ): Promise<{
    auth_profile: string | null;
    model: string | null;
    source: string | null;
    model_source: string | null;
    thinking_level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null;
  }> {
    const bindings = await this.bus.resolveRuntimeBinding(workspaceId, endpointId);
    if (bindings.endpoint_auth_profile) {
      return {
        auth_profile: bindings.endpoint_auth_profile,
        model: bindings.endpoint_model ?? bindings.workspace_model ?? bindings.global_model ?? null,
        source: "agent_binding",
        model_source: bindings.endpoint_model ? "agent_binding" : bindings.workspace_model ? "workspace_binding" : bindings.global_model ? "global_binding" : null,
        thinking_level: (bindings.endpoint_thinking_level ?? bindings.workspace_thinking_level ?? bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (bindings.workspace_auth_profile) {
      return {
        auth_profile: bindings.workspace_auth_profile,
        model: bindings.workspace_model ?? bindings.global_model ?? null,
        source: "workspace_binding",
        model_source: bindings.workspace_model ? "workspace_binding" : bindings.global_model ? "global_binding" : null,
        thinking_level: (bindings.workspace_thinking_level ?? bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (runtimeConfig?.auth_profile?.trim()) {
      return {
        auth_profile: runtimeConfig.auth_profile.trim(),
        model: null,
        source: "project_runtime",
        model_source: null,
        thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (bindings.global_auth_profile) {
      return {
        auth_profile: bindings.global_auth_profile,
        model: bindings.global_model ?? null,
        source: "runtime_binding_global",
        model_source: bindings.global_model ? "global_binding" : null,
        thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    if (this.config.runtime?.default_auth_profile?.trim()) {
      return {
        auth_profile: this.config.runtime.default_auth_profile.trim(),
        model: null,
        source: "config_global_default",
        model_source: null,
        thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
      };
    }
    return {
      auth_profile: null,
      model: null,
      source: null,
      model_source: null,
      thinking_level: (bindings.global_thinking_level ?? null) as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | null
    };
  }
}

export function chooseAdapter(configPath: string, config: LocalConfig): RuntimeAdapter {
  const configured = process.env.FLOE_RUNTIME_ADAPTER ?? config.bridge.runtime_adapter;
  const live = () => new PiAgentCoreAdapter(createBridgeAuthRuntime(configPath, config));
  if (!configured) return live();
  const selected = configured.trim().toLowerCase();
  if (selected === "fake") return new FakeRuntimeAdapter();
  if (["pi", "pi-agent-core", "floe-runtime"].includes(selected)) return live();
  throw new Error(`Unsupported FLOE runtime adapter "${selected}". Use "fake" or "pi-agent-core".`);
}

function actorEndpointId(workspaceId: string, agentId: string): string {
  return `actor:${workspaceId}:${agentId}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractRuntimeConfig(frontmatter: Record<string, unknown>): AgentRuntimeConfig {
  const runtime = (frontmatter.runtime ?? {}) as Record<string, unknown>;
  return {
    provider: typeof runtime.provider === "string" ? runtime.provider : undefined,
    model: typeof runtime.model === "string" ? runtime.model : undefined,
    auth_profile: typeof runtime.auth_profile === "string" ? runtime.auth_profile : undefined
  };
}
