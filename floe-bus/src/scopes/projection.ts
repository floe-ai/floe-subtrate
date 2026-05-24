import type { BusStore, PulseSubscriber, PulsePersistence } from "../store.js";

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
  persistence: PulsePersistence;
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
    pulse_subscribers: Array<{ pulse_id: string; subscriber: PulseSubscriber }>;
    event_context_ownership: Array<{ event_id: string; context_id: string }>;
  };
  unsupported: Array<{ kind: string; reason: string }>;
};

function pulseRef(row: unknown): ScopeProjectionPulseRef {
  const pulse = row as Record<string, any>;
  return {
    pulse_id: String(pulse.pulse_id),
    workspace_id: String(pulse.workspace_id),
    scope_id: String(pulse.scope_id),
    persistence: pulse.persistence as PulsePersistence,
    status: String(pulse.status),
    trigger: pulse.trigger,
    next_fire_at: typeof pulse.next_fire_at === "string" ? pulse.next_fire_at : null,
    last_fired_at: typeof pulse.last_fired_at === "string" ? pulse.last_fired_at : null,
    fire_count: Number(pulse.fire_count ?? 0),
    created_at: String(pulse.created_at),
    updated_at: String(pulse.updated_at)
  };
}

export function buildScopeProjection(store: BusStore, workspaceId: string, scopeId: string): ScopeProjection {
  const contexts = store.contextStore.listContextsForScope(workspaceId, scopeId);

  return {
    workspace_id: workspaceId,
    scope_id: scopeId,
    generated_at: new Date().toISOString(),
    refs: {
      contexts: contexts.map((context) => ({
        context_id: context.context_id,
        workspace_id: context.workspace_id,
        scope_id: context.scope_id,
        parent_context_id: context.parent_context_id,
        created_by_endpoint_id: context.created_by_endpoint_id,
        created_at: context.created_at,
        last_event_at: context.last_event_at,
        first_message_preview: store.contextStore.getFirstMessagePreview(context.context_id)
      })),
      pulses: (store.listPulses({ workspace_id: workspaceId, scope_id: scopeId }) as unknown[]).map(pulseRef),
      events: [],
      activity: []
    },
    relationships: {
      context_participants: contexts.flatMap((context) =>
        context.participants.map((endpoint_id) => ({ context_id: context.context_id, endpoint_id }))
      ),
      pulse_subscribers: (store.listPulses({ workspace_id: workspaceId, scope_id: scopeId }) as Array<{ pulse_id: string }>).flatMap((pulse) =>
        store.getPulseSubscribers(pulse.pulse_id).map((subscriber) => ({ pulse_id: pulse.pulse_id, subscriber }))
      ),
      event_context_ownership: []
    },
    unsupported: []
  };
}
