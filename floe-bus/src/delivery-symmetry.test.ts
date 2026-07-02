import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";

const noop = () => {};

const WS = "workspace:delivery-sym";
const PROCESSOR_EP = "actor:sym:processor";
const OBSERVER_EP = "actor:sym:observer";
const BRIDGE = "bridge:sym:b1";

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-delivery-sym-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

describe("Delivery symmetry", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeStore());
  });
  afterEach(() => cleanup());

  it("registers an actor-neutral endpoint record", () => {
    const ep = store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);
    expect(ep).toBeTruthy();
    expect((ep as any).bridge_id).toBe(BRIDGE);
  });

  it("creates delivery for actor with bridge_id", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OBSERVER_EP,
      destination: { kind: "endpoint", endpoint_id: PROCESSOR_EP },
      content: { body: "hello" },
      response: { expected: false }
    };
    const envelope = store.submitEvent(cmd, noop);
    expect(envelope).toBeTruthy();

    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
  });

  it("does not create delivery for actor without bridge_id", () => {
    store.registerEndpoint({
      endpoint_id: OBSERVER_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: PROCESSOR_EP,
      destination: { kind: "endpoint", endpoint_id: OBSERVER_EP },
      content: { body: "hello observer" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);

    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBe(0);
  });

  it("broadcast with_delivery_processor targets only actors with bridge_id", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);
    store.registerEndpoint({
      endpoint_id: OBSERVER_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "notification",
      workspace_id: WS,
      source_endpoint_id: OBSERVER_EP,
      destination: { kind: "broadcast", scope: "workspace", target: "with_delivery_processor" },
      content: { body: "system alert" },
      response: { expected: false }
    };
    const envelope = store.submitEvent(cmd, noop);
    expect(envelope).toBeTruthy();

    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries[0].endpoint_id).toBe(PROCESSOR_EP);
  });

  it("broadcast active_with_delivery_processor queues active actors with bridge_id without concurrent delivery", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "active"
    }, noop);
    store.registerEndpoint({
      endpoint_id: OBSERVER_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "active"
    }, noop);

    const cmd: EventCommand = {
      type: "notification",
      workspace_id: WS,
      source_endpoint_id: OBSERVER_EP,
      destination: { kind: "broadcast", scope: "workspace", target: "active_with_delivery_processor" },
      content: { body: "active processor alert" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);

    const queued = (store as any).db.prepare(
      "SELECT * FROM event_queue WHERE destination_endpoint_id = ? AND state = 'queued'"
    ).all(PROCESSOR_EP);
    expect(queued).toHaveLength(1);
    expect(store.claimDeliveries(BRIDGE, 10, noop)).toEqual([]);
  });

  it("broadcast active_without_delivery_processor targets active actors without bridge_id", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "active"
    }, noop);
    store.registerEndpoint({
      endpoint_id: OBSERVER_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "active"
    }, noop);

    const cmd: EventCommand = {
      type: "notification",
      workspace_id: WS,
      source_endpoint_id: PROCESSOR_EP,
      destination: { kind: "broadcast", scope: "workspace", target: "active_without_delivery_processor" },
      content: { body: "active pollable alert" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);

    const queued = (store as any).db.prepare(
      "SELECT * FROM event_queue WHERE destination_endpoint_id = ?"
    ).all(OBSERVER_EP);
    expect(queued).toHaveLength(1);
    expect(store.claimDeliveries(BRIDGE, 10, noop)).toEqual([]);
  });

  it("broadcast all targets all actors", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);
    store.registerEndpoint({
      endpoint_id: OBSERVER_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "notification",
      workspace_id: WS,
      source_endpoint_id: PROCESSOR_EP,
      destination: { kind: "broadcast", scope: "workspace", target: "all", exclude_source: true },
      content: { body: "hello everyone" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);

    const queued = (store as any).db.prepare(
      "SELECT * FROM event_queue WHERE destination_endpoint_id = ?"
    ).all(OBSERVER_EP);
    expect(queued.length).toBeGreaterThan(0);
  });

  it("deferred delivery sets runtime_unconfigured for bridge actors only", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OBSERVER_EP,
      destination: { kind: "endpoint", endpoint_id: PROCESSOR_EP },
      content: { body: "test deferred" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);
    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
    const delivery = deliveries[0];

    store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: delivery.delivery_id,
      state: "deferred",
      error: "bridge disconnected"
    }, noop);

    const ep = store.getEndpoint(PROCESSOR_EP) as any;
    expect(ep.status).toBe("runtime_unconfigured");
  });

  it("surfaces a visible runtime_unconfigured signal when messaging an unconfigured endpoint", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "runtime_unconfigured"
    }, noop);

    store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OBSERVER_EP,
      destination: { kind: "endpoint", endpoint_id: PROCESSOR_EP },
      content: { body: "hello into the void" },
      response: { expected: false }
    }, noop);

    // No delivery is created for an unconfigured endpoint...
    expect(store.claimDeliveries(BRIDGE, 10, noop)).toEqual([]);

    // ...but the message must not vanish silently: a visible telemetry signal is emitted.
    const telemetry = store.listRuntimeTelemetry({ workspace_id: WS }) as any[];
    const signal = telemetry.find((row) => row.kind === "runtime_unconfigured");
    expect(signal, "expected a runtime_unconfigured telemetry signal").toBeTruthy();
    expect(signal.endpoint_id).toBe(PROCESSOR_EP);
    const payload = typeof signal.payload_json === "string" ? JSON.parse(signal.payload_json) : signal.payload;
    expect(String(payload.message)).toMatch(/auth profile/i);
  });

  it("makes queued work deliverable at normal turn end for an active delivery processor", () => {
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);

    store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OBSERVER_EP,
      destination: { kind: "endpoint", endpoint_id: PROCESSOR_EP },
      content: { body: "first" },
      response: { expected: false }
    }, noop);

    const firstDeliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(firstDeliveries).toHaveLength(1);
    expect((store.getEndpoint(PROCESSOR_EP) as any).status).toBe("active");

    store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OBSERVER_EP,
      destination: { kind: "endpoint", endpoint_id: PROCESSOR_EP },
      content: { body: "second" },
      response: { expected: false }
    }, noop);

    expect(store.claimDeliveries(BRIDGE, 10, noop)).toEqual([]);

    store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: firstDeliveries[0].delivery_id,
      state: "acknowledged"
    }, noop);
    store.reportTurnEnd(PROCESSOR_EP, noop);

    const nextDeliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(nextDeliveries).toHaveLength(1);
    expect(nextDeliveries[0].trigger_event_id).not.toBe(firstDeliveries[0].trigger_event_id);
  });

  it("webhook ingest targets first actor with bridge_id", () => {
    store.registerEndpoint({
      endpoint_id: OBSERVER_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);
    store.registerEndpoint({
      endpoint_id: PROCESSOR_EP,
      workspace_id: WS,
      name: "Processor",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);

    store.createScope({ workspace_id: WS, scope_id: "ops", title: "Ops" }, noop);
    const envelope = store.ingestWebhook(WS, "route-1", { data: "payload" }, noop, "ops");
    expect(envelope).toBeTruthy();

    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
  });
});
