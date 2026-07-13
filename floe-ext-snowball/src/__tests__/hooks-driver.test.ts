/**
 * Overseer driver tests.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   - Column definitions now live in committed column files (boards/<slug>/columns/).
 *   - makeAgentBoardSidecar() is slim v3 (no columns); writeAgentBoardColumns()
 *     writes the column files to disk.
 *   - Tests for advanceCardIfReady now write column files before running.
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
import { slugify } from "../board-file.js";
import { writeCard, readCard } from "../card-file.js";
import { writeColumnToBoard as writeColumnFile } from "../board-file.js";
import type { ColumnFile } from "../types.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import type { CardFile } from "../types.js";

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

const AGENT_SCOPE = "scope:ws:test";

/**
 * Write the standard 3-column agent board to tmpDir:
 *   todo (no actors) → agent-col (snowball-overseer assigned, ec-done) → done (no actors)
 */
function writeAgentBoardColumns(tmpDir: string): ColumnFile[] {
  const slug = slugify(AGENT_SCOPE);
  const cols: ColumnFile[] = [
    {
      id: "todo",
      name: "To Do",
      scope_id: AGENT_SCOPE,
      wip_limit: null,
      order: 0,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    },
    {
      id: "agent-col",
      name: "Agent Work",
      scope_id: AGENT_SCOPE,
      wip_limit: null,
      order: 1,
      assigned_actors: [{ actor_ref: "snowball-overseer", event_types: ["*"] }],
      exit_criteria: [
        { id: "ec-done", description: "Work completed", kind: "machine" },
      ],
      instructions: "",
    },
    {
      id: "done",
      name: "Done",
      scope_id: AGENT_SCOPE,
      wip_limit: null,
      order: 2,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    },
  ];
  for (const col of cols) writeColumnFile(tmpDir, slug, col);
  return cols;
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
    context_id: null,
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
  return tool.execute("test-call-id", params) as ReturnType<typeof tool.execute>;
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
    writeAgentBoardColumns(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "ctx_card1", title: "Feature A", column: "todo" }));

    const tools = createTools(makeToolCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card1",
      to_column_id: "agent-col",
      scope_id: AGENT_SCOPE,
    });

    const payload = JSON.parse(result.content[0].text) as { ok: boolean };
    expect(payload.ok).toBe(true);

    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();
    // Slice 4: routes into card context (not endpoint-targeted)
    expect(routingEvent!.destination?.kind).toBe("context");
    // Card data is in the event
    expect((routingEvent!.content.data as Record<string, unknown>)?.card_id).toBe("ctx_card1");
  });

  it("does NOT emit entered_column when destination is human-owned", async () => {
    const now = new Date().toISOString();
    writeAgentBoardColumns(tmpDir);
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
      scope_id: AGENT_SCOPE,
    });

    const payload = JSON.parse(result.content[0].text) as { ok: boolean };
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
    writeAgentBoardColumns(tmpDir);
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

    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_ready");

    const updatedCard = readCard(tmpDir, "ctx_ready");
    expect(updatedCard!.column).toBe("done");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    // card.moved broadcast is intentionally not emitted (context-churn fix).
    expect(moveEvent).toBeUndefined();
    // The card file itself is authoritative — it has moved to 'done'.
    expect(updatedCard!.column).toBe("done"); // re-assert the key invariant
  });

  it("advance appends carry-forward comment to card body", async () => {
    const now = new Date().toISOString();
    writeAgentBoardColumns(tmpDir);
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

    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_ready");

    const updatedCard = readCard(tmpDir, "ctx_ready");
    expect(updatedCard!.body).toContain("Work in progress.");
    expect(updatedCard!.body).toContain(`carry-forward from "Agent Work"`);
  });

  it("holds card when exit criteria are NOT satisfied (hard gate)", async () => {
    writeAgentBoardColumns(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "ctx_blocked",
      title: "Blocked card",
      column: "agent-col",
      checks: {},
    }));

    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_blocked");

    const card = readCard(tmpDir, "ctx_blocked");
    expect(card!.column).toBe("agent-col");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("holds criteria-met card when destination is at WIP limit (hard block)", async () => {
    const now = new Date().toISOString();
    // Write columns with done having wip_limit=2
    const slug = slugify(AGENT_SCOPE);
    const cols = writeAgentBoardColumns(tmpDir);
    // Overwrite done column with wip_limit=2
    const doneCol = { ...cols[2], wip_limit: 2 };
    writeColumnFile(tmpDir, slug, doneCol);

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

    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_ready");

    const card = readCard(tmpDir, "ctx_ready");
    expect(card!.column).toBe("agent-col");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("does nothing when card is in a human-owned column", async () => {
    writeAgentBoardColumns(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "ctx_human",
      title: "Human card",
      column: "todo",
    }));

    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_human");

    const card = readCard(tmpDir, "ctx_human");
    expect(card!.column).toBe("todo");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("does not advance card that is already in the last column (agent-owned)", async () => {
    // Make done column agent-owned
    const slug = slugify(AGENT_SCOPE);
    const cols = writeAgentBoardColumns(tmpDir);
    const doneCol: ColumnFile = { ...cols[2], assigned_actors: [{ actor_ref: "snowball-overseer", event_types: ["*"] }] };
    writeColumnFile(tmpDir, slug, doneCol);
    writeCard(tmpDir, makeCardFile({ id: "ctx_done", title: "Done card", column: "done" }));

    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_done");

    const card = readCard(tmpDir, "ctx_done");
    expect(card!.column).toBe("done");

    const moveEvent = bus.emittedEvents.find((e) => e.type === "snowball.card.moved");
    expect(moveEvent).toBeUndefined();
  });

  it("advances multiple ready cards independently", async () => {
    const now = new Date().toISOString();
    writeAgentBoardColumns(tmpDir);

    const checks = {
      "agent-col": { "ec-done": { checked: true, checked_at: now, checked_by: null } },
    };
    writeCard(tmpDir, makeCardFile({ id: "ctx_ready1", title: "Card A", column: "agent-col", checks }));
    writeCard(tmpDir, makeCardFile({ id: "ctx_ready2", title: "Card B", column: "agent-col", order: 1, checks }));

    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_ready1");
    await advanceCardIfReady(makeCtx(), AGENT_SCOPE, "ctx_ready2");

    const card1 = readCard(tmpDir, "ctx_ready1");
    const card2 = readCard(tmpDir, "ctx_ready2");
    expect(card1!.column).toBe("done");
    expect(card2!.column).toBe("done");

    // card.moved broadcast is intentionally not emitted (context-churn fix);
    // verify the card files themselves are in the correct columns instead.
    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    expect(moveEvents).toHaveLength(0);
  });

  it("cascades through consecutive agent-owned columns", async () => {
    const now = new Date().toISOString();
    const cascadeScope = "scope:ws:test";
    const slug = slugify(cascadeScope);

    // 4-column cascade board: todo → agent-col-1 → agent-col-2 → done
    const cascadeCols: ColumnFile[] = [
      { id: "todo", name: "To Do", scope_id: cascadeScope, wip_limit: null, order: 0, assigned_actors: [], exit_criteria: [], instructions: "" },
      {
        id: "agent-col-1", name: "Agent Stage 1", scope_id: cascadeScope, wip_limit: null, order: 1,
        assigned_actors: [{ actor_ref: "snowball-overseer", event_types: ["*"] }],
        exit_criteria: [{ id: "stage1-done", description: "Stage 1 complete", kind: "machine" }],
        instructions: "",
      },
      {
        id: "agent-col-2", name: "Agent Stage 2", scope_id: cascadeScope, wip_limit: null, order: 2,
        assigned_actors: [{ actor_ref: "snowball-overseer", event_types: ["*"] }],
        exit_criteria: [], // No criteria — passes through immediately
        instructions: "",
      },
      { id: "done", name: "Done", scope_id: cascadeScope, wip_limit: null, order: 3, assigned_actors: [], exit_criteria: [], instructions: "" },
    ];
    for (const col of cascadeCols) writeColumnFile(tmpDir, slug, col);

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

    await advanceCardIfReady(makeCtx(), cascadeScope, "ctx_cascade");

    const card = readCard(tmpDir, "ctx_cascade");
    expect(card!.column).toBe("done");

    // card.moved broadcast is intentionally not emitted (context-churn fix).
    // Verify the card file is at the correct final column instead.
    const moveEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.moved");
    expect(moveEvents).toHaveLength(0);
    // entered_column events ARE still emitted for each agent-column step
    const enteredEvents = bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column");
    expect(enteredEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("move_card tool does NOT auto-advance on agent-column entry (advance-on-conclusion)", async () => {
    // This test verifies the fix for the pre-work cascade bug.
    // Previously, advanceCardIfReady was called synchronously after move_card
    // placed a card in an agent column, so a criteria-less column would
    // pass the card through before the agent did any work.
    //
    // After fm/floe-advance-protocol: the card stays in the agent column;
    // advance only happens when the agent concludes its work and calls move_card.
    const now = new Date().toISOString();
    bus.seedEndpoint({
      endpoint_id: "actor:ws:test:snowball-overseer",
      workspace_id: "ws:test",
      agent_id: "snowball-overseer",
      name: "Snowball Overseer",
      status: "idle",
    });

    writeAgentBoardColumns(tmpDir);

    // Even with all criteria pre-checked, the card must NOT auto-advance
    // simply because it arrived in an agent column.
    writeCard(tmpDir, makeCardFile({
      id: "ctx_no_cascade",
      title: "Should stay in agent-col",
      column: "todo",
      checks: {
        "agent-col": {
          "ec-done": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    const ctx = makeToolCtx(tmpDir, bus);
    const tools = createTools(ctx);

    const result = await callTool(tools, "move_card", {
      card_id: "ctx_no_cascade",
      to_column_id: "agent-col",
      scope_id: AGENT_SCOPE,
    });

    const payload = JSON.parse(result.content[0].text) as { ok: boolean };
    expect(payload.ok).toBe(true);

    // Card must remain in the agent column — not auto-advanced.
    const card = readCard(tmpDir, "ctx_no_cascade");
    expect(card!.column).toBe("agent-col");

    // No overseer-sourced move event should have fired.
    const overseerMoveEvents = bus.emittedEvents.filter(
      (e) =>
        e.type === "snowball.card.moved" &&
        (e.content.data as Record<string, unknown>)?.source === "overseer"
    );
    expect(overseerMoveEvents).toHaveLength(0);

    // The routing event (entered_column) MUST have been emitted so the agent wakes up.
    const routingEvent = bus.emittedEvents.find(
      (e) => e.type === "snowball.card.entered_column"
    );
    expect(routingEvent).toBeDefined();
  });
});
