/**
 * UI types for the Snowball board view.
 *
 * These mirror the sidecar types but are React-friendly (camelCase).
 */

export interface UiExitCriterion {
  id: string;
  description: string;
  kind: "machine" | "human";
}

export interface UiColumnOwner {
  kind: "human" | "agent";
  agent_id?: string;
}

export interface UiColumn {
  id: string;
  name: string;
  wipLimit: number | null;
  order: number;
  owner: UiColumnOwner;
  exitCriteria: UiExitCriterion[];
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
  /** True when the sidecar file exists on disk (first mutation creates it). */
  initialized: boolean;
  columns: Array<{
    id: string;
    name: string;
    wip_limit: number | null;
    card_count: number;
    wip_exceeded: boolean;
    owner: UiColumnOwner;
    exit_criteria: UiExitCriterion[];
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
