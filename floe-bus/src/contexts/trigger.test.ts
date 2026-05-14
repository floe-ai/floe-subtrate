import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore } from "../store.js";
import { defaultConfig } from "../config.js";

const noop = () => {};

const WS = "workspace:test-trig";
const TARGET = "actor:test:floe";
const OTHER = "actor:test:other";
const BRIDGE = "bridge:test:b1";

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-trig-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  for (const id of [TARGET, OTHER]) {
    store.registerEndpoint({
      endpoint_id: id,
      workspace_id: WS,
      name: id,
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);
  }
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe("trigger emission — target-only contexts (Slice 3)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  it("T8: pulse trigger event has context_id, target as sole participant, null source, trigger metadata", () => {
    const event = store.emitTriggerEvent(
      {
        type: "pulse.fired",
        workspace_id: WS,
        target_endpoint_id: TARGET,
        content: { text: "scheduled ping", pulse_id: "pulse_123" },
        metadata: {
          trigger_kind: "pulse",
          pulse_id: "pulse_123",
          pulse_name: "daily_check"
        }
      },
      noop
    );

    expect(event.context_id).toMatch(/^ctx_/);
    expect(event.source_endpoint_id).toBeNull();
    expect(event.metadata.trigger_kind).toBe("pulse");
    expect(event.metadata.pulse_id).toBe("pulse_123");
    expect(event.metadata.pulse_name).toBe("daily_check");
    expect(event.destination_json).toEqual({ kind: "endpoint", endpoint_id: TARGET });

    const participants = store.contextStore.getContextParticipants(event.context_id!);
    expect(participants).toEqual([TARGET]);
    // No synthetic system endpoint anywhere in participants
    expect(participants.some((p) => p.includes("system:") || p.includes(":pulse:") || p.includes(":webhook:"))).toBe(false);
  });

  it("T9: webhook ingest creates one context per ingest with target as sole participant", () => {
    const e1 = store.ingestWebhook(WS, "route_alpha", { text: "hello" }, noop);
    const e2 = store.ingestWebhook(WS, "route_alpha", { text: "again" }, noop);

    expect(e1.context_id).toMatch(/^ctx_/);
    expect(e2.context_id).toMatch(/^ctx_/);
    expect(e1.context_id).not.toBe(e2.context_id);

    for (const event of [e1, e2]) {
      expect(event.source_endpoint_id).toBeNull();
      expect(event.metadata.trigger_kind).toBe("webhook");
      expect(event.metadata.route_id).toBe("route_alpha");
      const parts = store.contextStore.getContextParticipants(event.context_id!);
      expect(parts).toEqual([TARGET]); // first agent endpoint registered for the workspace
      expect(parts.some((p) => p.includes("system:") || p.includes(":webhook:"))).toBe(false);
    }
  });

  it("pulse event row carries null source_endpoint_id in storage", () => {
    const event = store.emitTriggerEvent(
      {
        type: "pulse.fired",
        workspace_id: WS,
        target_endpoint_id: TARGET,
        content: {},
        metadata: { trigger_kind: "pulse", pulse_id: "p", pulse_name: "n" }
      },
      noop
    );
    const row = store.db
      .prepare("SELECT source_endpoint_id, context_id FROM events WHERE event_id = ?")
      .get(event.event_id) as any;
    expect(row.source_endpoint_id).toBeNull();
    expect(row.context_id).toBe(event.context_id);
  });

  it("trigger event still queues a delivery for the target endpoint", () => {
    const event = store.emitTriggerEvent(
      {
        type: "pulse.fired",
        workspace_id: WS,
        target_endpoint_id: TARGET,
        content: {},
        metadata: { trigger_kind: "pulse", pulse_id: "p", pulse_name: "n" }
      },
      noop
    );
    const queued = store.db
      .prepare("SELECT destination_endpoint_id FROM event_queue WHERE event_id = ?")
      .all(event.event_id) as Array<{ destination_endpoint_id: string }>;
    expect(queued.map((q) => q.destination_endpoint_id)).toContain(TARGET);
  });
});
