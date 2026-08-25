import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BusClient } from "../bus-client.js";
import { createScopeTools } from "./scope-tools.js";

function createMockBus(): BusClient & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    listScopes: async (...args: unknown[]) => {
      calls.push({ method: "listScopes", args });
      return [];
    },
    listScopeGraphsForWorkspace: async (...args: unknown[]) => {
      calls.push({ method: "listScopeGraphsForWorkspace", args });
      return { graphs: [] };
    },
    resolveEndpoint: async (...args: unknown[]) => {
      calls.push({ method: "resolveEndpoint", args });
      return { found: true, endpoint_id: `actor:${args[0]}:${args[1]}` };
    },
    createScope: async (...args: unknown[]) => {
      calls.push({ method: "createScope", args });
      return { scope_id: "delivery" };
    },
    createScopeGraph: async (...args: unknown[]) => {
      calls.push({ method: "createScopeGraph", args });
      const input = args[0] as any;
      return { graph_id: "graph-1", context_id: "context-1", nodes: input.nodes };
    },
    deleteScope: async (...args: unknown[]) => {
      calls.push({ method: "deleteScope", args });
    },
    requestConfigSnapshot: async (...args: unknown[]) => {
      calls.push({ method: "requestConfigSnapshot", args });
      return { ok: true };
    },
    fireScopeGraphTriggerNode: async (...args: unknown[]) => {
      calls.push({ method: "fireScopeGraphTriggerNode", args });
      return { events: [{ event_id: "evt-1" }] };
    },
  } as unknown as BusClient & { calls: Array<{ method: string; args: unknown[] }> };
}

describe("scope-tools", () => {
  let workspace: string;
  let bus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-scope-tools-"));
    bus = createMockBus();
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("exposes generic composition alongside the one-folder shortcut", () => {
    expect(createScopeTools(bus, "ws_test", workspace).map(tool => tool.name)).toEqual([
      "inspect_scopes",
      "compose_scope",
      "fire_scope_event",
      "connect_folder_to_actor",
    ]);
  });

  it("composes Event, Actor, and Command nodes into a real scoped Context", async () => {
    const tool = createScopeTools(bus, "ws_test", workspace).find(item => item.name === "compose_scope")!;
    const result = await tool.execute("call-compose", {
      scope_id: "application-delivery",
      title: "Application delivery",
      event_nodes: [{ node_id: "work-requested", event_type: "application.work.requested" }],
      actor_nodes: [
        {
          node_id: "planner",
          actor: "product-architect",
          event_types: ["application.work.requested"],
          instructions: "Plan the bounded work, then emit application.build.requested to current_context.",
        },
        {
          node_id: "builder",
          actor: "application-builder",
          event_types: ["application.build.requested", "application.rework.requested"],
        },
        {
          node_id: "judge",
          actor: "quality-judge",
          event_types: ["application.review.requested"],
        },
      ],
      command_nodes: [{
        node_id: "documentation-check",
        event_types: ["application.build.completed"],
        command: "npm run docs:check",
        result_event_type: "application.docs.checked",
      }],
    });

    expect(result.details?.ok).toBe(true);
    const graphInput = bus.calls.find(call => call.method === "createScopeGraph")?.args[0] as any;
    expect(graphInput).toMatchObject({
      workspace_id: "ws_test",
      scope_id: "application-delivery",
      nodes: [
        { kind: "trigger", node_id: "work-requested", event_type: "application.work.requested" },
        { kind: "actor", endpoint_id: "actor:ws_test:product-architect" },
        { kind: "actor", endpoint_id: "actor:ws_test:application-builder" },
        { kind: "actor", endpoint_id: "actor:ws_test:quality-judge" },
        {
          kind: "command",
          endpoint_id: expect.stringMatching(/^command:ws_test:application-delivery:documentation-check:/),
          command: "npm run docs:check",
        },
      ],
    });
    expect(bus.calls.at(-1)?.method).toBe("requestConfigSnapshot");
  });

  it("uses an existing Scope without deleting it if graph creation fails", async () => {
    bus.listScopes = vi.fn(async () => [{
      scope_id: "application-delivery",
      workspace_id: "ws_test",
      title: "Application delivery",
      description: null,
      created_at: "now",
      updated_at: "now",
    }]);
    bus.createScopeGraph = vi.fn(async () => { throw new Error("graph rejected"); });
    const tool = createScopeTools(bus, "ws_test", workspace).find(item => item.name === "compose_scope")!;
    const result = await tool.execute("call-compose", {
      scope_id: "application-delivery",
      title: "Application delivery",
      event_nodes: [{ node_id: "start", event_type: "work.requested" }],
      actor_nodes: [{ node_id: "builder", actor: "builder", event_types: ["work.requested"] }],
    });

    expect(result.details?.ok).toBe(false);
    expect(bus.calls.some(call => call.method === "deleteScope")).toBe(false);
  });

  it("keeps the folder shortcut as a real Scope composition", async () => {
    mkdirSync(join(workspace, "concepts"));
    const tool = createScopeTools(bus, "ws_test", workspace).find(item => item.name === "connect_folder_to_actor")!;
    const result = await tool.execute("call-folder", {
      path: "concepts",
      actor_id: "image-worker",
      scope_id: "concept-processing",
      scope_title: "Concept processing",
      event_type: "concept.image.arrived",
      instructions: "Inspect the image.",
    });

    expect(result.details?.ok).toBe(true);
    const graphInput = bus.calls.find(call => call.method === "createScopeGraph")?.args[0] as any;
    expect(graphInput.nodes).toEqual([
      expect.objectContaining({ source: { kind: "folder", path: "concepts" } }),
      expect.objectContaining({ endpoint_id: "actor:ws_test:image-worker" }),
    ]);
  });

  it("inspects compositions and fires a manual Event node", async () => {
    bus.listScopes = vi.fn(async () => [{
      scope_id: "delivery",
      workspace_id: "ws_test",
      title: "Delivery",
      description: null,
      created_at: "now",
      updated_at: "now",
    }]);
    bus.listScopeGraphsForWorkspace = vi.fn(async () => ({ graphs: [{
      graph_id: "graph-1",
      scope_id: "delivery",
      context_id: "context-1",
      nodes: [{ node_id: "start", kind: "trigger", event_type: "work.requested" }],
    }] }));
    const tools = createScopeTools(bus, "ws_test", workspace);

    const inspected = await tools.find(item => item.name === "inspect_scopes")!.execute("inspect", { scope_id: "delivery" });
    expect(inspected.details?.scopes).toEqual([
      expect.objectContaining({ scope_id: "delivery", compositions: [expect.objectContaining({ graph_id: "graph-1" })] }),
    ]);

    const fired = await tools.find(item => item.name === "fire_scope_event")!.execute("fire", {
      graph_id: "graph-1",
      event_node_id: "start",
      content: { app_id: "acme" },
    });
    expect(fired.details?.event_count).toBe(1);
    expect(bus.calls.at(-1)).toEqual({
      method: "fireScopeGraphTriggerNode",
      args: ["ws_test", "graph-1", "start", { content: { app_id: "acme" } }],
    });
  });
});
