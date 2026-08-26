import { describe, expect, it } from "vitest";
import type { BusClient } from "../bus-client.js";
import { createCapabilityTools } from "./capability-tools.js";

function createMockBus(): BusClient & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    discoverCapabilities: async (...args: unknown[]) => {
      calls.push({ method: "discoverCapabilities", args });
      return {
        capabilities: [{
          capability_id: "scope.compose",
          category: "organisation",
          title: "Bus-owned title",
          description: "Bus-owned description that is not duplicated by the Bridge.",
          effect: "write" as const,
          input_schema: {
            type: "object",
            required: ["scope_id"],
            properties: { scope_id: { type: "string", description: "Bus-owned field wording" } },
          },
        }],
      };
    },
    invokeCapability: async (...args: unknown[]) => {
      calls.push({ method: "invokeCapability", args });
      return {
        result: {
          summary: "Bus completed the operation.",
          data: { graph_id: "graph-1", context_id: "context-1" },
        },
      };
    },
  } as unknown as BusClient & { calls: Array<{ method: string; args: unknown[] }> };
}

describe("capability-tools", () => {
  it("keeps the fixed runtime seam to discovery and invocation", () => {
    const names = createCapabilityTools(createMockBus(), "workspace:1", "actor:workspace:1:floe")
      .map((tool) => tool.name);
    expect(names).toEqual(["discover_capabilities", "use_capability"]);
    expect(names).not.toContain("compose_scope");
    expect(names).not.toContain("connect_folder_to_actor");
  });

  it("renders the description and schema returned by the Bus without restating them", async () => {
    const bus = createMockBus();
    const discover = createCapabilityTools(bus, "workspace:1", "actor:workspace:1:floe")[0];
    const result = await discover.execute("discover", { query: "connected operation", limit: 3 });

    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Bus-owned description that is not duplicated by the Bridge.");
    expect(text).toContain("Bus-owned field wording");
    expect(result.details?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability_id: "scope.compose" }),
    ]));
    expect(bus.calls[0]).toEqual({
      method: "discoverCapabilities",
      args: ["workspace:1", { query: "connected operation", category: undefined, limit: 3 }],
    });
  });

  it("invokes a discovered capability with actor attribution", async () => {
    const bus = createMockBus();
    const use = createCapabilityTools(bus, "workspace:1", "actor:workspace:1:floe")[1];
    const result = await use.execute("invoke", {
      capability_id: "scope.compose",
      input: { scope_id: "delivery" },
    });

    expect((result.content[0] as { type: "text"; text: string }).text).toBe(
      "Bus completed the operation.\n\n{\n  \"graph_id\": \"graph-1\",\n  \"context_id\": \"context-1\"\n}",
    );
    expect(result.details).toMatchObject({
      ok: true,
      capability_id: "scope.compose",
      graph_id: "graph-1",
      context_id: "context-1",
    });
    expect(bus.calls[0]).toEqual({
      method: "invokeCapability",
      args: ["workspace:1", "scope.compose", "actor:workspace:1:floe", { scope_id: "delivery" }],
    });
  });
});
