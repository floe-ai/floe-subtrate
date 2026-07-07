/**
 * Sidecar unit tests — slugify, load/save, reconcile rules (§3.4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import {
  slugify,
  loadSidecar,
  saveSidecar,
  reconcileSidecar,
  getUncheckedCriteria,
  cardCountsByColumn,
  buildBoardSnapshot,
  renderCompactBoardSnapshot,
} from "../sidecar.js";
import { StubBusClient } from "../stub/bus-client.js";
import type { BoardSidecar, SidecarCard } from "../types.js";
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
    tmpDir = join(tmpdir(), `snowball-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns default board when file does not exist", () => {
    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    expect(sidecar.schema).toBe(SIDECAR_SCHEMA);
    expect(sidecar.columns).toHaveLength(3);
    expect(sidecar.columns[0].id).toBe("todo");
    expect(sidecar.cards).toEqual({});
  });

  it("round-trips through save and load", () => {
    const original = loadSidecar(tmpDir, "scope:ws:test");
    original.workspace_id = "ws:test";
    original.cards["ctx_abc"] = {
      column_id: "todo",
      order: 0,
      title: "Test card",
      created_at: new Date().toISOString(),
      checks: {},
    };
    saveSidecar(tmpDir, "scope:ws:test", original);

    const reloaded = loadSidecar(tmpDir, "scope:ws:test");
    expect(reloaded.cards["ctx_abc"]).toBeDefined();
    expect(reloaded.cards["ctx_abc"].title).toBe("Test card");
  });

  it("creates parent directories on save", () => {
    const sidecar = loadSidecar(tmpDir, "scope:ws:test");
    saveSidecar(tmpDir, "scope:ws:test", sidecar);
    const dir = join(tmpDir, ".floe", "extensions", "snowball", "boards");
    expect(existsSync(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcileSidecar
// ---------------------------------------------------------------------------

describe("reconcileSidecar", () => {
  let tmpDir: string;
  let bus: StubBusClient;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    bus = new StubBusClient();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rule 1: context in bus but not sidecar → recover into first column", async () => {
    bus.seedContext({
      context_id: "ctx_new",
      workspace_id: "ws:test",
      scope_id: "scope:ws:test",
      created_at: new Date().toISOString(),
      first_message_preview: "New card",
      participants: [],
    });

    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      cards: {},
    };

    const { sidecar: reconciled, changed } = await reconcileSidecar(
      sidecar,
      bus,
      "ws:test"
    );

    expect(changed).toBe(true);
    expect(reconciled.cards["ctx_new"]).toBeDefined();
    expect(reconciled.cards["ctx_new"].column_id).toBe("todo");
    expect(reconciled.cards["ctx_new"].title).toBe("New card");
  });

  it("rule 2: context in sidecar but not bus → remove", async () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      cards: {
        ctx_deleted: {
          column_id: "todo",
          order: 0,
          title: "Deleted card",
          created_at: new Date().toISOString(),
          checks: {},
        },
      },
    };

    const { sidecar: reconciled, changed } = await reconcileSidecar(
      sidecar,
      bus,
      "ws:test"
    );

    expect(changed).toBe(true);
    expect(reconciled.cards["ctx_deleted"]).toBeUndefined();
  });

  it("rule 3: card references unknown column → move to first column", async () => {
    bus.seedContext({
      context_id: "ctx_misplaced",
      workspace_id: "ws:test",
      scope_id: "scope:ws:test",
      created_at: new Date().toISOString(),
      first_message_preview: null,
      participants: [],
    });

    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      cards: {
        ctx_misplaced: {
          column_id: "nonexistent-column",
          order: 0,
          title: "Misplaced card",
          created_at: new Date().toISOString(),
          checks: {},
        },
      },
    };

    const { sidecar: reconciled, changed } = await reconcileSidecar(
      sidecar,
      bus,
      "ws:test"
    );

    expect(changed).toBe(true);
    expect(reconciled.cards["ctx_misplaced"].column_id).toBe("todo");
  });

  it("no changes when bus and sidecar are consistent", async () => {
    bus.seedContext({
      context_id: "ctx_ok",
      workspace_id: "ws:test",
      scope_id: "scope:ws:test",
      created_at: new Date().toISOString(),
      first_message_preview: "All good",
      participants: [],
    });

    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      cards: {
        ctx_ok: {
          column_id: "todo",
          order: 0,
          title: "All good",
          created_at: new Date().toISOString(),
          checks: {},
        },
      },
    };

    const { changed } = await reconcileSidecar(sidecar, bus, "ws:test");
    expect(changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getUncheckedCriteria
// ---------------------------------------------------------------------------

describe("getUncheckedCriteria", () => {
  const exitCriteria = [
    { id: "ec-tests", description: "Tests pass", kind: "machine" as const },
    { id: "ec-review", description: "Review done", kind: "human" as const },
  ];

  it("returns all criteria when no checks exist", () => {
    const card: SidecarCard = {
      column_id: "in-progress",
      order: 0,
      title: "Test",
      created_at: new Date().toISOString(),
      checks: {},
    };
    const unchecked = getUncheckedCriteria(card, "in-progress", exitCriteria);
    expect(unchecked).toHaveLength(2);
  });

  it("returns only unchecked criteria", () => {
    const card: SidecarCard = {
      column_id: "in-progress",
      order: 0,
      title: "Test",
      created_at: new Date().toISOString(),
      checks: {
        "in-progress": {
          "ec-tests": { checked: true, checked_at: new Date().toISOString(), checked_by: null },
        },
      },
    };
    const unchecked = getUncheckedCriteria(card, "in-progress", exitCriteria);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0].id).toBe("ec-review");
  });

  it("returns empty array when all criteria checked", () => {
    const now = new Date().toISOString();
    const card: SidecarCard = {
      column_id: "in-progress",
      order: 0,
      title: "Test",
      created_at: now,
      checks: {
        "in-progress": {
          "ec-tests": { checked: true, checked_at: now, checked_by: null },
          "ec-review": { checked: true, checked_at: now, checked_by: null },
        },
      },
    };
    const unchecked = getUncheckedCriteria(card, "in-progress", exitCriteria);
    expect(unchecked).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildBoardSnapshot
// ---------------------------------------------------------------------------

describe("buildBoardSnapshot", () => {
  it("computes correct card counts per column", () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      cards: {
        ctx_1: { column_id: "todo", order: 0, title: "Card 1", created_at: new Date().toISOString(), checks: {} },
        ctx_2: { column_id: "todo", order: 1, title: "Card 2", created_at: new Date().toISOString(), checks: {} },
        ctx_3: { column_id: "in-progress", order: 0, title: "Card 3", created_at: new Date().toISOString(), checks: {} },
      },
    };

    const snapshot = buildBoardSnapshot(sidecar);
    const todoCol = snapshot.columns.find((c) => c.id === "todo")!;
    const inProgressCol = snapshot.columns.find((c) => c.id === "in-progress")!;
    const doneCol = snapshot.columns.find((c) => c.id === "done")!;

    expect(todoCol.card_count).toBe(2);
    expect(inProgressCol.card_count).toBe(1);
    expect(doneCol.card_count).toBe(0);
  });

  it("flags WIP violations correctly", () => {
    const columns = defaultColumns();
    columns[1].wip_limit = 1; // in-progress: WIP 1

    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns,
      cards: {
        ctx_1: { column_id: "in-progress", order: 0, title: "Card 1", created_at: new Date().toISOString(), checks: {} },
        ctx_2: { column_id: "in-progress", order: 1, title: "Card 2", created_at: new Date().toISOString(), checks: {} },
      },
    };

    const snapshot = buildBoardSnapshot(sidecar);
    const inProgressCol = snapshot.columns.find((c) => c.id === "in-progress")!;
    expect(inProgressCol.wip_exceeded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderCompactBoardSnapshot
// ---------------------------------------------------------------------------

describe("renderCompactBoardSnapshot", () => {
  it("renders within character limits", () => {
    const sidecar: BoardSidecar = {
      schema: SIDECAR_SCHEMA,
      scope_id: "scope:ws:test",
      workspace_id: "ws:test",
      columns: defaultColumns(),
      cards: {
        ctx_1: { column_id: "todo", order: 0, title: "Card 1", created_at: new Date().toISOString(), checks: {} },
      },
    };
    const snapshot = buildBoardSnapshot(sidecar);
    const rendered = renderCompactBoardSnapshot(snapshot);
    expect(rendered.length).toBeLessThanOrEqual(4000);
    expect(rendered).toContain("Board:");
    expect(rendered).toContain("Card 1");
  });
});
