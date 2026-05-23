import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { loadExtensions, type LoadedExtension } from "./extension-loader.js";
import { HookRegistry } from "./hooks.js";

type Timer = ReturnType<typeof setInterval>;
const WEBHOOK_DEDUPE_MAX_EVENTS = 10_000;

type EndpointEntry = {
  config: AgentRuntimeConfig;
  instructions: string;
  workspace_locator?: string;
  agent_id?: string;
  extensions?: string[];
};

export class BridgeDaemon {
  readonly bridgeId: string;
  readonly bus: BusClient;
  readonly adapter: RuntimeAdapter;
  private endpointRuntime = new Map<string, EndpointEntry>();
  private workspaceExtensions = new Map<string, LoadedExtension[]>();
  private workspaceHooks = new Map<string, HookRegistry>();
  private timers: Timer[] = [];
  private attaching = false;
  private processing = false;
  private reportedAttachments = new Map<string, string>();
  private firedWebhookEvents = new Set<string>();

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
    this.timers.push(setInterval(() => void this.safeLivenessPing(), 10_000));
    this.timers.push(setInterval(() => void this.reconcileFromBus(), 30_000));
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.firedWebhookEvents.clear();
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
    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) return;
    const url = `${bridgeWsBase(this.config).replace(/\/$/, "")}/v1/events/stream`;
    try {
      const socket = new WebSocketCtor(url);
      socket.addEventListener("message", (event: MessageEvent) => {
        try {
          const message = JSON.parse(String(event.data));
          this.handleEventStreamMessage(message);
        } catch {
          // Event stream is the normal control path. Reconciliation timers are bounded recovery only.
        }
      });
    } catch {
      // Startup reconciliation and bounded recovery timers handle degraded socket availability.
    }
  }

  private handleEventStreamMessage(message: any): void {
    if (
      message.type === "workspace_registered" ||
      message.type === "workspace_selected" ||
      message.type === "workspace_attachment_requested" ||
      message.type === "config_snapshot_requested" ||
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
      void this.processDeliveries();
    }
    if (message.type === "config_snapshot_requested" && message.payload?.workspace_id) {
      void this.returnSnapshot(String(message.payload.workspace_id));
    }
    if (message.type === "event_submitted") {
      void this.fireWebhookReceived(message.payload?.event);
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

  private async safeLivenessPing(): Promise<void> {
    try {
      await this.bus.reportBridgeLiveness(this.bridgeId);
    } catch (error) {
      console.error("[bridge] liveness ping failed", error);
    }
  }

  private async reconcileFromBus(): Promise<void> {
    await this.attachKnownWorkspaces();
    await this.processDeliveries();
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
        this.endpointRuntime.set(endpointId, { config: runtimeConfig, instructions: agent.body, workspace_locator: locator, agent_id: agent.agent_id, extensions: agent.extensions });
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

      // Load extensions
      const extensionsDir = join(locator, ".floe", "extensions");
      try {
        const hookRegistry = new HookRegistry();
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

        // Register extension-declared pulses
        for (const ext of loaded) {
          for (const pulseDef of ext.pulses) {
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
      this.endpointRuntime.set(endpointId, { config: runtimeConfig, instructions: agent.body, workspace_locator: locator, agent_id: agent.agent_id, extensions: agent.extensions });
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
    if (this.processing) return;
    this.processing = true;
    try {
      const deliveries = await this.bus.claimDeliveries(this.bridgeId);
      for (const delivery of deliveries) {
        await this.handleDelivery(delivery);
      }
    } catch (error) {
      console.error("[bridge] delivery processing failed", error);
    } finally {
      this.processing = false;
    }
  }

  private async handleDelivery(delivery: DeliveryBundle): Promise<void> {
    console.log("[bridge] delivery claimed", {
      delivery_id: delivery.delivery_id,
      endpoint_id: delivery.endpoint_id,
      workspace_id: delivery.workspace_id,
      event_count: delivery.events.length
    });
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

      // Resolve extension tools for this agent
      const agentExtensionNames = endpointEntry?.extensions ?? [];
      const workspaceExts = this.workspaceExtensions.get(delivery.workspace_id) ?? [];
      const agentExtensions = workspaceExts.filter(ext => agentExtensionNames.includes(ext.name) && ext.errors.length === 0);

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
      console.log("[bridge] delivery failed", {
        delivery_id: delivery.delivery_id,
        error: (error as Error).message
      });
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "failed", (error as Error).message);
      await this.bus.updateEndpointStatus(delivery.endpoint_id, "error");
    }
  }

  private async resolveAuthProfile(
    workspaceId: string,
    endpointId: string,
    runtimeConfig: AgentRuntimeConfig | undefined
  ): Promise<{ auth_profile: string | null; model: string | null; source: string | null; model_source: string | null }> {
    const bindings = await this.bus.resolveRuntimeBinding(workspaceId, endpointId);
    if (bindings.endpoint_auth_profile) {
      return {
        auth_profile: bindings.endpoint_auth_profile,
        model: bindings.endpoint_model ?? bindings.workspace_model ?? bindings.global_model ?? null,
        source: "agent_binding",
        model_source: bindings.endpoint_model ? "agent_binding" : bindings.workspace_model ? "workspace_binding" : bindings.global_model ? "global_binding" : null
      };
    }
    if (bindings.workspace_auth_profile) {
      return {
        auth_profile: bindings.workspace_auth_profile,
        model: bindings.workspace_model ?? bindings.global_model ?? null,
        source: "workspace_binding",
        model_source: bindings.workspace_model ? "workspace_binding" : bindings.global_model ? "global_binding" : null
      };
    }
    if (runtimeConfig?.auth_profile?.trim()) {
      return {
        auth_profile: runtimeConfig.auth_profile.trim(),
        model: null,
        source: "project_runtime",
        model_source: null
      };
    }
    if (bindings.global_auth_profile) {
      return {
        auth_profile: bindings.global_auth_profile,
        model: bindings.global_model ?? null,
        source: "runtime_binding_global",
        model_source: bindings.global_model ? "global_binding" : null
      };
    }
    if (this.config.runtime?.default_auth_profile?.trim()) {
      return {
        auth_profile: this.config.runtime.default_auth_profile.trim(),
        model: null,
        source: "config_global_default",
        model_source: null
      };
    }
    return { auth_profile: null, model: null, source: null, model_source: null };
  }
}

export function chooseAdapter(configPath: string, config: LocalConfig): RuntimeAdapter {
  const configured = process.env.FLOE_RUNTIME_ADAPTER ?? config.bridge.runtime_adapter;
  if (!configured) {
    const authRuntime = createBridgeAuthRuntime(configPath, config);
    if (authRuntime.profiles.profiles.some((profile) => profile.provider !== "fake")) {
      return new PiAgentCoreAdapter(authRuntime);
    }
    return new FakeRuntimeAdapter();
  }
  const selected = configured.trim().toLowerCase();
  if (selected === "fake") return new FakeRuntimeAdapter();
  if (selected === "pi" || selected === "pi-agent-core") return new PiAgentCoreAdapter(createBridgeAuthRuntime(configPath, config));
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
