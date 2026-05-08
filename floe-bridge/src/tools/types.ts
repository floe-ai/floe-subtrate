/**
 * Shared types for Floe workspace tools.
 */

export type ToolActivityEntry = {
  name: string;
  call_id?: string;
  summary?: string;
  is_error?: boolean;
  files_touched?: string[];
  duration_ms?: number;
};

/**
 * Context provided to every workspace tool factory.
 * Gives tools access to the workspace root and the active turn
 * for enriching tool activity records.
 */
export type ToolContext = {
  workspaceRoot: string;
  getActiveTurn?: () => { tool_activity: ToolActivityEntry[] } | undefined;
};
