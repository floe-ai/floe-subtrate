/**
 * Stub bus client interface — the contract seam Track X builds against.
 *
 * The substrate provides a real implementation of this interface via
 * ExtensionContext.busClient (typed as `any` in the loader).  This module
 * provides the typed interface so extension code has compile-time safety.
 *
 * Integration join: swap `ctx.busClient as StubBusClient` for the real
 * typed client once Track S exports a BusClient interface.
 *
 * Contract §6 — stub seam.
 */

// ---------------------------------------------------------------------------
// Wire shapes (minimal subset needed by the Snowball extension)
// ---------------------------------------------------------------------------

export interface ContextRef {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  created_at: string;
  title: string | null;
  first_message_preview: string | null;
  participants: string[];
}

export interface EndpointRef {
  endpoint_id: string;
  workspace_id: string;
  agent_id: string | null;
  name: string;
  status: string;
}

export interface CreateContextInput {
  workspace_id: string;
  scope_id?: string | null;
  participants?: string[];
  created_by_endpoint_id?: string | null;
  title?: string | null;
}

export interface EmitInput {
  type: string;
  workspace_id: string;
  source_endpoint_id?: string | null;
  destination?: {
    kind: "endpoint" | "context" | "broadcast";
    endpoint_id?: string;
    context_id?: string;
    scope?: string;
    target?: string;
  };
  thread_id?: string | null;
  context_id?: string | null;
  scope_id?: string | null;
  current_delivery_context_id?: string | null;
  content: {
    text?: string;
    data?: Record<string, unknown>;
    [key: string]: unknown;
  };
  response?: { expected: boolean };
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// BusClient interface — the stub seam
// ---------------------------------------------------------------------------

export interface BusClient {
  /**
   * Create a new Context scoped to a board Scope.
   * Returns the context_id (= card_id in Snowball).
   */
  createContext(input: CreateContextInput): Promise<string>;

  /**
   * List all Contexts for a given scope.
   */
  listContextsForScope(
    workspaceId: string,
    scopeId: string
  ): Promise<ContextRef[]>;

  /**
   * Emit an event (card.moved, card.entered_column, etc.).
   * The bus is event-type agnostic — no registration needed.
   */
  emit(input: EmitInput): Promise<void>;

  /**
   * List all endpoints in a workspace.
   * Used to resolve agent_id → endpoint_id for routing events.
   */
  listEndpoints(workspaceId: string): Promise<EndpointRef[]>;

  /**
   * Add an endpoint as a participant in a context (idempotent).
   * Returns whether the participant was newly added.
   */
  addParticipant(contextId: string, endpointId: string): Promise<{ added: boolean }>;

  /**
   * Remove an endpoint from a context's participant list (idempotent).
   * Returns whether the participant was removed.
   */
  removeParticipant(contextId: string, endpointId: string): Promise<{ removed: boolean }>;

  /**
   * Subscribe an endpoint to event types in a context (UPSERT, idempotent).
   * eventTypes defaults to ["*"] (all events).
   * Pass [] to create a silent watcher — still a participant, never woken.
   */
  subscribeToContext(
    contextId: string,
    endpointId: string,
    eventTypes?: string[]
  ): Promise<void>;

  /**
   * Remove an endpoint's subscription from a context entirely.
   * Does NOT remove the endpoint from participants.
   */
  unsubscribeFromContext(contextId: string, endpointId: string): Promise<void>;

  /**
   * Batch-apply participant + subscription changes in one atomic call.
   *
   * - `entries`: each endpoint is added as a participant AND gets its subscription
   *   upserted with the given `event_types`. Pass `[]` to create a silent watcher.
   * - `participantsOnly`: endpoints added as participants with no subscription change.
   */
  applyContextSubscriptions(
    contextId: string,
    entries: Array<{ endpoint_id: string; event_types: string[] }>,
    participantsOnly?: string[]
  ): Promise<void>;

  /**
   * List all subscriptions for a context.
   */
  listContextSubscriptions(
    contextId: string
  ): Promise<Array<{ endpoint_id: string; event_types: string[]; subscribed_at: string }>>;

  /**
   * List child contexts whose parent_context_id equals contextId.
   * Used for epic→card links.
   */
  listChildContexts(contextId: string): Promise<ContextRef[]>;
}

// ---------------------------------------------------------------------------
// Stub implementation — used in tests and as a fallback when the real client
// does not yet expose these methods (pre-Track-S integration).
// ---------------------------------------------------------------------------

let _ctxSeq = 0;

export class StubBusClient implements BusClient {
  private contexts: ContextRef[] = [];
  private endpoints: EndpointRef[] = [];
  public emittedEvents: EmitInput[] = [];
  /** Captured createContext inputs — for assertions in tests. */
  public createdContexts: CreateContextInput[] = [];

