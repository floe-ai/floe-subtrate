import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore } from "./store.js";
import { defaultConfig } from "./config.js";

const noop = () => {};
const WS = "workspace:test-trace";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-trace-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  for (const id of [E1, E2]) {
    store.registerEndpoint({ endpoint_id: id, workspace_id: WS, name: id, bridge_id: null, status: "idle" }, noop);
  }
  return { store, cleanup: () => { try { store.close(); } catch {} rmSync(tmp, { recursive: true, force: true }); } };
}

// Emit an event carrying a producing-turn link in metadata, mirroring the emit tool.
function emitWithDelivery(store: BusStore, deliveryId: string | null) {
  return store.submitEvent(
    {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: E1,
      destination: { kind: "endpoint", endpoint_id: E2 },
      thread_id: "",
      correlation_id: null,
      content: { text: "hi" },
      response: undefined,
      metadata: deliveryId ? { delivery_id: deliveryId } : {},
      idempotency_key: null,
      context_id: undefined,
      current_delivery_context_id: undefined
    },
    noop
  ).event;
}

describe("getEventTrace", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => { const m = makeStore(); store = m.store; cleanup = m.cleanup; });
  afterEach(() => cleanup());

  it("returns the telemetry for the turn that produced the event", () => {
    const event = emitWithDelivery(store, "del_abc");
    store.appendRuntimeTelemetry({ workspace_id: WS, endpoint_id: E1, delivery_id: "del_abc", kind: "tool_use", payload: { tool: "bash" } }, noop);
    store.appendRuntimeTelemetry({ workspace_id: WS, endpoint_id: E1, delivery_id: "del_other", kind: "tool_use", payload: { tool: "read" } }, noop);

    const trace = store.getEventTrace(event.event_id);
    expect(trace?.delivery_id).toBe("del_abc");
    expect(trace?.telemetry).toHaveLength(1);
    expect((trace?.telemetry[0] as any).delivery_id).toBe("del_abc");
  });

  it("returns a null delivery_id and empty trace for an event with no producing turn", () => {
    const event = emitWithDelivery(store, null);
    const trace = store.getEventTrace(event.event_id);
    expect(trace?.delivery_id).toBeNull();
    expect(trace?.telemetry).toEqual([]);
  });

  it("returns null for an event that does not exist", () => {
    expect(store.getEventTrace("evt_missing")).toBeNull();
  });

  it("listRuntimeTelemetry filters by delivery_id", () => {
    store.appendRuntimeTelemetry({ workspace_id: WS, endpoint_id: E1, delivery_id: "del_1", kind: "k", payload: {} }, noop);
    store.appendRuntimeTelemetry({ workspace_id: WS, endpoint_id: E1, delivery_id: "del_2", kind: "k", payload: {} }, noop);
    const only1 = store.listRuntimeTelemetry({ workspace_id: WS, delivery_id: "del_1" });
    expect(only1).toHaveLength(1);
    expect((only1[0] as any).delivery_id).toBe("del_1");
  });
});
