/**
 * Column file unit tests — parse/serialize, read/write, update, discovery.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   Column definitions are committed markdown files at:
 *   boards/<scopeSlug>/columns/<id>.md
 *
 *   Invariants:
 *   - Frontmatter is the source of truth for column config (name, owner, etc.)
 *   - Body is the agent instructions (may be empty)
 *   - updateColumnFileFrontmatter preserves instructions body
 *   - updateColumnFileInstructions preserves frontmatter
 *   - findBoardScopesForAgentFromFiles scans committed column files (not sidecar)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import {
  parseColumnFile,
  serializeColumnFile,
  writeColumnFile,
  readColumnFile,
  listColumnFiles,
  updateColumnFileFrontmatter,
  updateColumnFileInstructions,
  deleteColumnFile,
  generateColumnId,
  defaultColumnFiles,
  findBoardScopesForAgentFromFiles,
  boardColumnsDir,
  columnFilePath,
  type ColumnFile,
} from "../column-file.js";

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
    owner: { kind: "human" },
    exit_criteria: [],
    instructions: "",
    ...overrides,
  };
}

const SCOPE_ID = "scope:ws:test";
const SCOPE_SLUG = "scope_ws_test";

// ---------------------------------------------------------------------------
// parseColumnFile / serializeColumnFile
// ---------------------------------------------------------------------------

describe("parseColumnFile", () => {
  it("parses a minimal column file", () => {
    const raw = `---
id: todo
name: To Do
scope_id: scope:ws:test
order: 0
wip_limit: null
owner:
  kind: human
exit_criteria: []
---
`;
    const col = parseColumnFile(raw, "todo");
    expect(col).not.toBeNull();
    expect(col!.id).toBe("todo");
    expect(col!.name).toBe("To Do");
    expect(col!.scope_id).toBe("scope:ws:test");
    expect(col!.order).toBe(0);
    expect(col!.wip_limit).toBeNull();
    expect(col!.owner).toEqual({ kind: "human" });
    expect(col!.exit_criteria).toEqual([]);
    expect(col!.instructions).toBe("");
  });

  it("parses instructions from the body", () => {
    const raw = `---
id: todo
name: To Do
scope_id: scope:ws:test
order: 0
wip_limit: null
owner:
  kind: human
exit_criteria: []
---

Review all tasks before marking them complete.
Check that PR is linked.
`;
    const col = parseColumnFile(raw, "todo");
    expect(col!.instructions).toContain("Review all tasks");
    expect(col!.instructions).toContain("Check that PR is linked.");
  });

  it("parses agent owner", () => {
    const raw = `---
id: in-progress
name: In Progress
scope_id: scope:ws:test
order: 1
wip_limit: 5
owner:
  kind: agent
  agent_id: snowball-overseer
exit_criteria:
  - id: ec-tests
    description: Tests pass
    kind: machine
---
`;
    const col = parseColumnFile(raw, "in-progress");
    expect(col!.owner).toEqual({ kind: "agent", agent_id: "snowball-overseer" });
    expect(col!.wip_limit).toBe(5);
    expect(col!.exit_criteria).toHaveLength(1);
    expect(col!.exit_criteria[0].id).toBe("ec-tests");
  });

  it("returns null when frontmatter is missing", () => {
    const col = parseColumnFile("No frontmatter here", "todo");
    expect(col).toBeNull();
  });

  it("returns null when frontmatter is unclosed", () => {
    const col = parseColumnFile("---\nid: todo\nname: To Do\n", "todo");
    expect(col).toBeNull();
  });

  it("falls back to columnId when id is missing in frontmatter", () => {
    const raw = `---
name: Fallback
scope_id: scope:ws:test
order: 0
wip_limit: null
owner:
  kind: human
exit_criteria: []
---
`;
    const col = parseColumnFile(raw, "fallback-id");
    expect(col!.id).toBe("fallback-id");
  });
});

describe("serializeColumnFile", () => {
  it("round-trips through serialize and parse", () => {
    const original: ColumnFile = {
      id: "in-progress",
      name: "In Progress",
      scope_id: "scope:ws:test",
      order: 1,
      wip_limit: 5,
      owner: { kind: "agent", agent_id: "my-worker" },
      exit_criteria: [
        { id: "ec-1", description: "Tests pass", kind: "machine" },
      ],
      instructions: "Do this when a card arrives.",
    };

    const raw = serializeColumnFile(original);
    const parsed = parseColumnFile(raw, original.id);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(original.id);
    expect(parsed!.name).toBe(original.name);
    expect(parsed!.scope_id).toBe(original.scope_id);
    expect(parsed!.order).toBe(original.order);
    expect(parsed!.wip_limit).toBe(original.wip_limit);
    expect(parsed!.owner).toEqual(original.owner);
    expect(parsed!.exit_criteria).toHaveLength(1);
    expect(parsed!.instructions).toContain("Do this when a card arrives.");
  });

  it("serializes empty instructions as empty body", () => {
    const col = makeColumn({ instructions: "" });
    const raw = serializeColumnFile(col);
    expect(raw).toMatch(/^---\n/);
    expect(raw).toContain("---\n");
    // Body should be empty (no instructions)
    const afterFm = raw.split("---\n").slice(2).join("---\n");
    expect(afterFm.trim()).toBe("");
  });

  it("serializes non-empty instructions as body", () => {
    const col = makeColumn({ instructions: "My instructions." });
    const raw = serializeColumnFile(col);
    expect(raw).toContain("My instructions.");
  });
});

// ---------------------------------------------------------------------------
// Read / Write / List
// ---------------------------------------------------------------------------

describe("writeColumnFile / readColumnFile / listColumnFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-colfile-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a column file and reads it back", () => {
    const col = makeColumn({ id: "todo", name: "To Do" });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const path = columnFilePath(tmpDir, SCOPE_SLUG, "todo");
    expect(existsSync(path)).toBe(true);

    const read = readColumnFile(tmpDir, SCOPE_SLUG, "todo");
    expect(read).not.toBeNull();
    expect(read!.name).toBe("To Do");
  });

  it("creates directories as needed", () => {
    const col = makeColumn({ id: "todo" });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const dir = boardColumnsDir(tmpDir, SCOPE_SLUG);
    expect(existsSync(dir)).toBe(true);
  });

  it("writes instructions to the file body", () => {
    const col = makeColumn({ id: "todo", instructions: "My agent instructions." });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const raw = readFileSync(columnFilePath(tmpDir, SCOPE_SLUG, "todo"), "utf-8");
    expect(raw).toContain("My agent instructions.");
  });

  it("listColumnFiles returns columns sorted by order", () => {
    writeColumnFile(tmpDir, SCOPE_SLUG, makeColumn({ id: "done", order: 2, name: "Done" }));
    writeColumnFile(tmpDir, SCOPE_SLUG, makeColumn({ id: "todo", order: 0, name: "To Do" }));
    writeColumnFile(tmpDir, SCOPE_SLUG, makeColumn({ id: "in-progress", order: 1, name: "In Progress" }));

    const cols = listColumnFiles(tmpDir, SCOPE_SLUG);
    expect(cols).toHaveLength(3);
    expect(cols[0].id).toBe("todo");
    expect(cols[1].id).toBe("in-progress");
    expect(cols[2].id).toBe("done");
  });

  it("listColumnFiles returns empty when directory does not exist", () => {
    const cols = listColumnFiles(tmpDir, "nonexistent-slug");
    expect(cols).toHaveLength(0);
  });

  it("readColumnFile returns null for nonexistent file", () => {
    const col = readColumnFile(tmpDir, SCOPE_SLUG, "nonexistent");
    expect(col).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Update operations
// ---------------------------------------------------------------------------

describe("updateColumnFileFrontmatter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-colupdate-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates name, preserving instructions", () => {
    const col = makeColumn({ id: "todo", name: "Old Name", instructions: "Keep this." });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const updated = updateColumnFileFrontmatter(tmpDir, SCOPE_SLUG, "todo", { name: "New Name" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New Name");
    expect(updated!.instructions).toBe("Keep this.");

    const onDisk = readColumnFile(tmpDir, SCOPE_SLUG, "todo");
    expect(onDisk!.name).toBe("New Name");
    expect(onDisk!.instructions).toBe("Keep this.");
  });

  it("updates wip_limit", () => {
    const col = makeColumn({ id: "todo", wip_limit: null });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const updated = updateColumnFileFrontmatter(tmpDir, SCOPE_SLUG, "todo", { wip_limit: 3 });
    expect(updated!.wip_limit).toBe(3);
  });

  it("updates exit_criteria", () => {
    const col = makeColumn({ id: "todo", exit_criteria: [] });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const newCriteria = [{ id: "ec-1", description: "Tests pass", kind: "machine" as const }];
    const updated = updateColumnFileFrontmatter(tmpDir, SCOPE_SLUG, "todo", { exit_criteria: newCriteria });
    expect(updated!.exit_criteria).toHaveLength(1);
  });

  it("updates owner", () => {
    const col = makeColumn({ id: "todo", owner: { kind: "human" } });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const updated = updateColumnFileFrontmatter(tmpDir, SCOPE_SLUG, "todo", {
      owner: { kind: "agent", agent_id: "my-agent" },
    });
    expect(updated!.owner).toEqual({ kind: "agent", agent_id: "my-agent" });
  });

  it("returns null when column file does not exist", () => {
    const result = updateColumnFileFrontmatter(tmpDir, SCOPE_SLUG, "nonexistent", { name: "X" });
    expect(result).toBeNull();
  });
});

describe("updateColumnFileInstructions", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-colinstr-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates instructions, preserving frontmatter", () => {
    const col = makeColumn({ id: "todo", name: "To Do", wip_limit: 5, instructions: "Old instructions." });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const updated = updateColumnFileInstructions(tmpDir, SCOPE_SLUG, "todo", "New instructions.");
    expect(updated!.instructions).toBe("New instructions.");
    expect(updated!.name).toBe("To Do");
    expect(updated!.wip_limit).toBe(5);

    const onDisk = readColumnFile(tmpDir, SCOPE_SLUG, "todo");
    expect(onDisk!.instructions).toBe("New instructions.");
    expect(onDisk!.name).toBe("To Do");
  });

  it("can set instructions to empty string", () => {
    const col = makeColumn({ id: "todo", instructions: "Old instructions." });
    writeColumnFile(tmpDir, SCOPE_SLUG, col);

    const updated = updateColumnFileInstructions(tmpDir, SCOPE_SLUG, "todo", "");
    expect(updated!.instructions).toBe("");
  });

  it("returns null when column file does not exist", () => {
    const result = updateColumnFileInstructions(tmpDir, SCOPE_SLUG, "nonexistent", "Test");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("deleteColumnFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-coldel-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("deletes an existing column file", () => {
    writeColumnFile(tmpDir, SCOPE_SLUG, makeColumn({ id: "todo" }));
    expect(existsSync(columnFilePath(tmpDir, SCOPE_SLUG, "todo"))).toBe(true);

    deleteColumnFile(tmpDir, SCOPE_SLUG, "todo");
    expect(existsSync(columnFilePath(tmpDir, SCOPE_SLUG, "todo"))).toBe(false);
  });

  it("is a no-op when file does not exist", () => {
    // Should not throw
    expect(() => deleteColumnFile(tmpDir, SCOPE_SLUG, "nonexistent")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// generateColumnId / defaultColumnFiles
// ---------------------------------------------------------------------------

describe("generateColumnId", () => {
  it("generates a unique-looking string", () => {
    const id1 = generateColumnId();
    const id2 = generateColumnId();
    expect(id1).toMatch(/^col-/);
    expect(id2).toMatch(/^col-/);
    // IDs should be different (timestamps differ)
    expect(id1).not.toBe(id2);
  });
});

describe("defaultColumnFiles", () => {
  it("returns 3 default columns with scope_id set", () => {
    const cols = defaultColumnFiles(SCOPE_ID);
    expect(cols).toHaveLength(3);
    expect(cols[0].id).toBe("todo");
    expect(cols[1].id).toBe("in-progress");
    expect(cols[2].id).toBe("done");
    for (const col of cols) {
      expect(col.scope_id).toBe(SCOPE_ID);
      expect(col.instructions).toBe("");
    }
  });

  it("in-progress has wip_limit=5", () => {
    const cols = defaultColumnFiles(SCOPE_ID);
    expect(cols[1].wip_limit).toBe(5);
  });

  it("todo and done have null wip_limit", () => {
    const cols = defaultColumnFiles(SCOPE_ID);
    expect(cols[0].wip_limit).toBeNull();
    expect(cols[2].wip_limit).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findBoardScopesForAgentFromFiles
// ---------------------------------------------------------------------------

describe("findBoardScopesForAgentFromFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-discovery-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty when boards/ directory does not exist", () => {
    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "my-agent", "snowball-overseer");
    expect(scopes).toHaveLength(0);
  });

  it("returns all boards for overseer agent", () => {
    // Write two separate boards
    const slug1 = "scope_ws_board1";
    const slug2 = "scope_ws_board2";
    writeColumnFile(tmpDir, slug1, makeColumn({ id: "todo", scope_id: "scope:ws:board1" }));
    writeColumnFile(tmpDir, slug2, makeColumn({ id: "todo", scope_id: "scope:ws:board2" }));

    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "snowball-overseer", "snowball-overseer");
    expect(scopes).toHaveLength(2);
    expect(scopes).toContain("scope:ws:board1");
    expect(scopes).toContain("scope:ws:board2");
  });

  it("returns only boards where non-overseer agent owns a column", () => {
    const slug = "scope_ws_board1";
    const cols: ColumnFile[] = [
      makeColumn({ id: "todo", scope_id: "scope:ws:board1", owner: { kind: "human" } }),
      makeColumn({ id: "work", scope_id: "scope:ws:board1", order: 1, owner: { kind: "agent", agent_id: "my-worker" } }),
    ];
    for (const col of cols) writeColumnFile(tmpDir, slug, col);

    // Board 2 — my-worker does NOT own any column
    const slug2 = "scope_ws_board2";
    writeColumnFile(tmpDir, slug2, makeColumn({ id: "todo", scope_id: "scope:ws:board2", owner: { kind: "human" } }));

    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "my-worker", "snowball-overseer");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toBe("scope:ws:board1");
  });

  it("returns empty when agent does not own any column", () => {
    const slug = "scope_ws_board1";
    writeColumnFile(tmpDir, slug, makeColumn({ id: "todo", scope_id: "scope:ws:board1", owner: { kind: "human" } }));

    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "unknown-agent", "snowball-overseer");
    expect(scopes).toHaveLength(0);
  });

  it("handles boards directory with no column subdirectories", () => {
    // Create .floe/extensions/snowball/boards/ with an empty subdirectory (no columns/ inside)
    mkdirSync(join(tmpDir, ".floe", "extensions", "snowball", "boards", "empty-slug"), { recursive: true });

    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "snowball-overseer", "snowball-overseer");
    expect(scopes).toHaveLength(0);
  });

  it("extracts scope_id from column file frontmatter", () => {
    const slug = "scope_ws_my-project";
    writeColumnFile(tmpDir, slug, makeColumn({
      id: "todo",
      scope_id: "scope:ws:my-project",
    }));

    const scopes = findBoardScopesForAgentFromFiles(tmpDir, "snowball-overseer", "snowball-overseer");
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toBe("scope:ws:my-project");
  });
});
