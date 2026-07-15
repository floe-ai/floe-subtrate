export type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  scope_id?: string | null;
  /** Source endpoint that emitted the event. Null for system-originated triggers (pulse, webhook). */
  source_endpoint_id: string | null;
  thread_id: string;
  context_id?: string | null;
  correlation_id: string | null;
  destination_json: {
    kind: "endpoint" | "broadcast" | "context";
    endpoint_id?: string;
    context_id?: string;
    scope?: "workspace";
    target?:
      | "all"
      | "active"
      | "with_delivery_processor"
      | "without_delivery_processor"
      | "active_with_delivery_processor"
      | "active_without_delivery_processor";
    exclude_source?: boolean;
  };
  content: Record<string, unknown>;
  response: {
    expected: boolean;
    mode?: "open" | "thread_affine" | "correlated";
    correlation_id?: string | null;
    timeout_at?: string | null;
  };
  metadata: Record<string, unknown>;
  created_at: string;
};

export type DeliveryBundle = {
  delivery_id: string;
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events: EventEnvelope[];
  delivered_at: string;
};

export type RuntimeBindingResolution = {
  endpoint_auth_profile: string | null;
  workspace_auth_profile: string | null;
  global_auth_profile: string | null;
  endpoint_model: string | null;
  workspace_model: string | null;
  global_model: string | null;
  endpoint_thinking_level: string | null;
  workspace_thinking_level: string | null;
  global_thinking_level: string | null;
};

export type EventCommand = Omit<EventEnvelope, "event_id" | "created_at" | "metadata" | "correlation_id" | "destination_json" | "response" | "context_id"> & {
  destination: EventEnvelope["destination_json"];
  correlation_id?: string | null;
  response?: EventEnvelope["response"];
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
  /** Caller-supplied context the event belongs to (rule 1). When omitted, the bus resolver decides. */
  context_id?: string | null;
  /** The context_id of the delivery currently being processed. Bridge always sets this from the active turn. */
  current_delivery_context_id?: string | null;
};

export class BusClient {
  constructor(readonly baseUrl: string) {}

  async health(): Promise<unknown> {
    return this.get("/health");
  }

  async registerBridge(bridgeId: string, capabilities: Record<string, unknown>): Promise<void> {
    await this.post("/v1/bridges/register", { bridge_id: bridgeId, capabilities });
  }

  async reportBridgeLiveness(bridgeId: string): Promise<void> {
    await this.post(`/v1/bridges/${encodeURIComponent(bridgeId)}/liveness`, {});
  }

  async listWorkspaces(): Promise<any[]> {
    const result = await this.get("/v1/workspaces") as { workspaces: any[] };
    return result.workspaces;
  }

  async listConfigs(): Promise<any[]> {
    const result = await this.get("/v1/configs") as { configs: any[] };
    return result.configs;
  }

  async listEndpoints(workspaceId: string): Promise<any[]> {
    const result = await this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`) as { endpoints: any[] };
    return result.endpoints;
  }

  async resolveEndpoint(workspaceId: string, ref: string): Promise<{ endpoint_id: string; found: boolean }> {
    return this.get(`/v1/workspaces/${encodeURIComponent(workspaceId)}/resolve-endpoint?ref=${encodeURIComponent(ref)}`) as Promise<{ endpoint_id: string; found: boolean }>;
  }

  /**
   * Fetch a context by id. Returns null when the bus reports 404. Throws on other non-2xx
   * responses or network errors — callers are expected to catch and degrade gracefully
   * (the bridge falls back to an empty participants list and logs a warning).
   */
  async getContext(contextId: string): Promise<{
    context_id: string;
    workspace_id: string;
    parent_context_id: string | null;
    created_by_endpoint_id: string | null;
    scope_id?: string | null;
    created_at: string;
    participants: string[];
  } | null> {
    const path = `/v1/contexts/${encodeURIComponent(contextId)}`;
    const response = await fetch(`${this.baseUrl}${path}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{
      context_id: string;
      workspace_id: string;
      parent_context_id: string | null;
      created_by_endpoint_id: string | null;
      scope_id?: string | null;
      created_at: string;
      participants: string[];
    }>;
  }

  async registerEndpoint(input: Record<string, unknown>): Promise<void> {
    await this.post("/v1/endpoints/register", input);
  }

  async updateEndpointStatus(endpointId: string, status: string): Promise<void> {
    await this.post(`/v1/endpoints/${encodeURIComponent(endpointId)}/status`, { status });
  }

