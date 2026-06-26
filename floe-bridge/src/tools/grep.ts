/**
 * Floe workspace tool — grep
 *
 * Searches file contents within the workspace. Uses ripgrep (rg) when
 * available, falls back to a Node.js recursive search.
 * Workspace-scoped: search is always rooted in the workspace.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { safeWorkspacePath } from "./path-scoping.js";
import { truncateOutput } from "./truncation.js";
import type { ToolContext } from "./types.js";

export function createGrepTool(ctx: ToolContext): AgentTool {
  return {
    name: "grep",
    label: "Search File Contents",
    description:
      "Search for a pattern in file contents within the workspace. " +
      "Returns matching lines with file paths and line numbers. " +
      "Uses ripgrep (rg) when available for fast searching, with a Node.js fallback. " +
      "The pattern is a regular expression by default. Use `fixed_string: true` for literal matching.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex by default)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search within. Defaults to workspace root." })),
      include: Type.Optional(Type.String({ description: "Glob pattern to filter files (e.g., '*.ts', '*.{js,jsx}')" })),
      fixed_string: Type.Optional(Type.Boolean({ description: "If true, treat pattern as a literal string instead of regex" })),
      max_results: Type.Optional(Type.Number({ description: "Maximum number of matches to return. Default: 200" })),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const pattern = String(params?.pattern ?? "");
      const searchPath = String(params?.path ?? ".");
      const include = params?.include as string | undefined;
      const fixedString = !!params?.fixed_string;
      const maxResults = params?.max_results ?? 200;

      if (!pattern) {
        enrichToolActivity(ctx, toolCallId, "grep — empty pattern", true, startTime);
        return { content: [{ type: "text", text: "Error: pattern is required." }], details: { ok: false } };
      }

      const resolved = safeWorkspacePath(ctx.workspaceRoot, searchPath);
      if (!resolved.ok) {
        enrichToolActivity(ctx, toolCallId, `grep '${pattern}' — path rejected`, true, startTime);
        return { content: [{ type: "text", text: resolved.error }], details: { ok: false } };
      }

      try {
        const { output, backend, matchCount } = hasRipgrep()
          ? searchWithRipgrep(resolved.path, pattern, fixedString, include, maxResults, ctx.workspaceRoot)
          : searchWithNode(resolved.path, pattern, fixedString, include, maxResults, ctx.workspaceRoot);

        const truncated = truncateOutput(output);
        const relPath = relative(ctx.workspaceRoot, resolved.path) || ".";
        const summary = `grep '${pattern.slice(0, 40)}' in ${relPath} — ${matchCount} matches (${backend})`;

        enrichToolActivity(ctx, toolCallId, summary, false, startTime);

        return {
          content: [{ type: "text", text: truncated.text || "(no matches)" }],
          details: { ok: true, matches: matchCount, backend, truncated: truncated.truncated }
        };
      } catch (err: any) {
        const msg = `Error searching: ${err.message}`;
        enrichToolActivity(ctx, toolCallId, `grep '${pattern.slice(0, 40)}' — error`, true, startTime);
        return { content: [{ type: "text", text: msg }], details: { ok: false } };
      }
    }
  };
}

let _hasRipgrep: boolean | null = null;
function hasRipgrep(): boolean {
  if (_hasRipgrep !== null) return _hasRipgrep;
  try {
    execFileSync("rg", ["--version"], { stdio: "pipe", timeout: 5000 });
    _hasRipgrep = true;
  } catch {
    _hasRipgrep = false;
  }
  return _hasRipgrep;
}

function searchWithRipgrep(
  searchPath: string,
  pattern: string,
  fixedString: boolean,
  include: string | undefined,
  maxResults: number,
  workspaceRoot: string
): { output: string; backend: string; matchCount: number } {
  const args = [
    "--no-heading",
    "--line-number",
    "--color", "never",
    "--max-count", String(maxResults),
  ];
  if (fixedString) args.push("--fixed-strings");
  if (include) args.push("--glob", include);
  args.push(pattern, searchPath);

  try {
    const result = execFileSync("rg", args, {
      cwd: workspaceRoot,
      stdio: "pipe",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const output = result.toString("utf-8");
    const matchCount = output.split("\n").filter((l) => l.trim()).length;
    return { output, backend: "ripgrep", matchCount };
  } catch (err: any) {
    // rg exits 1 when no matches found
    if (err.status === 1) return { output: "", backend: "ripgrep", matchCount: 0 };
    throw err;
  }
}

function searchWithNode(
  searchPath: string,
  pattern: string,
  fixedString: boolean,
  include: string | undefined,
  maxResults: number,
  workspaceRoot: string
): { output: string; backend: string; matchCount: number } {
  const regex = fixedString
    ? new RegExp(escapeRegex(pattern), "g")
    : new RegExp(pattern, "g");

  const includePattern = include ? globToRegex(include) : null;
  const results: string[] = [];
  let matchCount = 0;

  function walk(dir: string): void {
    if (matchCount >= maxResults) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matchCount >= maxResults) return;
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const relPath = relative(workspaceRoot, fullPath);
        if (includePattern && !includePattern.test(relPath)) continue;
        try {
          const content = readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length && matchCount < maxResults; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push(`${relPath}:${i + 1}:${lines[i]}`);
              matchCount++;
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(searchPath);
  return { output: results.join("\n"), backend: "node", matchCount };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  // Simple glob-to-regex: * → [^/]*, ** → .*, ? → .
  let pattern = glob
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  // Handle {a,b} alternation
  pattern = pattern.replace(/\{([^}]+)\}/g, (_match, group) => {
    return `(${group.split(",").join("|")})`;
  });
  return new RegExp(pattern + "$");
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
