import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type LocalConfig } from "./config.js";
import { BridgeDaemon, chooseAdapter } from "./daemon.js";
import { HookRegistry, type HookPayload } from "./hooks.js";

const envStack: Array<string | undefined> = [];

function makeConfig(runtimeAdapter?: string): { configPath: string; config: LocalConfig; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "floe-bridge-adapter-"));
  const config = defaultConfig(home);
  if (runtimeAdapter !== undefined) config.bridge.runtime_adapter = runtimeAdapter;
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return {
    configPath,
    config,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  };
}

function writeProfiles(home: string, profiles: Array<{ id: string; provider: string; model?: string }>): void {
  const authDir = join(home, "auth");
  mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, "profiles.yaml"), YAML.stringify({ version: 1, profiles }), "utf8");
}

function withoutAdapterEnv(): void {
  envStack.push(process.env.FLOE_RUNTIME_ADAPTER);
  delete process.env.FLOE_RUNTIME_ADAPTER;
}

afterEach(() => {
  const previous = envStack.pop();
  if (previous === undefined) delete process.env.FLOE_RUNTIME_ADAPTER;
  else process.env.FLOE_RUNTIME_ADAPTER = previous;
});

describe("chooseAdapter", () => {
  it("uses the deterministic fake adapter by default", () => {
    withoutAdapterEnv();
    const made = makeConfig();
    try {
      expect(chooseAdapter(made.configPath, made.config).name).toBe("fake");
    } finally {
      made.cleanup();
    }
  });

  it("uses pi-agent-core for real profile-backed runtime execution", () => {
    withoutAdapterEnv();
    const made = makeConfig("pi-agent-core");
    try {
      expect(chooseAdapter(made.configPath, made.config).name).toBe("pi-agent-core");
    } finally {
      made.cleanup();
    }
  });

  it("auto-selects pi-agent-core when a real auth profile exists and no adapter is configured", () => {
    withoutAdapterEnv();
    const made = makeConfig();
    try {
      writeProfiles(made.config.home, [{ id: "copilot-atvi", provider: "github-copilot", model: "gpt-4.1" }]);
      expect(chooseAdapter(made.configPath, made.config).name).toBe("pi-agent-core");
    } finally {
      made.cleanup();
    }
  });

  it("does not silently fall back to fake for unsupported adapter names", () => {
    withoutAdapterEnv();
    const made = makeConfig("copilot");
    try {
      expect(() => chooseAdapter(made.configPath, made.config)).toThrow(/Unsupported FLOE runtime adapter "copilot"/);
    } finally {
      made.cleanup();
    }
  });
});

describe("BridgeDaemon shutdown", () => {
  it("disposes runtime adapter sessions with bridge_shutdown reason", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const disposeReasons: string[] = [];
    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).adapter = {
        name: "test-adapter",
        async handleBundle() {},
        async dispose(reason?: string) {
          disposeReasons.push(reason ?? "");
        }
      };

      await daemon.stop();

      expect(disposeReasons).toEqual(["bridge_shutdown"]);
    } finally {
      made.cleanup();
    }
  });
});

