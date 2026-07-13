/**
 * Board snapshot tests — slugify, buildBoardSnapshot, renderCompactBoardSnapshot.
 *
 * Slice 6 (fm/snowball-ctx-retire):
 *   These functions were relocated from sidecar.ts (now deleted) to board-file.ts
 *   (slugify) and board-snapshot.ts (buildBoardSnapshot, renderCompactBoardSnapshot).
 *   initBoardContexts, loadSidecar, saveSidecar, sidecarExists are gone entirely.
 *
 * Validation requirement (c): no column_contexts / sidecar references remain.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import {
  slugify,
  writeColumnToBoard as writeColumnFile,
  defaultColumnFiles,
} from "../board-file.js";
import { buildBoardSnapshot, renderCompactBoardSnapshot } from "../board-snapshot.js";
import { writeCard, cardCountsByColumnFromFiles } from "../card-file.js";
import type { ColumnFile } from "../types.js";

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
// cardCountsByColumnFromFiles (from card-file.ts)
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

  function writeDefaultColumns(tmpDir: string, scopeId: string): ColumnFile[] {
    const slug = slugify(scopeId);
    const cols = defaultColumnFiles(scopeId);
    for (const col of cols) writeColumnFile(tmpDir, slug, col);
    return cols;
  }

  it("returns columns and cards from files", () => {
    const scopeId = "scope:ws:test";
    const now = new Date().toISOString();
    const columns = writeDefaultColumns(tmpDir, scopeId);
    writeCard(tmpDir, { id: "card-1", title: "Task 1", type: "task", actor: null, column: "todo", order: 0, created_at: now, context_id: null, checks: {}, body: "" });

    const snapshot = buildBoardSnapshot(tmpDir, scopeId, "ws:test", columns);
    expect(snapshot.columns).toHaveLength(3);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0].card_id).toBe("card-1");
    expect(snapshot.cards[0].column_id).toBe("todo");
    expect(snapshot.cards[0].title).toBe("Task 1");
    expect(snapshot.scope_id).toBe(scopeId);
    expect(snapshot.workspace_id).toBe("ws:test");
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
    const snapshot = buildBoardSnapshot(tmpDir, scopeId, "ws:test", [col]);
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
    const snapshot = buildBoardSnapshot(tmpDir, scopeId, "ws:test", columns);
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
    const snapshot = buildBoardSnapshot(tmpDir, scopeId, "ws:test", columns);
    const card = snapshot.cards.find((c) => c.card_id === "card-x")!;
    expect(card.criteria_checks).toHaveLength(1);
    expect(card.criteria_checks[0].checked).toBe(true);
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

// ---------------------------------------------------------------------------
// Sidecar absence verification (validation requirement c)
// ---------------------------------------------------------------------------

describe("No sidecar references remain", () => {
  it("sidecar.ts file does not exist in source tree", async () => {
    const { existsSync } = await import("node:fs");
    const { join: pathJoin, dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    // __tests__/../sidecar.ts
    const testDir = dirname(fileURLToPath(import.meta.url));
    const sidecarPath = resolve(testDir, "..", "sidecar.ts");
    expect(existsSync(sidecarPath)).toBe(false);
  });
});