  seedContext(ctx: ContextRef): void {
    this.contexts.push(ctx);
  }

  seedEndpoint(ep: EndpointRef): void {
    this.endpoints.push(ep);
  }

  async createContext(input: CreateContextInput): Promise<string> {
    const id = `ctx_stub_${++_ctxSeq}`;
    this.createdContexts.push(input);
    this.contexts.push({
      context_id: id,
      workspace_id: input.workspace_id,
      scope_id: input.scope_id ?? null,
      created_at: new Date().toISOString(),
      title: input.title ?? null,
      first_message_preview: input.title ?? null,
      participants: input.participants ?? [],
    });
    return id;
  }

  async listContextsForScope(
    workspaceId: string,
    scopeId: string
  ): Promise<ContextRef[]> {
    return this.contexts.filter(
      (c) => c.workspace_id === workspaceId && c.scope_id === scopeId
    );
  }

  async emit(input: EmitInput): Promise<void> {
    this.emittedEvents.push(input);
  }

  async listEndpoints(workspaceId: string): Promise<EndpointRef[]> {
    return this.endpoints.filter((e) => e.endpoint_id.startsWith(`actor:${workspaceId}:`) || e.workspace_id === workspaceId);
  }

  async addParticipant(
    contextId: string,
    endpointId: string
  ): Promise<{ added: boolean }> {
    const ctx = this.contexts.find((c) => c.context_id === contextId);
    if (ctx && !ctx.participants.includes(endpointId)) {
      ctx.participants.push(endpointId);
      return { added: true };
    }
    return { added: false };
  }

  async removeParticipant(
    contextId: string,
    endpointId: string
  ): Promise<{ removed: boolean }> {
    const ctx = this.contexts.find((c) => c.context_id === contextId);
    if (!ctx) return { removed: false };
    const idx = ctx.participants.indexOf(endpointId);
    if (idx === -1) return { removed: false };
    ctx.participants.splice(idx, 1);
    return { removed: true };
  }

  async subscribeToContext(
    contextId: string,
    endpointId: string,
    eventTypes: string[] = ["*"]
  ): Promise<void> {
    this._subscriptions ??= new Map();
    this._subscriptions.set(`${contextId}::${endpointId}`, eventTypes);
  }

  async applyContextSubscriptions(
    contextId: string,
    entries: Array<{ endpoint_id: string; event_types: string[] }>,
    participantsOnly: string[] = []
  ): Promise<void> {
    const ctx = this.contexts.find((c) => c.context_id === contextId);
    this._subscriptions ??= new Map();
    // participantsOnly: add as participant, no subscription change
    for (const ep of participantsOnly) {
      if (ctx && !ctx.participants.includes(ep)) {
        ctx.participants.push(ep);
      }
    }
    // entries: add as participant + upsert subscription
    for (const entry of entries) {
      if (ctx && !ctx.participants.includes(entry.endpoint_id)) {
        ctx.participants.push(entry.endpoint_id);
      }
      this._subscriptions.set(`${contextId}::${entry.endpoint_id}`, entry.event_types);
    }
  }

  async unsubscribeFromContext(
    contextId: string,
    endpointId: string
  ): Promise<void> {
    this._subscriptions?.delete(`${contextId}::${endpointId}`);
  }

  async listContextSubscriptions(
    contextId: string
  ): Promise<Array<{ endpoint_id: string; event_types: string[]; subscribed_at: string }>> {
    if (!this._subscriptions) return [];
    const result: Array<{ endpoint_id: string; event_types: string[]; subscribed_at: string }> = [];
    const prefix = `${contextId}::`;
    for (const [key, eventTypes] of this._subscriptions.entries()) {
      if (key.startsWith(prefix)) {
        const endpointId = key.slice(prefix.length);
        result.push({ endpoint_id: endpointId, event_types: eventTypes, subscribed_at: new Date().toISOString() });
      }
    }
    return result;
  }

  async listChildContexts(contextId: string): Promise<ContextRef[]> {
    return this._childContexts?.get(contextId) ?? [];
  }

  /** Subscription state keyed by "contextId::endpointId" — accessible in tests. */
  public _subscriptions?: Map<string, string[]>;

  /**
   * Seed child-context relationships for test assertions.
   * Key = parent context_id, value = array of child ContextRef.
   */
  public _childContexts?: Map<string, ContextRef[]>;
}

/**
 * Cast the extension context's busClient (typed as `any`) to the BusClient
 * interface.  This is the integration join — when Track S exports a typed
 * client, replace this cast with a proper typed import.
 */
export function asBusClient(raw: unknown): BusClient {
  return raw as BusClient;
}
