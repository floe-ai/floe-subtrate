/**
 * Directory browser for the workspace REGISTER flow — used before any
 * workspace exists, so it is NOT workspace-scoped (no root to contain it
 * to). Lists subdirectories of an absolute path so the console can let an
 * operator navigate the box's filesystem and pick a folder to register.
 *
 * Only directories are listed (a directory is what gets registered as a
 * workspace locator). Unreadable entries (permission errors, broken
 * symlinks, etc.) are skipped rather than failing the whole listing.
 */
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

export type BrowseDirEntry = {
  name: string;
  is_dir: boolean;
};

export type BrowseDirResult = {
  path: string;
  parent: string | null;
  entries: BrowseDirEntry[];
};

export function browseDir(requestedPath: string | undefined | null): BrowseDirResult {
  const base = requestedPath && requestedPath.trim().length > 0 ? requestedPath : homedir();
  const absolute = resolve(base);

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    // Path doesn't exist or isn't accessible — fall back to home dir so the
    // browser never just dead-ends.
    return browseDir(homedir());
  }

  const dirPath = stats.isDirectory() ? absolute : dirname(absolute);
  const parent = dirname(dirPath);

  const entries: BrowseDirEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dirPath);
  } catch {
    names = [];
  }

  for (const name of names) {
    if (name.startsWith(".")) continue; // skip dotfiles/dotdirs for a cleaner browse list
    try {
      const entryStats = statSync(resolve(dirPath, name));
      if (entryStats.isDirectory()) {
        entries.push({ name, is_dir: true });
      }
    } catch {
      // Unreadable entry (permission error, broken symlink, etc.) — skip it.
      continue;
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: dirPath,
    parent: parent === dirPath ? null : parent,
    entries,
  };
}
