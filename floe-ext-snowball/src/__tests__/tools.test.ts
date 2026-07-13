/**
 * Tool gate enforcement tests — the critical invariant for Snowball's
 * asymmetric gating model (contract §5.2).
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   - Column definitions now live in committed column files (boards/<slug>/columns/).
 *   - makeSidecar() is slim v3 (no columns); setupBoard() writes column files.
 *   - Tests use setupBoard() to create column files with specific configs
 *     (exit_criteria, wip_limit) before running tools.
 *
 * AI movers: HARD blocked by unchecked exit criteria (no force)
 * Human movers (force=true): soft gate — warned but allowed
 * WIP limit: hard block for both
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { createTools } from "../tools/index.js";
import { slugify } from "../board-file.js";
import { writeCard } from "../card-file.js";
import { writeColumnToBoard as writeColumnFile, defaultColumnFiles } from "../board-file.js";
import type { ColumnFile } from "../types.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import type { CardFile } from "../types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

function makeCtx(tmpDir: string, bus: StubBusClient): ExtensionContext {
  return {
    workspacePath: tmpDir,
    busClient: bus,
    workspaceId: "ws:test",
    extensionName: "snowball",
    hooks: { on: () => {} },
    registerHttpHandler: () => {},
  };
}

const SCOPE = "scope:ws:test";

/**
 * Write column files for the standard gate-enforcement test board:
 *   - todo: no exit criteria, no WIP limit
 *   - in-progress: exit_criteria=[ec-tests], wip_limit=2
 *   - done: no exit criteria, no WIP limit
 */
function setupBoard(tmpDir: string): ColumnFile[] {
  const slug = slugify(SCOPE);
  const defaults = defaultColumnFiles(SCOPE);
  const cols: ColumnFile[] = [
    defaults[0], // todo — unmodified
    {
      ...defaults[1], // in-progress
      exit_criteria: [{ id: "ec-tests", description: "Tests pass", kind: "machine" }],
      wip_limit: 2,
    },
    defaults[2], // done — unmodified
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
// move_card gate enforcement tests
// ---------------------------------------------------------------------------

describe("move_card gate enforcement", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-tools-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("hard blocks AI move when exit criteria unchecked (no force)", async () => {
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "ctx_card", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: SCOPE,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("gate_blocked");
    expect(payload.unchecked_criteria).toHaveLength(1);
    expect(payload.unchecked_criteria[0].id).toBe("ec-tests");
  });

  it("allows AI move when all criteria are checked", async () => {
    const now = new Date().toISOString();
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "ctx_card",
      column: "in-progress",
      checks: {
        "in-progress": {
          "ec-tests": { checked: true, checked_at: now, checked_by: null },
        },
      },
    }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: SCOPE,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.to_column_id).toBe("done");
  });

  it("allows human move with force=true even when criteria unchecked", async () => {
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "ctx_card", column: "in-progress", checks: {} }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: SCOPE,
      force: true,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.forced).toBe(true);
  });

  it("hard blocks WIP limit regardless of force", async () => {
    const now = new Date().toISOString();
    setupBoard(tmpDir);
    // Fill in-progress to WIP limit of 2
    writeCard(tmpDir, makeCardFile({
      id: "existing-1",
      column: "in-progress",
      order: 0,
      checks: { "in-progress": { "ec-tests": { checked: true, checked_at: now, checked_by: null } } },
    }));
    writeCard(tmpDir, makeCardFile({
      id: "existing-2",
      column: "in-progress",
      order: 1,
      checks: { "in-progress": { "ec-tests": { checked: true, checked_at: now, checked_by: null } } },
    }));
    writeCard(tmpDir, makeCardFile({ id: "new-card", column: "todo", order: 0 }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "new-card",
      to_column_id: "in-progress",
      scope_id: SCOPE,
      force: true,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("wip_limit_exceeded");
    expect(payload.current).toBe(2);
    expect(payload.limit).toBe(2);
  });

  it("reports card_not_found for missing card", async () => {
    setupBoard(tmpDir);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "nonexistent",
      to_column_id: "done",
      scope_id: SCOPE,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("card_not_found");
  });

  it("move updates card file column field", async () => {
    const { readCard } = await import("../card-file.js");
    const now = new Date().toISOString();
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "ctx_card",
      column: "in-progress",
      checks: {
        "in-progress": { "ec-tests": { checked: true, checked_at: now, checked_by: null } },
      },
    }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: SCOPE,
    });

    expect(JSON.parse(result.content[0].text).ok).toBe(true);

    const updatedCard = readCard(tmpDir, "ctx_card");
    expect(updatedCard).not.toBeNull();
    expect(updatedCard!.column).toBe("done");
  });

  it("move appends carry-forward comment to card body", async () => {
    const { readCard } = await import("../card-file.js");
    const now = new Date().toISOString();
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "ctx_card",
      column: "in-progress",
      body: "Initial work notes.",
      checks: {
        "in-progress": { "ec-tests": { checked: true, checked_at: now, checked_by: null } },
      },
    }));

    const tools = createTools(makeCtx(tmpDir, bus));
    await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: SCOPE,
    });

    const updatedCard = readCard(tmpDir, "ctx_card");
    expect(updatedCard!.body).toContain("Initial work notes.");
    expect(updatedCard!.body).toContain(`carry-forward from "In Progress"`);
  });
});

