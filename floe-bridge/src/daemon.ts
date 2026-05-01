import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentRuntimeConfig } from "./auth.js";
import { createBridgeAuthRuntime } from "./auth.js";
import type { LocalConfig } from "./config.js";
import { bridgeHttpBase, bridgeWsBase } from "./config.js";
import { BusClient, type DeliveryBundle } from "./bus-client.js";
import { ensureProjectTemplate, loadProject, materializeSavedConfig } from "./project.js";
import type { RuntimeAdapter } from "./adapters/runtime-adapter.js";
import { FakeRuntimeAdapter } from "./adapters/fake-runtime-adapter.js";
import { PiAgentCoreAdapter } from "./adapters/pi-agent-core-adapter.js";

type Timer = ReturnType<typeof setInterval>;

export class BridgeDaemon {
  readonly bridgeId: string;
  readonly bus: BusClient;
  readonly adapter: RuntimeAdapter;
  private endpointRuntime = new Map<string, AgentRuntimeConfig>();
  private timers: Timer[] = [];
  private attaching = false;
  private processing = false;
  private reportedAttachments = new Map<string, string>();

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
          if (
            message.type === "workspace_registered" ||
            message.type === "workspace_selected" ||
            message.type === "workspace_attachment_requested" ||
            message.type === "config_snapshot_requested"
          ) {
            void this.attachKnownWorkspaces();
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
        } catch {
          // Event stream is the normal control path. Reconciliation timers are bounded recovery only.
        }
      });
    } catch {
      // Startup reconciliation and bounded recovery timers handle degraded socket availability.
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
        await this.reportOnce(workspace.workspace_id, "config_drift", null, project.config_hash, {
          ...project.validation,
          observed_config_hash: project.config_hash,
          active_config_hash: workspace.active_config_hash
        });
        return;
      }

      for (const agent of project.agents) {
        const endpointId = agentEndpointId(workspace.workspace_id, agent.agent_id);
        this.endpointRuntime.set(endpointId, extractRuntimeConfig(agent.frontmatter));
        await this.bus.registerEndpoint({
          endpoint_id: endpointId,
          workspace_id: workspace.workspace_id,
          actor_type: "agent",
          name: agent.name,
          agent_id: agent.agent_id,
          bridge_id: this.bridgeId,
          status: "idle",
          metadata: {
            file: agent.file,
            runtime_adapter: this.adapter.name,
            frontmatter: agent.frontmatter
          }
        });
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
      const endpointId = agentEndpointId(workspaceId, agent.agent_id);
      this.endpointRuntime.set(endpointId, extractRuntimeConfig(agent.frontmatter));
      await this.bus.registerEndpoint({
        endpoint_id: endpointId,
        workspace_id: workspaceId,
        actor_type: "agent",
        name: agent.name,
        agent_id: agent.agent_id,
        bridge_id: this.bridgeId,
        status: "idle",
        metadata: {
          file: agent.file,
          runtime_adapter: this.adapter.name,
          frontmatter: agent.frontmatter
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
    try {
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "injected_to_runtime");
      await this.adapter.handleBundle({
        bridge_id: this.bridgeId,
        bus: this.bus
      }, delivery, this.endpointRuntime.get(delivery.endpoint_id));
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "acknowledged");
      await this.bus.reportTurnEnd(delivery.endpoint_id);
    } catch (error) {
      console.error("[bridge] adapter failed", error);
      await this.bus.reportDeliveryStatus(this.bridgeId, delivery.delivery_id, "failed", (error as Error).message);
      await this.bus.updateEndpointStatus(delivery.endpoint_id, "error");
    }
  }
}

function chooseAdapter(configPath: string, config: LocalConfig): RuntimeAdapter {
  const selected = process.env.FLOE_RUNTIME_ADAPTER ?? "fake";
  if (selected === "pi" || selected === "pi-agent-core") return new PiAgentCoreAdapter(createBridgeAuthRuntime(configPath, config));
  return new FakeRuntimeAdapter();
}

function agentEndpointId(workspaceId: string, agentId: string): string {
  return `endpoint:${workspaceId}:agent:${agentId}`;
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
