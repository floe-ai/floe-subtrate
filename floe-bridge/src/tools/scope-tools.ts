import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { BusClient } from "../bus-client.js";
import { safeWorkspacePath } from "./path-scoping.js";

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

function failure(message: string, error: string, details: Record<string, unknown> = {}): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    details: { ok: false, error, ...details },
  };
}

async function ensureScope(
  bus: BusClient,
  workspaceId: string,
  input: { scope_id: string; title: string; description?: string | null },
): Promise<boolean> {
  const scopes = await bus.listScopes(workspaceId);
  if (scopes.some(scope => scope.scope_id === input.scope_id)) return false;
  await bus.createScope({ workspace_id: workspaceId, ...input });
  return true;
}

async function resolveActorNodes(bus: BusClient, workspaceId: string, actorNodes: any[]): Promise<any[]> {
  const resolved = [];
  for (const actor of actorNodes) {
    const actorRef = String(actor.actor ?? "");
    const endpoint = await bus.resolveEndpoint(workspaceId, actorRef);
    if (!endpoint.found) throw new Error(`Actor '${actorRef}' is not attached to this workspace.`);
    const instructions = String(actor.instructions ?? "").trim();
    resolved.push({
      node_id: String(actor.node_id),
      kind: "actor",
      label: actor.label ? String(actor.label) : actorRef,
      endpoint_id: endpoint.endpoint_id,
      event_types: Array.isArray(actor.event_types) ? actor.event_types.map(String) : [],
      ...(instructions ? { bindings: [{ kind: "instructions", text: instructions }] } : {}),
    });
  }
  return resolved;
}

function commandEndpointId(workspaceId: string, scopeId: string, nodeId: string): string {
  return `command:${workspaceId}:${scopeId}:${nodeId}:${randomUUID()}`;
}

function validateNodeIds(nodes: any[]): string | null {
  const seen = new Set<string>();
  for (const node of nodes) {
    const id = String(node.node_id ?? "");
    if (!ID_RE.test(id)) return `Node id '${id}' must be lowercase alphanumeric with optional hyphens.`;
    if (seen.has(id)) return `Node id '${id}' is duplicated.`;
    seen.add(id);
  }
  return null;
}

function validateFolderSources(workspaceLocator: string | undefined, eventNodes: any[]): string | null {
  for (const node of eventNodes) {
    if (node.source?.kind !== "folder") continue;
    if (!workspaceLocator) return "A workspace locator is required for folder Event sources.";
    const path = String(node.source.path ?? "");
    const resolved = safeWorkspacePath(workspaceLocator, path);
    if (!resolved.ok) return resolved.error;
    if (!existsSync(resolved.path) || !statSync(resolved.path).isDirectory()) {
      return `Folder not found: '${path}'.`;
    }
  }
  return null;
}

