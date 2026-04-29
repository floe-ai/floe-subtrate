import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import YAML from "yaml";

export type AgentConfig = {
  agent_id: string;
  name: string;
  file: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

export type ProjectLoadResult = {
  config_hash: string;
  agents: AgentConfig[];
  validation: {
    ok: boolean;
    warnings: string[];
    errors: string[];
  };
};

export type SavedProjectConfig = {
  agents?: Array<{
    id?: string;
    agent_id?: string;
    name?: string;
    instructions?: string;
    skills?: string[];
  }>;
};

export function ensureProjectTemplate(workspacePath: string, workspaceName: string): void {
  const floeDir = join(workspacePath, ".floe");
  if (existsSync(floeDir)) return;
  mkdirSync(join(floeDir, "agents"), { recursive: true });
  mkdirSync(join(floeDir, "extensions"), { recursive: true });
  mkdirSync(join(floeDir, "skills", "substrate-build"), { recursive: true });
  mkdirSync(join(floeDir, "mcp"), { recursive: true });
  mkdirSync(join(floeDir, "state"), { recursive: true });

  writeFileSync(join(floeDir, "floe.yaml"), YAML.stringify({
    schema: "floe.workspace.v1",
    version: 1,
    name: workspaceName,
    agents: [
      {
        id: "floe",
        file: "agents/floe.md"
      }
    ]
  }), "utf8");

  writeFileSync(join(floeDir, "agents", "floe.md"), `---
schema: floe.agent.v1
agent_id: floe
name: Floe
runtime:
  provider: copilot_cli_sdk
skills:
  - substrate-build
---
# Floe

You are Floe, the default runtime-backed agent for this project.

Use the project-local substrate-build skill when it is available. Inspect and
extend the Floe substrate through the runtime-native tools provided by the
host runtime.

Before calling yield, send a meaningful summary of work completed, findings,
changes, and what you are waiting for. Do not yield with an empty or mechanical
message.
`, "utf8");

  writeFileSync(join(floeDir, "extensions", "README.md"), "# Extensions\n\nProject-local Floe extensions can be placed here.\n", "utf8");
  writeFileSync(join(floeDir, "skills", "substrate-build", "SKILL.md"), `# substrate-build

Use this skill to inspect and extend the Floe substrate. Preserve the daemon
boundary: bus owns durable routing state, bridge owns runtime adaptation, and
web owns the human operator experience.
`, "utf8");
  writeFileSync(join(floeDir, "mcp", "README.md"), "# MCP\n\nReference or copy runtime-native MCP profiles here when needed.\n", "utf8");
  writeFileSync(join(floeDir, "state", "README.md"), "# State\n\nEphemeral project-local Floe runtime state may be placed here.\n", "utf8");
  writeFileSync(join(floeDir, "state", ".gitignore"), "*\n!.gitignore\n!README.md\n", "utf8");
}

export function loadProject(workspacePath: string): ProjectLoadResult {
  const floeDir = join(workspacePath, ".floe");
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!existsSync(floeDir)) {
    return {
      config_hash: "",
      agents: [],
      validation: { ok: false, warnings, errors: [".floe folder is missing"] }
    };
  }

  const projectConfigPath = join(floeDir, "floe.yaml");
  if (!existsSync(projectConfigPath)) errors.push(".floe/floe.yaml is missing");
  let projectConfig: any = {};
  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = YAML.parse(readFileSync(projectConfigPath, "utf8")) ?? {};
      if (projectConfig.schema !== "floe.workspace.v1") warnings.push(".floe/floe.yaml schema is not floe.workspace.v1");
    } catch (error) {
      errors.push(`Unable to parse .floe/floe.yaml: ${(error as Error).message}`);
    }
  }

  const agentEntries = Array.isArray(projectConfig.agents) ? projectConfig.agents : [{ id: "floe", file: "agents/floe.md" }];
  const agents: AgentConfig[] = [];
  for (const entry of agentEntries) {
    const file = typeof entry.file === "string" ? entry.file : `agents/${entry.id ?? "floe"}.md`;
    const path = join(floeDir, file);
    if (!existsSync(path)) {
      errors.push(`Agent file is missing: ${file}`);
      continue;
    }
    const parsed = parseAgentFile(readFileSync(path, "utf8"));
    const agentId = String(parsed.frontmatter.agent_id ?? entry.id ?? basename(file, ".md"));
    if ("endpoint_id" in parsed.frontmatter) {
      warnings.push(`${file} contains endpoint_id; canonical project files should omit workspace-specific endpoint ids`);
    }
    agents.push({
      agent_id: agentId,
      name: String(parsed.frontmatter.name ?? titleCase(agentId)),
      file,
      frontmatter: parsed.frontmatter,
      body: parsed.body
    });
  }

  return {
    config_hash: hashFloeDir(floeDir),
    agents,
    validation: {
      ok: errors.length === 0,
      warnings,
      errors
    }
  };
}

export function materializeSavedConfig(workspacePath: string, config: SavedProjectConfig): ProjectLoadResult {
  ensureProjectTemplate(workspacePath, basename(workspacePath));
  const floeDir = join(workspacePath, ".floe");
  const projectConfigPath = join(floeDir, "floe.yaml");
  const projectConfig = YAML.parse(readFileSync(projectConfigPath, "utf8")) ?? {};
  const agents = Array.isArray(projectConfig.agents) ? [...projectConfig.agents] : [];
  const configuredAgents = Array.isArray(config.agents) ? config.agents : [];

  for (const agent of configuredAgents) {
    const agentId = slug(String(agent.agent_id ?? agent.id ?? ""));
    if (!agentId) continue;
    const name = String(agent.name ?? titleCase(agentId));
    const file = `agents/${agentId}.md`;
    const skills = Array.isArray(agent.skills) ? agent.skills.map(String) : [];
    const body = String(agent.instructions ?? `You are ${name}, a Floe runtime-backed agent for this project.`);
    const frontmatter = {
      schema: "floe.agent.v1",
      agent_id: agentId,
      name,
      runtime: {
        provider: "copilot_cli_sdk"
      },
      skills
    };
    writeFileSync(join(floeDir, file), `---\n${YAML.stringify(frontmatter).trim()}\n---\n# ${name}\n\n${body.trim()}\n`, "utf8");
    const existing = agents.find((entry: any) => entry.id === agentId);
    if (existing) existing.file = file;
    else agents.push({ id: agentId, file });
  }

  projectConfig.agents = agents;
  writeFileSync(projectConfigPath, YAML.stringify(projectConfig), "utf8");
  return loadProject(workspacePath);
}

function parseAgentFile(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const marker = "\n---";
  const end = content.indexOf(marker, 3);
  if (end < 0) return { frontmatter: {}, body: content };
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + marker.length).replace(/^\r?\n/, "");
  return {
    frontmatter: YAML.parse(raw) ?? {},
    body
  };
}

function hashFloeDir(floeDir: string): string {
  const hash = createHash("sha256");
  const files = listFiles(floeDir).filter((file) => {
    const rel = relative(floeDir, file).replace(/\\/g, "/");
    if (rel.startsWith("state/") && rel !== "state/README.md" && rel !== "state/.gitignore") return false;
    return true;
  });
  for (const file of files) {
    const rel = relative(floeDir, file).replace(/\\/g, "/");
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function listFiles(root: string): string[] {
  const results: string[] = [];
  for (const name of readdirSync(root)) {
    const path = resolve(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) results.push(...listFiles(path));
    if (stat.isFile()) results.push(path);
  }
  return results.sort();
}

function titleCase(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
