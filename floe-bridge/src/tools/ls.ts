/**
 * Floe workspace tool — ls
 *
 * Lists directory contents in the workspace. Shows files and directories
 * with basic metadata (type, size).
 * Workspace-scoped: all paths are resolved and validated within the workspace root.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { safeWorkspacePath } from "./path-scoping.js";
import { truncateOutput } from "./truncation.js";
import type { ToolContext } from "./types.js";

export function createLsTool(ctx: ToolContext): AgentTool {
  return {
    name: "ls",
    label: "List Directory",
    description:
      "List the contents of a directory in the workspace. " +
      "Returns file and directory names with type indicators. " +
      "Paths are relative to the workspace root. Defaults to the workspace root if no path is given.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory path relative to workspace root. Defaults to '.' (workspace root)." })),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const dirPath = String(params?.path ?? ".");

      const resolved = safeWorkspacePath(ctx.workspaceRoot, dirPath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `ls ${dirPath} — path rejected`, true, startTime);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      try {
        const stat = statSync(resolved.path);
        if (!stat.isDirectory()) {
          const msg = `'${dirPath}' is not a directory.`;
          enrichToolActivity(ctx, toolCallId, `ls ${dirPath} — not a directory`, true, startTime);
          return { content: [{ type: "text", text: msg }], details: { ok: false } };
        }

        const entries = readdirSync(resolved.path, { withFileTypes: true });
        const lines: string[] = [];

        for (const entry of entries) {
          if (entry.name.startsWith(".") && entry.name !== ".floe") continue; // skip hidden except .floe
          const indicator = entry.isDirectory() ? "/" : "";
          let sizeInfo = "";
          if (entry.isFile()) {
            try {
              const s = statSync(join(resolved.path, entry.name));
              sizeInfo = ` (${formatSize(s.size)})`;
            } catch {
              // stat failed, skip size
            }
          }
          lines.push(`${entry.name}${indicator}${sizeInfo}`);
        }

        // Sort: directories first, then files, alphabetical within each
        lines.sort((a, b) => {
          const aIsDir = a.endsWith("/");
          const bIsDir = b.endsWith("/");
          if (aIsDir && !bIsDir) return -1;
          if (!aIsDir && bIsDir) return 1;
          return a.localeCompare(b);
        });

        const output = lines.length > 0 ? lines.join("\n") : "(empty directory)";
        const truncated = truncateOutput(output);
        const relPath = relative(ctx.workspaceRoot, resolved.path) || ".";

        enrichToolActivity(ctx, toolCallId, `ls ${relPath} (${entries.length} entries)`, false, startTime);

        return {
          content: [{ type: "text", text: truncated.text }],
          details: { ok: true, entries: entries.length, truncated: truncated.truncated }
        };
      } catch (err: any) {
        const msg = err.code === "ENOENT"
          ? `Directory not found: '${dirPath}'`
          : `Error listing '${dirPath}': ${err.message}`;
        enrichToolActivity(ctx, toolCallId, `ls ${dirPath} — ${err.code ?? "error"}`, true, startTime);
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
  startTime: number
): void {
  const turn = ctx.getActiveTurn?.();
  if (!turn) return;
  const entry = turn.tool_activity.find((t) => t.call_id === toolCallId);
  if (entry) {
    entry.summary = summary;
    entry.is_error = isError;
    entry.duration_ms = Date.now() - startTime;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
