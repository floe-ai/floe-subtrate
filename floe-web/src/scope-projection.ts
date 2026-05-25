import type { Edge, Node } from "@xyflow/react";
import { parseFieldRef, type FieldLayoutFloeweb, type ParsedFieldRef } from "./fields";

export type ScopeRecord = {
  scope_id: string;
  workspace_id: string;
  title: string;
  description?: string | null;
  is_default?: boolean;
  created_at: string;
  updated_at: string;
};

export type ScopeProjectionContextRef = {
  context_id: string;
  workspace_id: string;
  scope_id: string;
  parent_context_id: string | null;
  created_by_endpoint_id: string;
  created_at: string;
  last_event_at: string | null;
  first_message_preview: string | null;
};

export type ScopeProjectionPulseRef = {
  pulse_id: string;
  workspace_id: string;
  scope_id: string;
  persistence: "workspace" | "local";
  status: string;
  trigger: unknown;
  next_fire_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
};

export type ScopeProjectionEventRef = {
  event_id: string;
  type: string;
  workspace_id: string;
  scope_id: string;
  context_id: string | null;
  source_endpoint_id: string | null;
  created_at: string;
};

export type ScopeProjectionActivityRef = {
  telemetry_id: string;
  workspace_id: string;
  endpoint_id: string;
  delivery_id: string;
  kind: string;
  context_id: string | null;
  event_id: string | null;
  created_at: string;
};

export type ScopeProjection = {
  workspace_id: string;
  scope_id: string;
  generated_at: string;
  refs: {
    contexts: ScopeProjectionContextRef[];
    pulses: ScopeProjectionPulseRef[];
    events: ScopeProjectionEventRef[];
    activity: ScopeProjectionActivityRef[];
  };
  relationships: {
    context_participants: Array<{ context_id: string; endpoint_id: string }>;
    pulse_subscribers: Array<{ pulse_id: string; subscriber: { kind?: string; context_id?: string | null; endpoint_ref?: string } }>;
    event_context_ownership: Array<{ event_id: string; context_id: string }>;
  };
  unsupported: Array<{ kind: string; reason: string }>;
};

export type ScopeProjectionNodeKind = "context" | "pulse" | "event" | "activity" | "unsupported";

export type ScopeProjectionNodeData = Record<string, unknown> & {
  ref: ParsedFieldRef;
  kind: ScopeProjectionNodeKind;
  label: string;
};

export type ScopeProjectionFlow = {
  nodes: Node[];
  edges: Edge[];
  unsupported: ScopeProjection["unsupported"];
};

function defaultProjectionLayout(index: number): { x: number; y: number } {
  return {
    x: 80,
    y: 80 + index * 220
  };
}

function projectionNode(
  ref: string,
  kind: ScopeProjectionNodeKind,
  label: string,
  index: number,
  layout?: FieldLayoutFloeweb,
  data: Record<string, unknown> = {}
): Node {
  const positioned = layout?.items[ref];
  return {
    id: ref,
    type: "fieldItem",
    position: positioned ? { x: positioned.x, y: positioned.y } : defaultProjectionLayout(index),
    deletable: false,
    data: {
      ref: parseFieldRef(ref),
      kind,
      label,
      ...data
    } satisfies ScopeProjectionNodeData
  };
}

export function projectionToReactFlow(
  projection: ScopeProjection,
  layout?: FieldLayoutFloeweb | null
): ScopeProjectionFlow {
  const participantsByContext = new Map<string, string[]>();
  for (const relationship of projection.relationships.context_participants) {
    const participants = participantsByContext.get(relationship.context_id) ?? [];
    participants.push(relationship.endpoint_id);
    participantsByContext.set(relationship.context_id, participants);
  }

  const pulseSubscribers = new Map<string, ScopeProjection["relationships"]["pulse_subscribers"]>();
  for (const relationship of projection.relationships.pulse_subscribers) {
    const relationships = pulseSubscribers.get(relationship.pulse_id) ?? [];
    relationships.push(relationship);
    pulseSubscribers.set(relationship.pulse_id, relationships);
  }

  const nodes: Node[] = [];
  for (const context of projection.refs.contexts) {
    const ref = `context:${context.context_id}`;
    const participants = participantsByContext.get(context.context_id) ?? [];
    nodes.push(projectionNode(ref, "context", context.first_message_preview || context.context_id, nodes.length, layout ?? undefined, {
      context_id: context.context_id,
      participant_count: participants.length,
      participants
    }));
  }
  for (const pulse of projection.refs.pulses) {
    const relationships = pulseSubscribers.get(pulse.pulse_id) ?? [];
    nodes.push(projectionNode(`pulse:${pulse.pulse_id}`, "pulse", pulse.pulse_id, nodes.length, layout ?? undefined, {
      pulse_id: pulse.pulse_id,
      status: pulse.status,
      persistence: pulse.persistence,
      subscriber_count: relationships.length,
      subscribers: relationships.map((relationship) => relationship.subscriber)
    }));
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: Edge[] = [];
  const edgeIds = new Set<string>();
  for (const relationship of projection.relationships.pulse_subscribers) {
    const source = `pulse:${relationship.pulse_id}`;
    const target = relationship.subscriber.context_id ? `context:${relationship.subscriber.context_id}` : null;
    if (!target || !nodeIds.has(source) || !nodeIds.has(target)) continue;
    const id = `pulse-subscriber:${relationship.pulse_id}:context:${relationship.subscriber.context_id}`;
    if (edgeIds.has(id)) continue;
    edgeIds.add(id);
    edges.push({
      id,
      source,
      target,
      label: "subscribes"
    });
  }

  return { nodes, edges, unsupported: projection.unsupported };
}
