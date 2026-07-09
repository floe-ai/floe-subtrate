/**
 * Overseer driver tests.
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Cards are now markdown files at tasks/<id>.md
 *   - advanceCardIfReady reads/writes card files instead of sidecar cards
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
import { saveSidecar } from "../sidecar.js";
import { writeCard, readCard } from "../card-file.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { SIDECAR_SCHEMA } from "../types.js";
import type { BoardSidecar, CardFile } from "../types.js";

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

/** Build a board sidecar with an agent-owned column (no cards — they're in files). */
function makeAgentBoardSidecar(): BoardSidecar {
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
    column_contexts: {},
  };
}

function makeCardFile(overrides: Partial<CardFile> = {}): CardFile {
  return {
    id: "test-card",
    title: "Test card",
    type: "task",
    actor: null,
    column: "todo",
    order: 0,
    created_at: new Date().toISOString(),
    checks: {},
    body: "",
    ...overrides,
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
    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());
    writeCard(tmpDir, makeCardFile({ id: "ctx_card1", title: "Feature A", column: "todo" }));

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
    expect((routingEvent!.content.data as any)?.card_id).toBe("ctx_card1");
  });

  it("does NOT emit entered_column when destination is human-owned", async () => {
    const now = new Date().toISOString();
    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());
    writeCard(tmpDir, makeCardFile({
      id: "ctx_card2",
      title: "Feature B",
      column: "agent-col",
      checks: {
        "agent-col": {
          "ec-done": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    const tools = createTools(makeToolCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card2",
      to_column_id: "done",
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);

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
    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());
    writeCard(tmpDir, makeCardFile({
      id: "ctx_ready",
      title: "Ready card",
      column: "agent-col",
      checks: {
        "agent-col": {
          "ec-done": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready");

    // Card file should be updated to done column
    const updatedCard = readCard(tmpDir, "ctx_ready");
    expect(updatedCard!.column).toBe("done");

    // Move event should be emitted
    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeDefined();
    expect((moveEvent!.content.data as any)?.source).toBe("overseer");
    expect((moveEvent!.content.data as any)?.from_column_id).toBe("agent-col");
    expect((moveEvent!.content.data as any)?.to_column_id).toBe("done");
  });

  it("advance appends carry-forward comment to card body", async () => {
    const now = new Date().toISOString();
    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());
    writeCard(tmpDir, makeCardFile({
      id: "ctx_ready",
      title: "Ready card",
      column: "agent-col",
      body: "Work in progress.",
      checks: {
        "agent-col": {
          "ec-done": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready");

    const updatedCard = readCard(tmpDir, "ctx_ready");
    expect(updatedCard!.body).toContain("Work in progress.");
    expect(updatedCard!.body).toContain(`carry-forward from "Agent Work"`);
  });

  it("holds card when exit criteria are NOT satisfied (hard gate)", async () => {
    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());
    writeCard(tmpDir, makeCardFile({
      id: "ctx_blocked",
      title: "Blocked card",
      column: "agent-col",
      checks: {}, // No checks → ec-done is unmet
    }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_blocked");

    // Card file should still be in agent-col
    const card = readCard(tmpDir, "ctx_blocked");
    expect(card!.column).toBe("agent-col");

    // No move event
    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("holds criteria-met card when destination is at WIP limit (hard block)", async () => {
    const now = new Date().toISOString();
    const sidecar = makeAgentBoardSidecar();
    const doneCol = sidecar.columns.find((c) => c.id === "done")!;
    doneCol.wip_limit = 2;
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    // Fill done column to WIP limit
    writeCard(tmpDir, makeCardFile({ id: "blocker-1", column: "done", order: 0 }));
    writeCard(tmpDir, makeCardFile({ id: "blocker-2", column: "done", order: 1 }));
    writeCard(tmpDir, makeCardFile({
      id: "ctx_ready",
      title: "Ready card",
      column: "agent-col",
      checks: {
        "agent-col": {
          "ec-done": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready");

    // Card should still be in agent-col (WIP limit blocks advance)
    const card = readCard(tmpDir, "ctx_ready");
    expect(card!.column).toBe("agent-col");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("does nothing when card is in a human-owned column", async () => {
    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());
    writeCard(tmpDir, makeCardFile({
      id: "ctx_human",
      title: "Human card",
      column: "todo",
    }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_human");

    const card = readCard(tmpDir, "ctx_human");
    expect(card!.column).toBe("todo");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("does not advance card that is already in the last column", async () => {
    const sidecar = makeAgentBoardSidecar();
    const doneCol = sidecar.columns.find((c) => c.id === "done")!;
    doneCol.owner = { kind: "agent", agent_id: "snowball-overseer" };
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    writeCard(tmpDir, makeCardFile({ id: "ctx_done", title: "Done card", column: "done" }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_done");

    const card = readCard(tmpDir, "ctx_done");
    expect(card!.column).toBe("done");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("advances multiple ready cards independently", async () => {
    const now = new Date().toISOString();
    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());

    const checks = {
      "agent-col": { "ec-done": { checked: true, checked_at: now, checked_by: null } },
    };
    writeCard(tmpDir, makeCardFile({ id: "ctx_ready1", title: "Card A", column: "agent-col", checks }));
    writeCard(tmpDir, makeCardFile({ id: "ctx_ready2", title: "Card B", column: "agent-col", order: 1, checks }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready1");
    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_ready2");

    const card1 = readCard(tmpDir, "ctx_ready1");
    const card2 = readCard(tmpDir, "ctx_ready2");
    expect(card1!.column).toBe("done");
    expect(card2!.column).toBe("done");

    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    expect(moveEvents).toHaveLength(2);
  });

  it("cascades through consecutive agent-owned columns", async () => {
    // Board: todo → agent-col-1 → agent-col-2 → done
    // Card ready in agent-col-1 AND agent-col-2 has no exit criteria (passes through immediately)
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
      column_contexts: {},
    };
    saveSidecar(tmpDir, "scope:ws:test", cascadeSidecar);

    writeCard(tmpDir, makeCardFile({
      id: "ctx_cascade",
      title: "Cascade card",
      column: "agent-col-1",
      checks: {
        "agent-col-1": {
          "stage1-done": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    await advanceCardIfReady(makeCtx(), "scope:ws:test", "ctx_cascade");

    // Card should have advanced all the way to done
    const card = readCard(tmpDir, "ctx_cascade");
    expect(card!.column).toBe("done");

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
    bus.seedEndpoint({
      endpoint_id: "actor:ws:test:snowball-overseer",
      workspace_id: "ws:test",
      agent_id: "snowball-overseer",
      name: "Snowball Overseer",
      status: "idle",
    });

    saveSidecar(tmpDir, "scope:ws:test", makeAgentBoardSidecar());
    // Card with ALL criteria pre-satisfied for agent-col
    writeCard(tmpDir, makeCardFile({
      id: "ctx_auto",
      title: "Auto-advance card",
      column: "todo",
      checks: {
        "agent-col": {
          "ec-done": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

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
    const card = readCard(tmpDir, "ctx_auto");
    expect(card!.column).toBe("done");

    // Events: overseer advance move
    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    const overseerMoveEvent = moveEvents.find(
      (e) => (e.content.data as any)?.source === "overseer"
    );
    expect(overseerMoveEvent).toBeDefined();
  });
});
