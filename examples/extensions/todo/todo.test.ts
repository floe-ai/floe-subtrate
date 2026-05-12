import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createTodoTools from "./index.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

let workDir: string;

function makeCtx(overrides?: Partial<{ hooks: any }>) {
  const hooks = overrides?.hooks ?? { on: vi.fn() };
  return {
    workspacePath: workDir,
    busClient: {},
    workspaceId: "test-ws",
    extensionName: "todo",
    hooks,
  };
}

function findTool(tools: any[], name: string) {
  const t = tools.find((t: any) => t.name === name);
  if (!t) throw new Error(`Tool "${name}" not found`);
  return t;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "todo-ext-test-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("todo extension", () => {
  it("add creates a todo item with correct shape", async () => {
    const tools = createTodoTools(makeCtx());
    const add = findTool(tools, "add");

    const result = await add.execute("c1", { text: "Buy milk" });
    const item = result.details.item;

    expect(item.id).toBe("t-1");
    expect(item.text).toBe("Buy milk");
    expect(item.status).toBe("pending");
    expect(item.created_at).toBeTruthy();
    expect(item.updated_at).toBeTruthy();
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Buy milk");
  });

  it("list returns all items", async () => {
    const tools = createTodoTools(makeCtx());
    const add = findTool(tools, "add");
    const list = findTool(tools, "list");

    await add.execute("c1", { text: "Item one" });
    await add.execute("c2", { text: "Item two" });

    const result = await list.execute("c3", {});
    expect(result.details.count).toBe(2);
    expect(result.details.items).toHaveLength(2);
  });

  it("list filters by status", async () => {
    const tools = createTodoTools(makeCtx());
    const add = findTool(tools, "add");
    const update = findTool(tools, "update");
    const list = findTool(tools, "list");

    await add.execute("c1", { text: "A" });
    await add.execute("c2", { text: "B" });
    await update.execute("c3", { id: "t-2", status: "done" });

    const pending = await list.execute("c4", { status: "pending" });
    expect(pending.details.count).toBe(1);
    expect(pending.details.items[0].text).toBe("A");

    const done = await list.execute("c5", { status: "done" });
    expect(done.details.count).toBe(1);
    expect(done.details.items[0].text).toBe("B");
  });

  it("update changes text", async () => {
    const tools = createTodoTools(makeCtx());
    const add = findTool(tools, "add");
    const update = findTool(tools, "update");

    await add.execute("c1", { text: "Old text" });
    const result = await update.execute("c2", { id: "t-1", text: "New text" });

    expect(result.details.item.text).toBe("New text");
    expect(result.details.item.status).toBe("pending");
  });

  it("update changes status", async () => {
    const tools = createTodoTools(makeCtx());
    const add = findTool(tools, "add");
    const update = findTool(tools, "update");

    await add.execute("c1", { text: "Do thing" });
    const result = await update.execute("c2", { id: "t-1", status: "done" });

    expect(result.details.item.status).toBe("done");
    expect(result.content[0].text).toContain("done");
  });

  it("update fails for invalid id", async () => {
    const tools = createTodoTools(makeCtx());
    const update = findTool(tools, "update");

    const result = await update.execute("c1", { id: "t-999" });
    expect(result.details.error).toBe(true);
    expect(result.content[0].text).toContain("no todo");
  });

  it("remove deletes an item", async () => {
    const tools = createTodoTools(makeCtx());
    const add = findTool(tools, "add");
    const remove = findTool(tools, "remove");
    const list = findTool(tools, "list");

    await add.execute("c1", { text: "To remove" });
    const removeResult = await remove.execute("c2", { id: "t-1" });

    expect(removeResult.content[0].text).toContain("Removed");
    const listResult = await list.execute("c3", {});
    expect(listResult.details.count).toBe(0);
  });

  it("remove fails for invalid id", async () => {
    const tools = createTodoTools(makeCtx());
    const remove = findTool(tools, "remove");

    const result = await remove.execute("c1", { id: "t-999" });
    expect(result.details.error).toBe(true);
    expect(result.content[0].text).toContain("no todo");
  });

  it("state persists across separate tool instances", async () => {
    // First instance: add an item
    const tools1 = createTodoTools(makeCtx());
    await findTool(tools1, "add").execute("c1", { text: "Persistent" });

    // Second instance: same workspacePath, should see the item
    const tools2 = createTodoTools(makeCtx());
    const result = await findTool(tools2, "list").execute("c2", {});

    expect(result.details.count).toBe(1);
    expect(result.details.items[0].text).toBe("Persistent");
  });

  it("hook registration works", () => {
    const hookOn = vi.fn();
    const ctx = makeCtx({ hooks: { on: hookOn } });
    createTodoTools(ctx);

    expect(hookOn).toHaveBeenCalledTimes(1);
    expect(hookOn).toHaveBeenCalledWith("TurnEnd", expect.any(Function));
  });

  it("creates state directory if it does not exist", async () => {
    // workDir has no .floe/state/ yet
    const stateDir = join(workDir, ".floe", "state");
    expect(existsSync(stateDir)).toBe(false);

    const tools = createTodoTools(makeCtx());
    await findTool(tools, "add").execute("c1", { text: "First" });

    expect(existsSync(stateDir)).toBe(true);
    const raw = readFileSync(join(stateDir, "todo.json"), "utf-8");
    const items = JSON.parse(raw);
    expect(items).toHaveLength(1);
  });
});
