import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { BusClient } from "../bus-client.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function failure(message: string, error: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: false, error },
  };
}

/**
 * A deliberately stable, small runtime seam. Capability-specific names,
 * descriptions and schemas remain Bus-owned and enter model context only when
 * discovery returns them for a concrete need.
 */
export function createCapabilityTools(
  bus: BusClient,
  workspaceId: string,
  endpointId: string,
): AgentTool[] {
  const discoverCapabilities: AgentTool = {
    name: "discover_capabilities",
    label: "Discover Capabilities",
    description:
      "Find Bus-supported semantic operations for a concrete need. Results include the authoritative capability id, description, effect, and input schema. Search before declaring that Floe cannot organise or perform an outcome.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Short description of the outcome or operation needed" })),
      category: Type.Optional(Type.String({ description: "Optional category returned by an earlier discovery" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum matching capabilities to return" })),
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const result = await bus.discoverCapabilities(workspaceId, {
          query: typeof params?.query === "string" ? params.query : undefined,
          category: typeof params?.category === "string" ? params.category : undefined,
          limit: typeof params?.limit === "number" ? params.limit : undefined,
        });
        const text = result.capabilities.length === 0
          ? "No Bus capability matched that need. Try a shorter outcome-oriented query before concluding the capability is unavailable."
          : result.capabilities.map((capability) =>
            `${capability.capability_id} — ${capability.title}: ${capability.description}\nInput schema: ${JSON.stringify(capability.input_schema)}`
          ).join("\n\n");
        return {
          content: [{ type: "text", text }],
          details: { ok: true, capabilities: result.capabilities },
        };
      } catch (error) {
        return failure(
          `Could not discover capabilities: ${error instanceof Error ? error.message : String(error)}`,
          "capability_discovery_failed",
        );
      }
    },
  };

  const useCapability: AgentTool = {
    name: "use_capability",
    label: "Use Capability",
    description:
      "Invoke one actor-safe Bus capability using the exact id and input schema returned by discover_capabilities. The Bus validates the input and owns the operation.",
    parameters: Type.Object({
      capability_id: Type.String({ description: "Exact capability id returned by discover_capabilities" }),
      input: Type.Object({}, {
        additionalProperties: true,
        description: "Input matching that capability's discovered input_schema",
      }),
    }),
    execute: async (_toolCallId, params: any) => {
      const capabilityId = String(params?.capability_id ?? "").trim();
      if (!capabilityId) return failure("A discovered capability_id is required.", "capability_id_required");
      try {
        const { result } = await bus.invokeCapability(
          workspaceId,
          capabilityId,
          endpointId,
          params?.input && typeof params.input === "object" ? params.input : {},
        );
        return {
          content: [{ type: "text", text: result.summary }],
          details: { ok: true, capability_id: capabilityId, ...result.data },
        };
      } catch (error) {
        return failure(
          `Could not use capability '${capabilityId}': ${error instanceof Error ? error.message : String(error)}`,
          "capability_invocation_failed",
        );
      }
    },
  };

  return [discoverCapabilities, useCapability];
}
