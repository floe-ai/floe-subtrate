/**
 * Actor-safe Bus capabilities.
 *
 * This catalogue is API metadata, not a substrate primitive. Each entry owns
 * the public description and JSON Schema for one semantic operation. The same
 * schema is returned by discovery and compiled by Fastify when the operation
 * is invoked, so runtime tools cannot drift from what the Bus accepts.
 */
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ScopeRemovalBlockedError,
  ScopeRetiredError,
  type BusStore,
} from "./store.js";
import {
  ScopeGraphNodeNotATriggerError,
  ScopeGraphNodeNotFoundError,
  ScopeGraphNotFoundError,
  type ScopeGraphNode,
} from "./scope-graphs.js";
import { PathEscapesRootError, resolveWithinRoot, RootNotFoundError } from "./fs/resolveWithinRoot.js";

type JsonSchema = Record<string, unknown>;
type Broadcast = (type: string, payload?: Record<string, unknown>) => void;

export type ActorCapabilityDescriptor = {
  capability_id: string;
  category: string;
  title: string;
  description: string;
  effect: "read" | "write";
  input_schema: JsonSchema;
};

export type ActorCapabilityResult = {
  summary: string;
  data: Record<string, unknown>;
};

type ActorCapabilityContext = {
  store: BusStore;
  workspaceId: string;
  callerEndpointId: string | null;
  broadcast: Broadcast;
};

type ActorCapabilityDefinition = ActorCapabilityDescriptor & {
  invoke(context: ActorCapabilityContext, input: Record<string, unknown>): ActorCapabilityResult;
};

export class ActorCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ActorCapabilityError";
  }
}

const ID_PATTERN = "^[a-z0-9][a-z0-9-]*$";
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

const nodeIdSchema = {
  type: "string",
  minLength: 1,
  pattern: ID_PATTERN,
  description: "Unique lowercase node id within this composition.",
};

const scopeInspectInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope_id: {
      type: "string",
      minLength: 1,
      description: "Optional Scope id to inspect; omit it to inspect all Scopes.",
    },
  },
};

const scopeComposeInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope_id", "title", "event_nodes", "actor_nodes"],
  properties: {
    scope_id: {
      type: "string",
      pattern: ID_PATTERN,
      description: "Lowercase id for the organising Scope.",
    },
    title: {
      type: "string",
      minLength: 1,
      description: "Human-readable purpose of the Scope.",
    },
    description: {
      type: "string",
      minLength: 1,
      description: "Concise description of the operation and intended outcome.",
    },
    event_nodes: {
      type: "array",
      minItems: 1,
      description: "Events that can land in the shared scoped Context. Omit source for a manually fired Event.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["node_id", "event_type"],
        properties: {
          node_id: nodeIdSchema,
          label: { type: "string", minLength: 1 },
          event_type: {
            type: "string",
            minLength: 1,
            description: "Event type that this node lands in the Context.",
          },
          source: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "path"],
            properties: {
              kind: { const: "folder" },
              path: {
                type: "string",
                minLength: 1,
                description: "Existing workspace-relative folder to observe.",
              },
              extensions: {
                type: "array",
                items: { type: "string", minLength: 1 },
                description: "Optional case-insensitive file extensions accepted by this source, for example ['png', 'jpg'].",
              },
              settle_ms: {
                type: "integer",
                minimum: 0,
                maximum: 60000,
                description: "Optional quiet period used to coalesce native filesystem notifications. Defaults to 250ms.",
              },
            },
          },
        },
      },
    },
    actor_nodes: {
      type: "array",
      description: "Model or human actors that participate in the shared Context.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["node_id", "actor", "event_types"],
        properties: {
          node_id: nodeIdSchema,
          actor: {
            type: "string",
            minLength: 1,
            description: "Actor ref returned by list_endpoints.",
          },
          label: { type: "string", minLength: 1 },
          event_types: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Event types that wake this actor; use an empty array for participation without automatic wake.",
          },
          instructions: {
            type: "string",
            minLength: 1,
            description: "Responsibility that applies only to this actor's placement in this composition.",
          },
        },
      },
    },
    command_nodes: {
      type: "array",
      description: "Optional deterministic commands that participate in the shared Context.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["node_id", "event_types", "command"],
        properties: {
          node_id: nodeIdSchema,
          label: { type: "string", minLength: 1 },
          event_types: {
            type: "array",
            items: { type: "string", minLength: 1 },
            description: "Event types that run this deterministic command.",
          },
          result_event_type: {
            type: "string",
            minLength: 1,
            description: "Event type emitted with the command result; defaults to command.result.",
          },
          command: {
            type: "string",
            minLength: 1,
            description: "Deterministic workspace command; may use named {{input}} placeholders.",
          },
          inputs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "content_key"],
              properties: {
                name: { type: "string", minLength: 1 },
                content_key: { type: "string", minLength: 1 },
                required: { type: "boolean" },
              },
            },
          },
          outputs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "from"],
              properties: {
                name: { type: "string", minLength: 1 },
                from: { enum: ["exit_code", "passed", "stdout", "stderr"] },
              },
            },
          },
        },
      },
    },
  },
};

const scopeFireInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope_id", "event_node_id"],
  properties: {
    scope_id: {
      type: "string",
      minLength: 1,
      description: "Organising Scope id returned by Scope inspection or composition.",
    },
    event_node_id: {
      type: "string",
      minLength: 1,
      description: "Manual Event node id to fire.",
    },
    content: {
      type: "object",
      additionalProperties: true,
      description: "Facts or work contract delivered with the Event.",
    },
  },
};

const scopeRetireInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope_id"],
  properties: {
    scope_id: {
      type: "string",
      pattern: ID_PATTERN,
      description: "Scope id to make inert while preserving its Context and Event history.",
    },
  },
};

const scopeRemoveInputSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scope_id"],
  properties: {
    scope_id: {
      type: "string",
      pattern: ID_PATTERN,
      description: "Obsolete Scope id returned by Scope inspection.",
    },
  },
};

function inspectScopes(context: ActorCapabilityContext, input: Record<string, unknown>): ActorCapabilityResult {
  const requested = typeof input.scope_id === "string" ? input.scope_id.trim() : "";
  const scopes = context.store.listScopes(context.workspaceId);
  const selected = requested ? scopes.filter((scope) => scope.scope_id === requested) : scopes;
  if (requested && selected.length === 0) {
    throw new ActorCapabilityError("scope_not_found", `Scope '${requested}' does not exist.`, 404, { scope_id: requested });
  }
  const compositions = selected.map((scope) => {
    const composition = context.store.getScopeGraphForScope(context.workspaceId, scope.scope_id);
    const deliveries = composition ? context.store.db.prepare(`
      SELECT d.delivery_id, d.endpoint_id, d.trigger_event_id, d.state, d.last_error, d.created_at
      FROM delivery_bundles d
      JOIN events e ON e.event_id = d.trigger_event_id
      WHERE e.context_id = ?
      ORDER BY d.created_at ASC
    `).all(composition.context_id) as Array<{
      delivery_id: string;
      endpoint_id: string;
      trigger_event_id: string;
      state: string;
      last_error: string | null;
      created_at: string;
    }> : [];
    const latestByInvocation = new Map<string, typeof deliveries[number]>();
    for (const delivery of deliveries) {
      latestByInvocation.set(`${delivery.endpoint_id}:${delivery.trigger_event_id}`, delivery);
    }
    const latestDeliveries = [...latestByInvocation.values()];
    const active = latestDeliveries.filter(delivery =>
      ["reserved", "delivered_to_bridge", "injected_to_runtime"].includes(delivery.state)
    );
    const attention = latestDeliveries.filter(delivery =>
      ["failed", "dead_lettered", "deferred"].includes(delivery.state)
    );
    const queuedEventCount = composition ? Number((context.store.db.prepare(`
      SELECT COUNT(*) AS count
      FROM event_queue q
      JOIN events e ON e.event_id = q.event_id
      WHERE e.context_id = ? AND q.state = 'queued'
    `).get(composition.context_id) as { count: number }).count) : 0;
    const latestEvents = composition ? context.store.db.prepare(`
      SELECT event_id, type, created_at
      FROM events
      WHERE context_id = ?
      ORDER BY created_at DESC
      LIMIT 5
    `).all(composition.context_id) : [];
    const operationState = active.length > 0
      ? "working"
      : queuedEventCount > 0
        ? "queued"
        : attention.length > 0
          ? "attention"
          : "settled";
    return {
    ...scope,
      composition: composition ? {
        graph_id: composition.graph_id,
        context_id: composition.context_id,
        nodes: composition.nodes,
        created_at: composition.created_at,
        updated_at: composition.updated_at,
        operation: {
          state: operationState,
          active_deliveries: active,
          queued_event_count: queuedEventCount,
          attention_deliveries: attention,
          latest_events: latestEvents,
          completion_note: operationState === "settled"
            ? "No work is currently active or queued. Confirm the expected terminal event or artifact before claiming the outcome is complete."
            : null,
        },
      } : null,
    };
  });
  return {
    summary: compositions.length === 0
      ? "No Scopes have been composed in this workspace."
      : `Found ${compositions.length} Scope${compositions.length === 1 ? "" : "s"} and their current organisation.`,
    data: { scopes: compositions },
  };
}

