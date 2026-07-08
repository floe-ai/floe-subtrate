/**
 * Deterministic overseer driver tests (Part C) and routing event tests (Part B).
 *
 * Part B — snowball.card.entered_column is emitted when a card moves to an agent-owned column
 * Part C — the Pulse hook driver:
 *   - Advances cards whose exit criteria are ALL satisfied
 *   - Holds cards with any unmet exit criterion (hard gate)
 *   - Respects WIP limits on the destination column (hard block for agent too)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { createTools } from "../tools/index.js";
import { registerHooks } from "../hooks.js";
import { saveSidecar, loadSidecar } from "../sidecar.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { SIDECAR_SCHEMA } from "../types.js";
import type { BoardSidecar } from "../types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/** Minimal hook registry for testing — collects registered handlers. */
interface TestHookRegistry {
  handlers: Map<string, Array<(payload: Record<string, unknown>) => unknown>>;
  on(hook: string, handler: (payload: Record<string, unknown>) => unknown): void;
  fire(hook: string, payload: Record<string, unknown>): Promise<void>;
}

function makeHookRegistry(): TestHookRegistry {
  const handlers = new Map<string, Array<(payload: Record<string, unknown>) => unknown>>();
  return {
    handlers,
    on(hook: string, handler: (payload: Record<string, unknown>) => unknown) {
      if (!handlers.has(hook)) handlers.set(hook, []);
      handlers.get(hook)!.push(handler);
    },
    async fire(hook: string, payload: Record<string, unknown>) {
      for (const h of handlers.get(hook) ?? []) {
        await h(payload);
      }
    },
  };
}

function makeCtx(tmpDir: string, bus: StubBusClient): ExtensionContext {
  const registry = makeHookRegistry();
  return {
    workspacePath: tmpDir,
    busClient: bus,
    workspaceId: "ws:test",
    extensionName: "snowball",
    hooks: {
      on(hook: string, handler: (payload: Record<string, unknown>) => unknown) {
        registry.on(hook, handler);
      },
    },
    registerHttpHandler: () => {},
    // expose for firing in tests
    _registry: registry,
  } as unknown as ExtensionContext & { _registry: TestHookRegistry };
}

function makeCtxWithRegistry(
  tmpDir: string,
  bus: StubBusClient
): { ctx: ExtensionContext; registry: TestHookRegistry } {
  const registry = makeHookRegistry();
  const ctx: ExtensionContext = {
    workspacePath: tmpDir,
    busClient: bus,
    workspaceId: "ws:test",
    extensionName: "snowball",
    hooks: {
      on(hook: string, handler: (payload: Record<string, unknown>) => unknown) {
        registry.on(hook, handler);
      },
    },
    registerHttpHandler: () => {},
  };
  return { ctx, registry };
}

function makeToolCtx(tmpDir: string, bus: StubBusClient): ExtensionContext {
  return {
    workspacePath: tmpDir,
    busClient: bus,
    workspaceId: "ws:test",
    extensionName: "snowball",
    hooks: { on: () => {} },
    registerHttpHandler: () => {},
  };
}

/** Build a board sidecar with an agent-owned column. */
function makeAgentBoardSidecar(cards: BoardSidecar["cards"] = {}): BoardSidecar {
  return {
    schema: SIDECAR_SCHEMA,
    scope_id: "scope:ws:test",
    workspace_id: "ws:test",
    columns: [
      {
        id: "todo",
        name: "To Do",
        wip_limit: null,
        order: 0,
        owner: { kind: "human" },
        exit_criteria: [],
      },
      {
        id: "agent-col",
        name: "Agent Work",
        wip_limit: null,
        order: 1,
        owner: { kind: "agent", agent_id: "snowball-overseer" },
        exit_criteria: [
          { id: "ec-done", description: "Work completed", kind: "machine" },
        ],
      },
      {
        id: "done",
        name: "Done",
        wip_limit: null,
        order: 2,
        owner: { kind: "human" },
        exit_criteria: [],
      },
    ],
    cards,
  };
}

async function callTool(
  tools: ReturnType<typeof createTools>,
  name: string,
  params: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool.execute("test-call-id", params) as any;
}

// ---------------------------------------------------------------------------
// Part B: Routing event tests
// ---------------------------------------------------------------------------

