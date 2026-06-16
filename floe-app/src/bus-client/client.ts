/**
 * Bus client — the ONLY substrate seam for floe-app.
 * All bus communication goes through these functions.
 * Base URL: http://127.0.0.1:5377
 */
import type {
  WorkspaceRef,
  ScopeRef,
  ScopeProjection,
  FieldLayout,
  ContextRef,
  EventEnvelope,
  EventTrace,
  EndpointRef,
  PendingResponse,
  PulseRef,
  PulseSubscriber,
  CreatePulseInput,
  Watermark,
  EmitInput,
  StreamMsg,
  DeliveryRow,
  DeliveryBundle,
  TelemetryRow,
  RuntimeBindingRecord,
  RuntimeBindingScope,
  RuntimeBindingResolution,
  AuthProfileRecord,
  AuthModelRecord,
  SavedConfigRow,
  RuntimeStatus,
  LocalConfigStatus,
  ResolvedEndpoint,
} from "./types.ts";
import { subscribeEvents as _subscribeEvents } from "./stream.ts";

const BUS_BASE = "http://127.0.0.1:5377";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BUS_BASE}${path}`);
  if (!res.ok) throw new Error(`Bus GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BUS_BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bus PUT ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BUS_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bus POST ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BUS_BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bus PATCH ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BUS_BASE}${path}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Bus DELETE ${path} → ${res.status}`);
  // 204 No Content has no body
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export async function listWorkspaces(): Promise<WorkspaceRef[]> {
  const data = await get<{ workspaces: WorkspaceRef[] }>("/v1/workspaces");
  return data.workspaces;
}

/** POST /v1/workspaces/register — register a new workspace by filesystem locator */
export async function registerWorkspace(input: {
  locator: string;
  name?: string;
  init_authorized?: boolean;
  create_directory?: boolean;
}): Promise<WorkspaceRef> {
  const data = await post<{ workspace: WorkspaceRef }>("/v1/workspaces/register", input);
  return data.workspace;
}

/** POST /v1/workspaces/:id/select — mark a workspace as selected */
export async function selectWorkspace(ws: string): Promise<WorkspaceRef> {
  const data = await post<{ workspace: WorkspaceRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/select`,
    {}
  );
  return data.workspace;
}

/** POST /v1/workspaces/:id/delete — remove a workspace (and optionally its locator) */
export async function deleteWorkspace(
  ws: string,
  options?: { delete_locator?: boolean }
): Promise<{ ok: true; workspace_id: string; locator_deleted: boolean }> {
  return post(
    `/v1/workspaces/${encodeURIComponent(ws)}/delete`,
    options ?? {}
  );
}

/** GET /v1/workspaces/:id/config-status — workspace config/attachment status */
export async function getWorkspaceConfigStatus(ws: string): Promise<WorkspaceRef> {
  const data = await get<{ workspace: WorkspaceRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/config-status`
  );
  return data.workspace;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export async function listScopes(ws: string): Promise<ScopeRef[]> {
  const data = await get<{ scopes: ScopeRef[] }>(`/v1/workspaces/${encodeURIComponent(ws)}/scopes`);
  return data.scopes;
}

export async function getScopeProjection(ws: string, scope: string): Promise<ScopeProjection> {
  const data = await get<{ projection: ScopeProjection }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/projection`
  );
  return data.projection;
}

export async function getFieldLayout(ws: string, scope: string, renderer: string): Promise<FieldLayout | null> {
  try {
    const data = await get<{ layout: FieldLayout }>(
      `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/projection/layout/${encodeURIComponent(renderer)}`
    );
    return data.layout;
  } catch {
    return null;
  }
}

/** POST /v1/workspaces/:ws/scopes — create a new scope */
export async function createScope(
  ws: string,
  input: { scope_id?: string; title: string; description?: string | null }
): Promise<ScopeRef> {
  const data = await post<{ scope: ScopeRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes`,
    input
  );
  return data.scope;
}

/** PATCH /v1/workspaces/:ws/scopes/:scope — update scope title/description */
export async function updateScope(
  ws: string,
  scope: string,
  input: { title?: string; description?: string | null }
): Promise<ScopeRef> {
  const data = await patch<{ scope: ScopeRef }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}`,
    input
  );
  return data.scope;
}

