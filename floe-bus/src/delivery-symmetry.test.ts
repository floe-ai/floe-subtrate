import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";

const noop = () => {};

const WS = "workspace:delivery-sym";
const AGENT_EP = "actor:sym:a1";
const HUMAN_EP = "actor:sym:h1";
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

describe("Delivery symmetry (actor_type removed)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    ({ store, cleanup } = makeStore());
  });
  afterEach(() => cleanup());

  it("registers an endpoint without actor_type field", () => {
    // Registration must succeed with no actor_type in input
    const ep = store.registerEndpoint({
      endpoint_id: AGENT_EP,
      workspace_id: WS,
      name: "Agent A1",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);
    expect(ep).toBeTruthy();
    expect((ep as any).actor_type).toBeUndefined();
    expect((ep as any).bridge_id).toBe(BRIDGE);
  });

  it("creates delivery for actor with bridge_id", () => {
    // Actor with bridge_id should get deliveries created
    store.registerEndpoint({
      endpoint_id: AGENT_EP,
      workspace_id: WS,
      name: "Agent A1",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: HUMAN_EP,
      destination: { kind: "endpoint", endpoint_id: AGENT_EP },
      content: { body: "hello" },
      response: { expected: false }
    };
    const envelope = store.submitEvent(cmd, noop);
    expect(envelope).toBeTruthy();

    // Try to claim a delivery for the bridge
    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
  });

  it("does not create delivery for actor without bridge_id", () => {
    // Actor without bridge_id should NOT get push deliveries
    store.registerEndpoint({
      endpoint_id: HUMAN_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: AGENT_EP,
      destination: { kind: "endpoint", endpoint_id: HUMAN_EP },
      content: { body: "hello human" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);

    // No delivery should be created for the human endpoint (no bridge)
    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBe(0);
  });

  it("broadcast with_runtime targets only actors with bridge_id", () => {
    store.registerEndpoint({
      endpoint_id: AGENT_EP,
      workspace_id: WS,
      name: "Agent A1",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);
    store.registerEndpoint({
      endpoint_id: HUMAN_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "notification",
      workspace_id: WS,
      source_endpoint_id: HUMAN_EP,
      destination: { kind: "broadcast", scope: "workspace", target: "with_runtime" },
      content: { body: "system alert" },
      response: { expected: false }
    };
    const envelope = store.submitEvent(cmd, noop);
    expect(envelope).toBeTruthy();

    // Only the agent (with bridge_id) should have a queued event
    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries[0].endpoint_id).toBe(AGENT_EP);
  });

  it("broadcast all targets all actors", () => {
    store.registerEndpoint({
      endpoint_id: AGENT_EP,
      workspace_id: WS,
      name: "Agent A1",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);
    store.registerEndpoint({
      endpoint_id: HUMAN_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);

    const cmd: EventCommand = {
      type: "notification",
      workspace_id: WS,
      source_endpoint_id: AGENT_EP,
      destination: { kind: "broadcast", scope: "workspace", target: "all", exclude_source: true },
      content: { body: "hello everyone" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);

    // The human endpoint should have a queued event (we check via DB state)
    const queued = (store as any).db.prepare(
      "SELECT * FROM event_queue WHERE destination_endpoint_id = ?"
    ).all(HUMAN_EP);
    expect(queued.length).toBeGreaterThan(0);
  });

  it("deferred delivery sets runtime_unconfigured for bridge actors only", () => {
    store.registerEndpoint({
      endpoint_id: AGENT_EP,
      workspace_id: WS,
      name: "Agent A1",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);

    // Submit event and create delivery
    const cmd: EventCommand = {
      type: "message",
      workspace_id: WS,
      source_endpoint_id: HUMAN_EP,
      destination: { kind: "endpoint", endpoint_id: AGENT_EP },
      content: { body: "test deferred" },
      response: { expected: false }
    };
    store.submitEvent(cmd, noop);
    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
    const delivery = deliveries[0];

    // Defer the delivery
    store.reportDeliveryStatus({
      bridge_id: BRIDGE,
      delivery_id: delivery.delivery_id,
      state: "deferred",
      error: "bridge disconnected"
    }, noop);

    // The endpoint should now be runtime_unconfigured (has bridge_id)
    const ep = store.getEndpoint(AGENT_EP) as any;
    expect(ep.status).toBe("runtime_unconfigured");
  });

  it("webhook ingest targets first actor with bridge_id", () => {
    store.registerEndpoint({
      endpoint_id: HUMAN_EP,
      workspace_id: WS,
      name: "Operator",
      bridge_id: null,
      status: "idle"
    }, noop);
    store.registerEndpoint({
      endpoint_id: AGENT_EP,
      workspace_id: WS,
      name: "Agent A1",
      bridge_id: BRIDGE,
      status: "idle"
    }, noop);

    // Webhook should find the agent (with bridge_id), not the human
    const envelope = store.ingestWebhook(WS, "route-1", { data: "payload" }, noop);
    expect(envelope).toBeTruthy();

    // Verify the event was queued for the agent endpoint
    const deliveries = store.claimDeliveries(BRIDGE, 10, noop);
    expect(deliveries.length).toBeGreaterThan(0);
  });
});
