import { type ActivityRow } from "./activity";
import { contextLabel, type ContextEvent, type ContextSummary } from "./contexts";
import { type ScopeProjection } from "./scope-projection";

export type InspectorRuntimeBinding = {
  auth_profile: string;
  model: string | null;
} | null | undefined;

export function buildWorkspaceInspectorSummary({
  namedScopeCount,
  scopeBackedFieldCount,
  contexts,
  eventCount,
  telemetryCount,
  endpointCount
}: {
  namedScopeCount: number;
  scopeBackedFieldCount: number;
  contexts: ContextSummary[];
  eventCount: number;
  telemetryCount: number;
  endpointCount: number;
}) {
  return {
    surface: "Workspace index (not a Scope)",
    namedScopeCount,
    scopeBackedFieldCount,
    workspaceLevelContextCount: contexts.filter((context) => !context.scope_id).length,
    loadedContextCount: contexts.length,
    eventCount,
    telemetryCount,
    endpointCount
  };
}

export function buildActorInspectorSummary({
  actorId,
  contexts,
  activityRows,
  runtimeBinding,
  adapter
}: {
  actorId: string;
  contexts: ContextSummary[];
  activityRows: ActivityRow[];
  runtimeBinding: InspectorRuntimeBinding;
  adapter: string | null;
}) {
  return {
    runtimeBindingLabel: runtimeBinding
      ? `${runtimeBinding.auth_profile}${runtimeBinding.model ? ` / ${runtimeBinding.model}` : ""}`
      : "Unconfigured",
    adapterLabel: adapter ?? "unknown",
    workspaceLevelContextCount: contexts.filter((context) => !context.scope_id).length,
    scopedContextCount: contexts.filter((context) => context.scope_id).length,
    activityCount: activityRows.filter((row) => row.sourceEndpointId === actorId).length
  };
}

export function buildScopeInspectorSummary({
  scopeId,
  projection,
  activityRows
}: {
  scopeId: string;
  projection: ScopeProjection | null;
  activityRows: ActivityRow[];
}) {
  const scopedActivityRows = activityRows.filter((row) => row.scopeId === scopeId);
  const pulseFireCount = projection?.refs.pulses.reduce((total, pulse) => total + pulse.fire_count, 0) ?? 0;
  const actorCount = new Set(projection?.relationships.context_participants.map((participant) => participant.endpoint_id) ?? []).size;
  return {
    projectedContextCount: projection?.refs.contexts.length ?? 0,
    projectedEventCount: projection?.refs.events.length ?? 0,
    projectedActivityRefCount: projection?.refs.activity.length ?? 0,
    actorCount,
    activityRows: scopedActivityRows,
    activityRowCount: scopedActivityRows.length,
    totalEmitCount: (projection?.refs.events.length ?? 0) + (projection?.refs.activity.length ?? 0) + pulseFireCount,
    pulseCount: projection?.refs.pulses.length ?? 0,
    unsupportedCount: projection?.unsupported.length ?? 0,
    hasProjectionActivityGap:
      projection !== null &&
      projection.refs.events.length === 0 &&
      projection.refs.activity.length === 0 &&
      scopedActivityRows.length > 0
  };
}

export function buildContextInspectorSummary({
  context,
  events,
  scopeTitlesById
}: {
  context: ContextSummary;
  events: ContextEvent[];
  scopeTitlesById: Record<string, string>;
}) {
  const orderedEvents = [...events].sort((left, right) => left.created_at.localeCompare(right.created_at));
  const firstEvent = orderedEvents[0] ?? null;
  const lastEvent = orderedEvents[orderedEvents.length - 1] ?? null;
  const messageCount = orderedEvents.filter((event) => event.type === "message").length;
  const scopeTitle = context.scope_id ? scopeTitlesById[context.scope_id]?.trim() ?? "" : "";

  return {
    label: contextLabel(context, firstEvent),
    scopeLabel: context.scope_id
      ? scopeTitle
        ? `${scopeTitle} Scope`
        : "Scoped Context"
      : "Workspace Context",
    participantIds: context.participants,
    participantCount: context.participants.length,
    totalEmitCount: orderedEvents.length,
    messageCount,
    createdAt: firstEvent?.created_at ?? context.created_at,
    lastActiveAt: lastEvent?.created_at ?? context.last_event_at ?? context.created_at
  };
}
