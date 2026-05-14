/**
 * Floe actor tools — agent-facing tools for creating and managing actors.
 *
 * Actors are agent definitions stored as `.floe/agents/<id>.md` files with
 * YAML frontmatter. These tools let agents create new actors, list existing
 * ones, and update their configuration — enabling self-organizing workspaces.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import YAML from "yaml";
import type { BusClient } from "../bus-client.js";

const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function parseAgentFile(content: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const marker = "\n---";
  const end = content.indexOf(marker, 3);
  if (end < 0) return { frontmatter: {}, body: content };
  const raw = content.slice(3, end).trim();
  const body = content.slice(end + marker.length).replace(/^\r?\n/, "");
  return {
    frontmatter: YAML.parse(raw) ?? {},
    body,
  };
}

function serializeAgentFile(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${YAML.stringify(frontmatter).trim()}\n---\n${body}`;
}

function addAgentToFloeYaml(floeYamlPath: string, agentId: string): void {
  const content = readFileSync(floeYamlPath, "utf8");
  const doc = YAML.parseDocument(content);

  let agents = doc.get("agents");
  if (!agents) {
    doc.set("agents", doc.createNode([]));
    agents = doc.get("agents");
  }

  const seq = agents as YAML.YAMLSeq;
  const existing = seq.items.find((item: any) => {
    if (YAML.isMap(item)) {
      const idNode = item.get("id");
      return idNode === agentId;
    }
    return false;
  });

  if (!existing) {
    seq.add(doc.createNode({ id: agentId, path: `./agents/${agentId}.md` }));
    writeFileSync(floeYamlPath, doc.toString(), "utf8");
  }
}

export function createActorTools(
  bus: BusClient,
  workspaceId: string,
  workspaceLocator: string | undefined,
): AgentTool[] {
  const createActorTool: AgentTool = {
    name: "create_actor",
    label: "Create Actor",
    description:
      "Create a new agent actor in this workspace. The actor will be registered as an endpoint " +
      "and can receive messages via the event bus. Writes the agent definition file and updates floe.yaml.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "Identifier for the agent (lowercase alphanumeric and hyphens, e.g. 'reviewer'). Used as filename.",
      }),
      name: Type.String({ description: "Display name for the agent (e.g. 'Code Reviewer')" }),
      instructions: Type.String({
        description: "Markdown instructions describing the agent's role and behavior",
      }),
      skills: Type.Optional(
        Type.Array(Type.String(), { description: "Skill paths to include (e.g. '../skills/my-skill')" }),
      ),
    }),
    execute: async (_toolCallId, params: any) => {
      if (!workspaceLocator) {
        return {
          content: [{ type: "text", text: "Cannot create actor: workspace locator is not available." }],
          details: { ok: false, error: "no_workspace_locator" },
        };
      }

      const agentId = String(params.agent_id ?? "").toLowerCase();
      if (!AGENT_ID_RE.test(agentId)) {
        return {
          content: [{ type: "text", text: `Invalid agent_id '${agentId}'. Must be lowercase alphanumeric with hyphens, starting with a letter or digit.` }],
          details: { ok: false, error: "invalid_agent_id" },
        };
      }

      const name = String(params.name);
      const instructions = String(params.instructions);
      const skills: string[] = Array.isArray(params.skills) ? params.skills.map(String) : [];

      const agentsDir = join(workspaceLocator, ".floe", "agents");
      mkdirSync(agentsDir, { recursive: true });

      const agentFilePath = join(agentsDir, `${agentId}.md`);
      if (existsSync(agentFilePath)) {
        return {
          content: [{ type: "text", text: `Actor '${agentId}' already exists at .floe/agents/${agentId}.md. Use update_actor to modify it.` }],
          details: { ok: false, error: "already_exists" },
        };
      }

      const frontmatter: Record<string, unknown> = {
        schema: "floe.agent.v1",
        agent_id: agentId,
        label: name,
        runtime: { engine: "pi" },
        extensions: [],
        skills,
        mcp: [],
        pulse: { inherit: true },
        scope: { paths: ["./"], services: [] },
      };

      const body = `# ${name}\n\n${instructions.trim()}\n`;
      writeFileSync(agentFilePath, serializeAgentFile(frontmatter, body), "utf8");

      const floeYamlPath = join(workspaceLocator, ".floe", "floe.yaml");
      if (existsSync(floeYamlPath)) {
        addAgentToFloeYaml(floeYamlPath, agentId);
      }

      try {
        await bus.requestConfigSnapshot(workspaceId);
      } catch (err) {
        console.error("[bridge] actor create: config snapshot request failed", { agent_id: agentId, error: err });
      }

      return {
        content: [{ type: "text", text: `Actor '${name}' created. It will be addressable as '${agentId}' shortly.` }],
        details: { ok: true, agent_id: agentId },
      };
    },
  };

  const listActorsTool: AgentTool = {
    name: "list_actors",
    label: "List Actors",
    description: "List all agent actors defined in this workspace's floe.yaml.",
    parameters: Type.Object({}),
    execute: async () => {
      if (!workspaceLocator) {
        return {
          content: [{ type: "text", text: "Cannot list actors: workspace locator is not available." }],
          details: { ok: false, error: "no_workspace_locator" },
        };
      }

      const floeYamlPath = join(workspaceLocator, ".floe", "floe.yaml");
      if (!existsSync(floeYamlPath)) {
        return {
          content: [{ type: "text", text: "No floe.yaml found in workspace." }],
          details: { ok: false, error: "no_floe_yaml" },
        };
      }

      const config = YAML.parse(readFileSync(floeYamlPath, "utf8")) ?? {};
      const agentEntries: Array<{ id: string; path?: string; file?: string }> = Array.isArray(config.agents) ? config.agents : [];

      const actors: Array<{ agent_id: string; name: string; file: string }> = [];
      for (const entry of agentEntries) {
        const file = entry.path ?? entry.file ?? `./agents/${entry.id}.md`;
        const resolvedPath = join(workspaceLocator, ".floe", file);
        let name = entry.id;
        if (existsSync(resolvedPath)) {
          try {
            const parsed = parseAgentFile(readFileSync(resolvedPath, "utf8"));
            name = String(parsed.frontmatter.label ?? parsed.frontmatter.name ?? entry.id);
          } catch { /* use fallback name */ }
        }
        actors.push({ agent_id: entry.id, name, file });
      }

      const text = actors.length === 0
        ? "No actors defined in this workspace."
        : actors.map((a) => `- ${a.agent_id}: ${a.name} (${a.file})`).join("\n");

      return {
        content: [{ type: "text", text }],
        details: { ok: true, count: actors.length, actors },
      };
    },
  };

  const updateActorTool: AgentTool = {
    name: "update_actor",
    label: "Update Actor",
    description: "Update an existing agent actor's name, instructions, or skills.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "Which actor to update" }),
      name: Type.Optional(Type.String({ description: "New display name" })),
      instructions: Type.Optional(Type.String({ description: "New markdown instructions" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "New skills list (replaces existing)" })),
    }),
    execute: async (_toolCallId, params: any) => {
      if (!workspaceLocator) {
        return {
          content: [{ type: "text", text: "Cannot update actor: workspace locator is not available." }],
          details: { ok: false, error: "no_workspace_locator" },
        };
      }

      const agentId = String(params.agent_id);
      const agentFilePath = join(workspaceLocator, ".floe", "agents", `${agentId}.md`);
      if (!existsSync(agentFilePath)) {
        return {
          content: [{ type: "text", text: `Actor '${agentId}' not found at .floe/agents/${agentId}.md.` }],
          details: { ok: false, error: "not_found" },
        };
      }

      const content = readFileSync(agentFilePath, "utf8");
      const parsed = parseAgentFile(content);
      const frontmatter = { ...parsed.frontmatter };
      let body = parsed.body;

      if (params.name != null) {
        frontmatter.label = String(params.name);
      }
      if (params.skills != null) {
        frontmatter.skills = Array.isArray(params.skills) ? params.skills.map(String) : [];
      }
      if (params.instructions != null) {
        const displayName = String(frontmatter.label ?? frontmatter.name ?? agentId);
        body = `# ${displayName}\n\n${String(params.instructions).trim()}\n`;
      }

      writeFileSync(agentFilePath, serializeAgentFile(frontmatter, body), "utf8");

      try {
        await bus.requestConfigSnapshot(workspaceId);
      } catch (err) {
        console.error("[bridge] actor update: config snapshot request failed", { agent_id: agentId, error: err });
      }

      return {
        content: [{ type: "text", text: `Actor '${agentId}' updated successfully.` }],
        details: { ok: true, agent_id: agentId },
      };
    },
  };

  return [createActorTool, listActorsTool, updateActorTool];
}
