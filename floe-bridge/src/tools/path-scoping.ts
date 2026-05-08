/**
 * Workspace path scoping — resolves and validates paths within a workspace root.
 *
 * All file-based tools use this to enforce workspace containment.
 * Paths are resolved relative to workspaceRoot and validated to ensure
 * they don't escape via ../ or symlink traversal.
 */

import { resolve, normalize, relative, isAbsolute } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Resolve a user-provided path relative to the workspace root.
 * Returns the absolute resolved path.
 *
 * - Absolute paths are validated for containment.
 * - Relative paths are resolved from workspaceRoot.
 */
export function resolveWorkspacePath(workspaceRoot: string, userPath: string): string {
  const normalizedRoot = normalize(resolve(workspaceRoot));
  const resolved = isAbsolute(userPath)
    ? normalize(resolve(userPath))
    : normalize(resolve(normalizedRoot, userPath));
  return resolved;
}

/**
 * Validate that a resolved path is within the workspace root.
 * Returns an error message if the path escapes, or null if valid.
 *
 * Checks both the logical path (relative check) and the real path
 * (symlink resolution) to prevent symlink-based escape.
 */
export function validateWorkspaceContainment(
  workspaceRoot: string,
  resolvedPath: string
): string | null {
  const normalizedRoot = normalize(resolve(workspaceRoot));
  const rel = relative(normalizedRoot, resolvedPath);

  // Check logical containment: relative path must not start with ..
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return `Path '${resolvedPath}' is outside the workspace root '${normalizedRoot}'.`;
  }

  // Check real path containment (symlink resolution)
  try {
    const realPath = realpathSync(resolvedPath);
    const realRoot = realpathSync(normalizedRoot);
    const realRel = relative(realRoot, realPath);
    if (realRel.startsWith("..") || isAbsolute(realRel)) {
      return `Path '${resolvedPath}' resolves outside the workspace root via symlink.`;
    }
  } catch {
    // File doesn't exist yet (e.g., write target) — logical check is sufficient
  }

  return null;
}

/**
 * Resolve and validate a workspace path in one call.
 * Returns { path } on success or { error } on containment violation.
 */
export function safeWorkspacePath(
  workspaceRoot: string,
  userPath: string
): { ok: true; path: string } | { ok: false; error: string } {
  const resolved = resolveWorkspacePath(workspaceRoot, userPath);
  const violation = validateWorkspaceContainment(workspaceRoot, resolved);
  if (violation) return { ok: false, error: violation };
  return { ok: true, path: resolved };
}
