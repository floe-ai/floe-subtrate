/**
 * Scoped, path-validated filesystem helper for the bus's workspace FS
 * surface (see server.ts `/v1/workspaces/:workspace_id/fs/*` routes).
 *
 * Ports the containment logic from floe-app/src-tauri/src/fs_commands.rs
 * (`resolve_within_root`) to TypeScript so the bus — which is the box-side
 * process and the only thing with direct disk access when the console is
 * remote — can apply the same traversal/absolute/drive-prefix/symlink-escape
 * checks before touching disk.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

export class PathEscapesRootError extends Error {
  constructor(public readonly relPath: string) {
    super(`path escapes workspace root: ${relPath}`);
    this.name = "PathEscapesRootError";
  }
}

export class RootNotFoundError extends Error {
  constructor(public readonly root: string) {
    super(`workspace root does not exist: ${root}`);
    this.name = "RootNotFoundError";
  }
}

/**
 * Lexically reject any relative path containing `..`, a root component, or
 * a Windows drive-letter prefix before touching the filesystem. Checks both
 * `/` and `\` separators regardless of host platform, since the console
 * (and thus the string typed into `path`) may run on a different OS than
 * the bus.
 */
function hasTraversalOrAbsolute(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");

  if (normalized.split("/").some((seg) => seg === "..")) return true;
  if (normalized.startsWith("/")) return true;
  // Windows drive-letter prefix, e.g. "C:\Windows" or "C:/Windows", typed
  // as a plain string on any host.
  if (normalized.length >= 2 && normalized[1] === ":") return true;

  return false;
}

/**
 * Resolve `relPath` against `workspaceRoot`, guaranteeing the result is
 * lexically and (where the path exists) physically contained within the
 * root. Returns the resolved absolute path on success.
 *
 * - Rejects traversal/absolute/drive-prefixed relative paths up front.
 * - If the resulting path already exists, resolves symlinks (realpath) for
 *   both root and target and re-checks containment, so a symlink inside the
 *   workspace that points outside it is rejected too.
 * - If the target does not yet exist (e.g. a new file about to be
 *   written), resolves the root and the nearest existing ancestor of the
 *   target, and checks that ancestor is contained in the root.
 */
export function resolveWithinRoot(workspaceRoot: string, relPath: string): string {
  if (!existsSync(workspaceRoot)) {
    throw new RootNotFoundError(workspaceRoot);
  }

  if (relPath.trim().length === 0) {
    throw new PathEscapesRootError(relPath);
  }

  if (hasTraversalOrAbsolute(relPath) || isAbsolute(relPath)) {
    throw new PathEscapesRootError(relPath);
  }

  const joined = join(workspaceRoot, relPath);
  const canonicalRoot = realpathSync(workspaceRoot);

  if (existsSync(joined)) {
    const canonicalTarget = realpathSync(joined);
    if (!isContained(canonicalTarget, canonicalRoot)) {
      throw new PathEscapesRootError(relPath);
    }
    return canonicalTarget;
  }

  // Target doesn't exist yet (e.g. writing a new file). Walk up to the
  // nearest existing ancestor and verify *that* is contained in the root —
  // defeats a symlinked ancestor dir escaping, while still allowing new
  // files/parent dirs to be created.
  let ancestor = joined;
  let nearestExisting: string | null = null;
  for (;;) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break; // reached filesystem root
    if (existsSync(parent)) {
      nearestExisting = parent;
      break;
    }
    ancestor = parent;
  }

  if (nearestExisting === null) {
    // No existing ancestor at all below the root — shouldn't happen since
    // root itself exists, but fail closed if it does.
    throw new PathEscapesRootError(relPath);
  }

  const canonicalAncestor = realpathSync(nearestExisting);
  if (!isContained(canonicalAncestor, canonicalRoot)) {
    throw new PathEscapesRootError(relPath);
  }

  return resolve(joined);
}

function isContained(target: string, root: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}
