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
   * Used by the reconciler on sidecar load.
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
}

/**
 * Cast the extension context's busClient (typed as `any`) to the BusClient
 * interface.  This is the integration join — when Track S exports a typed
 * client, replace this cast with a proper typed import.
 */
export function asBusClient(raw: unknown): BusClient {
  return raw as BusClient;
}
