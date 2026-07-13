/**
 * Sidecar unit tests — slugify, load/save, column_contexts, board snapshot.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   - Sidecar is now v3 (no `columns` field — column defs live in column files)
 *   - buildBoardSnapshot takes column files as 3rd argument
 *   - initBoardContexts takes column files as 4th argument
 *   - cardCountsByColumn helper removed; tests use cardCountsByColumnFromFiles directly
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import {
  slugify,
  loadSidecar,
  saveSidecar,
  sidecarExists,
  buildBoardSnapshot,
  renderCompactBoardSnapshot,
  getUncheckedCriteria,
  initBoardContexts,
} from "../sidecar.js";
import { writeCard, cardCountsByColumnFromFiles } from "../card-file.js";
import {
  writeColumnToBoard as writeColumnFile,
  listColumnsFromBoard as listColumnFiles,
  defaultColumnFiles,
} from "../board-file.js";
import type { ColumnFile } from "../types.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { BoardSidecar } from "../types.js";
import { SIDECAR_SCHEMA } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEmptySidecar(
  scopeId: string,
  workspaceId: string,
  column_contexts: Record<string, string> = {}
): BoardSidecar {
  return {
    schema: SIDECAR_SCHEMA,
    scope_id: scopeId,
    workspace_id: workspaceId,
    column_contexts,
  };
}

/** Write default column files to tmpDir and return them. */
function writeDefaultColumns(tmpDir: string, scopeId: string): ColumnFile[] {
  const slug = slugify(scopeId);
  const cols = defaultColumnFiles(scopeId);
  for (const col of cols) writeColumnFile(tmpDir, slug, col);
  return cols;
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("replaces colons with underscores", () => {
    expect(slugify("scope:workspace:name")).toBe("scope_workspace_name");
  });

  it("replaces forward slashes", () => {
    expect(slugify("scope/workspace/name")).toBe("scope_workspace_name");
  });

  it("replaces backslashes", () => {
    expect(slugify("scope\\workspace")).toBe("scope_workspace");
  });

  it("is stable (same input → same output)", () => {
    const id = "scope:ws_my-project:feature-planning";
    expect(slugify(id)).toBe(slugify(id));
    expect(slugify(id)).toBe("scope_ws_my-project_feature-planning");
  });

  it("leaves hyphens and letters untouched", () => {
    expect(slugify("my-scope")).toBe("my-scope");
  });
});

// ---------------------------------------------------------------------------
// loadSidecar / saveSidecar
// ---------------------------------------------------------------------------

