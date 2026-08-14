/**
 * Folder watching — the deterministic monitor node.
 *
 * This is not a new wake mechanism. It is a doorway that observes a path and
 * fires an EXISTING Scope Graph trigger node (BusStore.fireScopeGraphTrigger,
 * which itself reuses emitTriggerEvent) exactly as any other trigger firing
 * would. The only thing this primitive owns is noticing that a file arrived
 * or changed and stamping the resulting emission's `origin` with `kind:
 * "world"` — arrival facts only, no speaker, per
 * https://github.com/floe-ai/floe-subtrate/issues/145.
 *
 * A later mutation of the same file is just another observation, another
 * event — not a correction of the first one. What floe acted on is fixed at
 * observed_at plus the raw reference, so the file changing after that point
 * is someone else's problem to reconcile, never floe's to detect.
 */
import { existsSync, statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";

export type FileArrival = {
  file_path: string;
  file_name: string;
  observed_at: string;
};

/**
 * Watches `folderPath` (non-recursive) and invokes `onFile` once per
 * filesystem notification that resolves to an existing file — both file
 * creation and file modification are arrivals worth observing.
 *
 * Returns an unsubscribe function that stops the watcher.
 */
export function watchFolder(folderPath: string, onFile: (arrival: FileArrival) => void): () => void {
  let watcher: FSWatcher;
  try {
    watcher = fsWatch(folderPath, { persistent: false }, (_eventType, filename) => {
      if (!filename) return;
      const filePath = join(folderPath, filename.toString());
      if (!existsSync(filePath)) return; // removal, not an arrival
      let isFile: boolean;
      try {
        isFile = statSync(filePath).isFile();
      } catch {
        return; // vanished between existsSync and statSync
      }
      if (!isFile) return;
      onFile({
        file_path: filePath,
        file_name: filename.toString(),
        observed_at: new Date().toISOString()
      });
    });
  } catch (error) {
    console.error("[bridge] folder watcher failed to start", { folderPath, error });
    return () => {};
  }
  return () => watcher.close();
}
