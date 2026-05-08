import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath, validateWorkspaceContainment, safeWorkspacePath } from "./path-scoping.js";
import { truncateOutput } from "./truncation.js";
import { sanitiseEnvironment, listStrippedVarNames } from "./env-sanitise.js";
import { createReadTool } from "./read.js";
import { createLsTool } from "./ls.js";
import { createGrepTool } from "./grep.js";
import { createFindTool } from "./find.js";
import { createWriteTool } from "./write.js";
import { createEditTool } from "./edit.js";
import { normalizeForFuzzyMatch, fuzzyFindText, applyEditsToNormalizedContent, generateDiffString, stripBom, detectLineEnding } from "./edit-diff.js";
import type { ToolContext, ToolActivityEntry } from "./types.js";

// --- Path scoping tests ---

describe("path-scoping", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-test-path-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const x = 1;");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("resolves relative paths within workspace", () => {
    const result = resolveWorkspacePath(workspace, "src/index.ts");
    expect(result).toBe(join(workspace, "src", "index.ts"));
  });

  it("resolves absolute paths within workspace", () => {
    const absPath = join(workspace, "src", "index.ts");
    const result = resolveWorkspacePath(workspace, absPath);
    expect(result).toBe(absPath);
  });

  it("validates containment for valid paths", () => {
    const resolved = resolveWorkspacePath(workspace, "src/index.ts");
    expect(validateWorkspaceContainment(workspace, resolved)).toBeNull();
  });

  it("rejects paths that escape workspace", () => {
    const resolved = resolveWorkspacePath(workspace, "../../../etc/passwd");
    const error = validateWorkspaceContainment(workspace, resolved);
    expect(error).toContain("outside the workspace root");
  });

  it("safeWorkspacePath returns ok:true for valid paths", () => {
    const result = safeWorkspacePath(workspace, "src/index.ts");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(workspace, "src", "index.ts"));
    }
  });

  it("safeWorkspacePath returns ok:false for escape paths", () => {
    const result = safeWorkspacePath(workspace, "../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("outside the workspace root");
    }
  });
});

// --- Truncation tests ---

