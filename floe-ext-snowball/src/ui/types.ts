/**
 * UI types for the Snowball board view.
 *
 * These mirror the sidecar types but are React-friendly (camelCase).
 *
 * Slice 4 (fm/snowball-card-context):
 *   UiColumn uses assignedActors[] instead of owner.kind.
 *   A column with no assignedActors is equivalent to the old "human-owned".
 */

export interface UiExitCriterion {
  id: string;
  description: string;
  kind: "machine" | "human";
}

/** Uniform actor assignment on a column (mirrors AssignedActor from types.ts). */
export interface UiAssignedActor {
  actor_ref: string;
  event_types: string[];
}

export interface UiColumn {
  id: string;
  name: string;
  wipLimit: number | null;
  order: number;
  assignedActors: UiAssignedActor[];
  exitCriteria: UiExitCriterion[];
  /** Agent instructions for this column — editable, injected via BeforeTurn. */
  instructions: string;
}

export interface UiCriterionCheck {
  columnId: string;
  criterionId: string;
  checked: boolean;
  checkedAt?: string;
}

export interface UiCard {
  card_id: string;
  column_id: string;
  order: number;
  title: string;
  created_at: string;
  criteria_checks: UiCriterionCheck[];
}

export interface UiBoardState {
  scope_id: string;
  workspace_id: string;
  /** True when the sidecar file exists on disk (column contexts created). */
  initialized: boolean;
  columns: Array<{
    id: string;
    name: string;
    wip_limit: number | null;
    card_count: number;
    wip_exceeded: boolean;
    assigned_actors: UiAssignedActor[];
    exit_criteria: UiExitCriterion[];
    /** Agent instructions from the column definition file body. */
    instructions: string;
  }>;
  cards: UiCard[];
}

/** Props passed to the SnowballBoard component by the host app (contract §1.4). */
export interface ExtensionViewProps {
  workspaceId: string;
  scopeId: string;
  /** Base URL of the bus HTTP server, e.g. "http://localhost:3001" */
  busBaseUrl: string;
  extensionName: string;
}
