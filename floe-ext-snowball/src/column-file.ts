/**
 * Column definition files — read/write module for Snowball column markdown files.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   Column definitions move from the gitignored sidecar YAML to committed
 *   markdown files, mirroring the card-file pattern.
 *
 * Slice 4 (fm/snowball-card-context):
 *   `owner: { kind, agent_id }` replaced with `assigned_actors: AssignedActor[]`.
 *   Actors are uniform: operator and LLM agents use identical code.
 *   A column with no assigned actors is equivalent to the old "human-owned" column.
 *
 * Columns live at:
 *   {workspacePath}/boards/<scopeSlug>/columns/<id>.md
 *
 * Format:
 * ```
 * ---
 * id: "in-progress"
 * name: "In Progress"
 * scope_id: "scope:ws:project"
 * order: 1
 * wip_limit: 5
 * assigned_actors:
 *   - actor_ref: snowball-overseer
 *     event_types: ["*"]
 * exit_criteria:
 *   - id: ec-tests
 *     description: Tests pass
 *     kind: machine
 * ---
 *
 * Agent instructions for the In Progress column.
 * When a card enters this column, review its description and checks.
 * ```
 *
 * Invariants:
 *  - The column file NEVER moves (column id is stable).
 *  - Frontmatter is the source of truth for column config.
 *  - The file body is the agent instructions (may be empty string).
 *  - `scopeSlug` = slugify(scope_id) — callers compute this; see sidecar.ts.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AssignedActor, SidecarExitCriterion } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A column definition file.
 * `instructions` is the body of the markdown file (may be empty).
 */
export interface ColumnFile {
  id: string;
  name: string;
  /** The board scope this column belongs to. Stored in frontmatter. */
  scope_id: string;
  order: number;
  wip_limit: number | null;
  /**
   * Uniform actor assignments for this column.
   * Each actor is added as a participant of landing cards and subscribed
   * to their specified event types.
   * Empty = no assigned actors (equivalent to old "human-owned" column).
   */
  assigned_actors: AssignedActor[];
  exit_criteria: SidecarExitCriterion[];
  /** Agent instructions for this column — editable by the user, injected by BeforeTurn. */
  instructions: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Absolute path to the columns directory for a board. */
export function boardColumnsDir(
  workspacePath: string,
  scopeSlug: string
): string {
  return join(workspacePath, ".floe", "extensions", "snowball", "boards", scopeSlug, "columns");
}

/** Absolute path to a column definition file. */
export function columnFilePath(
  workspacePath: string,
  scopeSlug: string,
  columnId: string
): string {
  return join(boardColumnsDir(workspacePath, scopeSlug), `${columnId}.md`);
}

// ---------------------------------------------------------------------------
// Parse / Serialize
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIMITER = "---";

/**
 * Parse a column markdown file into a ColumnFile object.
 * Returns null if the file cannot be parsed.
 */
export function parseColumnFile(raw: string, columnId: string): ColumnFile | null {
  if (!raw.startsWith(FRONTMATTER_DELIMITER)) return null;
  const afterFirst = raw.slice(FRONTMATTER_DELIMITER.length);
  const endIdx = afterFirst.indexOf(`\n${FRONTMATTER_DELIMITER}`);
  if (endIdx === -1) return null;

  const yamlStr = afterFirst.slice(0, endIdx);
  const instructions = afterFirst
    .slice(endIdx + FRONTMATTER_DELIMITER.length + 1)
    .trimStart();

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(yamlStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!fm || typeof fm !== "object") return null;

  // Parse assigned_actors (Slice 4 model).
  // Legacy column files may have `owner` instead — migrate transparently.
  let assigned_actors: AssignedActor[] = [];
  if (Array.isArray(fm["assigned_actors"])) {
    assigned_actors = fm["assigned_actors"] as AssignedActor[];
  } else if (fm["owner"] && typeof fm["owner"] === "object") {
    // Legacy: convert owner.kind="agent" + owner.agent_id -> assigned_actors
    const owner = fm["owner"] as { kind?: string; agent_id?: string };
    if (owner.kind === "agent" && owner.agent_id) {
      assigned_actors = [{ actor_ref: owner.agent_id, event_types: ["*"] }];
    }
    // owner.kind="human" -> empty assigned_actors (already default)
  }

  return {
    id: (fm["id"] as string | undefined) ?? columnId,
    name: (fm["name"] as string | undefined) ?? columnId,
    scope_id: (fm["scope_id"] as string | undefined) ?? "",
    order: typeof fm["order"] === "number" ? fm["order"] : 0,
    wip_limit: fm["wip_limit"] !== undefined && fm["wip_limit"] !== null
      ? Number(fm["wip_limit"])
      : null,
    assigned_actors,
    exit_criteria: Array.isArray(fm["exit_criteria"])
      ? (fm["exit_criteria"] as SidecarExitCriterion[])
      : [],
    instructions,
  };
}

/**
 * Serialize a ColumnFile to a markdown string.
 */
export function serializeColumnFile(col: ColumnFile): string {
  const fm: Record<string, unknown> = {
    id: col.id,
    name: col.name,
    scope_id: col.scope_id,
    order: col.order,
    wip_limit: col.wip_limit,
    assigned_actors: col.assigned_actors,
    exit_criteria: col.exit_criteria,
  };
  const yamlStr = stringifyYaml(fm).trimEnd();
  const body = col.instructions ? `\n${col.instructions}` : "";
  return `---\n${yamlStr}\n---\n${body}`;
}

// ---------------------------------------------------------------------------
// Read / Write / List / Delete
// ---------------------------------------------------------------------------

/**
 * Write a column definition file to disk.
 * Creates parent directories as needed.
 */
export function writeColumnFile(
  workspacePath: string,
  scopeSlug: string,
  col: ColumnFile
): void {
  const dir = boardColumnsDir(workspacePath, scopeSlug);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    columnFilePath(workspacePath, scopeSlug, col.id),
    serializeColumnFile(col),
    "utf-8"
  );
}

