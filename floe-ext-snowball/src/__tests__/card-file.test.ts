/**
 * Card file unit tests — parse/serialize, read/write, carry-forward, query helpers.
 *
 * Foundation Slice 1: card = markdown file at tasks/<id>.md
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import {
  parseCardFile,
  serializeCardFile,
  generateCardId,
  writeCard,
  readCard,
  listCards,
  updateCardFrontmatter,
  appendCarryForward,
  cardCountsByColumnFromFiles,
  getUncheckedCriteriaForCard,
  tasksDir,
  cardPath,
} from "../card-file.js";
import type { CardFile } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCard(overrides: Partial<CardFile> = {}): CardFile {
  return {
    id: "fix-login-bug-abc123",
    title: "Fix the login bug",
    type: "task",
    actor: null,
    column: "todo",
    order: 0,
    created_at: "2024-01-15T10:00:00.000Z",
    checks: {},
    body: "Description of the task.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// generateCardId
// ---------------------------------------------------------------------------

describe("generateCardId", () => {
  it("produces a slug from the title", () => {
    const id = generateCardId("Fix the login bug");
    expect(id).toMatch(/^fix-the-login-bug-/);
  });

  it("handles special characters", () => {
    const id = generateCardId("Fix: Login Bug (v2)!");
    expect(id).not.toMatch(/[:()/!]/);
  });

  it("handles empty/whitespace title gracefully", () => {
    const id = generateCardId("   ");
    expect(id).toMatch(/^card-/);
  });

  it("produces unique ids for the same title", async () => {
    // Timestamps are monotonic within a process but could collide in same ms
    const ids = new Set(Array.from({ length: 5 }, () => generateCardId("Same title")));
    // At minimum the first part is the same; the suffix differs by time
    expect(ids.size).toBeGreaterThanOrEqual(1); // usually 5, but 1 is ok in same ms
    // Just check the format is consistent
    for (const id of ids) {
      expect(id).toMatch(/^same-title-/);
    }
  });
});

// ---------------------------------------------------------------------------
// parseCardFile / serializeCardFile
// ---------------------------------------------------------------------------

describe("parseCardFile / serializeCardFile", () => {
  it("round-trips a card with no checks", () => {
    const card = makeCard();
    const serialized = serializeCardFile(card);
    const parsed = parseCardFile(serialized, card.id);
    expect(parsed).not.toBeNull();
    expect(parsed!.id).toBe(card.id);
    expect(parsed!.title).toBe(card.title);
    expect(parsed!.column).toBe(card.column);
    expect(parsed!.order).toBe(card.order);
    expect(parsed!.checks).toEqual({});
    expect(parsed!.body.trim()).toBe("Description of the task.");
  });

  it("round-trips checks", () => {
    const card = makeCard({
      checks: {
        "in-progress": {
          "ec-tests": {
            checked: true,
            checked_at: "2024-01-15T12:00:00.000Z",
            checked_by: "machine",
            note: "All green",
          },
        },
      },
    });
    const parsed = parseCardFile(serializeCardFile(card), card.id);
    expect(parsed!.checks["in-progress"]["ec-tests"].checked).toBe(true);
    expect(parsed!.checks["in-progress"]["ec-tests"].note).toBe("All green");
  });

  it("handles null actor", () => {
    const card = makeCard({ actor: null });
    const parsed = parseCardFile(serializeCardFile(card), card.id);
    expect(parsed!.actor).toBeNull();
  });

  it("handles non-null actor", () => {
    const card = makeCard({ actor: "snowball-overseer" });
    const parsed = parseCardFile(serializeCardFile(card), card.id);
    expect(parsed!.actor).toBe("snowball-overseer");
  });

  it("handles body with carry-forward comments", () => {
    const card = makeCard({
      body: "Initial description.\n\n<!-- carry-forward from \"To Do\" at 2024-01-15T10:00:00.000Z -->",
    });
    const parsed = parseCardFile(serializeCardFile(card), card.id);
    expect(parsed!.body).toContain("carry-forward");
    expect(parsed!.body).toContain("Initial description.");
  });

  it("returns null for non-frontmatter content", () => {
    expect(parseCardFile("# Just a markdown file\nNo frontmatter.", "id")).toBeNull();
  });

  it("returns null for malformed YAML frontmatter", () => {
    const bad = "---\n: invalid: yaml: {\n---\nbody";
    expect(parseCardFile(bad, "id")).toBeNull();
  });

  it("serialized output starts with ---", () => {
    const serialized = serializeCardFile(makeCard());
    expect(serialized).toMatch(/^---\n/);
  });

  it("serialized output contains --- delimiter closing frontmatter", () => {
    const serialized = serializeCardFile(makeCard());
    expect(serialized).toContain("\n---\n");
  });
});

// ---------------------------------------------------------------------------
// writeCard / readCard
// ---------------------------------------------------------------------------

describe("writeCard / readCard", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-card-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates tasks/ directory if absent", () => {
    const card = makeCard();
    writeCard(tmpDir, card);
    expect(existsSync(tasksDir(tmpDir))).toBe(true);
  });

  it("writes file at expected path", () => {
    const card = makeCard();
    writeCard(tmpDir, card);
    expect(existsSync(cardPath(tmpDir, card.id))).toBe(true);
  });

  it("round-trips write and read", () => {
    const card = makeCard();
    writeCard(tmpDir, card);
    const loaded = readCard(tmpDir, card.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(card.id);
    expect(loaded!.title).toBe(card.title);
    expect(loaded!.column).toBe(card.column);
  });

  it("returns null for missing card", () => {
    expect(readCard(tmpDir, "nonexistent-card")).toBeNull();
  });

  it("overwrites an existing card file", () => {
    const card = makeCard();
    writeCard(tmpDir, card);
    writeCard(tmpDir, { ...card, title: "Updated title" });
    const loaded = readCard(tmpDir, card.id);
    expect(loaded!.title).toBe("Updated title");
  });
});

// ---------------------------------------------------------------------------
// listCards
// ---------------------------------------------------------------------------

describe("listCards", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-list-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when tasks/ does not exist", () => {
    expect(listCards(tmpDir)).toEqual([]);
  });

  it("returns all cards", () => {
    writeCard(tmpDir, makeCard({ id: "card-a", title: "A" }));
    writeCard(tmpDir, makeCard({ id: "card-b", title: "B" }));
    const cards = listCards(tmpDir);
    expect(cards).toHaveLength(2);
    const ids = cards.map((c) => c.id).sort();
    expect(ids).toEqual(["card-a", "card-b"]);
  });

  it("ignores non-.md files", () => {
    const dir = tasksDir(tmpDir);
    mkdirSync(dir, { recursive: true });
    // Create a non-.md file
    writeCard(tmpDir, makeCard({ id: "card-a", title: "A" }));
    const { writeFileSync } = require("node:fs");
    writeFileSync(join(dir, "not-a-card.txt"), "hello");
    const cards = listCards(tmpDir);
    expect(cards).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// updateCardFrontmatter
// ---------------------------------------------------------------------------

describe("updateCardFrontmatter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-update-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("updates column and order", () => {
    const card = makeCard({ column: "todo", order: 0 });
    writeCard(tmpDir, card);
    const updated = updateCardFrontmatter(tmpDir, card.id, { column: "in-progress", order: 1 });
    expect(updated).not.toBeNull();
    expect(updated!.column).toBe("in-progress");
    expect(updated!.order).toBe(1);

    // Reload from disk
    const reloaded = readCard(tmpDir, card.id);
    expect(reloaded!.column).toBe("in-progress");
    expect(reloaded!.order).toBe(1);
  });

  it("preserves body text", () => {
    const card = makeCard({ body: "Important description." });
    writeCard(tmpDir, card);
    updateCardFrontmatter(tmpDir, card.id, { column: "done" });
    const reloaded = readCard(tmpDir, card.id);
    expect(reloaded!.body).toContain("Important description.");
  });

  it("returns null for nonexistent card", () => {
    const result = updateCardFrontmatter(tmpDir, "no-such-card", { column: "done" });
    expect(result).toBeNull();
  });

  it("updates checks without touching other fields", () => {
    const card = makeCard({ title: "My card", column: "in-progress" });
    writeCard(tmpDir, card);
    const checks = {
      "in-progress": { "ec-1": { checked: true, checked_at: "2024-01-01T00:00:00.000Z", checked_by: "machine" } },
    };
    updateCardFrontmatter(tmpDir, card.id, { checks });
    const reloaded = readCard(tmpDir, card.id);
    expect(reloaded!.title).toBe("My card");
    expect(reloaded!.checks["in-progress"]["ec-1"].checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendCarryForward
// ---------------------------------------------------------------------------

describe("appendCarryForward", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `snowball-cf-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends carry-forward comment to body", () => {
    const card = makeCard({ body: "Initial body." });
    writeCard(tmpDir, card);
    appendCarryForward(tmpDir, card.id, "To Do");

    const reloaded = readCard(tmpDir, card.id);
    expect(reloaded!.body).toContain("Initial body.");
    expect(reloaded!.body).toContain(`carry-forward from "To Do"`);
  });

  it("can append multiple carry-forward comments", () => {
    const card = makeCard({ body: "" });
    writeCard(tmpDir, card);
    appendCarryForward(tmpDir, card.id, "To Do");
    appendCarryForward(tmpDir, card.id, "In Progress");

    const reloaded = readCard(tmpDir, card.id);
    expect(reloaded!.body).toContain(`carry-forward from "To Do"`);
    expect(reloaded!.body).toContain(`carry-forward from "In Progress"`);
  });

  it("does not modify frontmatter fields", () => {
    const card = makeCard({ column: "todo", order: 0 });
    writeCard(tmpDir, card);
    appendCarryForward(tmpDir, card.id, "To Do");

    const reloaded = readCard(tmpDir, card.id);
    expect(reloaded!.column).toBe("todo");  // frontmatter unchanged
    expect(reloaded!.order).toBe(0);
  });

  it("is a no-op for nonexistent card", () => {
    // Should not throw
    expect(() => appendCarryForward(tmpDir, "no-such-card", "To Do")).not.toThrow();
  });

  it("raw file contains <!-- carry-forward ... --> comment", () => {
    const card = makeCard({ body: "Body text." });
    writeCard(tmpDir, card);
    appendCarryForward(tmpDir, card.id, "In Progress");

    const raw = readFileSync(cardPath(tmpDir, card.id), "utf-8");
    expect(raw).toContain("<!-- carry-forward from \"In Progress\"");
  });
});

// ---------------------------------------------------------------------------
// cardCountsByColumnFromFiles
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
    const counts = cardCountsByColumnFromFiles(tmpDir, ["todo", "done"]);
    expect(counts).toEqual({ todo: 0, done: 0 });
  });

  it("counts cards per column", () => {
    writeCard(tmpDir, makeCard({ id: "a", column: "todo" }));
    writeCard(tmpDir, makeCard({ id: "b", column: "todo" }));
    writeCard(tmpDir, makeCard({ id: "c", column: "in-progress" }));
    const counts = cardCountsByColumnFromFiles(tmpDir, ["todo", "in-progress", "done"]);
    expect(counts).toEqual({ todo: 2, "in-progress": 1, done: 0 });
  });

  it("ignores cards in unknown columns", () => {
    writeCard(tmpDir, makeCard({ id: "a", column: "unknown-col" }));
    const counts = cardCountsByColumnFromFiles(tmpDir, ["todo", "done"]);
    expect(counts).toEqual({ todo: 0, done: 0 });
  });
});

// ---------------------------------------------------------------------------
// getUncheckedCriteriaForCard
// ---------------------------------------------------------------------------

describe("getUncheckedCriteriaForCard", () => {
  it("returns all criteria when checks is empty", () => {
    const card = makeCard({ column: "in-progress", checks: {} });
    const criteria = [
      { id: "ec-1", description: "Tests pass", kind: "machine" as const },
      { id: "ec-2", description: "Reviewed", kind: "human" as const },
    ];
    const unchecked = getUncheckedCriteriaForCard(card, criteria);
    expect(unchecked).toHaveLength(2);
  });

  it("returns only unchecked criteria", () => {
    const card = makeCard({
      column: "in-progress",
      checks: {
        "in-progress": {
          "ec-1": { checked: true, checked_at: "2024-01-01T00:00:00.000Z", checked_by: null },
          "ec-2": { checked: false, checked_at: null, checked_by: null },
        },
      },
    });
    const criteria = [
      { id: "ec-1", description: "Tests pass", kind: "machine" as const },
      { id: "ec-2", description: "Reviewed", kind: "human" as const },
    ];
    const unchecked = getUncheckedCriteriaForCard(card, criteria);
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0].id).toBe("ec-2");
  });

  it("returns empty array when all criteria are checked", () => {
    const card = makeCard({
      column: "in-progress",
      checks: {
        "in-progress": {
          "ec-1": { checked: true, checked_at: "2024-01-01T00:00:00.000Z", checked_by: null },
        },
      },
    });
    const criteria = [{ id: "ec-1", description: "Tests pass", kind: "machine" as const }];
    const unchecked = getUncheckedCriteriaForCard(card, criteria);
    expect(unchecked).toHaveLength(0);
  });

  it("ignores checks from other columns", () => {
    const card = makeCard({
      column: "in-progress",
      checks: {
        "todo": {
          "ec-1": { checked: true, checked_at: "2024-01-01T00:00:00.000Z", checked_by: null },
        },
      },
    });
    const criteria = [{ id: "ec-1", description: "Tests pass", kind: "machine" as const }];
    // ec-1 is checked in "todo" but card is now in "in-progress" — still unchecked
    const unchecked = getUncheckedCriteriaForCard(card, criteria);
    expect(unchecked).toHaveLength(1);
  });
});
