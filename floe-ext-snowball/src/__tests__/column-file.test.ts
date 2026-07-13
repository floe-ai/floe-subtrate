/**
 * Board-file column tests — parse/serialize, read/write, column operations.
 *
 * Slice 5 (fm/snowball-col-board-s5):
 *   Column definitions live inside board.md (board-file.ts).
 *   column-file.ts is deleted. These tests cover the column I/O
 *   functions that moved to board-file.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import {
  parseBoardFile,
  serializeBoardFile,
  writeBoardFile,
  readBoardFile,
  listColumnsFromBoard,
  readColumnFromBoard,
  writeColumnToBoard,
  updateColumnInBoard,
  updateColumnInstructions,
  deleteColumnFromBoard,
  generateColumnId,
  defaultColumnFiles,
  findBoardScopesForAgentFromFiles,
  boardFilePath,
  boardDir,
  type BoardFile,
} from "../board-file.js";
import { slugify } from "../board-file.js";
import type { ColumnFile } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeColumn(overrides: Partial<ColumnFile> = {}): ColumnFile {
  return {
    id: "todo",
    name: "To Do",
    scope_id: "scope:ws:test",
    order: 0,
    wip_limit: null,
    assigned_actors: [],
    exit_criteria: [],
    instructions: "",
    ...overrides,
  };
}

function makeBoardFile(overrides: Partial<BoardFile> = {}): BoardFile {
  return {
    scope_id: "scope:ws:test",
    done_protocol: "",
    columns: [],
    ...overrides,
  };
}

const SCOPE_ID = "scope:ws:test";
const SCOPE_SLUG = "scope_ws_test";

// ---------------------------------------------------------------------------
// parseBoardFile / serializeBoardFile — column handling
// ---------------------------------------------------------------------------

describe("parseBoardFile — columns in frontmatter", () => {
  it("parses a board file with no columns", () => {
    const raw = `---
scope_id: scope:ws:test
columns: []
---
`;
    const bf = parseBoardFile(raw);
    expect(bf).not.toBeNull();
    expect(bf!.columns).toEqual([]);
    expect(bf!.scope_id).toBe("scope:ws:test");
  });

  it("parses columns with assigned_actors", () => {
    const raw = `---
scope_id: scope:ws:test
columns:
  - id: in-progress
    name: In Progress
    order: 1
    wip_limit: 5
    assigned_actors:
      - actor_ref: snowball
        event_types:
          - "*"
    exit_criteria:
      - id: ec-tests
        description: Tests pass
        kind: machine
    instructions: ""
---
`;
    const bf = parseBoardFile(raw);
    expect(bf!.columns).toHaveLength(1);
    const col = bf!.columns[0];
    expect(col.id).toBe("in-progress");
    expect(col.scope_id).toBe("scope:ws:test"); // populated from board scope_id
    expect(col.assigned_actors).toHaveLength(1);
    expect(col.assigned_actors[0].actor_ref).toBe("snowball");
    expect(col.wip_limit).toBe(5);
    expect(col.exit_criteria[0].id).toBe("ec-tests");
  });

  it("parses column instructions from YAML string", () => {
    const raw = `---
scope_id: scope:ws:test
columns:
  - id: work
    name: Work
    order: 0
    wip_limit: null
    assigned_actors: []
    exit_criteria: []
    instructions: "Review tasks carefully."
---
`;
    const bf = parseBoardFile(raw);
    expect(bf!.columns[0].instructions).toBe("Review tasks carefully.");
  });

  it("sorts columns by order field on parse", () => {
    const raw = `---
scope_id: scope:ws:test
columns:
  - id: done
    name: Done
    order: 2
    wip_limit: null
    assigned_actors: []
    exit_criteria: []
    instructions: ""
  - id: todo
    name: To Do
    order: 0
    wip_limit: null
    assigned_actors: []
    exit_criteria: []
    instructions: ""
---
`;
    const bf = parseBoardFile(raw);
    expect(bf!.columns[0].id).toBe("todo");
    expect(bf!.columns[1].id).toBe("done");
  });

  it("returns null when frontmatter is missing", () => {
    expect(parseBoardFile("No frontmatter here")).toBeNull();
  });
});

describe("serializeBoardFile — round-trip with columns", () => {
  it("round-trips a board file with columns through serialize+parse", () => {
    const original: BoardFile = {
      scope_id: "scope:ws:test",
      done_protocol: "Do the work then advance.",
      columns: [
        {
          id: "todo", name: "To Do", scope_id: "scope:ws:test",
          order: 0, wip_limit: null, assigned_actors: [], exit_criteria: [], instructions: "",
        },
        {
          id: "work", name: "Work", scope_id: "scope:ws:test",
          order: 1, wip_limit: 3,
          assigned_actors: [{ actor_ref: "my-agent", event_types: ["*"] }],
          exit_criteria: [{ id: "ec-1", description: "Tests pass", kind: "machine" }],
          instructions: "Check the tests.",
        },
      ],
    };

    const raw = serializeBoardFile(original);
    const parsed = parseBoardFile(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.scope_id).toBe(original.scope_id);
    expect(parsed!.done_protocol).toBe(original.done_protocol);
    expect(parsed!.columns).toHaveLength(2);
    expect(parsed!.columns[0].id).toBe("todo");
    expect(parsed!.columns[1].assigned_actors[0].actor_ref).toBe("my-agent");
    expect(parsed!.columns[1].instructions).toBe("Check the tests.");
  });

  it("does NOT serialize scope_id per column (it is redundant)", () => {
    const bf: BoardFile = {
      scope_id: "scope:ws:test", done_protocol: "",
      columns: [makeColumn()],
    };
    const raw = serializeBoardFile(bf);
    // The YAML column record should not have a scope_id field
    // (it's populated from the board's scope_id at read time)
    const afterFm = raw.split("---\n")[1] ?? "";
    const colSection = afterFm.split("- id:")[1] ?? "";
    expect(colSection).not.toContain("scope_id:");
  });
});

// ---------------------------------------------------------------------------
// Read / Write / List (board-file column I/O)
// ---------------------------------------------------------------------------

describe("writeBoardFile / readBoardFile / listColumnsFromBoard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-board-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("writes and reads a board file with columns", () => {
    const bf: BoardFile = {
      scope_id: SCOPE_ID, done_protocol: "",
      columns: [makeColumn({ id: "todo", name: "To Do" })],
    };
    writeBoardFile(tmpDir, SCOPE_SLUG, bf);
    const read = readBoardFile(tmpDir, SCOPE_SLUG);
    expect(read).not.toBeNull();
    expect(read!.columns).toHaveLength(1);
    expect(read!.columns[0].name).toBe("To Do");
  });

  it("listColumnsFromBoard returns columns sorted by order", () => {
    const bf: BoardFile = {
      scope_id: SCOPE_ID, done_protocol: "",
      columns: [
        makeColumn({ id: "done", order: 2, name: "Done" }),
        makeColumn({ id: "todo", order: 0, name: "To Do" }),
        makeColumn({ id: "inprog", order: 1, name: "In Progress" }),
      ],
    };
    writeBoardFile(tmpDir, SCOPE_SLUG, bf);
    const cols = listColumnsFromBoard(tmpDir, SCOPE_SLUG);
    expect(cols[0].id).toBe("todo");
    expect(cols[1].id).toBe("inprog");
    expect(cols[2].id).toBe("done");
  });

  it("listColumnsFromBoard returns empty when board file does not exist", () => {
    const cols = listColumnsFromBoard(tmpDir, "nonexistent-slug");
    expect(cols).toHaveLength(0);
  });

  it("readColumnFromBoard returns null for nonexistent column", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({ columns: [makeColumn()] }));
    expect(readColumnFromBoard(tmpDir, SCOPE_SLUG, "nonexistent")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// writeColumnToBoard / updateColumnInBoard / updateColumnInstructions / delete
// ---------------------------------------------------------------------------

describe("writeColumnToBoard", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `snowball-wcol-test-${Date.now()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("adds a column to an existing board file", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile());
    writeColumnToBoard(tmpDir, SCOPE_SLUG, makeColumn({ id: "todo" }));
    const cols = listColumnsFromBoard(tmpDir, SCOPE_SLUG);
    expect(cols).toHaveLength(1);
    expect(cols[0].id).toBe("todo");
  });

  it("replaces existing column with same id", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({ columns: [makeColumn({ name: "Old Name" })] }));
    writeColumnToBoard(tmpDir, SCOPE_SLUG, makeColumn({ name: "New Name" }));
    const cols = listColumnsFromBoard(tmpDir, SCOPE_SLUG);
    expect(cols).toHaveLength(1);
    expect(cols[0].name).toBe("New Name");
  });

  it("creates board file with defaults if absent", () => {
    writeColumnToBoard(tmpDir, SCOPE_SLUG, makeColumn({ id: "custom", scope_id: SCOPE_ID }));
    const bf = readBoardFile(tmpDir, SCOPE_SLUG);
    expect(bf).not.toBeNull();
    expect(bf!.columns.find((c) => c.id === "custom")).toBeDefined();
  });
});

describe("updateColumnInBoard", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `snowball-ucol-test-${Date.now()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("updates name, preserving instructions", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({ columns: [makeColumn({ instructions: "Keep this." })] }));
    const updated = updateColumnInBoard(tmpDir, SCOPE_SLUG, "todo", { name: "New Name" });
    expect(updated!.name).toBe("New Name");
    expect(updated!.instructions).toBe("Keep this.");
    const onDisk = readColumnFromBoard(tmpDir, SCOPE_SLUG, "todo");
    expect(onDisk!.name).toBe("New Name");
    expect(onDisk!.instructions).toBe("Keep this.");
  });

  it("updates assigned_actors", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({ columns: [makeColumn()] }));
    const updated = updateColumnInBoard(tmpDir, SCOPE_SLUG, "todo", {
      assigned_actors: [{ actor_ref: "my-agent", event_types: ["*"] }],
    });
    expect(updated!.assigned_actors).toEqual([{ actor_ref: "my-agent", event_types: ["*"] }]);
  });

  it("returns null when column does not exist", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile());
    expect(updateColumnInBoard(tmpDir, SCOPE_SLUG, "nonexistent", { name: "X" })).toBeNull();
  });
});

describe("updateColumnInstructions", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `snowball-ucoli-test-${Date.now()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("updates instructions, preserving frontmatter", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({ columns: [makeColumn({ name: "To Do", wip_limit: 5 })] }));
    const updated = updateColumnInstructions(tmpDir, SCOPE_SLUG, "todo", "New instructions.");
    expect(updated!.instructions).toBe("New instructions.");
    expect(updated!.name).toBe("To Do");
    expect(updated!.wip_limit).toBe(5);
  });

  it("can set instructions to empty string", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({ columns: [makeColumn({ instructions: "Old." })] }));
    const updated = updateColumnInstructions(tmpDir, SCOPE_SLUG, "todo", "");
    expect(updated!.instructions).toBe("");
  });
});

describe("deleteColumnFromBoard", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `snowball-dcol-test-${Date.now()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("removes a column from the board file", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({
      columns: [makeColumn({ id: "todo" }), makeColumn({ id: "done", order: 1, name: "Done" })],
    }));
    deleteColumnFromBoard(tmpDir, SCOPE_SLUG, "todo");
    const cols = listColumnsFromBoard(tmpDir, SCOPE_SLUG);
    expect(cols).toHaveLength(1);
    expect(cols[0].id).toBe("done");
  });

  it("is a no-op when column does not exist", () => {
    writeBoardFile(tmpDir, SCOPE_SLUG, makeBoardFile({ columns: [makeColumn()] }));
    expect(() => deleteColumnFromBoard(tmpDir, SCOPE_SLUG, "nonexistent")).not.toThrow();
    expect(listColumnsFromBoard(tmpDir, SCOPE_SLUG)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// generateColumnId / defaultColumnFiles
// ---------------------------------------------------------------------------

describe("generateColumnId", () => {
  it("generates unique col- prefixed ids", () => {
    const id1 = generateColumnId();
    const id2 = generateColumnId();
    expect(id1).toMatch(/^col-/);
    expect(id2).toMatch(/^col-/);
    expect(id1).not.toBe(id2);
  });
});

describe("defaultColumnFiles", () => {
  it("returns 3 default columns with no assigned actors", () => {
    const cols = defaultColumnFiles(SCOPE_ID);
    expect(cols).toHaveLength(3);
    expect(cols[0].id).toBe("todo");
    expect(cols[1].id).toBe("in-progress");
    expect(cols[2].id).toBe("done");
    for (const col of cols) {
      expect(col.scope_id).toBe(SCOPE_ID);
      expect(col.assigned_actors).toEqual([]);
      expect(col.instructions).toBe("");
    }
  });

  it("in-progress has wip_limit=5", () => {
    expect(defaultColumnFiles(SCOPE_ID)[1].wip_limit).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// findBoardScopesForAgentFromFiles (now in board-file.ts)
// ---------------------------------------------------------------------------

describe("findBoardScopesForAgentFromFiles", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = join(tmpdir(), `snowball-disc-test-${Date.now()}`); mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("returns empty when boards/ directory does not exist", () => {
    expect(findBoardScopesForAgentFromFiles(tmpDir, "my-agent", "snowball")).toHaveLength(0);
  });

  it("returns all boards for snowball steward agent", () => {
    writeBoardFile(tmpDir, "scope_ws_board1", { scope_id: "scope:ws:board1", done_protocol: "", columns: [makeColumn({ scope_id: "scope:ws:board1" })] });
    writeBoardFile(tmpDir, "scope_ws_board2", { scope_id: "scope:ws:board2", done_protocol: "", columns: [makeColumn({ scope_id: "scope:ws:board2" })] });
    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "snowball", "snowball");
    expect(scopes).toHaveLength(2);
    expect(scopes).toContain("scope:ws:board1");
    expect(scopes).toContain("scope:ws:board2");
  });

  it("returns only boards where non-snowball agent has an assigned_actors entry", () => {
    writeBoardFile(tmpDir, "scope_ws_board1", {
      scope_id: "scope:ws:board1", done_protocol: "",
      columns: [
        makeColumn({ id: "todo", scope_id: "scope:ws:board1" }),
        makeColumn({ id: "work", scope_id: "scope:ws:board1", order: 1, assigned_actors: [{ actor_ref: "my-worker", event_types: ["*"] }] }),
      ],
    });
    writeBoardFile(tmpDir, "scope_ws_board2", {
      scope_id: "scope:ws:board2", done_protocol: "",
      columns: [makeColumn({ scope_id: "scope:ws:board2" })],
    });
    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "my-worker", "snowball");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toBe("scope:ws:board1");
  });

  it("returns empty when agent not in any board", () => {
    writeBoardFile(tmpDir, "scope_ws_board1", {
      scope_id: "scope:ws:board1", done_protocol: "", columns: [],
    });
    expect(findBoardScopesForAgentFromFiles(tmpDir, "unknown-agent", "snowball")).toHaveLength(0);
  });
});
