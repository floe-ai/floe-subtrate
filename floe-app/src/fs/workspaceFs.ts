/**
 * Workspace filesystem bridge — the ONLY seam between the console UI and
 * direct, on-disk workspace files.
 *
 * In the Tauri desktop shell, this invokes Rust commands that read/write
 * files scoped to a workspace root (the selected workspace's `locator`,
 * e.g. `/home/justin/work` on Linux or `C:\Users\justin\work` on Windows).
 * The Rust side validates every path stays within that root before
 * touching disk — see `src-tauri/src/fs_commands.rs`.
 *
 * In a plain browser (no Tauri runtime), these functions are unavailable.
 * Importing this module must never throw in the browser; callers should
 * gate file-editing UI on `isTauri()` and simply not call the read/write
 * functions when it's false.
 */

/** True when running inside the Tauri desktop shell, false in a plain browser. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeTauri<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(
      `workspaceFs.${cmd} is only available in the Tauri desktop shell (isTauri() is false)`
    );
  }
  // Imported dynamically so this module never fails to load in a plain
  // browser — `@tauri-apps/api` is present in node_modules either way, but
  // we still avoid touching it unless we're actually inside Tauri.
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * List `.floe/agents/**\/*.md` files under `workspaceRoot`, as relative
 * (forward-slash) path strings, e.g. `.floe/agents/floe.md`.
 */
export async function listAgentFiles(workspaceRoot: string): Promise<string[]> {
  return invokeTauri<string[]>("list_agent_files", { workspaceRoot });
}

/** Read a UTF-8 text file at `relPath` under `workspaceRoot`. */
export async function readWorkspaceFile(
  workspaceRoot: string,
  relPath: string
): Promise<string> {
  return invokeTauri<string>("read_file", { workspaceRoot, relPath });
}

/**
 * Write `contents` to `relPath` under `workspaceRoot`, creating parent
 * directories as needed.
 */
export async function writeWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  contents: string
): Promise<void> {
  await invokeTauri<void>("write_file", { workspaceRoot, relPath, contents });
}