/**
 * Read a column file by id. Returns null if not found or unparseable.
 */
export function readColumnFile(
  workspacePath: string,
  scopeSlug: string,
  columnId: string
): ColumnFile | null {
  const path = columnFilePath(workspacePath, scopeSlug, columnId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return parseColumnFile(raw, columnId);
  } catch {
    return null;
  }
}

/**
 * List all column definition files for a board, sorted by `order`.
 * Returns an empty array if the columns directory does not exist.
 */
export function listColumnFiles(
  workspacePath: string,
  scopeSlug: string
): ColumnFile[] {
  const dir = boardColumnsDir(workspacePath, scopeSlug);
  if (!existsSync(dir)) return [];

  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }

  const cols: ColumnFile[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const id = file.slice(0, -3);
    const col = readColumnFile(workspacePath, scopeSlug, id);
    if (col) cols.push(col);
  }

  cols.sort((a, b) => a.order - b.order);
  return cols;
}

/**
 * Update frontmatter fields of a column file, preserving the instructions body.
 * Returns the updated ColumnFile, or null if the column file does not exist.
 */
export function updateColumnFileFrontmatter(
  workspacePath: string,
  scopeSlug: string,
  columnId: string,
  updates: Partial<Omit<ColumnFile, "instructions">>
): ColumnFile | null {
  const existing = readColumnFile(workspacePath, scopeSlug, columnId);
  if (!existing) return null;
  const updated: ColumnFile = { ...existing, ...updates };
  writeColumnFile(workspacePath, scopeSlug, updated);
  return updated;
}

/**
 * Update only the instructions (body) of a column file, preserving frontmatter.
 * Returns the updated ColumnFile, or null if the column file does not exist.
 */
export function updateColumnFileInstructions(
  workspacePath: string,
  scopeSlug: string,
  columnId: string,
  instructions: string
): ColumnFile | null {
  const existing = readColumnFile(workspacePath, scopeSlug, columnId);
  if (!existing) return null;
  const updated: ColumnFile = { ...existing, instructions };
  writeColumnFile(workspacePath, scopeSlug, updated);
  return updated;
}

/**
 * Delete a column definition file.
 * No-op if the file does not exist.
 */
export function deleteColumnFile(
  workspacePath: string,
  scopeSlug: string,
  columnId: string
): void {
  const path = columnFilePath(workspacePath, scopeSlug, columnId);
  if (existsSync(path)) {
    rmSync(path);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a stable, unique column id.
 */
export function generateColumnId(): string {
  return `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Return default column definitions for a new board.
 * Column files are written to disk during board init (POST /board/init).
 * Default columns have no assigned actors (no agent auto-assigned).
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
// Board discovery (for hooks)
// ---------------------------------------------------------------------------

/**
 * Find all board scope_ids where the given agentId is associated.
 * Scans the committed `boards/` directory (not the gitignored sidecar directory).
 *
 * The overseer is associated with ALL boards.
 * A column worker is associated with any board where their actor_ref appears
 * in any column's assigned_actors list.
 */
export function findBoardScopesForAgentFromFiles(
  workspacePath: string,
  agentId: string,
  overseerId: string
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
    const dir = boardColumnsDir(workspacePath, slug);
    if (!existsSync(dir)) continue;

    let colFiles: string[];
    try {
      colFiles = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }

    let scopeId: string | null = null;
    let matched = false;

    for (const file of colFiles) {
      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const col = parseColumnFile(raw, file.slice(0, -3));
        if (!col) continue;
        if (!scopeId) scopeId = col.scope_id;

        if (agentId === overseerId) {
          // Overseer sees all boards — just need to find one column to get scope_id
          matched = true;
          break;
        } else if (col.assigned_actors.some((a) => a.actor_ref === agentId)) {
          matched = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (scopeId && matched) {
      scopes.push(scopeId);
    }
  }

  return scopes;
}
