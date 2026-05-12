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
  extensions: string[];
};

export type PulseConfig = {
  id: string;
  trigger: { type: string; at?: string; schedule?: string; timezone?: string };
  content: Record<string, unknown>;
  subscribers?: Array<{ endpoint_ref: string }>;
};

export type ProjectLoadResult = {
  config_hash: string;
  agents: AgentConfig[];
  pulses: PulseConfig[];
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
    applied_config: {
      config_id: "cfg_composition_floe_default",
      version: 1,
      source: "initial_template"
    },
    agents: [
      {
        id: "floe",
        path: "./agents/floe.md"
      }
    ],
    pulse: {
      default: "off",
      after_idle: "30m",
      min_interval: "30m"
    },
    state: {
      path: "./state"
    }
  }), "utf8");

  writeFileSync(join(floeDir, "agents", "floe.md"), `---
schema: floe.agent.v1
agent_id: floe
label: Floe
runtime:
  engine: pi
applied_from:
  config_id: cfg_composition_floe_default
  version: 1
extensions: []
skills:
  - ../skills/substrate-build
mcp: []
pulse:
  inherit: true
scope:
  paths:
    - ./
  services: []
---
# Floe

You are Floe, the default agent for this project.

You are a runtime-backed endpoint. Your visible output is work log only — it is
not automatically delivered to anyone. Nobody can see anything you produce unless
you explicitly emit it.

**CRITICAL: You MUST emit a message event before ending every turn where you
received a message from another endpoint.** Using tools (like list_endpoints) is
not communication — only emit delivers your response. If you used tools to gather
information, emit the result to the source endpoint.

When you receive a message and want to reply, use the emit tool with type
"message" addressed to the reply destination from your delivery context.

Use emit to publish messages, progress, review requests, status updates, and
other events into Floe.

If you need a future response before more work can continue, emit an event with
response.expected true and then end your turn normally.

If your work is complete and you are not waiting for anything, emit your final
response and end the turn normally.

Never end a turn without emitting at least one message event if you received a
message that expects a reply.
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
      pulses: [],
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
    const file = typeof entry.file === "string"
      ? entry.file
      : typeof entry.path === "string"
        ? entry.path
        : `agents/${entry.id ?? "floe"}.md`;
    let resolvedPath = join(floeDir, file);
    // Support directory-based agents: agents/<name>/agent.md
    if (!existsSync(resolvedPath) && !file.endsWith(".md")) {
      const dirAgent = join(floeDir, file, "agent.md");
      if (existsSync(dirAgent)) resolvedPath = dirAgent;
    }
    if (!existsSync(resolvedPath)) {
      // Try directory fallback: agents/<id>/agent.md
      const dirFallback = join(floeDir, "agents", entry.id ?? "floe", "agent.md");
      if (existsSync(dirFallback)) {
        resolvedPath = dirFallback;
      } else {
        errors.push(`Agent file is missing: ${file}`);
        continue;
      }
    }
    const parsed = parseAgentFile(readFileSync(resolvedPath, "utf8"));
    const agentId = String(parsed.frontmatter.agent_id ?? entry.id ?? basename(resolvedPath, ".md"));
    if ("endpoint_id" in parsed.frontmatter) {
      warnings.push(`${file} contains endpoint_id; canonical project files should omit workspace-specific endpoint ids`);
    }
    agents.push({
      agent_id: agentId,
      name: String(parsed.frontmatter.name ?? titleCase(agentId)),
      file,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      extensions: Array.isArray(parsed.frontmatter.extensions)
        ? parsed.frontmatter.extensions.map(String)
        : []
    });
  }

  const pulses: PulseConfig[] = Array.isArray(projectConfig.pulses)
    ? projectConfig.pulses.map((p: any) => ({
        id: String(p.id ?? ""),
        trigger: p.trigger ?? { type: "once" },
        content: p.content ?? {},
        subscribers: Array.isArray(p.subscribers) ? p.subscribers : [],
      }))
    : [];

  return {
    config_hash: hashFloeDir(floeDir),
    agents,
    pulses,
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
        engine: "pi"
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
    // Exclude worklogs from config hash — they are runtime artefacts, not config
    if (rel.includes("/worklogs/")) return false;
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