function commandEndpointId(workspaceId: string, scopeId: string, nodeId: string): string {
  return `command:${workspaceId}:${scopeId}:${nodeId}:${randomUUID()}`;
}

function composeScope(context: ActorCapabilityContext, input: Record<string, unknown>): ActorCapabilityResult {
  const scopeId = String(input.scope_id);
  const eventInputs = input.event_nodes as Array<Record<string, any>>;
  const actorInputs = input.actor_nodes as Array<Record<string, any>>;
  const commandInputs = (input.command_nodes ?? []) as Array<Record<string, any>>;
  const existingComposition = context.store.getScopeGraphForScope(context.workspaceId, scopeId);
  const existingCommandEndpoints = new Map(
    (existingComposition?.nodes ?? [])
      .filter((node): node is Extract<ScopeGraphNode, { kind: "command" }> => node.kind === "command")
      .map((node) => [node.node_id, node.endpoint_id]),
  );
  if (actorInputs.length + commandInputs.length === 0) {
    throw new ActorCapabilityError(
      "incomplete_composition",
      "A composition needs at least one Actor or Command node.",
    );
  }

  const seenNodeIds = new Set<string>();
  for (const node of [...eventInputs, ...actorInputs, ...commandInputs]) {
    const nodeId = String(node.node_id ?? "");
    if (!ID_RE.test(nodeId)) {
      throw new ActorCapabilityError("invalid_node_id", `Node id '${nodeId}' must be lowercase alphanumeric with optional hyphens.`);
    }
    if (seenNodeIds.has(nodeId)) {
      throw new ActorCapabilityError("invalid_node_id", `Node id '${nodeId}' is duplicated.`);
    }
    seenNodeIds.add(nodeId);
  }

  const workspace = context.store.getWorkspace(context.workspaceId) as { locator?: string } | undefined;
  if (!workspace?.locator) {
    throw new ActorCapabilityError("workspace_not_found", "The workspace locator is unavailable.", 404);
  }
  for (const node of eventInputs) {
    if (node.source?.kind !== "folder") continue;
    const relativePath = String(node.source.path);
    try {
      const path = resolveWithinRoot(workspace.locator, relativePath);
      if (!existsSync(path) || !statSync(path).isDirectory()) {
        throw new ActorCapabilityError("folder_not_found", `Folder not found: '${relativePath}'.`);
      }
    } catch (error) {
      if (error instanceof ActorCapabilityError) throw error;
      if (error instanceof PathEscapesRootError || error instanceof RootNotFoundError) {
        throw new ActorCapabilityError("invalid_folder_source", error.message);
      }
      throw error;
    }
  }

  const actorNodes: ScopeGraphNode[] = actorInputs.map((actor) => {
    const actorRef = String(actor.actor);
    const endpointId = context.store.resolveSubscriberEndpointId(context.workspaceId, actorRef);
    const endpoint = context.store.getEndpoint(endpointId) as { workspace_id?: string } | null;
    if (!endpoint || endpoint.workspace_id !== context.workspaceId) {
      throw new ActorCapabilityError("actor_not_found", `Actor '${actorRef}' is not attached to this workspace.`, 404, { actor: actorRef });
    }
    const instructions = typeof actor.instructions === "string" ? actor.instructions.trim() : "";
    return {
      node_id: String(actor.node_id),
      kind: "actor",
      label: typeof actor.label === "string" ? actor.label : actorRef,
      endpoint_id: endpointId,
      event_types: actor.event_types as string[],
      ...(instructions ? { bindings: [{ kind: "instructions" as const, text: instructions }] } : {}),
    };
  });
  const eventNodes: ScopeGraphNode[] = eventInputs.map((event) => ({
    node_id: String(event.node_id),
    kind: "trigger",
    label: typeof event.label === "string" ? event.label : undefined,
    event_type: String(event.event_type),
    ...(event.source ? { source: event.source } : {}),
  }));
  const commandNodes: ScopeGraphNode[] = commandInputs.map((command) => ({
    node_id: String(command.node_id),
    kind: "command",
    label: typeof command.label === "string" ? command.label : undefined,
    endpoint_id: existingCommandEndpoints.get(String(command.node_id))
      ?? commandEndpointId(context.workspaceId, scopeId, String(command.node_id)),
    event_types: command.event_types as string[],
    result_event_type: typeof command.result_event_type === "string" ? command.result_event_type : undefined,
    command: String(command.command),
    inputs: command.inputs,
    outputs: command.outputs,
  }));

  let scopeCreated = false;
  try {
    const existingScope = context.store.getScope(context.workspaceId, scopeId);
    if (!existingScope) {
      context.store.createScope({
        workspace_id: context.workspaceId,
        scope_id: scopeId,
        title: String(input.title),
        description: typeof input.description === "string" ? input.description : null,
      }, context.broadcast);
      scopeCreated = true;
    }
    const graph = context.store.createScopeGraph({
      workspace_id: context.workspaceId,
      scope_id: scopeId,
      created_by_endpoint_id: context.callerEndpointId,
      nodes: [...eventNodes, ...actorNodes, ...commandNodes],
    }, context.broadcast);
    if (existingScope) {
      context.store.updateScope({
        workspace_id: context.workspaceId,
        scope_id: scopeId,
        title: String(input.title),
        description: typeof input.description === "string" ? input.description : null,
      }, context.broadcast);
    }
    return {
      summary: `${existingComposition ? "Updated" : "Composed"} Scope '${scopeId}' with ${graph.nodes.length} current nodes${existingComposition ? "; its existing Context history was preserved" : ""}.`,
      data: {
        scope_id: scopeId,
        graph_id: graph.graph_id,
        context_id: graph.context_id,
        nodes: graph.nodes,
      },
    };
  } catch (error) {
    if (scopeCreated) {
      try {
        context.store.deleteScope(context.workspaceId, scopeId, context.broadcast);
      } catch {
        // Preserve the original failure. BusStore's emptiness check prevents
        // deleting any Scope that acquired durable state before the error.
      }
    }
    if (error instanceof ActorCapabilityError) throw error;
    throw new ActorCapabilityError(
      "scope_composition_failed",
      `Could not compose Scope: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function fireScopeEvent(context: ActorCapabilityContext, input: Record<string, unknown>): ActorCapabilityResult {
  const scopeId = String(input.scope_id);
  const graph = context.store.getScopeGraphForScope(context.workspaceId, scopeId);
  if (!graph) {
    throw new ActorCapabilityError("scope_composition_not_found", `Scope '${scopeId}' has no current composition.`, 404);
  }
  try {
    const events = context.store.fireScopeGraphTrigger({
      workspace_id: context.workspaceId,
      graph_id: graph.graph_id,
      node_id: String(input.event_node_id),
      content: input.content && typeof input.content === "object" ? input.content as Record<string, unknown> : {},
      correlation_id: null,
    }, context.broadcast);
    return {
      summary: `Event node '${String(input.event_node_id)}' fired; ${events.length} subscribed participant(s) were woken.`,
      data: { event_count: events.length, events },
    };
  } catch (error) {
    if (error instanceof ScopeGraphNotFoundError) {
      throw new ActorCapabilityError("scope_graph_not_found", error.message, 404);
    }
    if (error instanceof ScopeGraphNodeNotFoundError) {
      throw new ActorCapabilityError("scope_graph_node_not_found", error.message, 404);
    }
    if (error instanceof ScopeGraphNodeNotATriggerError) {
      throw new ActorCapabilityError("scope_graph_node_not_an_event", error.message);
    }
    if (error instanceof ScopeRetiredError) {
      throw new ActorCapabilityError("scope_retired", error.message, 409, { scope_id: scopeId });
    }
    throw error;
  }
}

function retireScope(context: ActorCapabilityContext, input: Record<string, unknown>): ActorCapabilityResult {
  const scopeId = String(input.scope_id);
  if (!context.store.getScope(context.workspaceId, scopeId)) {
    throw new ActorCapabilityError("scope_not_found", `Scope '${scopeId}' does not exist.`, 404, { scope_id: scopeId });
  }
  try {
    const result = context.store.retireScope(context.workspaceId, scopeId, context.broadcast);
    return {
      summary: `Stopped and retired Scope '${scopeId}'. Its queued work, active turns, folder sources, and Pulses were cancelled; its Context and Event history remain available.`,
      data: result,
    };
  } catch (error) {
    throw error;
  }
}

function removeUnusedScope(context: ActorCapabilityContext, input: Record<string, unknown>): ActorCapabilityResult {
  const scopeId = String(input.scope_id);
  if (!context.store.getScope(context.workspaceId, scopeId)) {
    throw new ActorCapabilityError("scope_not_found", `Scope '${scopeId}' does not exist.`, 404, { scope_id: scopeId });
  }
  try {
    const removed = context.store.removeUnusedScope(context.workspaceId, scopeId, context.broadcast);
    return {
      summary: `Removed unused Scope '${scopeId}' and its inactive composition.`,
      data: removed,
    };
  } catch (error) {
    if (error instanceof ScopeRemovalBlockedError) {
      throw new ActorCapabilityError(
        "scope_removal_blocked",
        `Scope '${scopeId}' was not removed because it has historical work, Pulse records, or an Endpoint that is still working. Preserve it and report the concrete blocker instead of deleting evidence or interrupting work.`,
        409,
        {
          scope_id: scopeId,
          event_count: error.event_count,
          pulse_count: error.pulse_count,
          busy_endpoint_count: error.busy_endpoint_count,
        },
      );
    }
    throw error;
  }
}

const definitions: ActorCapabilityDefinition[] = [
  {
    capability_id: "scope.inspect",
    category: "organisation",
    title: "Inspect connected organisation",
    description:
      "Inspect the workspace's durable Scopes, current graph handles, Event/Actor/Command nodes, and live operation state before creating, describing, or claiming completion of connected work.",
    effect: "read",
    input_schema: scopeInspectInputSchema,
    invoke: inspectScopes,
  },
  {
    capability_id: "scope.compose",
    category: "organisation",
    title: "Compose connected operation",
    description:
      "Create or correct the current durable organisation for a connected operation, pipeline, or folder-driven workflow from existing Floe primitives. Reusing a Scope id replaces its current nodes and subscriptions in place while preserving its Context history. Events land in that scoped Context, while Actors and deterministic Commands participate and wake for declared event types. This establishes routing, not opinionated workflow policy.",
    effect: "write",
    input_schema: scopeComposeInputSchema,
    invoke: composeScope,
  },
  {
    capability_id: "scope.event.fire",
    category: "organisation",
    title: "Start a composed operation",
    description:
      "Fire a manual Event node in an active Scope so the Event lands in its Context and wakes subscribed Actors or Commands.",
    effect: "write",
    input_schema: scopeFireInputSchema,
    invoke: fireScopeEvent,
  },
  {
    capability_id: "scope.retire",
    category: "organisation",
    title: "Stop connected work",
    description:
      "Stop a Scope and make it inert without deleting its durable Context or Event history. This cancels queued and active deliveries, scheduled Pulses, and folder sources; active runtimes are interrupted and are never resumed automatically. Retired Scopes cannot route new work and are excluded from the normal operator work surface.",
    effect: "write",
    input_schema: scopeRetireInputSchema,
    invoke: retireScope,
  },
  {
    capability_id: "scope.remove-unused",
    category: "organisation",
    title: "Remove unused organisation",
    description:
      "Remove an obsolete Scope, its authored nodes, and its empty scoped Contexts only when no Event history or Pulse records would be lost. The operation refuses destructive cleanup once work has happened.",
    effect: "write",
    input_schema: scopeRemoveInputSchema,
    invoke: removeUnusedScope,
  },
];

function toDescriptor(definition: ActorCapabilityDefinition): ActorCapabilityDescriptor {
  const { invoke: _invoke, ...descriptor } = definition;
  return descriptor;
}

export function listActorCapabilities(input: { query?: string; category?: string; limit?: number } = {}): ActorCapabilityDescriptor[] {
  const tokens = (input.query ?? "").toLowerCase().split(/\s+/).filter((token) => token.length >= 3);
  const category = input.category?.toLowerCase();
  return definitions
    .filter((definition) => !category || definition.category.toLowerCase() === category)
    .map((definition, index) => {
      const haystack = `${definition.capability_id} ${definition.category} ${definition.title} ${definition.description}`.toLowerCase();
      return {
        definition,
        index,
        score: tokens.filter((token) => haystack.includes(token)).length,
      };
    })
    .filter((candidate) => tokens.length === 0 || candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, input.limit ?? 10)
    .map((candidate) => toDescriptor(candidate.definition));
}

export function getActorCapability(capabilityId: string): ActorCapabilityDescriptor | null {
  const definition = definitions.find((candidate) => candidate.capability_id === capabilityId);
  return definition ? toDescriptor(definition) : null;
}

function invokeActorCapability(
  capabilityId: string,
  context: ActorCapabilityContext,
  input: Record<string, unknown>,
): ActorCapabilityResult {
  const definition = definitions.find((candidate) => candidate.capability_id === capabilityId);
  if (!definition) {
    throw new ActorCapabilityError("capability_not_found", `Capability '${capabilityId}' does not exist.`, 404);
  }
  return definition.invoke(context, input);
}

export function registerActorCapabilityRoutes(
  app: FastifyInstance,
  store: BusStore,
  broadcast: Broadcast,
): void {
  app.get("/v1/workspaces/:workspace_id/capabilities", async (request, reply) => {
    const params = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
    const query = z.object({
      query: z.string().max(200).optional(),
      category: z.string().max(80).optional(),
      limit: z.coerce.number().int().min(1).max(20).default(10),
    }).parse(request.query);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    return { capabilities: listActorCapabilities(query) };
  });

  app.post("/v1/workspaces/:workspace_id/capabilities/:capability_id/invoke", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      capability_id: z.string().min(1),
    }).parse(request.params);
    const body = z.object({
      input: z.record(z.unknown()),
      caller_endpoint_id: z.string().min(1).nullable().optional(),
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    const capability = getActorCapability(params.capability_id);
    if (!capability) {
      return reply.code(404).send({ error: "capability_not_found", capability_id: params.capability_id });
    }
    const validate = request.compileValidationSchema(capability.input_schema, "body");
    if (!validate(body.input)) {
      return reply.code(400).send({
        error: "capability_input_invalid",
        capability_id: params.capability_id,
        validation_errors: validate.errors ?? [],
      });
    }
    try {
      const result = invokeActorCapability(params.capability_id, {
        store,
        workspaceId: params.workspace_id,
        callerEndpointId: body.caller_endpoint_id ?? null,
        broadcast,
      }, body.input);
      return reply.code(capability.effect === "write" ? 201 : 200).send({ result });
    } catch (error) {
      if (error instanceof ActorCapabilityError) {
        return reply.code(error.statusCode).send({
          error: error.code,
          message: error.message,
          ...error.details,
        });
      }
      throw error;
    }
  });
}
