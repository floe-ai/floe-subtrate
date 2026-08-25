import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BusClient } from "../bus-client.js";
import type { LoadedExtension } from "../extension-loader.js";
import { createActorTools } from "./actor-tools.js";
import { createScopeTools } from "./scope-tools.js";
import { createWorkspaceTools } from "./index.js";
import { createPulseTools } from "./pulse-tools.js";
import type { ToolContext } from "./types.js";

/**
 * The Floe-owned tool catalogue shared by every model runtime.
 * Provider-native tools may supplement this catalogue, but cannot replace it.
 */
export function createRuntimeTools(input: {
  bus: BusClient;
  workspaceId: string;
  workspaceLocator?: string;
  extensions?: LoadedExtension[];
  toolContext: Pick<ToolContext, "getActiveTurn">;
}): AgentTool[] {
  const workspaceTools = input.workspaceLocator
    ? createWorkspaceTools({ workspaceRoot: input.workspaceLocator, ...input.toolContext })
    : [];
  const pulseTools = createPulseTools(input.bus, input.workspaceId, input.workspaceLocator, input.toolContext);
  const actorTools = createActorTools(input.bus, input.workspaceId, input.workspaceLocator);
  const scopeTools = createScopeTools(input.bus, input.workspaceId, input.workspaceLocator);
  const extensionTools = (input.extensions ?? []).flatMap(extension => extension.tools) as AgentTool[];
  return [...pulseTools, ...actorTools, ...scopeTools, ...extensionTools, ...workspaceTools];
}

/** Tool membership is fixed when either runtime creates a model session. */
export function runtimeToolsFingerprint(input: {
  workspaceLocator?: string;
  extensions?: LoadedExtension[];
}): string {
  const extensions = (input.extensions ?? [])
    .map(extension => ({
      name: extension.name,
      tools: extension.tools
        .map((tool: any) => ({ name: tool.name, parameters: tool.parameters }))
        .sort((left: any, right: any) => String(left.name).localeCompare(String(right.name))),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return createHash("sha256")
    .update(JSON.stringify({ workspace: input.workspaceLocator ?? null, extensions }))
    .digest("hex");
}
