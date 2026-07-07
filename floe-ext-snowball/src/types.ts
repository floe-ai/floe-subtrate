/**
 * Snowball extension — shared domain types.
 *
 * Covers both the sidecar file schema and the engine types used by tools/hooks.
 * Owner identity uses `agent_id` (contract R5) not free-form `role`.
 */

// ---------------------------------------------------------------------------
// Sidecar schema  (.floe/extensions/snowball/boards/<slug>.yaml)
// ---------------------------------------------------------------------------

export const SIDECAR_SCHEMA = "floe.ext.snowball.board.v1" as const;

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

export interface CriterionCheckState {
  checked: boolean;
  checked_at: string | null;
  checked_by: string | null;
  note?: string | null;
}

export interface SidecarCard {
  column_id: string;
  /** Position within the column (0-based) */
  order: number;
  title: string;
  created_at: string;
  /**
   * Nested: checks[column_id][criterion_id] → CriterionCheckState
   * Only the column the card is currently in (or was previously in) has entries.
   */
  checks: Record<string, Record<string, CriterionCheckState>>;
}

export interface BoardSidecar {
  schema: typeof SIDECAR_SCHEMA;
  scope_id: string;
  workspace_id: string;
  columns: SidecarColumn[];
  /** Keyed by context_id (= card_id) */
  cards: Record<string, SidecarCard>;
}

// ---------------------------------------------------------------------------
// Default columns — used when a board sidecar does not yet exist
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
// Engine types (ported from Snowball engine/types.ts; adapted for floe)
// ---------------------------------------------------------------------------

export interface ExitCriterion {
  id: string;
  description: string;
  kind: "machine" | "human";
}

export interface ColumnOwner {
  kind: "human" | "agent";
  /** agent_id when kind === "agent" */
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
  }>;
  cards: Card[];
}

// ---------------------------------------------------------------------------
// Board move result (used internally by tools)
// ---------------------------------------------------------------------------

export type MoveResult =
  | { ok: true; card_id: string; from_column_id: string; to_column_id: string }
  | { ok: false; error: string; message: string; [key: string]: unknown };
