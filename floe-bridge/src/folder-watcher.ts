/**
 * Folder watching — the deterministic monitor node.
 *
 * This is not a new wake mechanism. It is a doorway that observes a path and
 * fires an EXISTING Scope Graph trigger node (BusStore.fireScopeGraphTrigger,
 * which itself reuses emitTriggerEvent) exactly as any other trigger firing
 * would. The caller folds the arrival facts (channel, locator, observed_at,
 * raw_reference) into that fire's ordinary `content` — there is no separate
 * origin envelope. What lands is just data; what a node does with it is
 * entirely up to that node's own config, never a tag the substrate branches on.
 *
 * A later mutation of the same file is just another observation, another
 * event — not a correction of the first one. What floe acted on is fixed at
 * observed_at plus the raw reference, so the file changing after that point
 * is someone else's problem to reconcile, never floe's to detect.
 */
import { createHash } from "node:crypto";
import { statSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { extname, join, resolve } from "node:path";

export type FileArrival = {
  arrival_id: string;
  file_path: string;
  file_name: string;
  observed_at: string;
};

export type FolderWatchOptions = {
  /** Wait for a path to stop producing filesystem notifications before observing it. */
  settle_ms?: number;
  /** Optional case-insensitive file extensions, with or without a leading dot. */
  extensions?: string[];
};

/**
 * Watches `folderPath` (non-recursive) and invokes `onFile` once per stable
 * file version. Native filesystem notifications are hints rather than arrival
 * identities: duplicate notifications are coalesced, while a later file
 * version (different size or modification time) remains a new observation.
 *
 * Returns an unsubscribe function that stops the watcher.
 */
export function watchFolder(
  folderPath: string,
  onFile: (arrival: FileArrival) => void,
  options: FolderWatchOptions = {}
): () => void {
  let watcher: FSWatcher;
  const settleMs = Math.max(0, options.settle_ms ?? 250);
  const extensions = new Set((options.extensions ?? []).map(value => {
    const normalized = value.trim().toLowerCase();
    return normalized.startsWith(".") ? normalized : `.${normalized}`;
  }).filter(value => value.length > 1));
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const lastArrivalByPath = new Map<string, string>();

  const observe = (filePath: string, fileName: string): void => {
    pending.delete(filePath);
    if (extensions.size > 0 && !extensions.has(extname(fileName).toLowerCase())) return;
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      return;
    }
    if (!stat.isFile()) return;
    const arrivalId = createHash("sha256")
      .update(`${resolve(filePath).toLowerCase()}\0${stat.size}\0${stat.mtimeMs}`)
      .digest("hex");
    if (lastArrivalByPath.get(filePath) === arrivalId) return;
    lastArrivalByPath.set(filePath, arrivalId);
    onFile({
      arrival_id: arrivalId,
      file_path: filePath,
      file_name: fileName,
      observed_at: new Date().toISOString()
    });
  };

  try {
    watcher = fsWatch(folderPath, { persistent: false }, (_eventType, filename) => {
      if (!filename) return;
      const fileName = filename.toString();
      const filePath = join(folderPath, fileName);
      const existing = pending.get(filePath);
      if (existing) clearTimeout(existing);
      pending.set(filePath, setTimeout(() => observe(filePath, fileName), settleMs));
    });
  } catch (error) {
    console.error("[bridge] folder watcher failed to start", { folderPath, error });
    return () => {};
  }
  return () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    watcher.close();
  };
}
