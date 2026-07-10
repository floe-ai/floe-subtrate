/**
 * Board definition file — read/write module for the Snowball board.md file.
 *
 * fm/floe-advance-protocol:
 *   Introduces a committed board file `boards/<scopeSlug>/board.md` that gives
 *   the board its own file-first identity (mirroring card=file, column=file).
 *
 * Board file lives at:
 *   {workspacePath}/boards/<scopeSlug>/board.md
 *
 * Format:
 * ```
 * ---
 * scope_id: "scope:ws:project"
 * ---
 *
 * [board-wide done protocol — prose, injected into every column worker's BeforeTurn]
 * ```
 *
 * Invariants:
 *  - Frontmatter: `scope_id` (string).
 *  - Body: the board-wide done protocol (free-form markdown, editable in UI).
 *  - Created lazily during board init and on first BeforeTurn read if absent.
 *  - `scopeSlug` = slugify(scope_id) — callers compute this; see sidecar.ts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A board definition file.
 * `done_protocol` is the body of the markdown file (may be empty string).
 */
export interface BoardFile {
  scope_id: string;
  /** Board-wide done protocol — injected into every column worker's BeforeTurn. */
  done_protocol: string;
}

// ---------------------------------------------------------------------------
// Default done protocol
// ---------------------------------------------------------------------------

/**
 * The default done protocol injected into every column worker's BeforeTurn.
 *
 * This drives the advance-on-conclusion behavior (fm/floe-advance-protocol):
 * agents must complete work, verify criteria, then call move_card.
 * They must never auto-cascade a card before doing any work.
 */
export const DEFAULT_DONE_PROTOCOL = `## Done Protocol

When you have completed the work for a card in your column:

1. **Check criteria**: For each exit criterion that is now satisfied, call
   \`check_criteria\` with the criterion ID and a concrete evidence note (e.g.
   "Tests pass — all 47 assertions green", "Output reviewed and matches spec",
   "PR merged and deployed to staging").

2. **Advance the card**: Once all exit criteria are satisfied — or the column
   has none — call \`move_card\` to advance the card to the next column.

**Rule**: Do the work first, verify it, then advance. Never call \`move_card\`
before the work is genuinely complete. If a card's exit criteria cannot be
satisfied (blocked or out of scope), surface this in the context thread rather
than moving the card.`;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path to the board directory for a board. */
export function boardDir(workspacePath: string, scopeSlug: string): string {
  return join(workspacePath, ".floe", "extensions", "snowball", "boards", scopeSlug);
}

/** Absolute path to the board definition file. */
export function boardFilePath(
  workspacePath: string,
  scopeSlug: string
): string {
  return join(boardDir(workspacePath, scopeSlug), "board.md");
}

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIMITER = "---";

/**
 * Parse a board.md file into a BoardFile object.
 * Returns null if the file cannot be parsed.
 */
export function parseBoardFile(raw: string): BoardFile | null {
  if (!raw.startsWith(FRONTMATTER_DELIMITER)) return null;
  const afterFirst = raw.slice(FRONTMATTER_DELIMITER.length);
  const endIdx = afterFirst.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (endIdx === -1) return null;

  const yamlStr = afterFirst.slice(0, endIdx);
  const done_protocol = afterFirst
    .slice(endIdx + FRONTMATTER_DELIMITER.length + 1)
    .trimStart();

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(yamlStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object") return null;

  return {
    scope_id: (fm["scope_id"] as string | undefined) ?? "",
    done_protocol,
  };
}

/**
 * Serialize a BoardFile to a markdown string.
 */
export function serializeBoardFile(bf: BoardFile): string {
  const fm: Record<string, unknown> = {
    scope_id: bf.scope_id,
  };
  const yamlStr = stringifyYaml(fm).trimEnd();
  const body = bf.done_protocol ? `\n${bf.done_protocol}` : "";
  return `---\n${yamlStr}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Write a board definition file to disk.
 * Creates parent directories as needed.
 */
export function writeBoardFile(
  workspacePath: string,
  scopeSlug: string,
  bf: BoardFile
): void {
  const dir = boardDir(workspacePath, scopeSlug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(boardFilePath(workspacePath, scopeSlug), serializeBoardFile(bf), "utf-8");
}

/**
 * Read a board definition file. Returns null if not found or unparseable.
 */
export function readBoardFile(
  workspacePath: string,
  scopeSlug: string
): BoardFile | null {
  const path = boardFilePath(workspacePath, scopeSlug);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return parseBoardFile(raw);
  } catch {
    return null;
  }
}

/**
 * Update only the done_protocol (body) of a board file, preserving frontmatter.
 * Creates the file with defaults if it does not exist.
 * Returns the updated BoardFile.
 */
export function updateBoardFileProtocol(
  workspacePath: string,
  scopeSlug: string,
  scopeId: string,
  doneProtocol: string
): BoardFile {
  const existing = readBoardFile(workspacePath, scopeSlug);
  const updated: BoardFile = {
    scope_id: existing?.scope_id ?? scopeId,
    done_protocol: doneProtocol,
  };
  writeBoardFile(workspacePath, scopeSlug, updated);
  return updated;
}

/**
 * Ensure a board.md file exists for the given board, creating it with the
 * default done protocol if absent.
 *
 * Idempotent — does nothing if the file already exists.
 */
export function ensureBoardFile(
  workspacePath: string,
  scopeSlug: string,
  scopeId: string
): BoardFile {
  const existing = readBoardFile(workspacePath, scopeSlug);
  if (existing) return existing;
  const bf: BoardFile = {
    scope_id: scopeId,
    done_protocol: DEFAULT_DONE_PROTOCOL,
  };
  writeBoardFile(workspacePath, scopeSlug, bf);
  return bf;
}
