import { type ContextSummary } from "./contexts";
import { type ScopeRecord } from "./scope-projection";

export type ActivityEventRecord = {
  event_id: string;
  type: string;
  source_endpoint_id: string | null;
  context_id?: string | null;
  content?: { text?: string; data?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
  created_at: string;
};

export type ActivityTelemetryRecord = {
  telemetry_id: string;
  endpoint_id: string;
  kind: string;
  payload_json: string;
  created_at: string;
};

export type ActivityEndpoint = {
  endpoint_id: string;
  name: string;
  agent_id?: string | null;
};

export type ActivityRow = {
  id: string;
  category: "event" | "runtime";
  title: string;
  kind: string;
  detail: string;
  sourceEndpointId: string | null;
  sourceLabel: string;
  contextId: string | null;
  contextLabel: string | null;
  scopeId: string | null;
  scopeLabel: string;
  scopeState: "workspace" | "scoped" | "unresolved";
  createdAt: string;
};

export type ActivityFilters = {
  actorId: string;
  kind: string;
  scopeId: string;
  contextId: string;
};

export function buildActivityRows({
  events,
  telemetry,
  contexts,
  endpoints,
  scopes
}: {
  events: ActivityEventRecord[];
  telemetry: ActivityTelemetryRecord[];
  contexts: ContextSummary[];
  endpoints: ActivityEndpoint[];
  scopes: ScopeRecord[];
}): ActivityRow[] {
  const contextsById = new Map(contexts.map((context) => [context.context_id, context]));
  const scopeLabels = new Map(scopes.map((scope) => [scope.scope_id, scope.title]));
  const endpointLabels = new Map(endpoints.map((endpoint) => [endpoint.endpoint_id, endpointLabel(endpoint)]));

  const eventRows = events.map<ActivityRow>((event) => {
    const contextId = event.context_id ?? null;
    const context = contextId ? contextsById.get(contextId) ?? null : null;
    const scope = resolveActivityScope(contextId, context, scopeLabels);
    return {
      id: event.event_id,
      category: "event",
      title: event.type,
      kind: event.type,
      detail: eventDetail(event),
      sourceEndpointId: event.source_endpoint_id,
      sourceLabel: event.source_endpoint_id
        ? endpointLabels.get(event.source_endpoint_id) ?? event.source_endpoint_id
        : event.type === "pulse.fired" ? "Pulse" : "System",
      contextId,
      contextLabel: context ? contextActivityLabel(context) : null,
      scopeId: scope.scopeId,
      scopeLabel: scope.label,
      scopeState: scope.state,
      createdAt: event.created_at
    };
  });

  const telemetryRows = telemetry.map<ActivityRow>((record) => {
    const payload = parseTelemetryPayload(record);
    const contextId = typeof payload?.context_id === "string" ? payload.context_id : null;
    const context = contextId ? contextsById.get(contextId) ?? null : null;
    const scope = resolveActivityScope(contextId, context, scopeLabels);
    return {
      id: record.telemetry_id,
      category: "runtime",
      title: runtimeActivityLabel(record.kind),
      kind: record.kind,
      detail: summarizeTelemetry(record),
      sourceEndpointId: record.endpoint_id,
      sourceLabel: endpointLabels.get(record.endpoint_id) ?? record.endpoint_id,
      contextId,
      contextLabel: context ? contextActivityLabel(context) : null,
      scopeId: scope.scopeId,
      scopeLabel: scope.label,
      scopeState: scope.state,
      createdAt: record.created_at
    };
  });

  return [...eventRows, ...telemetryRows].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function filterActivityRows(rows: ActivityRow[], filters: ActivityFilters): ActivityRow[] {
  return rows.filter((row) => {
    if (filters.actorId !== "all" && row.sourceEndpointId !== filters.actorId) return false;
    if (filters.kind === "events" && row.category !== "event") return false;
    if (filters.kind === "runtime" && row.category !== "runtime") return false;
    if (!["all", "events", "runtime"].includes(filters.kind) && row.kind !== filters.kind) return false;
    if (filters.scopeId === "workspace" && row.scopeState !== "workspace") return false;
    if (filters.scopeId !== "all" && filters.scopeId !== "workspace" && row.scopeId !== filters.scopeId) return false;
    if (filters.contextId !== "all" && row.contextId !== filters.contextId) return false;
    return true;
  });
}

export function contextActivityLabel(context: ContextSummary): string {
  return context.first_message_preview?.trim() || `Context ${context.context_id.slice(0, 8)}`;
}

export function parseTelemetryPayload(record: ActivityTelemetryRecord): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(record.payload_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function telemetryContextId(record: ActivityTelemetryRecord): string | null {
  const payload = parseTelemetryPayload(record);
  return typeof payload?.context_id === "string" ? payload.context_id : null;
}

export function summarizeTelemetry(record: ActivityTelemetryRecord): string {
  const payload = parseTelemetryPayload(record);
  if (!payload) return record.kind;
  if (typeof payload.summary === "string" && payload.summary.trim()) {
    return payload.summary.trim().slice(0, 140).replace(/^emit\b/i, "sent message");
  }
  if (typeof payload.toolName === "string") {
    return payload.toolName === "emit" ? "sent message" : payload.toolName;
  }
  const candidate = payload.error_message ?? payload.message ?? payload.note ?? payload.text ?? payload.code;
  if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 140);
  return record.kind;
}

export function runtimeActivityLabel(kind: string): string {
  const labels: Record<string, string> = {
    BeforeToolUse: "Running",
    AfterToolUse: "Completed",
    ToolUseFailed: "Failed",
    runtime_error: "Error",
    runtime_no_visible_output: "No output",
    visible_output_worklog: "Runtime notes"
  };
  if (labels[kind]) return labels[kind];
  return kind
    .replace(/^runtime_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function endpointLabel(endpoint: ActivityEndpoint): string {
  return endpoint.name?.trim() || endpoint.agent_id || endpoint.endpoint_id;
}

function resolveActivityScope(
  contextId: string | null,
  context: ContextSummary | null,
  scopeLabels: Map<string, string>
): { scopeId: string | null; label: string; state: ActivityRow["scopeState"] } {
  if (context?.scope_id) {
    return { scopeId: context.scope_id, label: scopeLabels.get(context.scope_id) ?? context.scope_id, state: "scoped" };
  }
  if (context) {
    return { scopeId: null, label: "Workspace-only", state: "workspace" };
  }
  if (contextId) {
    return { scopeId: null, label: "Context unresolved", state: "unresolved" };
  }
  return { scopeId: null, label: "Workspace-only", state: "workspace" };
}

function eventDetail(event: ActivityEventRecord): string {
  if (typeof event.content?.text === "string" && event.content.text.trim()) return event.content.text.trim();
  const data = event.content?.data;
  if (data && typeof data.text === "string" && data.text.trim()) return data.text.trim();
  if (data && typeof data.summary === "string" && data.summary.trim()) return data.summary.trim();
  return event.context_id || event.type;
}
