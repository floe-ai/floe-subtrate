/**
 * Floe workspace tool — find
 *
 * Finds files by name/pattern within the workspace. Uses fd when available,
 * falls back to Node.js recursive directory walk.
 * Workspace-scoped: search is always rooted in the workspace.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { safeWorkspacePath } from "./path-scoping.js";
import { truncateOutput } from "./truncation.js";
import type { ToolContext } from "./types.js";

export function createFindTool(ctx: ToolContext): AgentTool {
  return {
    name: "find",
    label: "Find Files",
    description:
      "Find files by name or glob pattern within the workspace. " +
      "Returns matching file paths relative to the workspace root. " +
      "Uses fd when available for fast searching, with a Node.js fallback.",
    parameters: Type.Object({
      pattern: Type.String({ description: "File name pattern to search for (glob-style, e.g., '*.ts', 'index.*')" }),
      path: Type.Optional(Type.String({ description: "Directory to search within. Defaults to workspace root." })),
      type: Type.Optional(Type.String({ description: "'file', 'directory', or 'any'. Default: 'file'" })),
      max_results: Type.Optional(Type.Number({ description: "Maximum number of results. Default: 200" })),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const pattern = String(params?.pattern ?? "");
      const searchPath = String(params?.path ?? ".");
      const typeFilter = String(params?.type ?? "file");
      const maxResults = params?.max_results ?? 200;

      if (!pattern) {
        enrichToolActivity(ctx, toolCallId, "find — empty pattern", true, startTime);
        return { content: [{ type: "text", text: "Error: pattern is required." }], details: { ok: false } };
      }

      const resolved = safeWorkspacePath(ctx.workspaceRoot, searchPath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `find '${pattern}' — path rejected`, true, startTime);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      try {
        const { output, backend, count } = hasFd()
          ? findWithFd(resolved.path, pattern, typeFilter, maxResults, ctx.workspaceRoot)
          : findWithNode(resolved.path, pattern, typeFilter, maxResults, ctx.workspaceRoot);

        const truncated = truncateOutput(output);
        const relPath = relative(ctx.workspaceRoot, resolved.path) || ".";
        const summary = `find '${pattern.slice(0, 40)}' in ${relPath} — ${count} results (${backend})`;

        enrichToolActivity(ctx, toolCallId, summary, false, startTime);

        return {
          content: [{ type: "text", text: truncated.text || "(no matches)" }],
          details: { ok: true, count, backend, truncated: truncated.truncated }
        };
      } catch (err: any) {
        const msg = `Error finding files: ${err.message}`;
        enrichToolActivity(ctx, toolCallId, `find '${pattern.slice(0, 40)}' — error`, true, startTime);
        return { content: [{ type: "text", text: msg }], details: { ok: false } };
      }
    }
  };
}

let _hasFd: boolean | null = null;
function hasFd(): boolean {
  if (_hasFd !== null) return _hasFd;
  try {
    execFileSync("fd", ["--version"], { stdio: "pipe", timeout: 5000 });
    _hasFd = true;
  } catch {
    _hasFd = false;
  }
  return _hasFd;
}

function findWithFd(
  searchPath: string,
  pattern: string,
  typeFilter: string,
  maxResults: number,
  workspaceRoot: string
): { output: string; backend: string; count: number } {
  const args = [
    "--color", "never",
    "--max-results", String(maxResults),
  ];
  if (typeFilter === "file") args.push("--type", "f");
  else if (typeFilter === "directory") args.push("--type", "d");
  args.push("--glob", pattern);
  args.push(searchPath);

  try {
    const result = execFileSync("fd", args, {
      cwd: workspaceRoot,
      stdio: "pipe",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = result.toString("utf-8").trim();
    const lines = output ? output.split("\n") : [];
    // Make paths relative to workspace root
    const relativePaths = lines.map((line) => {
      const trimmed = line.trim();
      return relative(workspaceRoot, trimmed) || trimmed;
    });
    return { output: relativePaths.join("\n"), backend: "fd", count: relativePaths.length };
  } catch (err: any) {
    if (err.status === 1) return { output: "", backend: "fd", count: 0 };
    throw err;
  }
}

function findWithNode(
  searchPath: string,
  pattern: string,
  typeFilter: string,
  maxResults: number,
  workspaceRoot: string
): { output: string; backend: string; count: number } {
  const regex = globToRegex(pattern);
  const results: string[] = [];

  function walk(dir: string): void {
    if (results.length >= maxResults) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults) return;
      if (entry.name.startsWith(".") && entry.name !== ".floe") continue;
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      const relPath = relative(workspaceRoot, fullPath);

      if (entry.isDirectory()) {
        if (typeFilter !== "file" && regex.test(entry.name)) {
          results.push(relPath);
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (typeFilter !== "directory" && regex.test(entry.name)) {
          results.push(relPath);
        }
      }
    }
  }

  walk(searchPath);
  return { output: results.join("\n"), backend: "node", count: results.length };
}

function globToRegex(glob: string): RegExp {
  let pattern = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  pattern = pattern.replace(/\{([^}]+)\}/g, (_match, group) => {
    return `(${group.split(",").join("|")})`;
  });
  return new RegExp("^" + pattern + "$");
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
