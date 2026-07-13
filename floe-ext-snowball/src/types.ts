/**
 * Snowball extension — shared domain types.
 *
 * Slice 6 (fm/snowball-ctx-retire):
 *   - BoardSidecar, SIDECAR_SCHEMA, SidecarColumn removed (sidecar eliminated).
 *
 * Slice 4 (fm/snowball-card-context):
 *   - Card = context (context_id added to CardFile frontmatter)
 *   - Columns use assigned_actors[] replacing owner.kind model
 *   - Actors are uniform: no human/machine distinction in column config
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Card = Markdown file at tasks/<id>.md (frontmatter + body + carry-forward comments)
 *   - Card-move = event delivered to destination column's Context
 *
 * Owner identity uses actor_ref slugs (contract R5).
 */

// ---------------------------------------------------------------------------
// Exit criterion definition for a column
// ---------------------------------------------------------------------------

/**
 * Exit criterion definition for a column.
 */
export interface SidecarExitCriterion {
  id: string;
  description: string;
  kind: "machine" | "human";
}

/**
 * Uniform actor assignment on a column.
 *
 * Replaces the old `owner: { kind: "human"|"agent", agent_id? }` model.
 * Any actor — operator or LLM agent — is represented identically.
 *
 * `actor_ref` is the actor slug resolved at runtime to `actor:<workspace_id>:<actor_ref>`.
 *
 * event_types:
 *   ["*"]  = woken by all events (primary/owner behaviour)
 *   ["x"]  = woken only by specific event type
 *   []     = silent watcher: never woken, still a participant, can still emit
 */
export interface AssignedActor {
  /**
   * Actor slug, e.g. "snowball-overseer" or "operator".
   * Resolved to endpoint id: actor:<workspace_id>:<actor_ref>
   */
  actor_ref: string;
  /** Event types that wake this actor in the card context. */
  event_types: string[];
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
   * Bus context id for this card (card = context, 1:1).
   * Created when the card is first written. Null only for legacy cards
   * created before Slice 4 (lazy-created on first move to an agent column).
   * This context is the routing target for agent handoff events.
   */
  context_id: string | null;
  /**
   * Exit-criteria check state per column.
   * checks[column_id][criterion_id] -> CriterionCheckState
   */
  checks: Record<string, Record<string, CriterionCheckState>>;
  /** Markdown body text (everything after the YAML frontmatter block). */
  body: string;
}

// ---------------------------------------------------------------------------
// Engine types (used by tools/hooks)
// ---------------------------------------------------------------------------

export interface ExitCriterion {
  id: string;
  description: string;
  kind: "machine" | "human";
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
    /** Uniform actor assignments for this column. Replaces owner.kind model. */
    assigned_actors: AssignedActor[];
    exit_criteria: SidecarExitCriterion[];
    /** Agent instructions from the column definition file body. */
    instructions: string;
  }>;
  cards: Card[];
}

// ---------------------------------------------------------------------------
// Column definition (was in column-file.ts; relocated to board file in Slice 5)
// ---------------------------------------------------------------------------

/**
 * A column definition as stored inside board.md frontmatter (Slice 5).
 *
 * `scope_id` is populated from the board file's top-level scope_id when reading;
 * it is NOT stored redundantly per-column in the YAML (only the board carries it).
 * Callers receive it pre-populated for convenience.
 *
 * `instructions` is the agent instructions for this column (free-form markdown,
 * injected into BeforeTurn). Stored inline in the YAML column record.
 */
export interface ColumnFile {
  id: string;
  name: string;
  /** Populated from board scope_id at read time — not stored per-column. */
  scope_id: string;
  order: number;
  wip_limit: number | null;
  assigned_actors: AssignedActor[];
  exit_criteria: SidecarExitCriterion[];
  instructions: string;
}

// ---------------------------------------------------------------------------
// Board move result (used internally by tools)
// ---------------------------------------------------------------------------

export type MoveResult =
  | { ok: true; card_id: string; from_column_id: string; to_column_id: string }
  | { ok: false; error: string; message: string; [key: string]: unknown };
