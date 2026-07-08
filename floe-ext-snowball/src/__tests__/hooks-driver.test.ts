/**
 * Overseer driver tests.
 *
 * Part B — snowball.card.entered_column is emitted when a card moves to an agent-owned column
 * Part C — the event-driven advance driver (advanceCardIfReady):
 *   - Advances cards whose exit criteria are ALL satisfied
 *   - Holds cards with any unmet exit criterion (hard gate)
 *   - Respects WIP limits on the destination column (hard block for agent too)
 *   - Cascades through consecutive agent-owned columns in a single synchronous call
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { createTools } from "../tools/index.js";
import { advanceCardIfReady } from "../overseer.js";
import { saveSidecar, loadSidecar } from "../sidecar.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { SIDECAR_SCHEMA } from "../types.js";
import type { BoardSidecar } from "../types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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

    // No entered_column for human-owned destination
    const routingEvents = bus.emittedEvents.filter(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Part C: Event-driven advance driver (advanceCardIfReady)
// ---------------------------------------------------------------------------

describe("Part C — event-driven advance driver (advanceCardIfReady)", () => {
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

  function makeCtx() {
    return {
      workspacePath: tmpDir,
      workspaceId: "ws:test",
      busClient: bus,
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

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready");

    // Card should have moved to Done
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_ready"].column_id).toBe("done");

    // Move event should be emitted with overseer as source
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

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_blocked");

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

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready");

    // Card should still be in agent-col (WIP limit blocks advance)
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_ready"].column_id).toBe("agent-col");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("does nothing when card is in a human-owned column", async () => {
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

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_human");

    // Card should still be in todo (human-owned, driver ignores it)
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_human"].column_id).toBe("todo");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
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

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_done");

    // Card should still be in 'done' (it's the last column)
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_done"].column_id).toBe("done");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("advances multiple ready cards independently", async () => {
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

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready1");
    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready2");

    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_ready1"].column_id).toBe("done");
    expect(updated.cards["ctx_ready2"].column_id).toBe("done");

    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    expect(moveEvents).toHaveLength(2);
  });

  it("cascades through consecutive agent-owned columns", async () => {
    // Board: todo → agent-col-1 → agent-col-2 → done
    // Card is ready in agent-col-1 AND would be ready in agent-col-2 (no criteria)
    // advanceCardIfReady should cascade it all the way to done in one call.
    const now = new Date().toISOString();
    const cascadeSidecar: BoardSidecar = {
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
          id: "agent-col-1",
          name: "Agent Stage 1",
          wip_limit: null,
          order: 1,
          owner: { kind: "agent", agent_id: "snowball-overseer" },
          exit_criteria: [
            { id: "stage1-done", description: "Stage 1 complete", kind: "machine" },
          ],
        },
        {
          id: "agent-col-2",
          name: "Agent Stage 2",
          wip_limit: null,
          order: 2,
          owner: { kind: "agent", agent_id: "snowball-overseer" },
          exit_criteria: [], // No criteria — card passes through immediately
        },
        {
          id: "done",
          name: "Done",
          wip_limit: null,
          order: 3,
          owner: { kind: "human" },
          exit_criteria: [],
        },
      ],
      cards: {
        ctx_cascade: {
          column_id: "agent-col-1",
          order: 0,
          title: "Cascade card",
          created_at: now,
          checks: {
            "agent-col-1": {
              "stage1-done": { checked: true, checked_at: now, checked_by: null },
            },
          },
        },
      },
    };
    saveSidecar(tmpDir, "scope:ws:test", cascadeSidecar);

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_cascade");

    // Card should have advanced all the way to done
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_cascade"].column_id).toBe("done");

    // Two move events: agent-col-1 → agent-col-2, agent-col-2 → done
    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    expect(moveEvents).toHaveLength(2);
    expect((moveEvents[0].content.data as any)?.from_column_id).toBe("agent-col-1");
    expect((moveEvents[0].content.data as any)?.to_column_id).toBe("agent-col-2");
    expect((moveEvents[1].content.data as any)?.from_column_id).toBe("agent-col-2");
    expect((moveEvents[1].content.data as any)?.to_column_id).toBe("done");
  });

  it("move_card tool triggers advance immediately on agent-column entry (integration)", async () => {
    const now = new Date().toISOString();
    // Seed overseer endpoint for routing event
    bus.seedEndpoint({
      endpoint_id: "actor:ws:test:snowball-overseer",
      workspace_id: "ws:test",
      agent_id: "snowball-overseer",
      name: "Snowball Overseer",
      status: "idle",
    });

    // Card in todo with ALL criteria pre-satisfied for agent-col
    const sidecar = makeAgentBoardSidecar({
      ctx_auto: {
        column_id: "todo",
        order: 0,
        title: "Auto-advance card",
        created_at: now,
        checks: {
          "agent-col": {
            "ec-done": { checked: true, checked_at: now, checked_by: null },
          },
        },
      },
    });
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const ctx = makeToolCtx(tmpDir, bus);
    const tools = createTools(ctx);

    // Move card into agent-col — the tool should immediately advance it to done
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_auto",
      to_column_id: "agent-col",
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);

    // After the tool returns, the card should be in done (overseer advanced it)
    const updated = loadSidecar(tmpDir, "scope:ws:test");
    expect(updated.cards["ctx_auto"].column_id).toBe("done");

    // Events: initial move (tool), overseer advance move
    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    // At minimum: the overseer advance move
    const overseerMoveEvent = moveEvents.find(
      (e) => (e.content.data as any)?.source === "overseer"
    );
    expect(overseerMoveEvent).toBeDefined();
  });
});
