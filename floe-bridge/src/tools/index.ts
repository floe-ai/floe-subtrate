/**
 * Floe workspace tools — index
 *
 * Factory function that creates all workspace tools for an agent session.
 * Tools use the pi-agent-core AgentTool interface and are registered
 * alongside emit and list_endpoints in the Pi adapter.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createReadTool } from "./read.js";
import { createLsTool } from "./ls.js";
import { createGrepTool } from "./grep.js";
import { createFindTool } from "./find.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { createBashTool } from "./bash.js";
import type { ToolContext } from "./types.js";

export type { ToolContext, ToolActivityEntry } from "./types.js";
export { safeWorkspacePath, resolveWorkspacePath, validateWorkspaceContainment } from "./path-scoping.js";
export { truncateOutput } from "./truncation.js";
export { sanitiseEnvironment, listStrippedVarNames } from "./env-sanitise.js";

/**
 * Create the standard set of workspace tools for an agent session.
 * Returns an array of AgentTool instances ready for registration.
 *
 * Current local workspace rule: all agents get all tools.
 */
export function createWorkspaceTools(ctx: ToolContext): AgentTool[] {
  return [
    createReadTool(ctx),
    createLsTool(ctx),
    createGrepTool(ctx),
    createFindTool(ctx),
    createWriteTool(ctx),
    createEditTool(ctx),
    createBashTool(ctx),
  ];
}