describe("loadSidecar / saveSidecar", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-sidecar-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns v3 schema with empty column_contexts when file does not exist", () => {
    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    expect(sidecar.schema).toBe(SIDECAR_SCHEMA);
    expect(sidecar.column_contexts).toEqual({});
    // No `columns` field in v3
    expect((sidecar as unknown as Record<string, unknown>)["columns"]).toBeUndefined();
  });

  it("returns empty column_contexts when not present in file", () => {
    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    expect(sidecar.column_contexts).toEqual({});
  });

  it("round-trips through save and load", () => {
    const original = loadSidecar(tmpDir, "scope:ws:test");
    original.workspace_id = "ws:test";
    original.column_contexts["todo"] = "ctx_col_todo";
    original.column_contexts["in-progress"] = "ctx_col_inprogress";
    saveSidecar(tmpDir, "scope:ws:test", original);

    const reloaded = loadSidecar(tmpDir, "scope:ws:test");
    expect(reloaded.column_contexts["todo"]).toBe("ctx_col_todo");
    expect(reloaded.column_contexts["in-progress"]).toBe("ctx_col_inprogress");
  });

  it("creates parent directories on save", () => {
    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    const dir = join(tmpDir, ".floe", "extensions", "snowball", "runtime");
    expect(existsSync(dir)).toBe(true);
  });

  it("sidecarExists returns false before save", () => {
    expect(sidecarExists(tmpDir, "scope:ws:test")).toBe(false);
  });

  it("sidecarExists returns true after save", () => {
    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    expect(sidecarExists(tmpDir, "scope:ws:test")).toBe(true);
  });

  it("ignores v2 columns field when loading an old sidecar", () => {
    // Simulate a v2 sidecar with columns field
    const sidecarDir = join(tmpDir, ".floe", "extensions", "snowball", "runtime");
    mkdirSync(sidecarDir, { recursive: true });
    const v2Content = `schema: floe.ext.snowball.board.v2\nscope_id: scope:ws:test\nworkspace_id: ws:test\ncolumns:\n  - id: todo\n    name: To Do\n    order: 0\n    wip_limit: null\n    owner:\n      kind: human\n    exit_criteria: []\ncolumn_contexts:\n  todo: ctx-123\n`;
    writeFileSync(
      join(sidecarDir, "scope_ws_test.yaml"),
      v2Content,
      "utf-8"
    );

    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    expect(sidecar.column_contexts["todo"]).toBe("ctx-123");
    // columns field is stripped out
    expect((sidecar as unknown as Record<string, unknown>)["columns"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// initBoardContexts
// ---------------------------------------------------------------------------

describe("initBoardContexts", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-ctx-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates one context per column", async () => {
    const scopeId = "scope:ws:test";
    const sidecar = makeEmptySidecar(scopeId, "ws:test");
    const columns = writeDefaultColumns(tmpDir, scopeId);

    const { changed } = await initBoardContexts(sidecar, "ws:test", bus, columns);
    expect(changed).toBe(true);
    expect(Object.keys(sidecar.column_contexts)).toHaveLength(3);
    for (const col of columns) {
      expect(sidecar.column_contexts[col.id]).toBeDefined();
      expect(typeof sidecar.column_contexts[col.id]).toBe("string");
    }
  });

  it("creates one context per column with no participants for unassigned columns", async () => {
    const scopeId = "scope:ws:test";
    const sidecar = makeEmptySidecar(scopeId, "ws:test");
    const columns = writeDefaultColumns(tmpDir, scopeId);

    await initBoardContexts(sidecar, "ws:test", bus, columns);

    // Default columns have no assigned_actors => empty participants
    for (const ctx of bus.createdContexts) {
      expect(ctx.participants).toEqual([]);
    }
  });

  it("includes assigned actors as participants for actor-assigned columns", async () => {
    const scopeId = "scope:ws:test";
    const sidecar = makeEmptySidecar(scopeId, "ws:test");
    const agentCol: ColumnFile = {
      id: "agent-col",
      name: "Agent Work",
      scope_id: scopeId,
      wip_limit: null,
      order: 0,
      assigned_actors: [{ actor_ref: "my-worker", event_types: ["*"] }],
      exit_criteria: [],
      instructions: "",
    };
    const slug = slugify(scopeId);
    writeColumnFile(tmpDir, slug, agentCol);

    await initBoardContexts(sidecar, "ws:test", bus, [agentCol]);

    const ctx = bus.createdContexts.find((c) => c.title === "Column: Agent Work");
    expect(ctx).toBeDefined();
    expect(ctx!.participants).toContain("actor:ws:test:my-worker");
  });

  it("is idempotent — skips columns that already have contexts", async () => {
    const scopeId = "scope:ws:test";
    const sidecar = makeEmptySidecar(scopeId, "ws:test", { todo: "existing-ctx-id" });
    const columns = writeDefaultColumns(tmpDir, scopeId);

    await initBoardContexts(sidecar, "ws:test", bus, columns);

    // Only 2 new contexts created (in-progress and done), not todo
    expect(bus.createdContexts).toHaveLength(2);
    expect(sidecar.column_contexts["todo"]).toBe("existing-ctx-id");
  });

  it("returns changed=false when all columns already have contexts", async () => {
    const scopeId = "scope:ws:test";
    const defaultCols = defaultColumnFiles(scopeId);
    const sidecar = makeEmptySidecar(scopeId, "ws:test", {
      todo: "existing-ctx",
    });
    const firstCol = defaultCols[0];
    const slug = slugify(scopeId);
    writeColumnFile(tmpDir, slug, firstCol);

    const { changed } = await initBoardContexts(sidecar, "ws:test", bus, [firstCol]);
    expect(changed).toBe(false);
    expect(bus.createdContexts).toHaveLength(0);
  });

  it("scopes contexts to the board scope_id", async () => {
    const scopeId = "scope:ws:test:my-board";
    const sidecar = makeEmptySidecar(scopeId, "ws:test");
    const slug = slugify(scopeId);
    const col = defaultColumnFiles(scopeId)[0];
    writeColumnFile(tmpDir, slug, col);

    await initBoardContexts(sidecar, "ws:test", bus, [col]);

    const ctx = bus.createdContexts[0];
    expect(ctx.scope_id).toBe(scopeId);
  });
});

// ---------------------------------------------------------------------------
// cardCountsByColumnFromFiles (was cardCountsByColumn)
// ---------------------------------------------------------------------------

describe("cardCountsByColumnFromFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-counts-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zero counts when tasks/ does not exist", () => {
    const counts = cardCountsByColumnFromFiles(tmpDir, ["todo", "in-progress", "done"]);
    expect(counts).toEqual({ todo: 0, "in-progress": 0, done: 0 });
  });

  it("counts cards from task files", () => {
    const now = new Date().toISOString();
    writeCard(tmpDir, { id: "a", title: "A", type: "task", actor: null, column: "todo", order: 0, created_at: now, context_id: null, checks: {}, body: "" });
    writeCard(tmpDir, { id: "b", title: "B", type: "task", actor: null, column: "todo", order: 1, created_at: now, context_id: null, checks: {}, body: "" });
    writeCard(tmpDir, { id: "c", title: "C", type: "task", actor: null, column: "in-progress", order: 0, created_at: now, context_id: null, checks: {}, body: "" });

    const counts = cardCountsByColumnFromFiles(tmpDir, ["todo", "in-progress", "done"]);
    expect(counts["todo"]).toBe(2);
    expect(counts["in-progress"]).toBe(1);
    expect(counts["done"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildBoardSnapshot
// ---------------------------------------------------------------------------

describe("buildBoardSnapshot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-snapshot-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns columns from column files and cards from task files", () => {
    const scopeId = "scope:ws:test";
    const now = new Date().toISOString();
    const columns = writeDefaultColumns(tmpDir, scopeId);
    writeCard(tmpDir, { id: "card-1", title: "Task 1", type: "task", actor: null, column: "todo", order: 0, created_at: now, context_id: null, checks: {}, body: "" });

    const sidecar = makeEmptySidecar(scopeId, "ws:test", { todo: "ctx-todo" });
    const snapshot = buildBoardSnapshot(tmpDir, sidecar, columns);
    expect(snapshot.columns).toHaveLength(3);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0].card_id).toBe("card-1");
    expect(snapshot.cards[0].column_id).toBe("todo");
    expect(snapshot.cards[0].title).toBe("Task 1");
  });

  it("includes instructions in snapshot columns", () => {
    const scopeId = "scope:ws:test";
    const slug = slugify(scopeId);
    const col: ColumnFile = {
      id: "todo",
      name: "To Do",
      scope_id: scopeId,
      order: 0,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "Work on tasks here.",
    };
    writeColumnFile(tmpDir, slug, col);
    const sidecar = makeEmptySidecar(scopeId, "ws:test");
    const snapshot = buildBoardSnapshot(tmpDir, sidecar, [col]);
    expect(snapshot.columns[0].instructions).toBe("Work on tasks here.");
  });

  it("computes wip_exceeded correctly", () => {
    const scopeId = "scope:ws:test";
    const now = new Date().toISOString();
    const columns = writeDefaultColumns(tmpDir, scopeId); // in-progress has wip_limit=5
    for (let i = 0; i < 6; i++) {
      writeCard(tmpDir, {
        id: `card-${i}`,
        title: `Task ${i}`,
        type: "task",
        actor: null,
        column: "in-progress",
        order: i,
        created_at: now,
        context_id: null,
        checks: {},
        body: "",
      });
    }
    const sidecar = makeEmptySidecar(scopeId, "ws:test");
    const snapshot = buildBoardSnapshot(tmpDir, sidecar, columns);
    const inProgress = snapshot.columns.find((c) => c.id === "in-progress")!;
    expect(inProgress.wip_exceeded).toBe(true);
    expect(inProgress.card_count).toBe(6);
  });

  it("includes criteria_checks in card data", () => {
    const scopeId = "scope:ws:test";
    const now = new Date().toISOString();
    const columns = writeDefaultColumns(tmpDir, scopeId);
    writeCard(tmpDir, {
      id: "card-x",
      title: "Checked card",
      type: "task",
      actor: null,
      column: "in-progress",
      order: 0,
      created_at: now,
      context_id: null,
      checks: {
        "in-progress": {
          "ec-1": { checked: true, checked_at: now, checked_by: "machine" },
        },
      },
      body: "",
    });
    const sidecar = makeEmptySidecar(scopeId, "ws:test");
    const snapshot = buildBoardSnapshot(tmpDir, sidecar, columns);
    const card = snapshot.cards.find((c) => c.card_id === "card-x")!;
    expect(card.criteria_checks).toHaveLength(1);
    expect(card.criteria_checks[0].checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getUncheckedCriteria
// ---------------------------------------------------------------------------

describe("getUncheckedCriteria", () => {
  it("returns all criteria when checks is empty", () => {
    const card = {
      id: "c",
      title: "T",
      type: "task",
      actor: null,
      column: "in-progress",
      order: 0,
      created_at: new Date().toISOString(),
      context_id: null,
      checks: {},
      body: "",
    };
    const criteria = [{ id: "ec-1", description: "Tests", kind: "machine" }];
    const unchecked = getUncheckedCriteria(card, "in-progress", criteria);
    expect(unchecked).toHaveLength(1);
  });

  it("returns empty when all criteria checked", () => {
    const now = new Date().toISOString();
    const card = {
      id: "c",
      title: "T",
      type: "task",
      actor: null,
      column: "in-progress",
      order: 0,
      created_at: now,
      context_id: null,
      checks: {
        "in-progress": {
          "ec-1": { checked: true, checked_at: now, checked_by: null },
        },
      },
      body: "",
    };
    const criteria = [{ id: "ec-1", description: "Tests", kind: "machine" }];
    const unchecked = getUncheckedCriteria(card, "in-progress", criteria);
    expect(unchecked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// renderCompactBoardSnapshot
// ---------------------------------------------------------------------------

describe("renderCompactBoardSnapshot", () => {
  it("renders board with columns and cards", () => {
    const snapshot = {
      scope_id: "scope:test",
      workspace_id: "ws:test",
      columns: [
        {
          id: "todo",
          name: "To Do",
          wip_limit: null,
          card_count: 1,
          wip_exceeded: false,
          assigned_actors: [],
          exit_criteria: [],
          instructions: "",
        },
      ],
      cards: [
        {
          card_id: "card-1",
          column_id: "todo",
          order: 0,
          title: "My task",
          created_at: new Date().toISOString(),
          criteria_checks: [],
        },
      ],
    };
    const rendered = renderCompactBoardSnapshot(snapshot);
    expect(rendered).toContain("To Do");
    expect(rendered).toContain("My task");
    expect(rendered).toContain("[unassigned]");
  });
});
