import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "./hooks.js";
import type { HookPayload, HookResult } from "./hooks.js";

const deliveryPayload = {
  endpoint_id: "ep:1",
  workspace_id: "ws:1",
  delivery_id: "d:1",
  trigger_event_id: "evt:1"
} as const;

const turnEndPayload: HookPayload<"TurnEnd"> = {
  ...deliveryPayload,
  visible_output: "",
  tool_activity: [],
  emitted_events: []
};

const sessionStartPayload: HookPayload<"SessionStart"> = {
  ...deliveryPayload,
  provider: "mock-provider",
  model_id: "mock-model",
  reason: "session_created"
};

const sessionEndPayload: HookPayload<"SessionEnd"> = {
  endpoint_id: "ep:1",
  workspace_id: "ws:1",
  reason: "bridge_shutdown",
  previous_session: {
    provider: "mock-provider",
    model_id: "mock-model"
  }
};

const pulsePayload: HookPayload<"Pulse"> = {
  ...deliveryPayload,
  event_id: "evt:pulse",
  pulse_id: "reminder-daily",
  content: { text: "Daily standup reminder" }
};

describe("HookRegistry", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it("registers and fires a hook handler with payload", async () => {
    const received: Array<HookPayload<"BeforeTurn">> = [];
    registry.on("BeforeTurn", "test-ext", (payload) => {
      received.push(payload);
    });

    await registry.fire("BeforeTurn", deliveryPayload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(deliveryPayload);
  });

  it("fires multiple handlers in registration order", async () => {
    const order: string[] = [];
    registry.on("TurnEnd", "ext-a", () => { order.push("a"); });
    registry.on("TurnEnd", "ext-b", () => { order.push("b"); });

    await registry.fire("TurnEnd", turnEndPayload);

    expect(order).toEqual(["a", "b"]);
  });

  it("handler failure does not block subsequent handlers", async () => {
    const called: string[] = [];
    registry.on("Error", "ext-bad", () => { throw new Error("boom"); });
    registry.on("Error", "ext-ok", () => { called.push("ok"); });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await registry.fire("Error", { ...deliveryPayload, error: "boom" });
    consoleSpy.mockRestore();

    expect(called).toEqual(["ok"]);
  });

  it("firing a hook with no handlers returns empty results", async () => {
    const results = await registry.fire("SessionEnd", sessionEndPayload);
    expect(results).toEqual([]);
  });

  it("collects inject data from handler results", async () => {
    registry.on("BeforeTurn", "memory-ext", async (): Promise<HookResult> => {
      return { inject: { memory: "prior context" } };
    });
    registry.on("BeforeTurn", "plain-ext", () => {
      // void handler — no result
    });

    const results = await registry.fire("BeforeTurn", deliveryPayload);

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ inject: { memory: "prior context" } });
  });

  it("removeAll clears all handlers for an extension", async () => {
    const called: string[] = [];
    registry.on("SessionStart", "keep-ext", () => { called.push("keep"); });
    registry.on("SessionStart", "remove-ext", () => { called.push("remove"); });
    registry.on("TurnEnd", "remove-ext", () => { called.push("remove-turn"); });

    registry.removeAll("remove-ext");

    await registry.fire("SessionStart", sessionStartPayload);
    await registry.fire("TurnEnd", turnEndPayload);

    expect(called).toEqual(["keep"]);
  });

  it("hasHandlers returns correct values", () => {
    expect(registry.hasHandlers("BeforeTurn")).toBe(false);

    registry.on("BeforeTurn", "ext", () => {});
    expect(registry.hasHandlers("BeforeTurn")).toBe(true);
    expect(registry.hasHandlers("TurnEnd")).toBe(false);
  });

  it("listRegistered shows hook names and handler counts", () => {
    registry.on("BeforeTurn", "ext-a", () => {});
    registry.on("BeforeTurn", "ext-b", () => {});
    registry.on("SessionStart", "ext-a", () => {});

    const listing = registry.listRegistered();

    expect(listing).toContainEqual({ hook: "BeforeTurn", count: 2 });
    expect(listing).toContainEqual({ hook: "SessionStart", count: 1 });
    expect(listing).toHaveLength(2);
  });

  it("Pulse hook fires when pulse.fired event is processed", async () => {
    const received: Array<HookPayload<"Pulse">> = [];
    registry.on("Pulse", "pulse-tracker", (payload) => {
      received.push(payload);
    });

    await registry.fire("Pulse", pulsePayload);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      pulse_id: "reminder-daily",
      content: { text: "Daily standup reminder" }
    });
  });

  it("Pulse hook handler failure does not block delivery processing", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    registry.on("Pulse", "bad-ext", () => { throw new Error("pulse hook crash"); });

    // Should not throw
    const results = await registry.fire("Pulse", pulsePayload);
    expect(results).toEqual([]);
    consoleSpy.mockRestore();
  });

  it("BeforeTurn hook inject result can be rendered into prompt context", async () => {
    registry.on("BeforeTurn", "memory-ext", async () => ({
      inject: { source: "memory", content: "User last discussed: project deadlines" }
    }));
    registry.on("BeforeTurn", "todo-ext", async () => ({
      inject: { source: "todo", content: "Open tasks: fix bug #42, write docs" }
    }));

    const results = await registry.fire("BeforeTurn", deliveryPayload);

    expect(results).toHaveLength(2);
    expect(results[0].inject).toEqual({ source: "memory", content: "User last discussed: project deadlines" });
    expect(results[1].inject).toEqual({ source: "todo", content: "Open tasks: fix bug #42, write docs" });
  });
});
