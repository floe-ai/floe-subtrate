import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { watchFolder, type FileArrival } from "./folder-watcher.js";

describe("watchFolder", () => {
  let tmp: string;
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function waitFor<T>(predicate: () => T | undefined, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = () => {
        const value = predicate();
        if (value !== undefined) return resolve(value);
        if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for arrival"));
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  it("fires an arrival with file_path, file_name and an ISO observed_at when a file lands", async () => {
    tmp = mkdtempSync(join(tmpdir(), "floe-folder-watch-"));
    const arrivals: FileArrival[] = [];
    stop = watchFolder(tmp, (arrival) => arrivals.push(arrival));

    const filePath = join(tmp, "note.md");
    writeFileSync(filePath, "# hello", "utf8");

    const arrival = await waitFor(() => arrivals.find((a) => a.file_name === "note.md"));
    expect(arrival.file_path).toBe(filePath);
    expect(arrival.observed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("fires again on a later modification — a mutation is just another observation, not a correction", async () => {
    tmp = mkdtempSync(join(tmpdir(), "floe-folder-watch-"));
    const filePath = join(tmp, "note.md");
    writeFileSync(filePath, "# hello", "utf8");

    const arrivals: FileArrival[] = [];
    stop = watchFolder(tmp, (arrival) => arrivals.push(arrival));

    writeFileSync(filePath, "# hello again", "utf8");
    const arrival = await waitFor(() => arrivals.find((a) => a.file_name === "note.md"));
    expect(arrival.file_path).toBe(filePath);
  });

  it("does not fire for a file removal", async () => {
    tmp = mkdtempSync(join(tmpdir(), "floe-folder-watch-"));
    const filePath = join(tmp, "note.md");
    writeFileSync(filePath, "# hello", "utf8");

    const arrivals: FileArrival[] = [];
    stop = watchFolder(tmp, (arrival) => arrivals.push(arrival));

    rmSync(filePath);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(arrivals).toHaveLength(0);
  });

  it("stops firing once the returned unsubscribe function is called", async () => {
    tmp = mkdtempSync(join(tmpdir(), "floe-folder-watch-"));
    const arrivals: FileArrival[] = [];
    const stopWatching = watchFolder(tmp, (arrival) => arrivals.push(arrival));
    stopWatching();
    stop = null;

    writeFileSync(join(tmp, "late.md"), "# too late", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(arrivals).toHaveLength(0);
  });
});