  async reportAttachment(workspaceId: string, input: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/attachment-result`, input);
  }

  async importConfigSnapshot(workspaceId: string, snapshot: Record<string, unknown>): Promise<void> {
    await this.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/import-config`, snapshot);
  }

  async claimDeliveries(bridgeId: string): Promise<DeliveryBundle[]> {
    const result = await this.get(`/v1/delivery/claim?bridge_id=${encodeURIComponent(bridgeId)}&limit=10`) as { deliveries: DeliveryBundle[] };
    return result.deliveries;
  }

  async reportDeliveryStatus(
    bridgeId: string,
    deliveryId: string,
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered" | "deferred",
    error?: string
  ): Promise<void> {
    await this.post(`/v1/delivery/${encodeURIComponent(deliveryId)}/status`, {
      bridge_id: bridgeId,
      state,
      error: error ?? null
    });
  }

  async emit(event: EventCommand): Promise<void> {
    await this.post("/v1/events/emit", event);
  }

  async reportTurnEnd(endpointId: string): Promise<void> {
    await this.post(`/v1/endpoints/${encodeURIComponent(endpointId)}/turn-end`, {});
  }

  async appendRuntimeTelemetry(input: {
    workspace_id: string;
    endpoint_id: string;
    delivery_id?: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await this.post("/v1/runtime/telemetry", input);
  }

  async resolveRuntimeBinding(workspaceId: string, endpointId: string): Promise<RuntimeBindingResolution> {
    return this.get(`/v1/runtime/bindings/resolve?workspace_id=${encodeURIComponent(workspaceId)}&endpoint_id=${encodeURIComponent(endpointId)}`) as Promise<RuntimeBindingResolution>;
  }

  async createPulse(input: {
    pulse_id: string;
    workspace_id: string;
    persistence?: "workspace" | "local";
    scope_id?: string | null;
    current_context_id?: string | null;
    trigger: { type: string; at?: string; schedule?: string; timezone?: string };
    event?: { type: "pulse.fired"; content: Record<string, unknown> };
    content?: Record<string, unknown>;
    subscribers: Array<
      | { kind: "context"; context_id: string }
      | { kind?: "endpoint"; endpoint_ref: string; context_id?: string | null }
    >;
    created_by?: string;
  }): Promise<unknown> {
    return this.post("/v1/pulses", input);
  }

  async listPulses(filters: { workspace_id?: string; status?: string; scope_id?: string }): Promise<{ pulses: unknown[] }> {
    const params = new URLSearchParams();
    if (filters.workspace_id) params.set("workspace_id", filters.workspace_id);
    if (filters.status) params.set("status", filters.status);
    if (filters.scope_id) params.set("scope_id", filters.scope_id);
    return this.get(`/v1/pulses?${params}`) as Promise<{ pulses: unknown[] }>;
  }

  async pausePulse(pulseId: string): Promise<unknown> {
    return this.post(`/v1/pulses/${encodeURIComponent(pulseId)}/pause`, {});
  }

  async resumePulse(pulseId: string): Promise<unknown> {
    return this.post(`/v1/pulses/${encodeURIComponent(pulseId)}/resume`, {});
  }

  async cancelPulse(pulseId: string): Promise<unknown> {
    return this.post(`/v1/pulses/${encodeURIComponent(pulseId)}/cancel`, {});
  }

  async requestConfigSnapshot(workspaceId: string): Promise<unknown> {
    return this.post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/config-snapshot`, {});
  }

  /**
   * Create a new context in the bus.
   * Supports optional scope_id (for card-as-context) and title.
   */
  async createContext(input: {
    workspace_id: string;
    scope_id?: string | null;
    participants?: string[];
    created_by_endpoint_id?: string | null;
    title?: string | null;
  }): Promise<string> {
    const result = await this.post(
      `/v1/workspaces/${encodeURIComponent(input.workspace_id)}/contexts`,
      {
        participants: input.participants ?? [],
        scope_id: input.scope_id ?? null,
        created_by_endpoint_id: input.created_by_endpoint_id ?? null,
        title: input.title ?? null,
      }
    ) as { context: { context_id: string } };
    return result.context.context_id;
  }

  /**
   * List all contexts for a specific scope in a workspace.
   * Uses the server-side indexed query (idx_contexts_workspace_scope).
   */
  async listContextsForScope(workspaceId: string, scopeId: string): Promise<Array<{
    context_id: string;
    workspace_id: string;
    scope_id: string | null;
    created_at: string;
    title: string | null;
    participants: string[];
  }>> {
    const url = `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope_id=${encodeURIComponent(scopeId)}`;
    const result = await this.get(url) as { contexts: any[] };
    return result.contexts;
  }

  /**
   * Report loaded extension metadata to the bus so `GET /v1/extensions` can
   * return them to the app. Called by the bridge after each workspace attach.
   */
  async reportExtensions(workspaceId: string, extensions: Array<{
    name: string;
    views: Array<{ slot: string; label: string; component: string }>;
    errors: string[];
    relay_url?: string | null;
  }>): Promise<void> {
    await this.post("/v1/extensions/report", { workspace_id: workspaceId, extensions });
  }

  /**
   * Add an endpoint as a participant in a context (idempotent).
   * Returns whether the participant was newly added.
   */
  async addParticipant(
    contextId: string,
    endpointId: string
  ): Promise<{ added: boolean }> {
    const result = await this.post(
      `/v1/contexts/${encodeURIComponent(contextId)}/participants`,
      { endpoint_id: endpointId }
    ) as { ok: boolean; context_id: string; endpoint_id: string; added: boolean };
    return { added: result.added };
  }

  /**
   * Remove an endpoint from a context's participant list (idempotent).
   * Returns whether the participant was removed.
   */
  async removeParticipant(
    contextId: string,
    endpointId: string
  ): Promise<{ removed: boolean }> {
    const result = await this._delete(
      `/v1/contexts/${encodeURIComponent(contextId)}/participants/${encodeURIComponent(endpointId)}`
    ) as { ok: boolean; context_id: string; endpoint_id: string; removed: boolean };
    return { removed: result.removed };
  }

  /**
   * Subscribe an endpoint to event types in a context (UPSERT, idempotent).
   * eventTypes defaults to ["*"] (all events).
   * Pass [] to create a silent watcher — still a participant, never woken.
   */
  async subscribeToContext(
    contextId: string,
    endpointId: string,
    eventTypes: string[] = ["*"]
  ): Promise<void> {
    await this.post(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions`,
      { endpoint_id: endpointId, event_types: eventTypes }
    );
  }

  /**
   * Remove an endpoint's subscription from a context entirely.
   * Does NOT remove the endpoint from participants.
   */
  async unsubscribeFromContext(
    contextId: string,
    endpointId: string
  ): Promise<void> {
    await this._delete(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions/${encodeURIComponent(endpointId)}`
    );
  }

  /**
   * Batch-apply participant + subscription changes in one atomic call.
   *
   * - `entries`: each endpoint is added as a participant AND gets its subscription
   *   upserted with the given `event_types`. Pass `[]` to create a silent watcher.
   * - `participantsOnly`: endpoints added as participants with no subscription change.
   *
   * Maps to `POST /v1/contexts/:id/subscriptions:batch`.
   */
  async applyContextSubscriptions(
    contextId: string,
    entries: Array<{ endpoint_id: string; event_types: string[] }>,
    participantsOnly: string[] = []
  ): Promise<void> {
    await this.post(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions:batch`,
      { entries, participants_only: participantsOnly }
    );
  }

  /**
   * List all subscriptions for a context.
   */
  async listContextSubscriptions(
    contextId: string
  ): Promise<Array<{ endpoint_id: string; event_types: string[]; subscribed_at: string }>> {
    const result = await this.get(
      `/v1/contexts/${encodeURIComponent(contextId)}/subscriptions`
    ) as { subscriptions: Array<{ endpoint_id: string; event_types: string[]; subscribed_at: string }> };
    return result.subscriptions;
  }

  /**
   * List events for a context, optionally since a cursor position.
   * Returns the events and a next_cursor for advancing the session's ephemeral injection cursor.
   * `since` = null → cold start (full backfill from the beginning of the thread).
   */
  async listContextEvents(
    contextId: string,
    since?: string | null,
    limit?: number
  ): Promise<{ events: EventEnvelope[]; next_cursor: string | null }> {
    const params = new URLSearchParams({ context_id: contextId });
    if (since) params.set("since", since);
    if (limit != null) params.set("limit", String(limit));
    const result = await this.get(`/v1/events?${params}`) as { events: EventEnvelope[]; next_cursor: string | null };
    return { events: result.events ?? [], next_cursor: result.next_cursor ?? null };
  }

  /**
   * List child contexts whose parent_context_id equals contextId.
   * Used for epic→card links.
   */
  async listChildContexts(
    contextId: string
  ): Promise<Array<{ context_id: string; workspace_id: string; scope_id: string | null; created_at: string; title: string | null; participants: string[] }>> {
    const result = await this.get(
      `/v1/contexts/${encodeURIComponent(contextId)}/children`
    ) as { contexts: Array<{ context_id: string; workspace_id: string; scope_id: string | null; created_at: string; title: string | null; participants: string[] }> };
    return result.contexts;
  }

  private async _delete(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`DELETE ${path} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`POST ${path} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }
}
