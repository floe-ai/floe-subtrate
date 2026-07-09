/**
 * Sidecar unit tests — slugify, load/save, column_contexts, board snapshot.
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Sidecar no longer holds card state (cards are files)
 *   - Sidecar holds column definitions + column_contexts map
 *   - buildBoardSnapshot reads cards from tasks/ directory
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import {
  slugify,
  loadSidecar,
  saveSidecar,
  sidecarExists,
  buildBoardSnapshot,
  renderCompactBoardSnapshot,
  cardCountsByColumn,
  getUncheckedCriteria,
  initBoardContexts,
} from "../sidecar.js";
import { writeCard } from "../card-file.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { BoardSidecar } from "../types.js";
import { SIDECAR_SCHEMA, defaultColumns } from "../types.js";

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

  it("returns default board with v2 schema when file does not exist", () => {
    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    expect(sidecar.schema).toBe(SIDECAR_SCHEMA);
    expect(sidecar.columns).toHaveLength(3);
    expect(sidecar.columns[0].id).toBe("todo");
    expect(sidecar.column_contexts).toEqual({});
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
    const dir = join(tmpDir, ".floe", "extensions", "snowball", "boards");
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
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: {},
    };

    const { changed } = await initBoardContexts(sidecar, "ws:test", bus);
    expect(changed).toBe(true);
    expect(Object.keys(sidecar.column_contexts)).toHaveLength(3);
    for (const col of sidecar.columns) {
      expect(sidecar.column_contexts[col.id]).toBeDefined();
      expect(typeof sidecar.column_contexts[col.id]).toBe("string");
    }
  });

  it("includes overseer as participant in all column contexts", async () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: {},
    };

    await initBoardContexts(sidecar, "ws:test", bus);

    // The stub bus captures contexts; check that overseer was added
    for (const ctx of bus.createdContexts) {
      expect(ctx.participants).toContain("actor:ws:test:snowball-overseer");
    }
  });

  it("includes column owner agent as participant for agent-owned columns", async () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: [
        {
          id: "agent-col",
          name: "Agent Work",
          wip_limit: null,
          order: 0,
          owner: { kind: "agent", agent_id: "my-worker" },
          exit_criteria: [],
        },
      ],
      column_contexts: {},
    };

    await initBoardContexts(sidecar, "ws:test", bus);

    const ctx = bus.createdContexts.find((c) => c.title === "Column: Agent Work");
    expect(ctx).toBeDefined();
    expect(ctx!.participants).toContain("actor:ws:test:snowball-overseer");
    expect(ctx!.participants).toContain("actor:ws:test:my-worker");
  });

  it("is idempotent — skips columns that already have contexts", async () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: { todo: "existing-ctx-id" },
    };

    await initBoardContexts(sidecar, "ws:test", bus);

    // Only 2 new contexts created (in-progress and done), not todo
    expect(bus.createdContexts).toHaveLength(2);
    expect(sidecar.column_contexts["todo"]).toBe("existing-ctx-id");
  });

  it("returns changed=false when all columns already have contexts", async () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: [defaultColumns()[0]],
      column_contexts: { todo: "existing-ctx" },
    };

    const { changed } = await initBoardContexts(sidecar, "ws:test", bus);
    expect(changed).toBe(false);
    expect(bus.createdContexts).toHaveLength(0);
  });

  it("scopes contexts to the board scope_id", async () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test:my-board",
      workspace_id: "ws:test",
      columns: [defaultColumns()[0]],
      column_contexts: {},
    };

    await initBoardContexts(sidecar, "ws:test", bus);

    const ctx = bus.createdContexts[0];
    expect(ctx.scope_id).toBe("scope:ws:test:my-board");
  });
});

// ---------------------------------------------------------------------------
// cardCountsByColumn
// ---------------------------------------------------------------------------

describe("cardCountsByColumn", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-counts-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns zero counts when tasks/ does not exist", () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: {},
    };
    const counts = cardCountsByColumn(tmpDir, sidecar);
    expect(counts).toEqual({ todo: 0, "in-progress": 0, done: 0 });
  });

  it("counts cards from task files", () => {
    const now = new Date().toISOString();
    writeCard(tmpDir, { id: "a", title: "A", type: "task", actor: null, column: "todo", order: 0, created_at: now, checks: {}, body: "" });
    writeCard(tmpDir, { id: "b", title: "B", type: "task", actor: null, column: "todo", order: 1, created_at: now, checks: {}, body: "" });
    writeCard(tmpDir, { id: "c", title: "C", type: "task", actor: null, column: "in-progress", order: 0, created_at: now, checks: {}, body: "" });

    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: {},
    };
    const counts = cardCountsByColumn(tmpDir, sidecar);
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

  it("returns columns from sidecar and cards from files", () => {
    const now = new Date().toISOString();
    writeCard(tmpDir, { id: "card-1", title: "Task 1", type: "task", actor: null, column: "todo", order: 0, created_at: now, checks: {}, body: "" });

    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: { todo: "ctx-todo" },
    };

    const snapshot = buildBoardSnapshot(tmpDir, sidecar);
    expect(snapshot.columns).toHaveLength(3);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0].card_id).toBe("card-1");
    expect(snapshot.cards[0].column_id).toBe("todo");
    expect(snapshot.cards[0].title).toBe("Task 1");
  });

  it("computes wip_exceeded correctly", () => {
    const now = new Date().toISOString();
    // in-progress has wip_limit=5 — add 6 cards
    for (let i = 0; i < 6; i++) {
      writeCard(tmpDir, {
        id: `card-${i}`,
        title: `Task ${i}`,
        type: "task",
        actor: null,
        column: "in-progress",
        order: i,
        created_at: now,
        checks: {},
        body: "",
      });
    }
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: {},
    };
    const snapshot = buildBoardSnapshot(tmpDir, sidecar);
    const inProgress = snapshot.columns.find((c) => c.id === "in-progress")!;
    expect(inProgress.wip_exceeded).toBe(true);
    expect(inProgress.card_count).toBe(6);
  });

  it("includes criteria_checks in card data", () => {
    const now = new Date().toISOString();
    writeCard(tmpDir, {
      id: "card-x",
      title: "Checked card",
      type: "task",
      actor: null,
      column: "in-progress",
      order: 0,
      created_at: now,
      checks: {
        "in-progress": {
          "ec-1": { checked: true, checked_at: now, checked_by: "machine" },
        },
      },
      body: "",
    });
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      column_contexts: {},
    };
    const snapshot = buildBoardSnapshot(tmpDir, sidecar);
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
          owner: { kind: "human" as const },
          exit_criteria: [],
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
    expect(rendered).toContain("[human]");
  });
});
