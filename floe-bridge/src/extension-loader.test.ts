import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadExtensions } from "./extension-loader.js";
import type { ExtensionContext } from "./extension-loader.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "floe-ext-test-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function baseContext(): Omit<ExtensionContext, "extensionName"> {
  return {
    workspacePath: tempDir,
    busClient: {},
    workspaceId: "test-workspace",
  };
}

function writeExtension(
  name: string,
  manifest: Record<string, unknown>,
  entryContent?: string
) {
  const extDir = join(tempDir, name);
  mkdirSync(extDir, { recursive: true });
  writeFileSync(
    join(extDir, "extension.json"),
    JSON.stringify(manifest, null, 2)
  );
  if (entryContent !== undefined) {
    const entry =
      typeof manifest.entry === "string" ? manifest.entry : "./index.ts";
    writeFileSync(join(extDir, entry.replace(/^\.\//, "")), entryContent);
  }
}

const VALID_ENTRY = `
export default function(ctx) {
  return [
    {
      name: "add",
      label: "Add Item",
      description: "Add an item",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (_id, params) => ({
        content: [{ type: "text", text: "Added: " + (params?.text ?? "") }],
        details: {}
      })
    }
  ];
}
`;

const MULTI_TOOL_ENTRY = `
export default function(ctx) {
  return [
    {
      name: "add",
      label: "Add",
      description: "Add an item",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "added" }], details: {} })
    },
    {
      name: "remove",
      label: "Remove",
      description: "Remove an item",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "removed" }], details: {} })
    }
  ];
}
`;

const EMPTY_TOOLS_ENTRY = `
export default function(ctx) {
  return [];
}
`;

const THROWING_ENTRY = `
export default function(ctx) {
  throw new Error("Extension init failed!");
}
`;

const VALID_MANIFEST = {
  schema: "floe.extension.v1",
  name: "todo",
  description: "Task tracking",
  entry: "./index.ts",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadExtensions", () => {
  it("returns empty array for empty extensions directory", async () => {
    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toEqual([]);
  });

  it("returns empty array for non-existent extensions directory", async () => {
    const result = await loadExtensions(
      join(tempDir, "nonexistent"),
      baseContext()
    );
    expect(result).toEqual([]);
  });

  it("loads a valid extension with tools", async () => {
    writeExtension("todo", VALID_MANIFEST, VALID_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("todo");
    expect(result[0].tools).toHaveLength(1);
    expect(result[0].errors).toHaveLength(0);
  });

  it("prefixes tool names with extension name", async () => {
    writeExtension("todo", VALID_MANIFEST, VALID_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    const tool = result[0].tools[0];
    expect(tool.name).toBe("todo_add");
    // label and description should be unchanged
    expect(tool.label).toBe("Add Item");
    expect(tool.description).toBe("Add an item");
  });

  it("prefixes multiple tool names correctly", async () => {
    writeExtension("tasks", { ...VALID_MANIFEST, name: "tasks" }, MULTI_TOOL_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    expect(result[0].tools).toHaveLength(2);
    expect(result[0].tools[0].name).toBe("tasks_add");
    expect(result[0].tools[1].name).toBe("tasks_remove");
  });

  it("extracts pulse declarations from manifest", async () => {
    const manifest = {
      ...VALID_MANIFEST,
      pulses: [
        {
          id: "daily-review",
          trigger: {
            type: "cron",
            expression: "0 9 * * *",
            timezone: "America/New_York",
          },
          subscribers: ["floe"],
        },
      ],
    };
    writeExtension("todo", manifest, VALID_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    expect(result[0].pulses).toHaveLength(1);
    expect(result[0].pulses[0].id).toBe("daily-review");
    expect(result[0].pulses[0].trigger.type).toBe("cron");
    expect(result[0].pulses[0].subscribers).toEqual(["floe"]);
  });

  it("returns error when extension.json is missing", async () => {
    const extDir = join(tempDir, "broken");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "index.ts"), VALID_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("broken");
    expect(result[0].tools).toHaveLength(0);
    expect(result[0].errors.length).toBeGreaterThan(0);
    expect(result[0].errors[0]).toMatch(/extension\.json/i);
  });

  it("returns error when manifest is missing required name field", async () => {
    writeExtension(
      "bad",
      { schema: "floe.extension.v1", entry: "./index.ts" },
      VALID_ENTRY
    );

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("bad");
    expect(result[0].tools).toHaveLength(0);
    expect(result[0].errors.length).toBeGreaterThan(0);
    expect(result[0].errors[0]).toMatch(/name/i);
  });

  it("returns error when manifest has wrong schema version", async () => {
    writeExtension(
      "wrongver",
      { schema: "floe.extension.v99", name: "wrongver", entry: "./index.ts" },
      VALID_ENTRY
    );

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(1);
    expect(result[0].tools).toHaveLength(0);
    expect(result[0].errors.length).toBeGreaterThan(0);
    expect(result[0].errors[0]).toMatch(/schema/i);
  });

  it("returns error when entry point file is missing", async () => {
    writeExtension("noentry", VALID_MANIFEST);
    // no entry file written

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(1);
    expect(result[0].tools).toHaveLength(0);
    expect(result[0].errors.length).toBeGreaterThan(0);
  });

  it("returns error when entry point factory throws, other extensions still load", async () => {
    writeExtension("broken-ext", { ...VALID_MANIFEST, name: "broken-ext" }, THROWING_ENTRY);
    writeExtension("good-ext", { ...VALID_MANIFEST, name: "good-ext" }, VALID_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(2);

    const broken = result.find((e) => e.name === "broken-ext")!;
    const good = result.find((e) => e.name === "good-ext")!;

    expect(broken.tools).toHaveLength(0);
    expect(broken.errors.length).toBeGreaterThan(0);
    expect(broken.errors[0]).toMatch(/Extension init failed/);

    expect(good.tools).toHaveLength(1);
    expect(good.errors).toHaveLength(0);
  });

  it("loads multiple extensions independently", async () => {
    writeExtension("ext-a", { ...VALID_MANIFEST, name: "ext-a" }, VALID_ENTRY);
    writeExtension("ext-b", { ...VALID_MANIFEST, name: "ext-b" }, MULTI_TOOL_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(2);

    const a = result.find((e) => e.name === "ext-a")!;
    const b = result.find((e) => e.name === "ext-b")!;

    expect(a.tools).toHaveLength(1);
    expect(a.tools[0].name).toBe("ext-a_add");

    expect(b.tools).toHaveLength(2);
    expect(b.tools[0].name).toBe("ext-b_add");
    expect(b.tools[1].name).toBe("ext-b_remove");
  });

  it("handles extension that returns no tools (empty array)", async () => {
    writeExtension("empty", { ...VALID_MANIFEST, name: "empty" }, EMPTY_TOOLS_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("empty");
    expect(result[0].tools).toHaveLength(0);
    expect(result[0].errors).toHaveLength(0);
  });

  it("prefixed tool execute still works", async () => {
    writeExtension("todo", VALID_MANIFEST, VALID_ENTRY);

    const result = await loadExtensions(tempDir, baseContext());
    const tool = result[0].tools[0];
    const execResult = await tool.execute("call-1", { text: "buy milk" });
    expect(execResult.content[0]).toEqual({
      type: "text",
      text: "Added: buy milk",
    });
  });
});
