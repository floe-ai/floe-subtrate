import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createActorTools } from "./actor-tools.js";
import type { BusClient } from "../bus-client.js";

function createMockBus(): BusClient & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    requestConfigSnapshot: async (...args: unknown[]) => {
      calls.push({ method: "requestConfigSnapshot", args });
      return { ok: true };
    },
  } as unknown as BusClient & { calls: Array<{ method: string; args: unknown[] }> };
}

function baseFloeYaml() {
  return YAML.stringify({
    schema: "floe.workspace.v1",
    version: 1,
    agents: [{ id: "floe", path: "./agents/floe.md" }],
  });
}

describe("actor-tools", () => {
  let workspace: string;
  let bus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-actor-test-"));
    mkdirSync(join(workspace, ".floe", "agents"), { recursive: true });
    writeFileSync(join(workspace, ".floe", "floe.yaml"), baseFloeYaml(), "utf8");
    writeFileSync(
      join(workspace, ".floe", "agents", "floe.md"),
      `---\nschema: floe.agent.v1\nagent_id: floe\nlabel: Floe\nruntime:\n  engine: pi\n---\n# Floe\n\nDefault agent.\n`,
      "utf8",
    );
    bus = createMockBus();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns 3 tools", () => {
    const tools = createActorTools(bus, "ws_test", workspace);
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(["create_actor", "list_actors", "update_actor"]);
  });

  describe("create_actor", () => {
    it("writes correct frontmatter format", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;
      const result = await createTool.execute("call-1", {
        agent_id: "reviewer",
        name: "Code Reviewer",
        instructions: "You review code for quality and correctness.",
        skills: ["../skills/review-skill"],
      });

      expect((result as any).details.ok).toBe(true);

      const agentPath = join(workspace, ".floe", "agents", "reviewer.md");
      expect(existsSync(agentPath)).toBe(true);

      const content = readFileSync(agentPath, "utf8");
      expect(content).toContain("schema: floe.agent.v1");
      expect(content).toContain("agent_id: reviewer");
      expect(content).toContain("label: Code Reviewer");
      expect(content).toContain("engine: pi");
      expect(content).toContain("# Code Reviewer");
      expect(content).toContain("You review code for quality and correctness.");

      const parsed = YAML.parse(content.split("\n---")[0].replace(/^---\n/, ""));
      expect(parsed.skills).toEqual(["../skills/review-skill"]);
      expect(parsed.pulse).toEqual({ inherit: true });
      expect(parsed.scope).toEqual({ paths: ["./"], services: [] });
    });

    it("updates floe.yaml with new agent entry", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;
      await createTool.execute("call-1", {
        agent_id: "reviewer",
        name: "Code Reviewer",
        instructions: "Review code.",
      });

      const yamlContent = readFileSync(join(workspace, ".floe", "floe.yaml"), "utf8");
      const parsed = YAML.parse(yamlContent);
      expect(parsed.agents).toHaveLength(2);
      expect(parsed.agents[1].id).toBe("reviewer");
      expect(parsed.agents[1].path).toBe("./agents/reviewer.md");
    });

    it("does not duplicate existing agents in floe.yaml", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;

      // Create first
      await createTool.execute("call-1", {
        agent_id: "reviewer",
        name: "Code Reviewer",
        instructions: "Review code.",
      });

      // Attempt to create again — should fail because file exists
      const result = await createTool.execute("call-2", {
        agent_id: "reviewer",
        name: "Code Reviewer",
        instructions: "Review code.",
      });

      expect((result as any).details.ok).toBe(false);
      expect((result as any).details.error).toBe("already_exists");

      const yamlContent = readFileSync(join(workspace, ".floe", "floe.yaml"), "utf8");
      const parsed = YAML.parse(yamlContent);
      expect(parsed.agents).toHaveLength(2);
    });

    it("rejects invalid agent_id", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;

      const result = await createTool.execute("call-1", {
        agent_id: "Invalid Name!",
        name: "Bad",
        instructions: "nope",
      });

      expect((result as any).details.ok).toBe(false);
      expect((result as any).details.error).toBe("invalid_agent_id");
    });

    it("triggers config snapshot request", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;
      await createTool.execute("call-1", {
        agent_id: "helper",
        name: "Helper",
        instructions: "Help out.",
      });

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0].method).toBe("requestConfigSnapshot");
      expect(bus.calls[0].args[0]).toBe("ws_test");
    });

    it("handles missing workspace locator", async () => {
      const tools = createActorTools(bus, "ws_test", undefined);
      const createTool = tools.find((t) => t.name === "create_actor")!;
      const result = await createTool.execute("call-1", {
        agent_id: "reviewer",
        name: "Reviewer",
        instructions: "Review.",
      });

      expect((result as any).details.ok).toBe(false);
      expect((result as any).details.error).toBe("no_workspace_locator");
    });
  });

  describe("list_actors", () => {
    it("returns all agents from floe.yaml", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const listTool = tools.find((t) => t.name === "list_actors")!;
      const result = await listTool.execute("call-1", {});

      expect((result as any).details.ok).toBe(true);
      expect((result as any).details.count).toBe(1);
      expect((result as any).details.actors[0].agent_id).toBe("floe");
      expect((result as any).details.actors[0].name).toBe("Floe");
    });

    it("lists multiple agents after creation", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;
      await createTool.execute("call-1", {
        agent_id: "reviewer",
        name: "Code Reviewer",
        instructions: "Review code.",
      });

      const listTool = tools.find((t) => t.name === "list_actors")!;
      const result = await listTool.execute("call-2", {});

      expect((result as any).details.count).toBe(2);
      const ids = (result as any).details.actors.map((a: any) => a.agent_id);
      expect(ids).toContain("floe");
      expect(ids).toContain("reviewer");
    });
  });

  describe("update_actor", () => {
    it("modifies only specified fields", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const updateTool = tools.find((t) => t.name === "update_actor")!;
      const result = await updateTool.execute("call-1", {
        agent_id: "floe",
        name: "Floe Bot",
      });

      expect((result as any).details.ok).toBe(true);

      const content = readFileSync(join(workspace, ".floe", "agents", "floe.md"), "utf8");
      expect(content).toContain("label: Floe Bot");
      // Original schema should still be present
      expect(content).toContain("schema: floe.agent.v1");
      expect(content).toContain("agent_id: floe");
    });

    it("preserves existing frontmatter fields", async () => {
      // Create an actor with specific fields first
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;
      await createTool.execute("call-1", {
        agent_id: "tester",
        name: "Tester",
        instructions: "Run tests.",
        skills: ["../skills/test-skill"],
      });

      // Update only instructions
      const updateTool = tools.find((t) => t.name === "update_actor")!;
      await updateTool.execute("call-2", {
        agent_id: "tester",
        instructions: "Run all tests and report results.",
      });

      const content = readFileSync(join(workspace, ".floe", "agents", "tester.md"), "utf8");
      expect(content).toContain("Run all tests and report results.");
      // Skills should be preserved
      const fmRaw = content.split("\n---")[0].replace(/^---\n/, "");
      const parsed = YAML.parse(fmRaw);
      expect(parsed.skills).toEqual(["../skills/test-skill"]);
      expect(parsed.label).toBe("Tester");
    });

    it("updates skills when specified", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_actor")!;
      await createTool.execute("call-1", {
        agent_id: "builder",
        name: "Builder",
        instructions: "Build things.",
        skills: ["../skills/old-skill"],
      });

      const updateTool = tools.find((t) => t.name === "update_actor")!;
      await updateTool.execute("call-2", {
        agent_id: "builder",
        skills: ["../skills/new-skill", "../skills/extra-skill"],
      });

      const content = readFileSync(join(workspace, ".floe", "agents", "builder.md"), "utf8");
      const fmRaw = content.split("\n---")[0].replace(/^---\n/, "");
      const parsed = YAML.parse(fmRaw);
      expect(parsed.skills).toEqual(["../skills/new-skill", "../skills/extra-skill"]);
    });

    it("returns error for non-existent actor", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const updateTool = tools.find((t) => t.name === "update_actor")!;
      const result = await updateTool.execute("call-1", {
        agent_id: "nonexistent",
        name: "Ghost",
      });

      expect((result as any).details.ok).toBe(false);
      expect((result as any).details.error).toBe("not_found");
    });

    it("triggers config snapshot request", async () => {
      const tools = createActorTools(bus, "ws_test", workspace);
      const updateTool = tools.find((t) => t.name === "update_actor")!;
      await updateTool.execute("call-1", {
        agent_id: "floe",
        name: "Updated Floe",
      });

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0].method).toBe("requestConfigSnapshot");
    });
  });
});