/** DELETE /v1/workspaces/:ws/scopes/:scope — delete an empty scope */
export async function deleteScope(ws: string, scope: string): Promise<void> {
  await del(`/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}`);
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

export async function listContexts(ws: string, options?: {
  scope?: "all" | "scoped" | "unscoped";
  limit?: number;
}): Promise<ContextRef[]> {
  const params = new URLSearchParams();
  if (options?.scope) params.set("scope", options.scope);
  if (options?.limit != null) params.set("limit", String(options.limit));
  const qs = params.toString();
  const data = await get<{ contexts: ContextRef[] }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts${qs ? `?${qs}` : ""}`
  );
  return data.contexts;
}

/** GET /v1/contexts?participant=...&workspace_id=...&scope_id=... — list contexts by participant */
export async function listContextsByParticipant(q: {
  participant: string;
  workspace_id?: string;
  scope_id?: string;
}): Promise<ContextRef[]> {
  const params = new URLSearchParams({ participant: q.participant });
  if (q.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q.scope_id) params.set("scope_id", q.scope_id);
  const data = await get<{ contexts: ContextRef[] }>(`/v1/contexts?${params.toString()}`);
  return data.contexts;
}

export async function getContext(id: string): Promise<ContextRef> {
  return get<ContextRef>(`/v1/contexts/${encodeURIComponent(id)}`);
}

export async function listContextEvents(id: string, options?: { limit?: number }): Promise<EventEnvelope[]> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set("limit", String(options.limit));
  const qs = params.toString();
  const data = await get<{ events: EventEnvelope[] }>(
    `/v1/contexts/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`
  );
  return data.events;
}

/** POST /v1/workspaces/:ws/contexts/:id/assign-scope */
export async function assignContextScope(
  ws: string,
  contextId: string,
  input: { scope_id: string; assigned_by?: string | null; reason?: string | null }
): Promise<{ ok: true; context: ContextRef; audit_event: EventEnvelope }> {
  return post(
    `/v1/workspaces/${encodeURIComponent(ws)}/contexts/${encodeURIComponent(contextId)}/assign-scope`,
    input
  );
}

/** DELETE /v1/contexts/:id — delete a context and all its events */
export async function deleteContext(id: string): Promise<{
  ok: true;
  context_id: string;
  workspace_id: string;
  events_deleted: number;
  delivery_bundles_deleted: number;
  pulse_subscribers_deleted: number;
}> {
  return del(`/v1/contexts/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export async function listEvents(q: {
  workspace_id?: string;
  scope_id?: string;
  context_id?: string;
  thread_id?: string;
  since?: string;
  limit?: number;
}): Promise<{ events: EventEnvelope[]; next_cursor: string | null }> {
  const params = new URLSearchParams();
  if (q.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q.scope_id) params.set("scope_id", q.scope_id);
  if (q.context_id) params.set("context_id", q.context_id);
  if (q.thread_id) params.set("thread_id", q.thread_id);
  if (q.since) params.set("since", q.since);
  if (q.limit != null) params.set("limit", String(q.limit));
  const qs = params.toString();
  return get<{ events: EventEnvelope[]; next_cursor: string | null }>(`/v1/events${qs ? `?${qs}` : ""}`);
}

export async function getEventTrace(eventId: string): Promise<EventTrace> {
  return get<EventTrace>(`/v1/events/${encodeURIComponent(eventId)}/trace`);
}

/** POST /v1/events/emit */
export async function emit(event: EmitInput): Promise<EventEnvelope> {
  const data = await post<{ event: EventEnvelope }>("/v1/events/emit", event);
  return data.event;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** GET /v1/endpoints?workspace_id=... — list endpoints; workspace_id is optional */
export async function listEndpointsGlobal(workspace_id?: string): Promise<EndpointRef[]> {
  const qs = workspace_id ? `?workspace_id=${encodeURIComponent(workspace_id)}` : "";
  const data = await get<{ endpoints: EndpointRef[] }>(`/v1/endpoints${qs}`);
  return data.endpoints;
}

/** GET /v1/workspaces/:ws/endpoints — list endpoints for a specific workspace */
export async function listEndpoints(ws: string): Promise<EndpointRef[]> {
  const data = await get<{ endpoints: EndpointRef[] }>(`/v1/workspaces/${encodeURIComponent(ws)}/endpoints`);
  return data.endpoints;
}

/** GET /v1/workspaces/:ws/resolve-endpoint?ref=... */
export async function resolveEndpoint(ws: string, ref: string): Promise<ResolvedEndpoint> {
  return get<ResolvedEndpoint>(
    `/v1/workspaces/${encodeURIComponent(ws)}/resolve-endpoint?ref=${encodeURIComponent(ref)}`
  );
}

/** POST /v1/endpoints/:id/status — set endpoint status */
export async function setEndpointStatus(endpointId: string, status: string): Promise<EndpointRef> {
  const data = await post<{ endpoint: EndpointRef }>(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/status`,
    { status }
  );
  return data.endpoint;
}

/** POST /v1/endpoints/:id/turn-end — signal that the endpoint's turn has ended */
export async function reportTurnEnd(endpointId: string): Promise<EndpointRef> {
  const data = await post<{ endpoint: EndpointRef }>(
    `/v1/endpoints/${encodeURIComponent(endpointId)}/turn-end`,
    {}
  );
  return data.endpoint;
}

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** GET /v1/delivery?workspace_id=...&limit=... — list delivery bundles (raw rows) */
export async function listDeliveries(q?: {
  workspace_id?: string;
  limit?: number;
}): Promise<DeliveryRow[]> {
  const params = new URLSearchParams();
  if (q?.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q?.limit != null) params.set("limit", String(q.limit));
  const qs = params.toString();
  const data = await get<{ deliveries: DeliveryRow[] }>(`/v1/delivery${qs ? `?${qs}` : ""}`);
  return data.deliveries;
}

/**
 * GET /v1/delivery/claim?bridge_id=...&limit=...
 *
 * CONSUMING OPERATION: claiming a delivery transitions it to `delivered_to_bridge`.
 * Only call this from bridge-equivalent code; do not use for read-only UI display.
 */
export async function claimDelivery(bridgeId: string, limit?: number): Promise<DeliveryBundle[]> {
  const params = new URLSearchParams({ bridge_id: bridgeId });
  if (limit != null) params.set("limit", String(limit));
  const data = await get<{ deliveries: DeliveryBundle[] }>(`/v1/delivery/claim?${params.toString()}`);
  return data.deliveries;
}

/** POST /v1/delivery/:id/status — report delivery state transition */
export async function setDeliveryStatus(
  deliveryId: string,
  input: {
    bridge_id: string;
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered" | "deferred";
    error?: string | null;
  }
): Promise<DeliveryRow> {
  const data = await post<{ delivery: DeliveryRow }>(
    `/v1/delivery/${encodeURIComponent(deliveryId)}/status`,
    input
  );
  return data.delivery;
}

// ---------------------------------------------------------------------------
// Pulses
// ---------------------------------------------------------------------------

/** GET /v1/pulses?workspace_id=... — list pulses for a workspace */
export async function listPulses(ws: string): Promise<PulseRef[]> {
  const data = await get<{ pulses: PulseRef[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(ws)}`);
  return data.pulses;
}

/** GET /v1/pulses — list pulses with optional filters (workspace, status, scope) */
export async function queryPulses(q?: {
  workspace_id?: string;
  status?: string;
  scope_id?: string;
}): Promise<PulseRef[]> {
  const params = new URLSearchParams();
  if (q?.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q?.status) params.set("status", q.status);
  if (q?.scope_id) params.set("scope_id", q.scope_id);
  const qs = params.toString();
  const data = await get<{ pulses: PulseRef[] }>(`/v1/pulses${qs ? `?${qs}` : ""}`);
  return data.pulses;
}

/** POST /v1/pulses — create a new pulse */
export async function createPulse(input: CreatePulseInput): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>("/v1/pulses", input);
  return data.pulse;
}

/** POST /v1/pulses/:id/pause */
export async function pausePulse(pulseId: string): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>(
    `/v1/pulses/${encodeURIComponent(pulseId)}/pause`,
    {}
  );
  return data.pulse;
}

/** POST /v1/pulses/:id/resume */
export async function resumePulse(pulseId: string): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>(
    `/v1/pulses/${encodeURIComponent(pulseId)}/resume`,
    {}
  );
  return data.pulse;
}