export function createScopeTools(
  bus: BusClient,
  workspaceId: string,
  workspaceLocator: string | undefined,
): AgentTool[] {
  const inspectScopes: AgentTool = {
    name: "inspect_scopes",
    label: "Inspect Scope Compositions",
    description:
      "Inspect the workspace's durable operational organisation before creating or describing one. " +
      "Returns Scopes and their Event, Actor, and Command nodes; each stored composition owns a Context where its work happens.",
    parameters: Type.Object({
      scope_id: Type.Optional(Type.String({ description: "Optional Scope id to inspect; omit for all Scopes" })),
    }),
    execute: async (_toolCallId, params: any) => {
      const requested = String(params?.scope_id ?? "").trim();
      const [scopes, { graphs }] = await Promise.all([
        bus.listScopes(workspaceId),
        bus.listScopeGraphsForWorkspace(workspaceId),
      ]);
      const selectedScopes = requested ? scopes.filter(scope => scope.scope_id === requested) : scopes;
      if (requested && selectedScopes.length === 0) {
        return failure(`Scope '${requested}' does not exist.`, "scope_not_found", { scope_id: requested });
      }
      const compositions = selectedScopes.map(scope => ({
        ...scope,
        compositions: graphs.filter((graph: any) => graph.scope_id === scope.scope_id),
      }));
      const text = compositions.length === 0
        ? "No Scopes have been composed in this workspace."
        : compositions.map(scope => {
          const nodes = scope.compositions.flatMap((graph: any) => graph.nodes ?? []);
          const summary = nodes.map((node: any) => `${node.kind}:${node.label ?? node.node_id}`).join(", ") || "no nodes";
          return `- ${scope.scope_id}: ${scope.title} (${summary})`;
        }).join("\n");
      return { content: [{ type: "text", text }], details: { ok: true, scopes: compositions } };
    },
  };

  const composeScope: AgentTool = {
    name: "compose_scope",
    label: "Compose Scope",
    description:
      "Create durable Floe organisation from existing primitives: Event nodes land in one scoped Context, and Actor or deterministic Command nodes participate and wake for declared event types. " +
      "Use this for connected or operational work instead of only creating actors, files, conventions, or a detached controller. " +
      "This configures real routing; any workflow policy still belongs in actor/node instructions or an extension.",
    parameters: Type.Object({
      scope_id: Type.String({ description: "Lowercase id for the organising Scope" }),
      title: Type.String({ description: "Human-readable purpose of the Scope" }),
      description: Type.Optional(Type.String({ description: "Concise description of the operation and outcome" })),
      event_nodes: Type.Array(Type.Object({
        node_id: Type.String({ description: "Unique lowercase node id" }),
        label: Type.Optional(Type.String()),
        event_type: Type.String({ description: "Event type this node lands in the Context" }),
        source: Type.Optional(Type.Object({
          kind: Type.Literal("folder"),
          path: Type.String({ description: "Existing workspace-relative folder" }),
        })),
      }), { description: "Manual Event nodes omit source; folder ingress declares source.kind='folder'" }),
      actor_nodes: Type.Array(Type.Object({
        node_id: Type.String({ description: "Unique lowercase node id" }),
        actor: Type.String({ description: "Actor ref as shown by list_endpoints" }),
        label: Type.Optional(Type.String()),
        event_types: Type.Array(Type.String(), { description: "Event types that wake this actor in the Scope Context; use [] for participation without automatic wake" }),
        instructions: Type.Optional(Type.String({ description: "Responsibility that applies only in this Scope composition" })),
      })),
      command_nodes: Type.Optional(Type.Array(Type.Object({
        node_id: Type.String({ description: "Unique lowercase node id" }),
        label: Type.Optional(Type.String()),
        event_types: Type.Array(Type.String(), { description: "Event types that run this deterministic command" }),
        result_event_type: Type.Optional(Type.String({ description: "Event type emitted with the command result" })),
        command: Type.String({ description: "Deterministic workspace command; may use {{input_name}} placeholders" }),
        inputs: Type.Optional(Type.Array(Type.Object({
          name: Type.String(),
          content_key: Type.String(),
          required: Type.Optional(Type.Boolean()),
        }))),
        outputs: Type.Optional(Type.Array(Type.Object({
          name: Type.String(),
          from: Type.Union([
            Type.Literal("exit_code"),
            Type.Literal("passed"),
            Type.Literal("stdout"),
            Type.Literal("stderr"),
          ]),
        }))),
      }))),
    }),
    execute: async (_toolCallId, params: any) => {
      const scopeId = String(params?.scope_id ?? "").toLowerCase();
      if (!ID_RE.test(scopeId)) return failure("scope_id must be lowercase alphanumeric with optional hyphens.", "invalid_scope_id");
      const eventNodes = Array.isArray(params?.event_nodes) ? params.event_nodes : [];
      const actorInputs = Array.isArray(params?.actor_nodes) ? params.actor_nodes : [];
      const commandInputs = Array.isArray(params?.command_nodes) ? params.command_nodes : [];
      if (eventNodes.length === 0 || actorInputs.length + commandInputs.length === 0) {
        return failure("A composition needs at least one Event node and one Actor or Command node.", "incomplete_composition");
      }
      const nodeIdError = validateNodeIds([...eventNodes, ...actorInputs, ...commandInputs]);
      if (nodeIdError) return failure(nodeIdError, "invalid_node_id");
      const folderError = validateFolderSources(workspaceLocator, eventNodes);
      if (folderError) return failure(folderError, "invalid_folder_source");

      let scopeCreated = false;
      try {
        const actorNodes = await resolveActorNodes(bus, workspaceId, actorInputs);
        const commandNodes = commandInputs.map((node: any) => ({
          ...node,
          node_id: String(node.node_id),
          kind: "command",
          endpoint_id: commandEndpointId(workspaceId, scopeId, String(node.node_id)),
        }));
        const normalizedEvents = eventNodes.map((node: any) => ({
          ...node,
          node_id: String(node.node_id),
          kind: "trigger",
          event_type: String(node.event_type),
        }));
        scopeCreated = await ensureScope(bus, workspaceId, {
          scope_id: scopeId,
          title: String(params.title),
          description: params.description ? String(params.description) : null,
        });
        const graph = await bus.createScopeGraph({
          workspace_id: workspaceId,
          scope_id: scopeId,
          created_by_endpoint_id: null,
          nodes: [...normalizedEvents, ...actorNodes, ...commandNodes],
        });
        try {
          await bus.requestConfigSnapshot(workspaceId);
        } catch (error) {
          console.error("[bridge] scope composition: refresh request failed", { scope_id: scopeId, error });
        }
        return {
          content: [{ type: "text", text: `Composed Scope '${scopeId}' with ${graph.nodes.length} nodes. Fire an Event node to start manual work; declared sources remain active after workspace attach.` }],
          details: { ok: true, scope_id: scopeId, graph_id: graph.graph_id, context_id: graph.context_id, nodes: graph.nodes },
        };
      } catch (error: any) {
        if (scopeCreated) {
          try { await bus.deleteScope(workspaceId, scopeId); }
          catch (rollbackError) {
            console.error("[bridge] scope composition: empty scope rollback failed", { scope_id: scopeId, error: rollbackError });
          }
        }
        return failure(`Could not compose Scope: ${error?.message ?? String(error)}`, "composition_failed");
      }
    },
  };

  const fireScopeEvent: AgentTool = {
    name: "fire_scope_event",
    label: "Fire Scope Event",
    description:
      "Activate a manual Event node in an existing Scope composition. The Event lands in that composition's Context and wakes only Actor or Command nodes subscribed to its event type.",
    parameters: Type.Object({
      graph_id: Type.String({ description: "Stored composition id returned by compose_scope or inspect_scopes" }),
      event_node_id: Type.String({ description: "Event node id to fire" }),
      content: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Facts or work contract delivered with the Event" })),
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const result = await bus.fireScopeGraphTriggerNode(
          workspaceId,
          String(params.graph_id),
          String(params.event_node_id),
          { content: params.content && typeof params.content === "object" ? params.content : {} },
        );
        return {
          content: [{ type: "text", text: `Event node '${params.event_node_id}' fired; ${result.events.length} subscribed participant(s) were woken.` }],
          details: { ok: true, event_count: result.events.length, events: result.events },
        };
      } catch (error: any) {
        return failure(`Could not fire Scope Event: ${error?.message ?? String(error)}`, "event_fire_failed");
      }
    },
  };

  const connectFolderToActor: AgentTool = {
    name: "connect_folder_to_actor",
    label: "Connect Folder to Actor",
    description:
      "Shortcut for the common two-node composition: a workspace folder Event source connected to one model actor. Use compose_scope for multi-actor or Event/Command operations.",
    parameters: Type.Object({
      path: Type.String({ description: "Existing folder path relative to the workspace root" }),
      actor_id: Type.String({ description: "Actor ref that should process each arrival" }),
      scope_id: Type.String({ description: "Lowercase id for the operational Scope" }),
      scope_title: Type.String({ description: "Human-readable purpose of the operation" }),
      event_type: Type.String({ description: "Event type emitted for each file" }),
      instructions: Type.Optional(Type.String({ description: "Node-specific responsibility for the actor" })),
    }),
    execute: async (toolCallId, params: any) => composeScope.execute(toolCallId, {
      scope_id: params.scope_id,
      title: params.scope_title,
      description: `Files arriving in ${params.path} are processed by ${params.actor_id}.`,
      event_nodes: [{
        node_id: "folder-arrival",
        label: `${params.path} arrival`,
        event_type: params.event_type,
        source: { kind: "folder", path: params.path },
      }],
      actor_nodes: [{
        node_id: "folder-processor",
        actor: params.actor_id,
        label: params.actor_id,
        event_types: [params.event_type],
        instructions: params.instructions,
      }],
    }),
  };

  return [inspectScopes, composeScope, fireScopeEvent, connectFolderToActor];
}
