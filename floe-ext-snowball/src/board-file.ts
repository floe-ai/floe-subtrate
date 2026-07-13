/**
 * Board definition file — read/write module for Snowball board.md.
 *
 * Slice 5 (fm/snowball-col-board-s5):
 *   Column definitions move FROM individual `columns/<id>.md` files INTO the
 *   board file (board.md frontmatter). `column-file.ts` is deleted.
 *
 * Board file lives at:
 *   {workspacePath}/.floe/extensions/snowball/boards/<scopeSlug>/board.md
 *
 * Format:
 * ```
 * ---
 * scope_id: "scope:ws:project"
 * columns:
 *   - id: todo
 *     name: To Do
 *     order: 0
 *     wip_limit: null
 *     assigned_actors: []
 *     exit_criteria: []
 *     instructions: ""
 *   - id: in-progress
 *     name: In Progress
 *     order: 1
 *     wip_limit: 5
 *     assigned_actors:
 *       - actor_ref: snowball
 *         event_types: ["*"]
 *     exit_criteria:
 *       - id: ec-tests
 *         description: Tests pass
 *         kind: machine
 *     instructions: |
 *       Review each card carefully before advancing.
 * ---
 *
 * [board-wide done protocol — prose, injected into every column worker's BeforeTurn]
 * ```
 *
 * Invariants:
 *  - Frontmatter: `scope_id` (string) + `columns` (array).
 *  - Body: board-wide done protocol (free-form markdown, editable in UI).
 *  - Column `scope_id` is NOT stored per-column — populated from board scope_id.
 *  - Columns are addressable by id; ids are stable and unique within a board.
 *    FUTURE: cross-board column references use <board_scope_id>/<column_id>.
 *  - Created lazily during board init; ensureBoardFile creates with defaults.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ColumnFile, AssignedActor, SidecarExitCriterion } from "./types.js";

// ---------------------------------------------------------------------------
// Slug utility
// ---------------------------------------------------------------------------

/**
 * Convert a scope_id to a safe filesystem slug.
 * Characters illegal in filenames on Windows/Unix (: / \ * ? " < > |) are
 * replaced with underscores. The result is stable: same input → same slug.
 *
 * Example: "scope:workspace_id:feature-planning" → "scope_workspace_id_feature-planning"
 */