describe("Part B — routing event on agent-column entry", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-routing-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
    // Seed the overseer endpoint so routing resolves
    bus.seedEndpoint({
      endpoint_id: "actor:ws:test:snowball-overseer",
      workspace_id: "ws:test",
      agent_id: "snowball-overseer",
      name: "Snowball Overseer",
      status: "idle",
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits snowball.card.entered_column when move_card targets agent-owned column", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_card1: {
        column_id: "todo",
        order: 0,
        title: "Feature A",
        created_at: now,
        checks: {},
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeToolCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card1",
      to_column_id: "agent-col",
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);

    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();
    expect(routingEvent!.destination?.kind).toBe("endpoint");
    expect(routingEvent!.destination?.endpoint_id).toBe(
      "actor:ws:test:snowball-overseer"
    );
    expect((routingEvent!.content.data as any)?.card_context_id).toBe("ctx_card1");
    expect((routingEvent!.content.data as any)?.column_id).toBe("agent-col");
  });

  it("does NOT emit entered_column when destination is human-owned", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_card2: {
        column_id: "agent-col",
        order: 0,
        title: "Feature B",
        created_at: now,
        checks: {
          "agent-col": {
            "ec-done": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeToolCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card2",
      to_column_id: "done",
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);

    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Part C: Deterministic overseer driver
// ---------------------------------------------------------------------------

describe("Part C — deterministic overseer driver (Pulse hook)", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-driver-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePulsePayload(scopeId: string): Record<string, unknown> {
    return {
      endpoint_id: "actor:ws:test:snowball-overseer",
      workspace_id: "ws:test",
      delivery_id: "del:test",
      trigger_event_id: "evt:test",
      pulse_id: `snowball:snowball-board-heartbeat:${scopeId.replace(/[:/\\]/g, "_")}`,
      event_id: "evt:pulse:test",
      content: { scope_id: scopeId },
    };
  }

  it("advances card when all exit criteria are satisfied", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_ready: {
        column_id: "agent-col",
        order: 0,
        title: "Ready card",
        created_at: now,
        checks: {
          "agent-col": {
            "ec-done": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const { ctx, registry } = makeCtxWithRegistry(tmpDir, bus);
    registerHooks(ctx);

    await registry.fire("Pulse", makePulsePayload("scope:ws:test"));

    // Card should have moved to Done
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_ready"].column_id).toBe("done");

    // Move event should be emitted
    const moveEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.moved"
    );
    expect(moveEvent).toBeDefined();
    expect((moveEvent!.content.data as any)?.source).toBe("overseer");
    expect((moveEvent!.content.data as any)?.from_column_id).toBe("agent-col");
    expect((moveEvent!.content.data as any)?.to_column_id).toBe("done");
  });

  it("holds card when exit criteria are NOT satisfied (hard gate)", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_blocked: {
        column_id: "agent-col",
        order: 0,
        title: "Blocked card",
        created_at: now,
        checks: {}, // No checks → ec-done is unmet
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const { ctx, registry } = makeCtxWithRegistry(tmpDir, bus);
    registerHooks(ctx);

    await registry.fire("Pulse", makePulsePayload("scope:ws:test"));

    // Card should still be in agent-col
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_blocked"].column_id).toBe("agent-col");

    // No move event
    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("holds criteria-met card when destination is at WIP limit (hard block)", async () => {
    const now = new Date().toISOString();
    const sidecarBase = makeAgentBoardSidecar({
      ctx_ready: {
        column_id: "agent-col",
        order: 0,
        title: "Ready card",
        created_at: now,
        checks: {
          "agent-col": {
            "ec-done": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
      ctx_blocker: {
        column_id: "done",
        order: 0,
        title: "Done card 1",
        created_at: now,
        checks: {},
      },
      ctx_blocker2: {
        column_id: "done",
        order: 1,
        title: "Done card 2",
        created_at: now,
        checks: {},
      },
    });
    // Set done column WIP limit to 2
    const doneCol = sidecarBase.columns.find((c) => c.id === "done")!;
    doneCol.wip_limit = 2;
    saveSidecar(tmpDir, "scope:ws:test", sidecarBase);

    const { ctx, registry } = makeCtxWithRegistry(tmpDir, bus);
    registerHooks(ctx);

    await registry.fire("Pulse", makePulsePayload("scope:ws:test"));

    // Card should still be in agent-col (WIP limit blocks advance)
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_ready"].column_id).toBe("agent-col");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("does nothing for cards in human-owned columns", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_human: {
        column_id: "todo",
        order: 0,
        title: "Human card",
        created_at: now,
        checks: {},
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const { ctx, registry } = makeCtxWithRegistry(tmpDir, bus);
    registerHooks(ctx);

    await registry.fire("Pulse", makePulsePayload("scope:ws:test"));

    // Card should still be in todo (human-owned, driver ignores it)
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_human"].column_id).toBe("todo");
  });

  it("ignores pulse events that are not heartbeat pulses", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_ready: {
        column_id: "agent-col",
        order: 0,
        title: "Ready card",
        created_at: now,
        checks: {
          "agent-col": {
            "ec-done": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const { ctx, registry } = makeCtxWithRegistry(tmpDir, bus);
    registerHooks(ctx);

    // Fire a different pulse
    await registry.fire("Pulse", {
      endpoint_id: "actor:ws:test:snowball-overseer",
      workspace_id: "ws:test",
      delivery_id: "del:test",
      trigger_event_id: "evt:test",
      pulse_id: "some-other-pulse",
      event_id: "evt:pulse:test",
      content: {},
    });

    // Card should NOT have moved
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_ready"].column_id).toBe("agent-col");
  });

  it("does not advance card that is already in the last column", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_done: {
        column_id: "done",
        order: 0,
        title: "Done card",
        created_at: now,
        checks: {},
      },
    });
    // Make 'done' agent-owned for this test
    const doneCol = sidecar.columns.find((c) => c.id === "done")!;
    doneCol.owner = { kind: "agent", agent_id: "snowball-overseer" };
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const { ctx, registry } = makeCtxWithRegistry(tmpDir, bus);
    registerHooks(ctx);

    await registry.fire("Pulse", makePulsePayload("scope:ws:test"));

    // Card should still be in 'done' (it's the last column)
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_done"].column_id).toBe("done");
  });

  it("advances multiple ready cards in one cycle", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar({
      ctx_ready1: {
        column_id: "agent-col",
        order: 0,
        title: "Card A",
        created_at: now,
        checks: {
          "agent-col": {
            "ec-done": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
      ctx_ready2: {
        column_id: "agent-col",
        order: 1,
        title: "Card B",
        created_at: now,
        checks: {
          "agent-col": {
            "ec-done": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const { ctx, registry } = makeCtxWithRegistry(tmpDir, bus);
    registerHooks(ctx);

    await registry.fire("Pulse", makePulsePayload("scope:ws:test"));

    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_ready1"].column_id).toBe("done");
    expect(updated.cards["ctx_ready2"].column_id).toBe("done");

    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    expect(moveEvents).toHaveLength(2);
  });
});
