import { describe, expect, it } from "vitest";
import { FakeRuntimeAdapter } from "./fake-runtime-adapter.js";
import { BusClient, type DeliveryBundle } from "../bus-client.js";
import type { RuntimeContext } from "./runtime-adapter.js";

function makeDelivery(contextId: string | null = "ctx_delivery"): DeliveryBundle {
  const trigger: DeliveryBundle["events"][number] = {
    event_id: "evt_trigger",
    type: "message",
    workspace_id: "workspace:test",
    source_endpoint_id: "actor:workspace:test:operator",
    thread_id: "thread:test",
    context_id: contextId,
    correlation_id: null,
    destination_json: {
      kind: "endpoint",
      endpoint_id: "actor:workspace:test:floe"
    },
    content: {
      text: "hello"
    },
    response: {
      expected: false
    },
    metadata: {},
    created_at: new Date().toISOString()
  };

  return {
    delivery_id: "del_test",
    endpoint_id: "actor:workspace:test:floe",
    workspace_id: "workspace:test",
    trigger_event_id: trigger.event_id,
    events: [trigger],
    delivered_at: new Date().toISOString()
  };
}

function makeContext(): { context: RuntimeContext; emittedEvents: Array<Parameters<BusClient["emit"]>[0]> } {
  const emittedEvents: Array<Parameters<BusClient["emit"]>[0]> = [];
  const bus = new BusClient("http://127.0.0.1");
  bus.appendRuntimeTelemetry = async () => {};
  bus.emit = async (event) => {
    emittedEvents.push(event);
    return { event_id: `evt_fake_${Date.now()}`, context_id: null };
  };
  return {
    emittedEvents,
    context: {
      bridge_id: "bridge:test",
      bus
    }
  };
}

describe("FakeRuntimeAdapter", () => {
  it("continues the active delivery context for progress and message replies", async () => {
    const { context, emittedEvents } = makeContext();
    const adapter = new FakeRuntimeAdapter();

    await adapter.handleBundle(context, makeDelivery("ctx_delivery"), undefined);

    expect(emittedEvents).toHaveLength(2);
    for (const emitted of emittedEvents) {
      expect(emitted.context_id).toBeUndefined();
      expect(emitted.current_delivery_context_id).toBe("ctx_delivery");
      expect(emitted.destination.endpoint_id).toBe("actor:workspace:test:operator");
    }
  });
});