// ---------------------------------------------------------------------------
// create_card tool
// ---------------------------------------------------------------------------

describe("create_card tool", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-create-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a card file in tasks/", async () => {
    const { listCards } = await import("../card-file.js");
    setupBoard(tmpDir);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: SCOPE,
      title: "New task",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.card_id).toBeDefined();
    expect(payload.column_id).toBe("todo");

    const cards = listCards(tmpDir);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("New task");
    expect(cards[0].column).toBe("todo");
  });

  it("places card in specified column", async () => {
    const { listCards } = await import("../card-file.js");
    setupBoard(tmpDir);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: SCOPE,
      title: "Card in done",
      column_id: "done",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.column_id).toBe("done");

    const cards = listCards(tmpDir);
    expect(cards[0].column).toBe("done");
  });

  it("returns column_not_found for invalid column", async () => {
    setupBoard(tmpDir);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: SCOPE,
      title: "Bad card",
      column_id: "nonexistent",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("column_not_found");
  });
});

// ---------------------------------------------------------------------------
// check_criteria tool
// ---------------------------------------------------------------------------

describe("check_criteria tool", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-criteria-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks criterion as checked in card file", async () => {
    const { readCard } = await import("../card-file.js");
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "test-card", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "check_criteria", {
      card_id: "test-card",
      scope_id: SCOPE,
      criterion_id: "ec-tests",
      checked: true,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.checked).toBe(true);

    const updatedCard = readCard(tmpDir, "test-card");
    expect(updatedCard!.checks["in-progress"]["ec-tests"].checked).toBe(true);
  });

  it("allows unchecking a criterion", async () => {
    const { readCard } = await import("../card-file.js");
    const now = new Date().toISOString();
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({
      id: "test-card",
      column: "in-progress",
      checks: {
        "in-progress": { "ec-tests": { checked: true, checked_at: now, checked_by: null } },
      },
    }));

    const tools = createTools(makeCtx(tmpDir, bus));
    await callTool(tools, "check_criteria", {
      card_id: "test-card",
      scope_id: SCOPE,
      criterion_id: "ec-tests",
      checked: false,
    });

    const updatedCard = readCard(tmpDir, "test-card");
    expect(updatedCard!.checks["in-progress"]["ec-tests"].checked).toBe(false);
  });

  it("returns card_not_found for missing card", async () => {
    setupBoard(tmpDir);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "check_criteria", {
      card_id: "nonexistent",
      scope_id: SCOPE,
      criterion_id: "ec-tests",
      checked: true,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("card_not_found");
  });
});

// ---------------------------------------------------------------------------
// list_cards / list_columns / get_board_state tools
// ---------------------------------------------------------------------------

describe("list_cards / list_columns / get_board_state tools", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-list-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("list_cards returns all cards from task files", async () => {
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "B", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_cards", { scope_id: SCOPE });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.cards).toHaveLength(2);
  });

  it("list_cards filters by column_id", async () => {
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "B", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_cards", {
      scope_id: SCOPE,
      column_id: "todo",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0].card_id).toBe("card-a");
  });

  it("list_columns returns card counts from files", async () => {
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_columns", { scope_id: SCOPE });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.card_counts["todo"]).toBe(2);
  });

  it("list_columns includes instructions from column files", async () => {
    const slug = slugify(SCOPE);
    const defaults = defaultColumnFiles(SCOPE);
    const todoWithInstructions: ColumnFile = {
      ...defaults[0],
      instructions: "Work on tasks here.",
    };
    writeColumnFile(tmpDir, slug, todoWithInstructions);
    writeColumnFile(tmpDir, slug, defaults[1]);
    writeColumnFile(tmpDir, slug, defaults[2]);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_columns", { scope_id: SCOPE });
    const payload = JSON.parse(result.content[0].text);
    const todoCol = payload.columns.find((c: { id: string }) => c.id === "todo");
    expect(todoCol.instructions).toBe("Work on tasks here.");
  });

  it("get_board_state includes cards and columns", async () => {
    setupBoard(tmpDir);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Task A", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "get_board_state", { scope_id: SCOPE });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.columns).toHaveLength(3);
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0].title).toBe("Task A");
  });

  it("get_board_state includes instructions in columns", async () => {
    const slug = slugify(SCOPE);
    const defaults = defaultColumnFiles(SCOPE);
    const todoWithInstructions: ColumnFile = {
      ...defaults[0],
      instructions: "Review before moving.",
    };
    writeColumnFile(tmpDir, slug, todoWithInstructions);
    writeColumnFile(tmpDir, slug, defaults[1]);
    writeColumnFile(tmpDir, slug, defaults[2]);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "get_board_state", { scope_id: SCOPE });
    const payload = JSON.parse(result.content[0].text);
    const todoCol = payload.columns.find((c: { id: string }) => c.id === "todo");
    expect(todoCol.instructions).toBe("Review before moving.");
  });
});
