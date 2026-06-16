/**
 * Shared substrate types for floe-app.
 *
 * Thin refs mirror wire field names from floe-bus exactly.
 * Do not add derived/computed fields here — those belong in the consuming module.
 */

// ---------------------------------------------------------------------------
// Refs (wire shapes mirroring floe-bus)
// ---------------------------------------------------------------------------

export type WorkspaceRef = {
  workspace_id: string;
  name: string;
  locator: string;
  status: string;
  selected_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ScopeRef = {
  scope_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  created_at: string;
  updated_at: string;
};

export type ContextRef = {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  last_event_at: string | null;
  participants: string[];
  first_message_preview: string | null;
};

export type EndpointRef = {
  endpoint_id: string;
  workspace_id: string;
  name: string;
  agent_id: string | null;
  bridge_id: string | null;
  status: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
};

export type PulseRef = {
  pulse_id: string;
  workspace_id: string;
  scope_id: string | null;
  persistence: "workspace" | "local";
  status: string;
  trigger: unknown;
  next_fire_at: string | null;
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  updated_at: string;
};

export type Watermark = {
  workspace_id: string;
  endpoint_id: string;
  cursor: string;
  updated_at: string;
};

export type DestinationSelector =
  | { kind: "endpoint"; endpoint_id: string }
  | { kind: "context"; context_id: string }
  | {
      kind: "broadcast";
      scope: "workspace";
      target: string;
      exclude_source?: boolean;
    };

export type ResponseExpectation = {
  expected: boolean;
  mode?: "open" | "thread_affine" | "correlated";
  correlation_id?: string | null;
  timeout_at?: string | null;
};

export type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  source_endpoint_id: string | null;
  thread_id: string;
  context_id: string;
  scope_id: string | null;
  correlation_id: string | null;
  destination_json: DestinationSelector;
  content: Record<string, unknown>;
  response: ResponseExpectation;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type PendingResponse = {
  pending_id: string;
  workspace_id: string;
  waiting_endpoint_id: string;
  source_event_id: string;
  mode: string;
  thread_id: string | null;
  correlation_id: string | null;
  timeout_at: string | null;
  status: string;
  created_at: string;
  resolved_at: string | null;
};

// ---------------------------------------------------------------------------
// Deliveries
// ---------------------------------------------------------------------------

/** Raw delivery_bundles row as returned by GET /v1/delivery */
export type DeliveryRow = {
  delivery_id: string;
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events_json: string;
  state: string;
  lease_expires_at: string | null;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  claimed_at: string | null;
};

/** Hydrated delivery as returned by GET /v1/delivery/claim */
export type DeliveryBundle = {
  delivery_id: string;
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events: EventEnvelope[];
  delivered_at: string;
};

// ---------------------------------------------------------------------------
// Runtime telemetry
// ---------------------------------------------------------------------------

/** Raw runtime_telemetry row as returned by GET /v1/runtime/telemetry */
export type TelemetryRow = {
  telemetry_id: string;
  workspace_id: string;
  endpoint_id: string;
  delivery_id: string | null;
  kind: string;
  payload_json: string;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Runtime bindings
// ---------------------------------------------------------------------------

export type RuntimeBindingScope = "agent" | "workspace_default" | "global_default";

export type RuntimeBindingRecord = {
  binding_key: string;
  scope: RuntimeBindingScope;
  workspace_id: string | null;
  endpoint_id: string | null;
  auth_profile: string;
  model: string | null;
  thinking_level: string | null;
  created_at: string;
  updated_at: string;
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

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type AuthProfileRecord = {
  id: string;
  provider: string;
  model?: string;
  label?: string;
  created_at?: string;
  updated_at?: string;
};

export type AuthModelRecord = {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
};

// ---------------------------------------------------------------------------
// Saved configs
// ---------------------------------------------------------------------------

export type SavedConfigRow = {
  config_id: string;
  name: string;
  config_json: string;
  created_at: string;
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Runtime status
// ---------------------------------------------------------------------------

export type RuntimeStatus = {
  bridge: {
    online: boolean;
    runtime_adapter: string | null;
  };
};

export type LocalConfigStatus = {
  ok: boolean;
  config_path: string;
  home: string;
  bus: unknown;
  web: unknown;
  bridge: unknown;
};

// ---------------------------------------------------------------------------
// Endpoint resolve
// ---------------------------------------------------------------------------

export type ResolvedEndpoint = {
  endpoint_id: string;
  found: boolean;
};

// ---------------------------------------------------------------------------
// Projection types (mirror floe-bus/src/scopes/projection.ts)
// ---------------------------------------------------------------------------

export type ScopeProjectionContextRef = {
  context_id: string;
  workspace_id: string;
  scope_id: string;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
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
    pulse_subscribers: Array<{ pulse_id: string; subscriber: unknown }>;
    event_context_ownership: Array<{ event_id: string; context_id: string }>;
  };
  unsupported: Array<{ kind: string; reason: string }>;
};

// ---------------------------------------------------------------------------
// Field layout (persisted renderer layout for scope projection)
// ---------------------------------------------------------------------------

export type FieldLayoutNode = {
  id: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

export type FieldLayoutEdge = {
  id: string;
  source: string;
  target: string;
  data?: Record<string, unknown>;
};

export type FieldLayout = {
  workspace_id: string;
  scope_id: string;
  renderer: string;
  nodes: FieldLayoutNode[];
  edges: FieldLayoutEdge[];
  updated_at: string;
};

// ---------------------------------------------------------------------------
// Event trace
// ---------------------------------------------------------------------------

export type EventTrace = {
  event_id: string;
  delivery_id: string | null;
  telemetry: unknown[];
};

// ---------------------------------------------------------------------------
// Emit input (for client.emit)
// ---------------------------------------------------------------------------

export type EmitInput = {
  type: string;
  workspace_id: string;
  source_endpoint_id: string;
  destination: DestinationSelector;
  context_id?: string | null;
  scope_id?: string | null;
  current_delivery_context_id?: string | null;
  correlation_id?: string | null;
  content: Record<string, unknown>;
  response?: ResponseExpectation;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
};

// ---------------------------------------------------------------------------
// Pulse subscriber (for createPulse / subscribePulse / unsubscribePulse)
// ---------------------------------------------------------------------------

export type PulseSubscriber =
  | { kind: "context"; context_id: string }
  | { kind?: "endpoint"; endpoint_ref: string; context_id?: string | null };

export type PulseTrigger =
  | { type: "once"; at: string }
  | { type: "cron"; schedule: string; timezone?: string };

export type CreatePulseInput = {
  pulse_id: string;
  workspace_id: string;
  persistence?: "workspace" | "local";
  scope_id?: string | null;
  current_context_id?: string | null;
  trigger: PulseTrigger;
  content?: Record<string, unknown>;
  subscribers: PulseSubscriber[];
  created_by?: string;
};

// ---------------------------------------------------------------------------
// Stream messages (WebSocket /v1/events/stream)
// ---------------------------------------------------------------------------

export type StreamMsg = {
  type: string;
  payload: Record<string, unknown>;
  at: string;
};

// ---------------------------------------------------------------------------
// App-level domain types
// ---------------------------------------------------------------------------

export type ImpactSummary = {
  architecture?: string;
  product?: string;
  risk?: string;
  cost?: string;
};

export type DecisionCard = {
  source: PendingResponse;
  impact: ImpactSummary | null;
  askingActor: EndpointRef;
};
