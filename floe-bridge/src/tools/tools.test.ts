import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath, validateWorkspaceContainment, safeWorkspacePath } from "./path-scoping.js";
import { truncateOutput } from "./truncation.js";
import { sanitiseEnvironment, listStrippedVarNames } from "./env-sanitise.js";
import { createReadTool } from "./read.js";
import { createLsTool } from "./ls.js";
import { createGrepTool } from "./grep.js";
import { createFindTool } from "./find.js";
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
