import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import YAML from "yaml";
import { ensureProjectTemplate, materializeSavedConfig } from "./project.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-project-test-"));
  tmpDirs.push(dir);
  return dir;
}

function readAgentFrontmatter(workspacePath: string, agentFile = "floe.md"): Record<string, unknown> {
  const content = readFileSync(join(workspacePath, ".floe", "agents", agentFile), "utf8");
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  return YAML.parse(content.slice(3, end).trim()) ?? {};
}

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

// ---------------------------------------------------------------------------
// Tests – Issue 1 (fresh default agent template)
// ---------------------------------------------------------------------------

describe("ensureProjectTemplate – default agent file (Issue 1)", () => {
  it("does not write provider or model in the default agent runtime block", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const fm = readAgentFrontmatter(workspace);
    const runtime = (fm.runtime ?? {}) as Record<string, unknown>;

    expect(runtime.engine).toBe("pi");
    expect(runtime).not.toHaveProperty("provider");
    expect(runtime).not.toHaveProperty("model");
  });

  it("does not write auth_profile in the default agent runtime block", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const fm = readAgentFrontmatter(workspace);
    const runtime = (fm.runtime ?? {}) as Record<string, unknown>;

    expect(runtime).not.toHaveProperty("auth_profile");
  });

  it("does not include openai-codex or gpt-5.4-mini anywhere in the default agent file", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const content = readFileSync(join(workspace, ".floe", "agents", "floe.md"), "utf8");

    expect(content).not.toContain("openai-codex");
    expect(content).not.toContain("gpt-5.4-mini");
    expect(content).not.toContain("auth_profile");
  });

  it("is idempotent — does not overwrite an existing .floe directory", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    // Modify the agent file
    const agentPath = join(workspace, ".floe", "agents", "floe.md");
    const original = readFileSync(agentPath, "utf8");

    // Call again — should not overwrite
    ensureProjectTemplate(workspace, "Test Project");

    const after = readFileSync(agentPath, "utf8");
    expect(after).toBe(original);
  });
});

describe("materializeSavedConfig – agent runtime block (Issue 1)", () => {
  it("does not write provider or model in materialized agent runtime block", () => {
    const workspace = makeTmp();
    materializeSavedConfig(workspace, {
      agents: [
        {
          id: "reviewer",
          name: "Reviewer",
          instructions: "You are a code reviewer."
        }
      ]
    });

    const fm = readAgentFrontmatter(workspace, "reviewer.md");
    const runtime = (fm.runtime ?? {}) as Record<string, unknown>;

    expect(runtime.engine).toBe("pi");
    expect(runtime).not.toHaveProperty("provider");
    expect(runtime).not.toHaveProperty("model");
  });
});
