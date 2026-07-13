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

// ---------------------------------------------------------------------------
// Tests - config hash allow-list (Fix 1: deny-list to allow-list)
// ---------------------------------------------------------------------------

describe("hashFloeDir allow-list (Fix 1: extension data must not change config hash)", () => {
  it("extension data write does NOT change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    // Add an extension manifest to the workspace
    const extDir = join(workspace, ".floe", "extensions", "testExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ name: "testExt", version: "1.0.0" }), "utf8");

    const before = loadProject(workspace).config_hash;

    // Write extension runtime data (board.md under a boards subdir)
    const boardsDir = join(extDir, "boards", "scope-abc");
    mkdirSync(boardsDir, { recursive: true });
    writeFileSync(join(boardsDir, "board.md"), "# Board\n\nsome card data", "utf8");

    // Write a card file inside the same extension data tree
    const cardsDir = join(extDir, "boards", "scope-abc", "cards");
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(join(cardsDir, "card-1.md"), "# Card 1\n\nfrontmatter stuff", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).toBe(before);
  });

  it("changing floe.yaml DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    const yamlPath = join(workspace, ".floe", "floe.yaml");
    const original = readFileSync(yamlPath, "utf8");
    writeFileSync(yamlPath, original + "# extra comment\n", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("changing an agent definition file DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    const agentPath = join(workspace, ".floe", "agents", "floe.md");
    const original = readFileSync(agentPath, "utf8");
    writeFileSync(agentPath, original + "\n\n# extra section", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("changing an extension manifest DOES change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const extDir = join(workspace, ".floe", "extensions", "testExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ name: "testExt", version: "1.0.0" }), "utf8");

    const before = loadProject(workspace).config_hash;

    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ name: "testExt", version: "2.0.0" }), "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).not.toBe(before);
  });

  it("writing non-config files (README, skills, state, mcp) does NOT change the config hash", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const before = loadProject(workspace).config_hash;

    // Overwrite README (not a config file)
    writeFileSync(join(workspace, ".floe", "extensions", "README.md"), "# Changed\n", "utf8");
    // Overwrite skill file
    writeFileSync(join(workspace, ".floe", "skills", "substrate-build", "SKILL.md"), "# Changed skill\n", "utf8");
    // Write a new file into state
    writeFileSync(join(workspace, ".floe", "state", "some-runtime.json"), "{}", "utf8");
    // Write a file into mcp
    writeFileSync(join(workspace, ".floe", "mcp", "README.md"), "# Changed mcp\n", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).toBe(before);
  });

  it("extension entry-point source files are NOT in the config hash (only extension.json is)", () => {
    const workspace = makeTmp();
    ensureProjectTemplate(workspace, "Test");

    const extDir = join(workspace, ".floe", "extensions", "testExt");
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, "extension.json"), JSON.stringify({ name: "testExt", entry: "./index.ts" }), "utf8");
    writeFileSync(join(extDir, "index.ts"), "export default () => [];", "utf8");

    const before = loadProject(workspace).config_hash;

    // Changing the entry-point source must NOT change the hash
    writeFileSync(join(extDir, "index.ts"), "export default () => []; // v2", "utf8");

    const after = loadProject(workspace).config_hash;

    expect(after).toBe(before);
  });
});