describe("BridgeDaemon hook event stream", () => {
  it("fires WebhookReceived once for a persisted webhook ingest event and ignores spoofed or repeated payloads", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;
    let socket: { emitMessage(data: string): void } | undefined;

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: { data: string }) => void>>();

      constructor(readonly url: string) {
        socket = this;
      }

      addEventListener(event: string, listener: (event: { data: string }) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      emitMessage(data: string): void {
        for (const listener of this.listeners.get("message") ?? []) listener({ data });
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    const received: HookPayload[] = [];
    const hooks = new HookRegistry();
    hooks.on("WebhookReceived", "bad-ext", () => {
      throw new Error("webhook hook failed");
    });
    hooks.on("WebhookReceived", "test-ext", (payload) => {
      received.push(payload);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { return []; },
        async reportBridgeLiveness() {}
      };

      await daemon.start();
      (daemon as any).workspaceHooks.set("workspace:test", hooks);

      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:1",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            thread_id: "",
            context_id: "ctx:webhook:1",
            correlation_id: "corr-1",
            destination_json: {
              kind: "endpoint",
              endpoint_id: "actor:workspace:test:floe"
            },
            content: {
              text: "Webhook route_alpha received",
              data: { text: "Webhook route_alpha received", correlation_id: "corr-1" }
            },
            response: { expected: false },
            metadata: {
              trigger_kind: "webhook",
              route_id: "route_alpha"
            },
            created_at: new Date().toISOString()
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:1",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            context_id: "ctx:webhook:1",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "duplicate replay" },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:spoof",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: "actor:workspace:test:operator",
            context_id: "ctx:webhook:spoof",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "ordinary emit spoof" },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:other-workspace",
            type: "webhook_received",
            workspace_id: "workspace:other",
            source_endpoint_id: null,
            context_id: "ctx:webhook:other",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:other:floe" },
            content: { text: "other workspace" },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:webhook:missing-route",
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            context_id: "ctx:webhook:missing-route",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "missing route" },
            metadata: { trigger_kind: "webhook" }
          }
        }
      }));
      socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: "evt:message:1",
            type: "message",
            workspace_id: "workspace:test",
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: "not a webhook" },
            metadata: {}
          }
        }
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await daemon.stop();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        workspace_id: "workspace:test",
        route_id: "route_alpha",
        event_id: "evt:webhook:1",
        context_id: "ctx:webhook:1",
        target_endpoint_id: "actor:workspace:test:floe",
        content: {
          text: "Webhook route_alpha received"
        },
        metadata: {
          trigger_kind: "webhook",
          route_id: "route_alpha"
        }
      });
    } finally {
      consoleSpy.mockRestore();
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });

  it("bounds WebhookReceived replay dedupe to recent event IDs", async () => {
    withoutAdapterEnv();
    const made = makeConfig("fake");
    const previousWebSocket = (globalThis as any).WebSocket;
    let socket: { emitMessage(data: string): void } | undefined;

    class FakeWebSocket {
      private listeners = new Map<string, Array<(event: { data: string }) => void>>();

      constructor(readonly url: string) {
        socket = this;
      }

      addEventListener(event: string, listener: (event: { data: string }) => void): void {
        const existing = this.listeners.get(event) ?? [];
        existing.push(listener);
        this.listeners.set(event, existing);
      }

      emitMessage(data: string): void {
        for (const listener of this.listeners.get("message") ?? []) listener({ data });
      }
    }

    (globalThis as any).WebSocket = FakeWebSocket;

    const receivedEventIds: string[] = [];
    const hooks = new HookRegistry();
    hooks.on("WebhookReceived", "test-ext", (payload) => {
      receivedEventIds.push(payload.event_id);
    });

    try {
      const daemon = new BridgeDaemon(made.configPath, made.config);
      (daemon as any).bus = {
        async health() {},
        async registerBridge() {},
        async listWorkspaces() { return []; },
        async claimDeliveries() { return []; },
        async reportBridgeLiveness() {}
      };

      await daemon.start();
      (daemon as any).workspaceHooks.set("workspace:test", hooks);

      const emitWebhook = (eventId: string) => socket?.emitMessage(JSON.stringify({
        type: "event_submitted",
        payload: {
          event: {
            event_id: eventId,
            type: "webhook_received",
            workspace_id: "workspace:test",
            source_endpoint_id: null,
            context_id: `ctx:${eventId}`,
            destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
            content: { text: eventId },
            metadata: { trigger_kind: "webhook", route_id: "route_alpha" }
          }
        }
      }));

      const webhookDedupeMaxEvents = 10_000;
      for (let index = 0; index <= webhookDedupeMaxEvents; index += 1) {
        emitWebhook(`evt:webhook:${index}`);
      }
      emitWebhook("evt:webhook:10000");
      emitWebhook("evt:webhook:0");

      await new Promise((resolve) => setTimeout(resolve, 0));
      await daemon.stop();

      expect(receivedEventIds.filter((eventId) => eventId === "evt:webhook:10000")).toHaveLength(1);
      expect(receivedEventIds.filter((eventId) => eventId === "evt:webhook:0")).toHaveLength(2);
    } finally {
      (globalThis as any).WebSocket = previousWebSocket;
      made.cleanup();
    }
  });
});
