/**
 * Tool gate enforcement tests — the critical invariant for Snowball's
 * asymmetric gating model (contract §5.2).
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Cards are now markdown files at tasks/<id>.md
 *   - Gate checks read card files instead of sidecar cards
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
import { saveSidecar } from "../sidecar.js";
import { writeCard } from "../card-file.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { ExtensionContext } from "../stub/extension-context.js";
import { SIDECAR_SCHEMA, defaultColumns } from "../types.js";
import type { BoardSidecar, CardFile } from "../types.js";

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

function makeSidecar(): BoardSidecar {
  const columns = defaultColumns();
  // Give in-progress column an exit criterion
  columns[1].exit_criteria = [
    { id: "ec-tests", description: "Tests pass", kind: "machine" },
  ];
  columns[1].wip_limit = 2;

  return {
    schema: SIDECAR_SCHEMA,
    scope_id: "scope:ws:test",
    workspace_id: "ws:test",
    columns,
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
// Tests
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
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    // Card is in in-progress column with no checks
    writeCard(tmpDir, makeCardFile({ id: "ctx_card", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: "scope:ws:test",
      // No force → AI path
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("gate_blocked");
    expect(payload.unchecked_criteria).toHaveLength(1);
    expect(payload.unchecked_criteria[0].id).toBe("ec-tests");
  });

  it("allows AI move when all criteria are checked", async () => {
    const now = new Date().toISOString();
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
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
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.to_column_id).toBe("done");
  });

  it("allows human move with force=true even when criteria unchecked", async () => {
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    writeCard(tmpDir, makeCardFile({ id: "ctx_card", column: "in-progress", checks: {} }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "ctx_card",
      to_column_id: "done",
      scope_id: "scope:ws:test",
      force: true, // Human override
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.forced).toBe(true);
  });

  it("hard blocks WIP limit regardless of force", async () => {
    const now = new Date().toISOString();
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
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
    // in-progress has WIP limit of 2 (already at 2)
    const result = await callTool(tools, "move_card", {
      card_id: "new-card",
      to_column_id: "in-progress",
      scope_id: "scope:ws:test",
      force: true, // Even with force, WIP is hard-blocked
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("wip_limit_exceeded");
    expect(payload.current).toBe(2);
    expect(payload.limit).toBe(2);
  });

  it("reports card_not_found for missing card", async () => {
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "move_card", {
      card_id: "nonexistent",
      to_column_id: "done",
      scope_id: "scope:ws:test",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe("card_not_found");
  });

  it("move updates card file column field", async () => {
    const { readCard } = await import("../card-file.js");
    const now = new Date().toISOString();
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
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
      scope_id: "scope:ws:test",
    });

    expect(JSON.parse(result.content[0].text).ok).toBe(true);

    // Verify card file was updated
    const updatedCard = readCard(tmpDir, "ctx_card");
    expect(updatedCard).not.toBeNull();
    expect(updatedCard!.column).toBe("done");
  });

  it("move appends carry-forward comment to card body", async () => {
    const { readCard } = await import("../card-file.js");
    const now = new Date().toISOString();
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
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
      scope_id: "scope:ws:test",
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
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: "scope:ws:test",
      title: "New task",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.card_id).toBeDefined();
    expect(payload.column_id).toBe("todo"); // default first column

    const cards = listCards(tmpDir);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("New task");
    expect(cards[0].column).toBe("todo");
  });

  it("places card in specified column", async () => {
    const { listCards } = await import("../card-file.js");
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: "scope:ws:test",
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
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "create_card", {
      scope_id: "scope:ws:test",
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
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    writeCard(tmpDir, makeCardFile({ id: "test-card", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "check_criteria", {
      card_id: "test-card",
      scope_id: "scope:ws:test",
      criterion_id: "ec-tests",
      checked: true,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.ok).toBe(true);
    expect(payload.checked).toBe(true);

    // Verify card file was updated
    const updatedCard = readCard(tmpDir, "test-card");
    expect(updatedCard!.checks["in-progress"]["ec-tests"].checked).toBe(true);
  });

  it("allows unchecking a criterion", async () => {
    const { readCard } = await import("../card-file.js");
    const now = new Date().toISOString();
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
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
      scope_id: "scope:ws:test",
      criterion_id: "ec-tests",
      checked: false,
    });

    const updatedCard = readCard(tmpDir, "test-card");
    expect(updatedCard!.checks["in-progress"]["ec-tests"].checked).toBe(false);
  });

  it("returns card_not_found for missing card", async () => {
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "check_criteria", {
      card_id: "nonexistent",
      scope_id: "scope:ws:test",
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
    const now = new Date().toISOString();
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "B", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_cards", { scope_id: "scope:ws:test" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.cards).toHaveLength(2);
  });

  it("list_cards filters by column_id", async () => {
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "A", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", title: "B", column: "in-progress" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_cards", {
      scope_id: "scope:ws:test",
      column_id: "todo",
    });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0].card_id).toBe("card-a");
  });

  it("list_columns returns card counts from files", async () => {
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    writeCard(tmpDir, makeCardFile({ id: "card-a", column: "todo" }));
    writeCard(tmpDir, makeCardFile({ id: "card-b", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "list_columns", { scope_id: "scope:ws:test" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.card_counts["todo"]).toBe(2);
  });

  it("get_board_state includes cards and columns", async () => {
    const sidecar = makeSidecar();
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    writeCard(tmpDir, makeCardFile({ id: "card-a", title: "Task A", column: "todo" }));

    const tools = createTools(makeCtx(tmpDir, bus));
    const result = await callTool(tools, "get_board_state", { scope_id: "scope:ws:test" });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.columns).toHaveLength(3);
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0].title).toBe("Task A");
  });
});