describe("truncation", () => {
  it("does not truncate small output", () => {
    const result = truncateOutput("line 1\nline 2\nline 3");
    expect(result.truncated).toBe(false);
    expect(result.text).toBe("line 1\nline 2\nline 3");
  });

  it("truncates by line count (tail)", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const result = truncateOutput(lines.join("\n"), { maxLines: 10 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("line 100");
    expect(result.text).toContain("line 91");
    expect(result.text).toContain("[truncated");
    expect(result.original_lines).toBe(100);
  });

  it("truncates by byte size", () => {
    const bigText = "A".repeat(100_000);
    const result = truncateOutput(bigText, { maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf-8")).toBeLessThan(2000); // notice + content
  });

  it("head truncation keeps first lines", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const result = truncateOutput(lines.join("\n"), { maxLines: 10, strategy: "head" });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("line 1");
    expect(result.text).toContain("line 10");
    expect(result.text).not.toContain("line 100");
  });
});

// --- Environment sanitisation tests ---

describe("env-sanitise", () => {
  it("strips Floe-managed env vars", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      FLOE_AUTH_TOKEN: "secret-token",
      GITHUB_TOKEN: "gh-token",
      OPENAI_API_KEY: "sk-123",
      NORMAL_VAR: "keep-me",
    };
    const result = sanitiseEnvironment(env as any);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.NORMAL_VAR).toBe("keep-me");
    expect(result.FLOE_AUTH_TOKEN).toBeUndefined();
    expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it("lists stripped var names without values", () => {
    const env = {
      PATH: "/usr/bin",
      FLOE_SECRET: "secret",
      COPILOT_TOKEN: "token",
    };
    const stripped = listStrippedVarNames(env as any);
    expect(stripped).toContain("FLOE_SECRET");
    expect(stripped).toContain("COPILOT_TOKEN");
    expect(stripped).not.toContain("PATH");
  });
});

// --- Tool tests ---

function createTestContext(workspaceRoot: string): ToolContext & { toolActivity: ToolActivityEntry[] } {
  const toolActivity: ToolActivityEntry[] = [];
  return {
    workspaceRoot,
    toolActivity,
    getActiveTurn: () => ({ tool_activity: toolActivity }),
  };
}

describe("read tool", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-test-read-"));
    writeFileSync(join(workspace, "hello.txt"), "line 1\nline 2\nline 3\nline 4\nline 5");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("reads an entire file with line numbers", async () => {
    const ctx = createTestContext(workspace);
    const tool = createReadTool(ctx);
    // Simulate tool_activity entry (normally done by adapter on tool_execution_start)
    ctx.toolActivity.push({ name: "read", call_id: "tc1" });
    const result = await tool.execute("tc1", { path: "hello.txt" });
    expect(result.content[0].text).toContain("1. line 1");
    expect(result.content[0].text).toContain("5. line 5");
    expect(result.details?.ok).toBe(true);
  });

  it("reads a line range", async () => {
    const ctx = createTestContext(workspace);
    const tool = createReadTool(ctx);
    ctx.toolActivity.push({ name: "read", call_id: "tc2" });
    const result = await tool.execute("tc2", { path: "hello.txt", start_line: 2, end_line: 4 });
    expect(result.content[0].text).toContain("2. line 2");
    expect(result.content[0].text).toContain("4. line 4");
    expect(result.content[0].text).not.toContain("1. line 1");
    expect(result.content[0].text).not.toContain("5. line 5");
  });

  it("rejects paths outside workspace", async () => {
    const ctx = createTestContext(workspace);
    const tool = createReadTool(ctx);
    ctx.toolActivity.push({ name: "read", call_id: "tc3" });
    const result = await tool.execute("tc3", { path: "../../../etc/passwd" });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("outside the workspace root");
  });

  it("reports file not found", async () => {
    const ctx = createTestContext(workspace);
    const tool = createReadTool(ctx);
    ctx.toolActivity.push({ name: "read", call_id: "tc4" });
    const result = await tool.execute("tc4", { path: "nonexistent.txt" });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("File not found");
  });

  it("enriches tool activity with summary and duration", async () => {
    const ctx = createTestContext(workspace);
    const tool = createReadTool(ctx);
    ctx.toolActivity.push({ name: "read", call_id: "tc5" });
    await tool.execute("tc5", { path: "hello.txt" });
    const entry = ctx.toolActivity.find((t) => t.call_id === "tc5");
    expect(entry?.summary).toContain("read hello.txt");
    expect(entry?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(entry?.files_touched).toEqual(["hello.txt"]);
  });
});

describe("ls tool", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-test-ls-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "README.md"), "# Hello");
    writeFileSync(join(workspace, "src", "index.ts"), "export {};");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("lists workspace root", async () => {
    const ctx = createTestContext(workspace);
    const tool = createLsTool(ctx);
    ctx.toolActivity.push({ name: "ls", call_id: "tc1" });
    const result = await tool.execute("tc1", {});
    expect(result.content[0].text).toContain("src/");
    expect(result.content[0].text).toContain("README.md");
    expect(result.details?.ok).toBe(true);
  });

  it("lists a subdirectory", async () => {
    const ctx = createTestContext(workspace);
    const tool = createLsTool(ctx);
    ctx.toolActivity.push({ name: "ls", call_id: "tc2" });
    const result = await tool.execute("tc2", { path: "src" });
    expect(result.content[0].text).toContain("index.ts");
    expect(result.content[0].text).not.toContain("README.md");
  });

  it("rejects paths outside workspace", async () => {
    const ctx = createTestContext(workspace);
    const tool = createLsTool(ctx);
    ctx.toolActivity.push({ name: "ls", call_id: "tc3" });
    const result = await tool.execute("tc3", { path: "../../.." });
    expect(result.details?.ok).toBe(false);
  });
});

describe("grep tool", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-test-grep-"));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "main.ts"), "function hello() {\n  return 'world';\n}\n");
    writeFileSync(join(workspace, "src", "util.ts"), "export function greet(name: string) {\n  return `Hello ${name}`;\n}\n");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("finds matches in files", async () => {
    const ctx = createTestContext(workspace);
    const tool = createGrepTool(ctx);
    ctx.toolActivity.push({ name: "grep", call_id: "tc1" });
    const result = await tool.execute("tc1", { pattern: "function" });
    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("function");
    expect((result.details as any).matches).toBeGreaterThanOrEqual(2);
  });

  it("returns no matches gracefully", async () => {
    const ctx = createTestContext(workspace);
    const tool = createGrepTool(ctx);
    ctx.toolActivity.push({ name: "grep", call_id: "tc2" });
    const result = await tool.execute("tc2", { pattern: "zzz_nonexistent_pattern_zzz" });
    expect(result.details?.ok).toBe(true);
    expect((result.details as any).matches).toBe(0);
    expect(result.content[0].text).toContain("(no matches)");
  });

  it("supports fixed string matching", async () => {
    const ctx = createTestContext(workspace);
    const tool = createGrepTool(ctx);
    ctx.toolActivity.push({ name: "grep", call_id: "tc3" });
    const result = await tool.execute("tc3", { pattern: "return 'world'", fixed_string: true });
    expect(result.details?.ok).toBe(true);
    expect((result.details as any).matches).toBeGreaterThanOrEqual(1);
  });
});

