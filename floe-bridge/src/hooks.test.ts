import { describe, it, expect, vi, beforeEach } from "vitest";
import { HookRegistry } from "./hooks.js";
import type { HookPayload, HookResult } from "./hooks.js";

describe("HookRegistry", () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it("registers and fires a hook handler with payload", async () => {
    const received: HookPayload[] = [];
    registry.on("BeforeTurn", "test-ext", (payload) => {
      received.push(payload);
    });

    await registry.fire("BeforeTurn", { endpoint_id: "ep:1", workspace_id: "ws:1" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ endpoint_id: "ep:1", workspace_id: "ws:1" });
  });

  it("fires multiple handlers in registration order", async () => {
    const order: string[] = [];
    registry.on("TurnEnd", "ext-a", () => { order.push("a"); });
    registry.on("TurnEnd", "ext-b", () => { order.push("b"); });

    await registry.fire("TurnEnd", {});

    expect(order).toEqual(["a", "b"]);
  });

  it("handler failure does not block subsequent handlers", async () => {
    const called: string[] = [];
    registry.on("Error", "ext-bad", () => { throw new Error("boom"); });
    registry.on("Error", "ext-ok", () => { called.push("ok"); });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await registry.fire("Error", {});
    consoleSpy.mockRestore();

    expect(called).toEqual(["ok"]);
  });

  it("firing a hook with no handlers returns empty results", async () => {
    const results = await registry.fire("SessionEnd", { reason: "test" });
    expect(results).toEqual([]);
  });

  it("collects inject data from handler results", async () => {
    registry.on("BeforeTurn", "memory-ext", async (): Promise<HookResult> => {
      return { inject: { memory: "prior context" } };
    });
    registry.on("BeforeTurn", "plain-ext", () => {
      // void handler — no result
    });

    const results = await registry.fire("BeforeTurn", { delivery_id: "d:1" });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ inject: { memory: "prior context" } });
  });

  it("removeAll clears all handlers for an extension", async () => {
    const called: string[] = [];
    registry.on("SessionStart", "keep-ext", () => { called.push("keep"); });
    registry.on("SessionStart", "remove-ext", () => { called.push("remove"); });
    registry.on("TurnEnd", "remove-ext", () => { called.push("remove-turn"); });

    registry.removeAll("remove-ext");

    await registry.fire("SessionStart", {});
    await registry.fire("TurnEnd", {});

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
});
