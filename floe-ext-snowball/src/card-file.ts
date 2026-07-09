/**
 * Card file — read/write module for Snowball card markdown files.
 *
 * Cards live at {workspacePath}/tasks/<id>.md
 *
 * Format:
 * ```
 * ---
 * id: "card-abc123"
 * title: "Fix the login bug"
 * type: "task"
 * actor: null
 * column: "todo"
 * order: 0
 * created_at: "2024-01-15T10:00:00.000Z"
 * checks: {}
 * ---
 *
 * Description body text.
 *
 * <!-- carry-forward from "In Progress" at 2024-01-15T12:00:00.000Z -->
 * ```
 *
 * Invariants (D1):
 *  - The card file NEVER moves between directories.
 *  - The `column` field in frontmatter is updated in-place on move.
 *  - The `id` field is the stable card identity — matches the filename (without .md).
 *  - Carry-forward comments are APPENDED to the body on each column move.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { CardFile, CriterionCheckState } from "./types.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path to the tasks directory in the workspace. */
export function tasksDir(workspacePath: string): string {
  return join(workspacePath, "tasks");
}

/** Absolute path to a card file. */
export function cardPath(workspacePath: string, cardId: string): string {
  return join(tasksDir(workspacePath), `${cardId}.md`);
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable, human-readable card id from a title + timestamp.
 * Example: "Fix the login bug" → "fix-the-login-bug-lz0vb8"
 *
 * Guaranteed unique within the lifetime of a process (monotonic timestamp).
 */
export function generateCardId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Date.now().toString(36);
  return `${slug || "card"}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIMITER = "---";

/**
 * Parse a card markdown file into a CardFile object.
 * Returns null if the file cannot be parsed.
 */
export function parseCardFile(raw: string, id: string): CardFile | null {
  // Split frontmatter from body
  if (!raw.startsWith(FRONTMATTER_DELIMITER)) return null;
  const afterFirst = raw.slice(FRONTMATTER_DELIMITER.length);
  const endIdx = afterFirst.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (endIdx === -1) return null;

  const yamlStr = afterFirst.slice(0, endIdx);
  const body = afterFirst.slice(endIdx + FRONTMATTER_DELIMITER.length + 1).trimStart();

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(yamlStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!fm || typeof fm !== "object") return null;

  return {
    id: (fm["id"] as string | undefined) ?? id,
    title: (fm["title"] as string | undefined) ?? id,
    type: (fm["type"] as string | undefined) ?? "task",
    actor: (fm["actor"] as string | null | undefined) ?? null,
    column: (fm["column"] as string | undefined) ?? "",
    order: typeof fm["order"] === "number" ? fm["order"] : 0,
    created_at: (fm["created_at"] as string | undefined) ?? new Date().toISOString(),
    checks: (fm["checks"] as Record<string, Record<string, CriterionCheckState>> | undefined) ?? {},
    body,
  };
}

/**
 * Serialize a CardFile to markdown string.
 */
export function serializeCardFile(card: CardFile): string {
  const fm: Record<string, unknown> = {
    id: card.id,
    title: card.title,
    type: card.type,
    actor: card.actor,
    column: card.column,
    order: card.order,
    created_at: card.created_at,
    checks: card.checks,
  };
  const yamlStr = stringifyYaml(fm).trimEnd();
  const body = card.body ? `\n${card.body}` : "";
  return `---\n${yamlStr}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Read / Write / List
// ---------------------------------------------------------------------------

/**
 * Write a card file to disk. Creates tasks/ directory if needed.
 */
export function writeCard(workspacePath: string, card: CardFile): void {
  const dir = tasksDir(workspacePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cardPath(workspacePath, card.id), serializeCardFile(card), "utf-8");
}

/**
 * Read a card file by id. Returns null if not found or unparseable.
 */
export function readCard(workspacePath: string, cardId: string): CardFile | null {
  const path = cardPath(workspacePath, cardId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return parseCardFile(raw, cardId);
  } catch {
    return null;
  }
}

/**
 * List all card files in the tasks/ directory.
 * Returns an empty array if the directory does not exist.
 */
export function listCards(workspacePath: string): CardFile[] {
  const dir = tasksDir(workspacePath);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const cards: CardFile[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const id = file.slice(0, -3);
    const card = readCard(workspacePath, id);
    if (card) cards.push(card);
  }
  return cards;
}

/**
 * Update frontmatter fields of an existing card file.
 * The body is preserved unchanged; only the specified fields are overwritten.
 * Returns the updated CardFile, or null if the card does not exist.
 */
export function updateCardFrontmatter(
  workspacePath: string,
  cardId: string,
  updates: Partial<Omit<CardFile, "body">>
): CardFile | null {
  const existing = readCard(workspacePath, cardId);
  if (!existing) return null;
  const updated: CardFile = { ...existing, ...updates };
  writeCard(workspacePath, updated);
  return updated;
}

/**
 * Append a carry-forward comment to a card file body.
 * Called when a card moves from one column to another.
 *
 * Format: `<!-- carry-forward from "<fromColumnName>" at <ISO timestamp> -->`
 */
export function appendCarryForward(
  workspacePath: string,
  cardId: string,
  fromColumnName: string
): void {
  const existing = readCard(workspacePath, cardId);
  if (!existing) return;
  const timestamp = new Date().toISOString();
  const comment = `\n<!-- carry-forward from "${fromColumnName}" at ${timestamp} -->`;
  const updated: CardFile = {
    ...existing,
    body: existing.body + comment,
  };
  writeCard(workspacePath, updated);
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Count cards per column from the tasks/ directory.
 */
export function cardCountsByColumnFromFiles(
  workspacePath: string,
  columnIds: string[]
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const id of columnIds) counts[id] = 0;

  const cards = listCards(workspacePath);
  for (const card of cards) {
    if (Object.prototype.hasOwnProperty.call(counts, card.column)) {
      counts[card.column]++;
    }
  }
  return counts;
}

/**
 * Return the unchecked exit criteria for a card leaving its current column.
 */
export function getUncheckedCriteriaForCard(
  card: CardFile,
  exitCriteria: Array<{ id: string; description: string; kind: string }>
): Array<{ id: string; description: string; kind: string }> {
  const colChecks = card.checks[card.column] ?? {};
  return exitCriteria.filter((ec) => !colChecks[ec.id]?.checked);
}
