/**
 * List `.floe/agents/**\/*.md` files under a workspace root, as relative
 * (forward-slash, root-relative) path strings, e.g. `.floe/agents/floe.md`.
 *
 * Mirrors floe-app/src-tauri/src/fs_commands.rs `list_agent_files` /
 * `collect_md_files` exactly, so the bus-served list matches what the
 * Tauri desktop shell would report for the same workspace.
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { resolveWithinRoot } from "./resolveWithinRoot.js";

export function listAgentFiles(workspaceRoot: string): string[] {
  let agentsDir: string;
  try {
    agentsDir = resolveWithinRoot(workspaceRoot, ".floe/agents");
  } catch {
    return [];
  }

  if (!existsSync(agentsDir)) return [];

  const canonicalRoot = realpathSync(workspaceRoot);
  const results: string[] = [];
  collectMdFiles(agentsDir, canonicalRoot, results);
  results.sort();
  return results;
}

function collectMdFiles(dir: string, canonicalRoot: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      collectMdFiles(path, canonicalRoot, out);
    } else if (path.endsWith(".md")) {
      const canonicalPath = realpathSync(path);
      const rel = relative(canonicalRoot, canonicalPath);
      if (!rel.startsWith("..")) {
        out.push(rel.split(sep).join("/"));
      }
    }
  }
}
