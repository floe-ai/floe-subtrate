/**
 * Floe workspace tool — write
 *
 * Creates or overwrites a file in the workspace. Automatically creates
 * parent directories if needed.
 * Workspace-scoped: all paths are resolved and validated within the workspace root.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative } from "node:path";
import { safeWorkspacePath } from "./path-scoping.js";
import type { ToolContext } from "./types.js";

export function createWriteTool(ctx: ToolContext): AgentTool {
  return {
    name: "write",
    label: "Write File",
    description:
      "Write content to a file in the workspace. Creates the file if it doesn't exist, " +
      "overwrites if it does. Automatically creates parent directories. " +
      "Paths are relative to the workspace root. Use this for new files or complete rewrites. " +
      "For precise edits to existing files, use the `edit` tool instead.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to workspace root" }),
      content: Type.String({ description: "Content to write to the file" }),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const filePath = String(params?.path ?? "");
      const content = String(params?.content ?? "");

      if (!filePath) {
        enrichToolActivity(ctx, toolCallId, "write — no path provided", true, [], startTime);
        return { content: [{ type: "text", text: "Error: path is required." }], details: { ok: false } };
      }

      const resolved = safeWorkspacePath(ctx.workspaceRoot, filePath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `write ${filePath} — path rejected`, true, [], startTime);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      try {
        const dir = dirname(resolved.path);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolved.path, content, "utf-8");

        const relPath = relative(ctx.workspaceRoot, resolved.path);
        const summary = `write ${relPath} (${content.length} bytes)`;
        enrichToolActivity(ctx, toolCallId, summary, false, [relPath], startTime);

        return {
          content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${filePath}` }],
          details: { ok: true, bytes: content.length }
        };
      } catch (err: any) {
        const msg = `Error writing '${filePath}': ${err.message}`;
        enrichToolActivity(ctx, toolCallId, `write ${filePath} — ${err.code ?? "error"}`, true, [filePath], startTime);
        return { content: [{ type: "text", text: msg }], details: { ok: false } };
      }
    }
  };
}

function enrichToolActivity(
  ctx: ToolContext,
  toolCallId: string,
  summary: string,
  isError: boolean,
  filesTouched: string[],
  startTime: number
): void {
  const turn = ctx.getActiveTurn?.();
  if (!turn) return;
  const entry = turn.tool_activity.find((t) => t.call_id === toolCallId);
  if (entry) {
    entry.summary = summary;
    entry.is_error = isError;
    entry.files_touched = filesTouched;
    entry.duration_ms = Date.now() - startTime;
  }
}