/** POST /v1/pulses/:id/cancel */
export async function cancelPulse(pulseId: string): Promise<PulseRef> {
  const data = await post<{ pulse: PulseRef }>(
    `/v1/pulses/${encodeURIComponent(pulseId)}/cancel`,
    {}
  );
  return data.pulse;
}

/** POST /v1/pulses/:id/subscribe */
export async function subscribePulse(pulseId: string, subscriber: PulseSubscriber): Promise<{ ok: true; pulse: PulseRef }> {
  return post(`/v1/pulses/${encodeURIComponent(pulseId)}/subscribe`, subscriber);
}

/** POST /v1/pulses/:id/unsubscribe */
export async function unsubscribePulse(pulseId: string, subscriber: PulseSubscriber): Promise<{ ok: true; pulse: PulseRef }> {
  return post(`/v1/pulses/${encodeURIComponent(pulseId)}/unsubscribe`, subscriber);
}

// ---------------------------------------------------------------------------
// Pending responses
// ---------------------------------------------------------------------------

export async function listPendingResponses(ws: string): Promise<PendingResponse[]> {
  const data = await get<{ pending: PendingResponse[] }>(`/v1/pending-responses?workspace_id=${encodeURIComponent(ws)}`);
  return data.pending;
}

// ---------------------------------------------------------------------------
// Watermarks
// ---------------------------------------------------------------------------

