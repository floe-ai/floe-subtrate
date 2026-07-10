/**
 * Snowball extension — shared domain types.
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Column = Context (bus Context per column, owner actor frozen participant)
 *   - Card = Markdown file at tasks/<id>.md (frontmatter + body + carry-forward comments)
 *   - Card-move = event delivered to destination column's Context
 *
 * Owner identity uses `agent_id` (contract R5) not free-form `role`.
 */

// ---------------------------------------------------------------------------
// Board sidecar schema v2
// (.floe/extensions/snowball/boards/<slug>.yaml)
// Now owns column definitions + column_contexts map only.
// Cards are files in tasks/; the sidecar no longer holds card state.
// ---------------------------------------------------------------------------

/**
 * Slice 2 (fm/snowball-col-instr-s2):
 *   Bumped to v3 — `columns` field removed from sidecar.
 *   Column definitions now live in committed markdown files:
 *   boards/<scopeSlug>/columns/<id>.md
 */
export const SIDECAR_SCHEMA = "floe.ext.snowball.board.v3" as const;

export interface SidecarColumnOwner {
  kind: "human" | "agent";
  /** Only when kind === "agent". Matches the agent_id in .floe/agents/<agent_id>.md */
  agent_id?: string;
}

export interface SidecarExitCriterion {
  id: string;
  description: string;
  kind: "machine" | "human";
}

export interface SidecarColumn {
  id: string;
  name: string;
  wip_limit: number | null;
  order: number;
  owner: SidecarColumnOwner;
  exit_criteria: SidecarExitCriterion[];
}

export interface BoardSidecar {
  schema: typeof SIDECAR_SCHEMA;
  scope_id: string;
  workspace_id: string;
  /**
   * Runtime map: column_id → context_id (bus Context, created at board init).
   *
   * Column DEFINITIONS no longer live here — they are committed markdown files
   * at boards/<scopeSlug>/columns/<id>.md (see column-file.ts).
   *
   * This map is populated by POST /board/init (idempotent) and lives in the
   * gitignored sidecar location (.floe/extensions/snowball/boards/).
   */
  column_contexts: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Card file schema (tasks/<id>.md)
// ---------------------------------------------------------------------------

export interface CriterionCheckState {
  checked: boolean;
  checked_at: string | null;
  checked_by: string | null;
  note?: string | null;
}

/**
 * The parsed card file.  Lives at tasks/<id>.md in the workspace.
 *
 * Frontmatter fields are the source of truth for card state.
 * The body is the description, and carry-forward comments are appended
 * at the bottom on each column move.
 */
export interface CardFile {
  /** Stable card identity — matches the filename (without .md). */
  id: string;
  title: string;
  /** Accepted card type for this board (e.g. "task"). */
  type: string;
  /** Assigned actor (agent_id), or null if unassigned. */
  actor: string | null;
  /** Current column id. Updated in-place on move; file never moves. */
  column: string;
  /** Position within the column (0-based). Updated on move. */
  order: number;
  created_at: string;
  /**
   * Exit-criteria check state per column.
   * checks[column_id][criterion_id] → CriterionCheckState
   */
  checks: Record<string, Record<string, CriterionCheckState>>;
  /** Markdown body text (everything after the YAML frontmatter block). */
  body: string;
}

// ---------------------------------------------------------------------------
// Default columns — kept for test helpers and tooling that need raw column
// definitions without a workspace path.  For runtime use, prefer
// defaultColumnFiles() from column-file.ts.
// ---------------------------------------------------------------------------

export function defaultColumns(): SidecarColumn[] {
  return [
    {
      id: "todo",
      name: "To Do",
      wip_limit: null,
      order: 0,
      owner: { kind: "human" },
      exit_criteria: [],
    },
    {
      id: "in-progress",
      name: "In Progress",
      wip_limit: 5,
      order: 1,
      owner: { kind: "human" },
      exit_criteria: [],
    },
    {
      id: "done",
      name: "Done",
      wip_limit: null,
      order: 2,
      owner: { kind: "human" },
      exit_criteria: [],
    },
  ];
}

// ---------------------------------------------------------------------------
// Engine types (used by tools/hooks)
// ---------------------------------------------------------------------------

export interface ExitCriterion {
  id: string;
  description: string;
  kind: "machine" | "human";
}

export interface ColumnOwner {
  kind: "human" | "agent";
  agent_id?: string;
}

export interface Column {
  id: string;
  name: string;
  wipLimit: number | null;
  owner: ColumnOwner;
  exitCriteria: ExitCriterion[];
}

export interface CardCriterionCheck {
  columnId: string;
  criterionId: string;
  checked: boolean;
  checkedAt?: string;
  checkedBy?: string;
  note?: string;
}

/** Card as projected for API responses and BeforeTurn injection. */
export interface Card {
  card_id: string;
  column_id: string;
  order: number;
  title: string;
  created_at: string;
  criteria_checks: CardCriterionCheck[];
}

export interface BoardSnapshot {
  scope_id: string;
  workspace_id: string;
  columns: Array<{
    id: string;
    name: string;
    wip_limit: number | null;
    card_count: number;
    wip_exceeded: boolean;
    owner: SidecarColumnOwner;
    exit_criteria: SidecarExitCriterion[];
    /** Agent instructions from the column definition file body. */
    instructions: string;
  }>;
  cards: Card[];
}

// ---------------------------------------------------------------------------
// Board move result (used internally by tools)
// ---------------------------------------------------------------------------

export type MoveResult =
  | { ok: true; card_id: string; from_column_id: string; to_column_id: string }
  | { ok: false; error: string; message: string; [key: string]: unknown };
