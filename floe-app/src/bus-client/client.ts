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
  Watermark,
  EmitInput,
  StreamMsg,
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

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export async function listWorkspaces(): Promise<WorkspaceRef[]> {
  const data = await get<{ workspaces: WorkspaceRef[] }>("/v1/workspaces");
  return data.workspaces;
}

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

export async function listContexts(ws: string): Promise<ContextRef[]> {
  const data = await get<{ contexts: ContextRef[] }>(`/v1/workspaces/${encodeURIComponent(ws)}/contexts`);
  return data.contexts;
}

export async function getContext(id: string): Promise<ContextRef> {
  return get<ContextRef>(`/v1/contexts/${encodeURIComponent(id)}`);
}

export async function listContextEvents(id: string): Promise<EventEnvelope[]> {
  const data = await get<{ events: EventEnvelope[] }>(`/v1/contexts/${encodeURIComponent(id)}/events`);
  return data.events;
}

export async function listEvents(q: {
  workspace_id?: string;
  scope_id?: string;
  context_id?: string;
  since?: string;
  limit?: number;
}): Promise<{ events: EventEnvelope[]; next_cursor: string | null }> {
  const params = new URLSearchParams();
  if (q.workspace_id) params.set("workspace_id", q.workspace_id);
  if (q.scope_id) params.set("scope_id", q.scope_id);
  if (q.context_id) params.set("context_id", q.context_id);
  if (q.since) params.set("since", q.since);
  if (q.limit != null) params.set("limit", String(q.limit));
  const qs = params.toString();
  return get<{ events: EventEnvelope[]; next_cursor: string | null }>(`/v1/events${qs ? `?${qs}` : ""}`);
}

export async function getEventTrace(eventId: string): Promise<EventTrace> {
  return get<EventTrace>(`/v1/events/${encodeURIComponent(eventId)}/trace`);
}

export async function listEndpoints(ws: string): Promise<EndpointRef[]> {
  const data = await get<{ endpoints: EndpointRef[] }>(`/v1/workspaces/${encodeURIComponent(ws)}/endpoints`);
  return data.endpoints;
}

export async function listPendingResponses(ws: string): Promise<PendingResponse[]> {
  const data = await get<{ pending: PendingResponse[] }>(`/v1/pending-responses?workspace_id=${encodeURIComponent(ws)}`);
  return data.pending;
}

export async function listPulses(ws: string): Promise<PulseRef[]> {
  const data = await get<{ pulses: PulseRef[] }>(`/v1/pulses?workspace_id=${encodeURIComponent(ws)}`);
  return data.pulses;
}

export async function getWatermark(ws: string, endpoint: string): Promise<Watermark | null> {
  const data = await get<{ watermark: Watermark | null }>(
    `/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent(endpoint)}/watermark`
  );
  return data.watermark;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export async function emit(event: EmitInput): Promise<EventEnvelope> {
  const data = await post<{ event: EventEnvelope }>("/v1/events/emit", event);
  return data.event;
}

export async function putWatermark(ws: string, endpoint: string, cursor: string): Promise<void> {
  await put(`/v1/workspaces/${encodeURIComponent(ws)}/endpoints/${encodeURIComponent(endpoint)}/watermark`, { cursor });
}

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