export function slugify(scopeId: string): string {
  return scopeId.replace(/[:/\\*?"<>|]/g, "_");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A board definition file.
 * `done_protocol` is the body of the markdown file (may be empty string).
 * `columns` holds all column definitions (relocated from individual column files).
 */
export interface BoardFile {
  scope_id: string;
  /** Board-wide done protocol — injected into every column worker's BeforeTurn. */
  done_protocol: string;
  /** All column definitions for this board, sorted by order. */
  columns: ColumnFile[];
}

// ---------------------------------------------------------------------------
// Default done protocol
// ---------------------------------------------------------------------------

/**
 * The default done protocol injected into every column worker's BeforeTurn.
 */
export const DEFAULT_DONE_PROTOCOL = `## Done Protocol

When you have completed the work for a card in your column:

1. **Check criteria**: For each exit criterion that is now satisfied, call
   \`snowball_check_criteria\` with the criterion ID and a concrete evidence note (e.g.
   "Tests pass — all 47 assertions green", "Output reviewed and matches spec",
   "PR merged and deployed to staging").

2. **Advance the card**: Once all exit criteria are satisfied — or the column
   has none — call \`snowball_move_card\` to advance the card to the next column.

3. **If unclear**: If you are unsure about board behavior, criteria IDs, or whether
   a card should be moved, emit a message to the \`snowball\` actor asking
   for clarification before acting. Do not guess at exit criteria or skip the gate.

**Rule**: Do the work first, verify it, then advance. Never call \`snowball_move_card\`
before the work is genuinely complete. If a card's exit criteria cannot be
satisfied (blocked or out of scope), surface this in the context thread rather
than moving the card.`;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path to the board directory. */
export function boardDir(workspacePath: string, scopeSlug: string): string {
  return join(workspacePath, ".floe", "extensions", "snowball", "boards", scopeSlug);
}

/** Absolute path to the board.md file. */
export function boardFilePath(workspacePath: string, scopeSlug: string): string {
  return join(boardDir(workspacePath, scopeSlug), "board.md");
}

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIMITER = "---";

/**
 * Parse a board.md file into a BoardFile object.
 * Returns null if the file cannot be parsed.
 * Column scope_id is populated from the board's scope_id.
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

  const scope_id = (fm["scope_id"] as string | undefined) ?? "";

  // Parse columns array from frontmatter
  const rawColumns = Array.isArray(fm["columns"]) ? fm["columns"] : [];
  const columns: ColumnFile[] = rawColumns.map((raw: unknown, idx: number) => {
    const col = raw as Record<string, unknown>;
    return {
      id: (col["id"] as string | undefined) ?? `col-${idx}`,
      name: (col["name"] as string | undefined) ?? `Column ${idx}`,
      scope_id,
      order: typeof col["order"] === "number" ? col["order"] : idx,
      wip_limit: col["wip_limit"] !== undefined && col["wip_limit"] !== null
        ? Number(col["wip_limit"])
        : null,
      assigned_actors: Array.isArray(col["assigned_actors"])
        ? (col["assigned_actors"] as AssignedActor[])
        : [],
      exit_criteria: Array.isArray(col["exit_criteria"])
        ? (col["exit_criteria"] as SidecarExitCriterion[])
        : [],
      instructions: typeof col["instructions"] === "string" ? col["instructions"] : "",
    };
  });

  columns.sort((a, b) => a.order - b.order);

  return { scope_id, done_protocol, columns };
}

/**
 * Serialize a BoardFile to markdown.
 * Columns are stored in frontmatter; done_protocol is the body.
 */
export function serializeBoardFile(bf: BoardFile): string {
  // Serialize columns without the redundant scope_id field
  const serializedColumns = bf.columns.map((col) => ({
    id: col.id,
    name: col.name,
    order: col.order,
    wip_limit: col.wip_limit,
    assigned_actors: col.assigned_actors,
    exit_criteria: col.exit_criteria,
    instructions: col.instructions,
  }));

  const fm: Record<string, unknown> = {
    scope_id: bf.scope_id,
    columns: serializedColumns,
  };
  const yamlStr = stringifyYaml(fm).trimEnd();
  const body = bf.done_protocol ? `\n${bf.done_protocol}` : "";
  return `---\n${yamlStr}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Write a board.md file to disk. Creates parent directories as needed.
 */
export function writeBoardFile(workspacePath: string, scopeSlug: string, bf: BoardFile): void {
  const dir = boardDir(workspacePath, scopeSlug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(boardFilePath(workspacePath, scopeSlug), serializeBoardFile(bf), "utf-8");
}

/**
 * Read a board.md file. Returns null if not found or unparseable.
 */
export function readBoardFile(workspacePath: string, scopeSlug: string): BoardFile | null {
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
 * Update only the done_protocol body of a board file, preserving frontmatter + columns.
 * Creates the file with defaults if it does not exist.
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
    columns: existing?.columns ?? defaultColumnFiles(scopeId),
  };
  writeBoardFile(workspacePath, scopeSlug, updated);
  return updated;
}

/**
 * Ensure a board.md file exists, creating it with default columns + done protocol if absent.
 * Idempotent — no-op if the file already exists.
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
    columns: defaultColumnFiles(scopeId),
  };
  writeBoardFile(workspacePath, scopeSlug, bf);
  return bf;
}

// ---------------------------------------------------------------------------
// Column helpers (relocated from column-file.ts)
// ---------------------------------------------------------------------------

/**
 * List all columns for a board, sorted by order.
 * Falls back to defaults if the board file has no columns.
 */
export function listColumnsFromBoard(
  workspacePath: string,
  scopeSlug: string
): ColumnFile[] {
  const bf = readBoardFile(workspacePath, scopeSlug);
  return bf?.columns ?? [];
}

/**
 * Read a single column from the board file by id.
 * Returns null if not found.
 */
export function readColumnFromBoard(
  workspacePath: string,
  scopeSlug: string,
  columnId: string
): ColumnFile | null {
  const columns = listColumnsFromBoard(workspacePath, scopeSlug);
  return columns.find((c) => c.id === columnId) ?? null;
}

/**
 * Write (upsert) a column into the board file.
 * If a column with the same id exists, it is replaced. Otherwise appended.
 * Creates the board file with defaults if absent.
 */
export function writeColumnToBoard(
  workspacePath: string,
  scopeSlug: string,
  col: ColumnFile
): BoardFile {
  const bf = readBoardFile(workspacePath, scopeSlug) ?? {
    scope_id: col.scope_id,
    done_protocol: DEFAULT_DONE_PROTOCOL,
    columns: [],
  };
  const idx = bf.columns.findIndex((c) => c.id === col.id);
  if (idx >= 0) {
    bf.columns[idx] = col;
  } else {
    bf.columns.push(col);
  }
  bf.columns.sort((a, b) => a.order - b.order);
  writeBoardFile(workspacePath, scopeSlug, bf);
  return bf;
}

/**
 * Update frontmatter fields of a column in the board file (preserves instructions).
 * Returns the updated ColumnFile, or null if the column does not exist.
 */
export function updateColumnInBoard(
  workspacePath: string,
  scopeSlug: string,
  columnId: string,
  updates: Partial<Omit<ColumnFile, "instructions" | "scope_id">>
): ColumnFile | null {
  const bf = readBoardFile(workspacePath, scopeSlug);
  if (!bf) return null;
  const idx = bf.columns.findIndex((c) => c.id === columnId);
  if (idx === -1) return null;
  const updated: ColumnFile = { ...bf.columns[idx], ...updates };
  bf.columns[idx] = updated;
  bf.columns.sort((a, b) => a.order - b.order);
  writeBoardFile(workspacePath, scopeSlug, bf);
  return updated;
}

/**
 * Update only the instructions of a column in the board file (preserves frontmatter).
 * Returns the updated ColumnFile, or null if the column does not exist.
 */
export function updateColumnInstructions(
  workspacePath: string,
  scopeSlug: string,
  columnId: string,
  instructions: string
): ColumnFile | null {
  const bf = readBoardFile(workspacePath, scopeSlug);
  if (!bf) return null;
  const idx = bf.columns.findIndex((c) => c.id === columnId);
  if (idx === -1) return null;
  bf.columns[idx] = { ...bf.columns[idx], instructions };
  writeBoardFile(workspacePath, scopeSlug, bf);
  return bf.columns[idx];
}

/**
 * Delete a column from the board file.
 * No-op if the column does not exist.
 */
export function deleteColumnFromBoard(
  workspacePath: string,
  scopeSlug: string,
  columnId: string
): void {
  const bf = readBoardFile(workspacePath, scopeSlug);
  if (!bf) return;
  bf.columns = bf.columns.filter((c) => c.id !== columnId);
  writeBoardFile(workspacePath, scopeSlug, bf);
}

// ---------------------------------------------------------------------------
// Column utilities (relocated from column-file.ts)
// ---------------------------------------------------------------------------

/**
 * Generate a stable, unique column id.
 */
export function generateColumnId(): string {
  return `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Return default column definitions for a new board.
 * All columns start with no assigned actors.
 */
export function defaultColumnFiles(scopeId: string): ColumnFile[] {
  return [
    {
      id: "todo",
      name: "To Do",
      scope_id: scopeId,
      order: 0,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    },
    {
      id: "in-progress",
      name: "In Progress",
      scope_id: scopeId,
      order: 1,
      wip_limit: 5,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    },
    {
      id: "done",
      name: "Done",
      scope_id: scopeId,
      order: 2,
      wip_limit: null,
      assigned_actors: [],
      exit_criteria: [],
      instructions: "",
    },
  ];
}

// ---------------------------------------------------------------------------
// Board discovery (relocated from column-file.ts)
// ---------------------------------------------------------------------------

/**
 * Find all board scope_ids where the given agentId is associated.
 * Scans the committed `boards/` directory (reads board.md files).
 *
 * The snowball system steward sees ALL boards.
 * A column worker is associated with boards where their actor_ref appears
 * in any column's assigned_actors list.
 */
export function findBoardScopesForAgentFromFiles(
  workspacePath: string,
  agentId: string,
  snowballId: string
): string[] {
  const boardsDir = join(workspacePath, ".floe", "extensions", "snowball", "boards");
  if (!existsSync(boardsDir)) return [];

  let slugDirs: string[];
  try {
    slugDirs = readdirSync(boardsDir);
  } catch {
    return [];
  }

  const scopes: string[] = [];

  for (const slug of slugDirs) {
    const bf = readBoardFile(workspacePath, slug);
    if (!bf?.scope_id) continue;

    if (agentId === snowballId) {
      scopes.push(bf.scope_id);
      continue;
    }

    const matched = bf.columns.some((col) =>
      col.assigned_actors.some((a) => a.actor_ref === agentId)
    );
    if (matched) scopes.push(bf.scope_id);
  }

  return scopes;
}