describe("find tool", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-test-find-"));
    mkdirSync(join(workspace, "src", "components"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "");
    writeFileSync(join(workspace, "src", "components", "Button.tsx"), "");
    writeFileSync(join(workspace, "package.json"), "{}");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("finds files by pattern", async () => {
    const ctx = createTestContext(workspace);
    const tool = createFindTool(ctx);
    ctx.toolActivity.push({ name: "find", call_id: "tc1" });
    const result = await tool.execute("tc1", { pattern: "*.ts" });
    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("index.ts");
  });

  it("finds files by glob with extension", async () => {
    const ctx = createTestContext(workspace);
    const tool = createFindTool(ctx);
    ctx.toolActivity.push({ name: "find", call_id: "tc2" });
    const result = await tool.execute("tc2", { pattern: "*.tsx" });
    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("Button.tsx");
  });

  it("finds directories", async () => {
    const ctx = createTestContext(workspace);
    const tool = createFindTool(ctx);
    ctx.toolActivity.push({ name: "find", call_id: "tc3" });
    const result = await tool.execute("tc3", { pattern: "*", type: "directory" });
    expect(result.details?.ok).toBe(true);
    expect(result.content[0].text).toContain("src");
  });
});

// --- Write tool tests ---

describe("write tool", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-test-write-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("creates a new file in workspace", async () => {
    const ctx = createTestContext(workspace);
    const tool = createWriteTool(ctx);
    ctx.toolActivity.push({ name: "write", call_id: "w1" });
    const result = await tool.execute("w1", { path: "hello.txt", content: "Hello, world!" });
    expect(result.details?.ok).toBe(true);
    expect((result.details as any).bytes).toBe(13);
    expect(readFileSync(join(workspace, "hello.txt"), "utf-8")).toBe("Hello, world!");
  });

  it("creates parent directories automatically", async () => {
    const ctx = createTestContext(workspace);
    const tool = createWriteTool(ctx);
    ctx.toolActivity.push({ name: "write", call_id: "w2" });
    const result = await tool.execute("w2", { path: "deep/nested/dir/file.ts", content: "export {};" });
    expect(result.details?.ok).toBe(true);
    expect(existsSync(join(workspace, "deep", "nested", "dir", "file.ts"))).toBe(true);
  });

  it("overwrites an existing file", async () => {
    writeFileSync(join(workspace, "existing.txt"), "old content");
    const ctx = createTestContext(workspace);
    const tool = createWriteTool(ctx);
    ctx.toolActivity.push({ name: "write", call_id: "w3" });
    const result = await tool.execute("w3", { path: "existing.txt", content: "new content" });
    expect(result.details?.ok).toBe(true);
    expect(readFileSync(join(workspace, "existing.txt"), "utf-8")).toBe("new content");
  });

  it("rejects paths that escape workspace", async () => {
    const ctx = createTestContext(workspace);
    const tool = createWriteTool(ctx);
    ctx.toolActivity.push({ name: "write", call_id: "w4" });
    const result = await tool.execute("w4", { path: "../../../etc/pwned", content: "hack" });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("outside the workspace root");
  });

  it("returns error when path is empty", async () => {
    const ctx = createTestContext(workspace);
    const tool = createWriteTool(ctx);
    ctx.toolActivity.push({ name: "write", call_id: "w5" });
    const result = await tool.execute("w5", { path: "", content: "data" });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("path is required");
  });

  it("enriches tool activity on success", async () => {
    const ctx = createTestContext(workspace);
    const tool = createWriteTool(ctx);
    ctx.toolActivity.push({ name: "write", call_id: "w6" });
    await tool.execute("w6", { path: "activity.txt", content: "data" });
    const entry = ctx.toolActivity.find((t) => t.call_id === "w6");
    expect(entry?.summary).toContain("write");
    expect(entry?.summary).toContain("activity.txt");
    expect(entry?.is_error).toBe(false);
    expect(entry?.files_touched).toContain("activity.txt");
    expect(entry?.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// --- Edit-diff utility tests ---

describe("edit-diff utilities", () => {
  it("detects CRLF line endings", () => {
    expect(detectLineEnding("line1\r\nline2\r\n")).toBe("\r\n");
  });

  it("detects LF line endings", () => {
    expect(detectLineEnding("line1\nline2\n")).toBe("\n");
  });

  it("strips BOM from content", () => {
    const result = stripBom("\uFEFFhello");
    expect(result.bom).toBe("\uFEFF");
    expect(result.text).toBe("hello");
  });

  it("no-ops when no BOM present", () => {
    const result = stripBom("hello");
    expect(result.bom).toBe("");
    expect(result.text).toBe("hello");
  });

  it("normalizes smart quotes for fuzzy matching", () => {
    const result = normalizeForFuzzyMatch("\u201CHello\u201D \u2018world\u2019");
    expect(result).toBe('"Hello" \'world\'');
  });

  it("normalizes Unicode dashes", () => {
    const result = normalizeForFuzzyMatch("a\u2014b\u2013c");
    expect(result).toBe("a-b-c");
  });

  it("strips trailing whitespace per line", () => {
    const result = normalizeForFuzzyMatch("hello   \nworld  ");
    expect(result).toBe("hello\nworld");
  });

  it("fuzzyFindText finds exact match", () => {
    const result = fuzzyFindText("const x = 42;", "x = 42");
    expect(result.found).toBe(true);
    expect(result.usedFuzzyMatch).toBe(false);
  });

  it("fuzzyFindText finds fuzzy match with smart quotes", () => {
    const result = fuzzyFindText('const msg = "hello";', 'const msg = \u201Chello\u201D;');
    expect(result.found).toBe(true);
    expect(result.usedFuzzyMatch).toBe(true);
  });

  it("fuzzyFindText returns not-found for missing text", () => {
    const result = fuzzyFindText("const x = 42;", "does not exist");
    expect(result.found).toBe(false);
  });

  it("applyEditsToNormalizedContent applies a single replacement", () => {
    const { baseContent, newContent } = applyEditsToNormalizedContent(
      "const x = 42;\nconst y = 99;\n",
      [{ oldText: "const x = 42;", newText: "const x = 100;" }],
      "test.ts"
    );
    expect(newContent).toContain("const x = 100;");
    expect(newContent).toContain("const y = 99;");
  });

  it("applyEditsToNormalizedContent applies multiple non-overlapping replacements", () => {
    const { newContent } = applyEditsToNormalizedContent(
      "aaa\nbbb\nccc\n",
      [
        { oldText: "aaa", newText: "AAA" },
        { oldText: "ccc", newText: "CCC" }
      ],
      "test.txt"
    );
    expect(newContent).toBe("AAA\nbbb\nCCC\n");
  });

  it("applyEditsToNormalizedContent throws on ambiguous match", () => {
    expect(() =>
      applyEditsToNormalizedContent("aaa\naaa\n", [{ oldText: "aaa", newText: "bbb" }], "dup.txt")
    ).toThrow(/occurrences/);
  });

  it("applyEditsToNormalizedContent throws on missing text", () => {
    expect(() =>
      applyEditsToNormalizedContent("const x = 1;\n", [{ oldText: "missing", newText: "new" }], "miss.txt")
    ).toThrow(/Could not find/);
  });

  it("applyEditsToNormalizedContent throws on overlapping edits", () => {
    expect(() =>
      applyEditsToNormalizedContent("aabbcc", [
        { oldText: "aabb", newText: "XX" },
        { oldText: "bbcc", newText: "YY" }
      ], "overlap.txt")
    ).toThrow(/overlap/);
  });

  it("generateDiffString produces diff with line numbers", () => {
    const { diff, firstChangedLine } = generateDiffString("line1\nline2\n", "line1\nLINE2\n");
    expect(diff).toContain("-");
    expect(diff).toContain("+");
    expect(diff).toContain("line1");
    expect(firstChangedLine).toBe(2);
  });
});

// --- Edit tool tests ---

describe("edit tool", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-test-edit-"));
    writeFileSync(join(workspace, "sample.ts"), "const x = 1;\nconst y = 2;\nconst z = 3;\n");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("performs a single replacement", async () => {
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e1" });
    const result = await tool.execute("e1", {
      path: "sample.ts",
      edits: [{ old_text: "const x = 1;", new_text: "const x = 42;" }]
    });
    expect(result.details?.ok).toBe(true);
    const content = readFileSync(join(workspace, "sample.ts"), "utf-8");
    expect(content).toContain("const x = 42;");
    expect(content).toContain("const y = 2;");
  });

  it("performs multiple non-overlapping replacements", async () => {
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e2" });
    const result = await tool.execute("e2", {
      path: "sample.ts",
      edits: [
        { old_text: "const x = 1;", new_text: "const x = 100;" },
        { old_text: "const z = 3;", new_text: "const z = 300;" }
      ]
    });
    expect(result.details?.ok).toBe(true);
    const content = readFileSync(join(workspace, "sample.ts"), "utf-8");
    expect(content).toContain("const x = 100;");
    expect(content).toContain("const y = 2;");
    expect(content).toContain("const z = 300;");
  });

  it("returns diff in output", async () => {
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e3" });
    const result = await tool.execute("e3", {
      path: "sample.ts",
      edits: [{ old_text: "const y = 2;", new_text: "const y = 99;" }]
    });
    expect(result.details?.ok).toBe(true);
    expect((result.details as any).diff).toContain("+");
    expect((result.details as any).diff).toContain("-");
  });

  it("handles CRLF files", async () => {
    writeFileSync(join(workspace, "crlf.ts"), "aaa\r\nbbb\r\nccc\r\n");
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e4" });
    const result = await tool.execute("e4", {
      path: "crlf.ts",
      edits: [{ old_text: "bbb", new_text: "BBB" }]
    });
    expect(result.details?.ok).toBe(true);
    const content = readFileSync(join(workspace, "crlf.ts"), "utf-8");
    expect(content).toContain("BBB");
    // CRLF should be preserved
    expect(content).toContain("\r\n");
  });

  it("handles fuzzy matching with smart quotes", async () => {
    writeFileSync(join(workspace, "quotes.ts"), 'const msg = "hello";\n');
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e5" });
    const result = await tool.execute("e5", {
      path: "quotes.ts",
      edits: [{ old_text: 'const msg = \u201Chello\u201D;', new_text: 'const msg = "world";' }]
    });
    expect(result.details?.ok).toBe(true);
    const content = readFileSync(join(workspace, "quotes.ts"), "utf-8");
    expect(content).toContain("world");
  });

  it("returns error for file not found", async () => {
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e6" });
    const result = await tool.execute("e6", {
      path: "does-not-exist.ts",
      edits: [{ old_text: "a", new_text: "b" }]
    });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("not found");
  });

  it("returns error for ambiguous match", async () => {
    writeFileSync(join(workspace, "dup.ts"), "aaa\naaa\n");
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e7" });
    const result = await tool.execute("e7", {
      path: "dup.ts",
      edits: [{ old_text: "aaa", new_text: "bbb" }]
    });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("occurrences");
  });

  it("rejects paths that escape workspace", async () => {
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e8" });
    const result = await tool.execute("e8", {
      path: "../../escape.ts",
      edits: [{ old_text: "a", new_text: "b" }]
    });
    expect(result.details?.ok).toBe(false);
    expect(result.content[0].text).toContain("outside the workspace root");
  });

  it("accepts oldText/newText camelCase field names", async () => {
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e9" });
    const result = await tool.execute("e9", {
      path: "sample.ts",
      edits: [{ oldText: "const x = 1;", newText: "const x = 42;" }]
    });
    expect(result.details?.ok).toBe(true);
  });

  it("enriches tool activity on success", async () => {
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e10" });
    await tool.execute("e10", {
      path: "sample.ts",
      edits: [{ old_text: "const x = 1;", new_text: "const x = 0;" }]
    });
    const entry = ctx.toolActivity.find((t) => t.call_id === "e10");
    expect(entry?.summary).toContain("edit");
    expect(entry?.summary).toContain("sample.ts");
    expect(entry?.is_error).toBe(false);
    expect(entry?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("preserves BOM in file", async () => {
    writeFileSync(join(workspace, "bom.txt"), "\uFEFFhello world\n");
    const ctx = createTestContext(workspace);
    const tool = createEditTool(ctx);
    ctx.toolActivity.push({ name: "edit", call_id: "e11" });
    const result = await tool.execute("e11", {
      path: "bom.txt",
      edits: [{ old_text: "hello world", new_text: "goodbye world" }]
    });
    expect(result.details?.ok).toBe(true);
    const content = readFileSync(join(workspace, "bom.txt"), "utf-8");
    expect(content.startsWith("\uFEFF")).toBe(true);
    expect(content).toContain("goodbye world");
  });
});