export async function getWatermark(ws: string, endpoint: string): Promise<Watermark | null> {
  const data = await get<{ watermark: Watermark | null }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent(endpoint)}/watermark`
  );
  return data.watermark;
}

export async function putWatermark(ws: string, endpoint: string, cursor: string): Promise<void> {
  await put(`/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent(endpoint)}/watermark`, { cursor });
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/** GET /v1/runtime/telemetry?workspace_id=...&delivery_id=...&limit=... */
export async function listRuntimeTelemetry(q?: {
  workspace_id?: string;
  delivery_id?: string;
  limit?: number;
}): Promise<TelemetryRow[]> {
  const params = new URLSearchParams();
  if (q?.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q?.delivery_id) params.set("delivery_id", q.delivery_id);
  if (q?.limit != null) params.set("limit", String(q.limit));
  const qs = params.toString();
  const data = await get<{ records: TelemetryRow[] }>(`/v1/runtime/telemetry${qs ? `?${qs}` : ""}`);
  return data.records;
}

// ---------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------

/** GET /v1/runtime/bindings?workspace_id=... */
export async function getRuntimeBindings(workspace_id?: string): Promise<RuntimeBindingRecord[]> {
  const qs = workspace_id ? `?workspace_id=${encodeURIComponent(workspace_id)}` : "";
  const data = await get<{ bindings: RuntimeBindingRecord[] }>(`/v1/runtime/bindings${qs}`);
  return data.bindings;
}

/** GET /v1/runtime/bindings/resolve?workspace_id=...&endpoint_id=... */
export async function resolveRuntimeBinding(
  workspace_id: string,
  endpoint_id: string
): Promise<RuntimeBindingResolution> {
  return get<RuntimeBindingResolution>(
    `/v1/runtime/bindings/resolve?workspace_id=${encodeURIComponent(workspace_id)}&endpoint_id=${encodeURIComponent(endpoint_id)}`
  );
}

/** POST /v1/runtime/bindings — upsert a runtime binding */
export async function upsertRuntimeBinding(input: {
  scope: RuntimeBindingScope;
  workspace_id?: string | null;
  endpoint_id?: string | null;
  auth_profile: string;
  model?: string | null;
  thinking_level?: string | null;
}): Promise<RuntimeBindingRecord> {
  const data = await post<{ binding: RuntimeBindingRecord }>("/v1/runtime/bindings", input);
  return data.binding;
}

/** POST /v1/runtime/bindings/clear — remove a runtime binding */
export async function clearRuntimeBindings(input: {
  scope: RuntimeBindingScope;
  workspace_id?: string | null;
  endpoint_id?: string | null;
}): Promise<{ ok: true; binding_key: string }> {
  return post("/v1/runtime/bindings/clear", input);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** GET /v1/auth/profiles */
export async function getAuthProfiles(): Promise<{
  profiles: AuthProfileRecord[];
  default_auth_profile: string | null;
}> {
  return get("/v1/auth/profiles");
}

/** GET /v1/auth/models?provider=... */
export async function getAuthModels(provider?: string): Promise<AuthModelRecord[]> {
  const qs = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  const data = await get<{ models: AuthModelRecord[] }>(`/v1/auth/models${qs}`);
  return data.models;
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

/** GET /v1/configs */
export async function listConfigs(): Promise<SavedConfigRow[]> {
  const data = await get<{ configs: SavedConfigRow[] }>("/v1/configs");
  return data.configs;
}

/** POST /v1/configs — save a named config snapshot */
export async function postConfig(input: {
  name: string;
  config: Record<string, unknown>;
}): Promise<SavedConfigRow> {
  const data = await post<{ config: SavedConfigRow }>("/v1/configs", input);
  return data.config;
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** POST /v1/webhooks/:workspace_id/:route_id — ingest a webhook payload */
export async function ingestWebhook(
  workspaceId: string,
  routeId: string,
  body: Record<string, unknown>
): Promise<{ ok: true; event: EventEnvelope }> {
  return post(
    `/v1/webhooks/${encodeURIComponent(workspaceId)}/${encodeURIComponent(routeId)}`,
    body
  );
}

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

/** GET /v1/runtime/status — bridge liveness and runtime adapter */
export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  return get("/v1/runtime/status");
}

/** GET /v1/local-config/status — local config paths and sections */
export async function getLocalConfigStatus(): Promise<LocalConfigStatus> {
  return get("/v1/local-config/status");
}

// ---------------------------------------------------------------------------
// Field layout
// ---------------------------------------------------------------------------

export async function putFieldLayout(ws: string, scope: string, renderer: string, layout: FieldLayout): Promise<void> {
  await put(
    `/v1/workspaces/${encodeURIComponent(ws)}/scopes/${encodeURIComponent(scope)}/projection/layout/${encodeURIComponent(renderer)}`,
    layout
  );
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

export { subscribeEvents } from "./stream.ts";

// Re-export types for convenience
export type { StreamMsg };
