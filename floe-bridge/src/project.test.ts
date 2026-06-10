import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import YAML from "yaml";
import { ensureProjectTemplate, loadProject, materializeSavedConfig } from "./project.js";

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

  it("uses the canonical default Floe operating doctrine", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test Project");

    const content = readFileSync(join(workspace, ".floe", "agents", "floe.md"), "utf8");

    expect(content).toContain("You are Floe, the default agent for this project.");
    expect(content).toContain("You are the primary builder/coordinator");
    expect(content).toContain("Route before broad exploration");
    expect(content).toContain("Work from first principles.");
    expect(content).toContain("Be highly token-conscious.");
    expect(content).not.toContain("runtime-backed endpoint");
    expect(content).not.toContain("source endpoint");
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

  it("initializes missing template files when the field directory already exists", () => {
    const workspace = makeTmp();
    mkdirSync(join(workspace, ".floe", "fields"), { recursive: true });

    ensureProjectTemplate(workspace, "Test Project");

    expect(existsSync(join(workspace, ".floe", "fields"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "floe.yaml"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "agents", "floe.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "extensions", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "skills", "substrate-build", "SKILL.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "mcp", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "state", "README.md"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "state", ".gitignore"))).toBe(true);
  });

  it("fills missing canonical files without overwriting existing project config", () => {
    const workspace = makeTmp();
    const floeDir = join(workspace, ".floe");
    const projectConfigPath = join(floeDir, "floe.yaml");
    const customProjectConfig = "schema: floe.workspace.v1\nversion: 99\n";
    mkdirSync(floeDir, { recursive: true });
    writeFileSync(projectConfigPath, customProjectConfig, "utf8");

    ensureProjectTemplate(workspace, "Test Project");

    expect(readFileSync(projectConfigPath, "utf8")).toBe(customProjectConfig);
    expect(existsSync(join(workspace, ".floe", "agents", "floe.md"))).toBe(true);
  });

  it("keeps the project config hash stable across repeated template ensures", () => {
    const workspace = makeTmp();

    ensureProjectTemplate(workspace, "Test Project");
    const first = loadProject(workspace);
    ensureProjectTemplate(workspace, "Test Project");
    const second = loadProject(workspace);

    expect(first.config_hash).toBe(second.config_hash);
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

  it("uses actor-neutral fallback instructions for configured agents", () => {
    const workspace = makeTmp();
    materializeSavedConfig(workspace, {
      agents: [
        {
          id: "reviewer",
          name: "Reviewer"
        }
      ]
    });

    const content = readFileSync(join(workspace, ".floe", "agents", "reviewer.md"), "utf8");

    expect(content).toContain("You are Reviewer, a Floe actor for this project.");
    expect(content).not.toContain("runtime-backed agent");
    expect(content).not.toContain("runtime-backed endpoint");
  });
});
