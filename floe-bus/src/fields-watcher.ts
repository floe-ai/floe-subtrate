import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { loadField } from "./fields-store.js";

type Broadcast = (type: string, payload?: Record<string, unknown>) => void;

type WorkspaceRecord = {
  workspace_id?: unknown;
  locator?: unknown;
};

type ParsedFieldFile =
  | { kind: "semantic"; fieldId: string }
  | { kind: "layout"; fieldId: string; renderer: string };

type WatchedWorkspace = {
  workspaceId: string;
  locator: string;
  watcher: FSWatcher;
  ready: Promise<void>;
};

function fieldsDir(locator: string): string {
  return join(locator, ".floe", "fields");
}

function parseFieldFile(filePath: string): ParsedFieldFile | null {
  const name = basename(filePath);
  if (!name.endsWith(".yaml")) return null;
  const withoutSuffix = name.slice(0, -".yaml".length);
  const layoutMarker = ".layout.";
  const layoutIndex = withoutSuffix.indexOf(layoutMarker);
  if (layoutIndex > 0) {
    const fieldId = withoutSuffix.slice(0, layoutIndex);
    const renderer = withoutSuffix.slice(layoutIndex + layoutMarker.length);
    if (!fieldId || !renderer) return null;
    return { kind: "layout", fieldId, renderer };
  }
  if (withoutSuffix.length === 0) return null;
  return { kind: "semantic", fieldId: withoutSuffix };
}

export class FieldsWatcherRegistry {
  private readonly workspaces = new Map<string, WatchedWorkspace>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly broadcast: Broadcast,
    private readonly onError: (error: unknown) => void
  ) {}

  async watchWorkspace(workspace: WorkspaceRecord): Promise<void> {
    if (typeof workspace.workspace_id !== "string" || typeof workspace.locator !== "string") {
      return;
    }
    const existing = this.workspaces.get(workspace.workspace_id);
    if (existing?.locator === workspace.locator) {
      await existing.ready;
      return;
    }
    if (existing) {
      await existing.watcher.close();
      this.workspaces.delete(workspace.workspace_id);
    }

    const dir = fieldsDir(workspace.locator);
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 75, pollInterval: 10 }
    });
    const ready = new Promise<void>((resolve, reject) => {
      watcher.once("ready", () => resolve());
      watcher.once("error", (error) => reject(error));
    });
    const watched: WatchedWorkspace = {
      workspaceId: workspace.workspace_id,
      locator: workspace.locator,
      watcher,
      ready
    };
    this.workspaces.set(workspace.workspace_id, watched);
    watcher.on("add", (filePath) => this.schedule(watched, "write", filePath));
    watcher.on("change", (filePath) => this.schedule(watched, "write", filePath));
    watcher.on("unlink", (filePath) => this.schedule(watched, "delete", filePath));
    watcher.on("error", this.onError);
    await ready;
  }

  watchWorkspaces(workspaces: WorkspaceRecord[]): void {
    for (const workspace of workspaces) {
      void this.watchWorkspace(workspace).catch(this.onError);
    }
  }

  async unwatchWorkspace(workspaceId: string): Promise<void> {
    const existing = this.workspaces.get(workspaceId);
    if (!existing) return;
    this.workspaces.delete(workspaceId);
    for (const key of [...this.timers.keys()]) {
      if (key.startsWith(`${workspaceId}:`)) {
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
      }
    }
    await existing.watcher.close();
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const watchers = [...this.workspaces.values()].map((workspace) => workspace.watcher.close());
    this.workspaces.clear();
    await Promise.all(watchers);
  }

  private schedule(workspace: WatchedWorkspace, event: "write" | "delete", filePath: string): void {
    const parsed = parseFieldFile(filePath);
    if (!parsed) return;
    const key = [
      workspace.workspaceId,
      parsed.fieldId,
      event,
      parsed.kind,
      parsed.kind === "layout" ? parsed.renderer : ""
    ].join(":");
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      try {
        this.handle(workspace, event, parsed);
      } catch (error) {
        this.onError(error);
      }
    }, 50);
    this.timers.set(key, timer);
  }

  private handle(workspace: WatchedWorkspace, event: "write" | "delete", parsed: ParsedFieldFile): void {
    if (event === "delete" && parsed.kind === "semantic") {
      this.broadcast("field.deleted", {
        workspace_id: workspace.workspaceId,
        field_id: parsed.fieldId
      });
      return;
    }
    if (event === "delete" && parsed.kind === "layout") {
      return;
    }

    const loaded = loadField(workspace.locator, parsed.fieldId);
    if (!loaded) return;
    this.broadcast("field.upserted", {
      workspace_id: workspace.workspaceId,
      field_id: parsed.fieldId,
      source: "watcher",
      changed: parsed.kind,
      ...(parsed.kind === "layout" ? { renderer: parsed.renderer } : {})
    });
  }
}
