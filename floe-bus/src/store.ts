/**
 * @invariant BusStore is the sole mutable substrate store for bus-owned records.
 * Runtime bindings, bridges, deliveries, and telemetry must be persisted and resolved here
 * with explicit precedence rules; callers must not invent parallel runtime state.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, parse, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CronExpressionParser } from "cron-parser";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";
import { ContextStore, applyContextSchema, type ContextRecord } from "./contexts/store.js";
import { decodeEventCursor } from "./event-cursor.js";
import {
  EndpointWatermarkStore,
  applyEndpointWatermarkSchema,
  type EndpointWatermark
} from "./endpoint-watermark-store.js";
import { resolveContext, type NotContextParticipantError } from "./contexts/resolver.js";
import {
  RESERVED_DEFAULT_SCOPE_ID,
  ScopeNotEmptyError,
  ScopeNotFoundError,
  ScopeReservedIdError,
  ScopeStore,
  applyScopeSchema,
  type ScopeRecord
} from "./scopes/store.js";

type Broadcast = (type: string, payload: Record<string, unknown>) => void;

export const BROADCAST_TARGETS = [
  "all",
  "active",
  "with_delivery_processor",
  "without_delivery_processor",
  "active_with_delivery_processor",
  "active_without_delivery_processor"
] as const;

export type BroadcastTarget = typeof BROADCAST_TARGETS[number];

export class ContextParticipantError extends Error {
  readonly code = "E_NOT_CONTEXT_PARTICIPANT" as const;
  readonly payload: NotContextParticipantError["payload"];
  constructor(payload: NotContextParticipantError["payload"]) {
    super(payload.message);
    this.name = "ContextParticipantError";
    this.payload = payload;
  }
}

export class ContextNotFoundError extends Error {
  readonly code = "E_CONTEXT_NOT_FOUND" as const;
  constructor(readonly workspace_id: string, readonly context_id: string) {
    super(`Context not found: ${context_id}`);
    this.name = "ContextNotFoundError";
  }
}

export class ContextAnchorError extends Error {
  readonly code = "E_CONTEXT_ANCHOR_INVALID" as const;
  constructor(
    readonly workspace_id: string,
    readonly context_id: string,
    readonly reason: string
  ) {
    super(`Invalid Context anchor: ${reason}`);
    this.name = "ContextAnchorError";
  }
}

export class ScopeRequiredError extends Error {
  readonly code = "E_SCOPE_REQUIRED" as const;
  constructor(readonly workspace_id: string, readonly reason: string) {
    super(`Scope is required: ${reason}`);
    this.name = "ScopeRequiredError";
  }
}

export class ContextScopeAssignmentError extends Error {
  readonly code = "E_CONTEXT_SCOPE_ASSIGNMENT_INVALID" as const;
  constructor(
    readonly workspace_id: string,
    readonly context_id: string,
    readonly reason: string
  ) {
    super(`Context Scope assignment invalid: ${reason}`);
    this.name = "ContextScopeAssignmentError";
  }
}

export class PulseNotFoundError extends Error {
  readonly code = "E_PULSE_NOT_FOUND" as const;
  constructor(readonly pulse_id: string) {
    super(`Pulse not found: ${pulse_id}`);
    this.name = "PulseNotFoundError";
  }
}

export type DestinationSelector =
  | { kind: "endpoint"; endpoint_id: string }
  | { kind: "context"; context_id: string }
  | {
      kind: "broadcast";
      scope: "workspace";
      target: BroadcastTarget;
      exclude_source?: boolean;
    };

export type ResponseExpectation = {
  expected: boolean;
  mode?: "open" | "thread_affine" | "correlated";
  correlation_id?: string | null;
  timeout_at?: string | null;
};

export type EventCommand = {
  type: string;
  workspace_id: string;
  source_endpoint_id: string;
  destination: DestinationSelector;
  /**
   * Legacy field retained for storage compatibility only — no new flow reads it.
   * Resolver computes the canonical `context_id`. If omitted, `submitEvent` writes
   * the resolved context_id into this column to satisfy the existing NOT NULL constraint.
   */
  thread_id?: string;
  correlation_id?: string | null;
  content: Record<string, unknown>;
  response?: ResponseExpectation;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
  /** Caller-supplied context_id (rule 1). When omitted, resolver decides. */
  context_id?: string | null;
  /** Caller-supplied organising Scope for newly-created contexts. Existing Context Scope remains authoritative. */
  scope_id?: string | null;
  /** Bridge passes the context_id of the delivery currently being processed (rules 2/3). */
  current_delivery_context_id?: string | null;
};

/**
 * Bus-originated trigger emission (pulse.fired, webhook ingest, etc.).
 *
 * Triggers are NOT actor-to-actor messages. Per design §3.1.6, the bus directly
 * creates a target-only context (`participants = [target_endpoint_id]`) and the
 * event's `source_endpoint_id` is `null` — never a synthetic system endpoint.
 * The participant-aware resolver (§3.1.4) does not apply.
 */
export type TriggerEventCommand = {
  type: string;
  workspace_id: string;
  target_endpoint_id: string;
  context_id?: string | null;
  scope_id?: string | null;
  content: Record<string, unknown>;
  metadata: Record<string, unknown> & { trigger_kind: "pulse" | "webhook" | string };
  correlation_id?: string | null;
  idempotency_key?: string | null;
};

export type PulseSubscriber =
  | { kind: "context"; context_id: string }
  | { kind?: "endpoint"; endpoint_ref: string; context_id?: string | null };

export type PulsePersistence = "workspace" | "local";

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

export type DeliveryBundle = {
  delivery_id: string;
  endpoint_id: string;
  workspace_id: string;
  trigger_event_id: string;
  events: EventEnvelope[];
  delivered_at: string;
};

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

export type BridgeRecord = {
  bridge_id: string;
  status: string;
  capabilities: Record<string, unknown>;
  last_seen_at: string;
  created_at: string;
};

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workspaceIdForLocator(locator: string): string {
  const hash = stableHash(locator.toLowerCase()).slice(0, 16);
  return `workspace:${hash}`;
}

export class BusStore {
  readonly db: DatabaseSync;
  readonly contextStore: ContextStore;
  readonly scopeStore: ScopeStore;
  readonly endpointWatermarkStore: EndpointWatermarkStore;

  constructor(configPath: string, readonly config: LocalConfig) {
    const dataDir = resolveLocalPath(configPath, config.home, config.bus.data_dir);
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "floe-bus.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.contextStore = new ContextStore(this.db);
    this.scopeStore = new ScopeStore(this.db);
    this.endpointWatermarkStore = new EndpointWatermarkStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        locator TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        init_authorized INTEGER NOT NULL DEFAULT 0,
        active_config_hash TEXT,
        selected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bridges (
        bridge_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS endpoints (
        endpoint_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_id TEXT,
        bridge_id TEXT,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_endpoint_id TEXT,
        thread_id TEXT NOT NULL,
        scope_id TEXT,
        correlation_id TEXT,
        destination_json TEXT NOT NULL,
        content_json TEXT NOT NULL,
        response_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
        ON events(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS event_queue (
        queue_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        destination_endpoint_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivery_id TEXT,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        delivered_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_event_queue_destination
        ON event_queue(destination_endpoint_id, state, created_at);

      CREATE TABLE IF NOT EXISTS delivery_bundles (
        delivery_id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        trigger_event_id TEXT NOT NULL,
        events_json TEXT NOT NULL,
        state TEXT NOT NULL,
        lease_expires_at TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 1,
        last_error TEXT,
        created_at TEXT NOT NULL,
        claimed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_delivery_bundles_endpoint
        ON delivery_bundles(endpoint_id, state, created_at);

      CREATE TABLE IF NOT EXISTS pending_responses (
        pending_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        waiting_endpoint_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        thread_id TEXT,
        correlation_id TEXT,
        timeout_at TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_pending_waiting_endpoint
        ON pending_responses(waiting_endpoint_id, status, created_at);

      CREATE TABLE IF NOT EXISTS runtime_telemetry (
        telemetry_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        delivery_id TEXT,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS saved_configs (
        config_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_bindings (
        binding_key TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        workspace_id TEXT,
        endpoint_id TEXT,
        auth_profile TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_runtime_bindings_workspace
        ON runtime_bindings(workspace_id, scope, endpoint_id);

      CREATE TABLE IF NOT EXISTS pulses (
        pulse_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        persistence TEXT NOT NULL DEFAULT 'local',
        scope_id TEXT,
        trigger_json TEXT NOT NULL,
        content_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_fire_at TEXT,
        last_fired_at TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_pulses_workspace
        ON pulses(workspace_id, status);

      CREATE INDEX IF NOT EXISTS idx_pulses_next_fire
        ON pulses(status, next_fire_at);

      CREATE TABLE IF NOT EXISTS pulse_subscribers (
        pulse_id TEXT NOT NULL,
        subscriber_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (pulse_id, subscriber_json)
      );

      CREATE TABLE IF NOT EXISTS pulse_delivery_contexts (
        pulse_id TEXT NOT NULL,
        subscriber_key TEXT NOT NULL,
        context_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        endpoint_ref TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (pulse_id, subscriber_key)
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_delivery_contexts_context
        ON pulse_delivery_contexts(context_id);
    `);
    this.addColumnIfMissing("events", "destination_endpoint_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("events", "destination_json", "TEXT");
    this.addColumnIfMissing("events", "response_json", "TEXT");
    this.addColumnIfMissing("events", "context_id", "TEXT");
    this.addColumnIfMissing("events", "scope_id", "TEXT");
    this.relaxEventScopeColumn();
    this.addColumnIfMissing("delivery_bundles", "wait_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "resume_reason", "TEXT NOT NULL DEFAULT 'event'");
    this.addColumnIfMissing("runtime_telemetry", "delivery_id", "TEXT");
    this.addColumnIfMissing("runtime_bindings", "model", "TEXT");
    this.addColumnIfMissing("runtime_bindings", "thinking_level", "TEXT");
    this.addColumnIfMissing("pulses", "persistence", "TEXT NOT NULL DEFAULT 'local'");
    this.addColumnIfMissing("pulses", "scope_id", "TEXT");
    this.relaxPulseScopeColumn();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_pulses_workspace_scope
        ON pulses(workspace_id, scope_id, status);
    `);
    applyContextSchema(this.db);
    applyScopeSchema(this.db);
    applyEndpointWatermarkSchema(this.db);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_workspace_created
        ON events(workspace_id, created_at, event_id);
    `);
    this.backfillEventDestinationJson();
    this.backfillEventResponseJson();
    this.backfillEventScopeId();
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private relaxEventScopeColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const scope = columns.find((item) => item.name === "scope_id");
    if (scope?.notnull !== 1 && scope?.dflt_value == null) return;

    this.db.exec(`
      CREATE TABLE events_next (
        event_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_endpoint_id TEXT,
        destination_endpoint_id TEXT NOT NULL DEFAULT '',
        thread_id TEXT NOT NULL,
        context_id TEXT,
        scope_id TEXT,
        correlation_id TEXT,
        destination_json TEXT,
        content_json TEXT NOT NULL,
        response_json TEXT,
        metadata_json TEXT NOT NULL,
        idempotency_key TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO events_next (
        event_id, type, workspace_id, source_endpoint_id, destination_endpoint_id, thread_id, context_id,
        scope_id, correlation_id, destination_json, content_json, response_json, metadata_json, idempotency_key, created_at
      )
      SELECT
        event_id,
        type,
        workspace_id,
        source_endpoint_id,
        COALESCE(destination_endpoint_id, ''),
        thread_id,
        context_id,
        NULLIF(scope_id, 'default'),
        correlation_id,
        destination_json,
        content_json,
        response_json,
        metadata_json,
        idempotency_key,
        created_at
      FROM events;

      DROP TABLE events;
      ALTER TABLE events_next RENAME TO events;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency
        ON events(idempotency_key)
        WHERE idempotency_key IS NOT NULL;
    `);
  }

  private relaxPulseScopeColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(pulses)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const scope = columns.find((item) => item.name === "scope_id");
    if (scope?.notnull !== 1 && scope?.dflt_value == null) return;

    this.db.exec(`
      CREATE TABLE pulses_next (
        pulse_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        persistence TEXT NOT NULL DEFAULT 'local',
        scope_id TEXT,
        trigger_json TEXT NOT NULL,
        content_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_fire_at TEXT,
        last_fired_at TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0
      );

      INSERT INTO pulses_next (
        pulse_id, workspace_id, persistence, scope_id, trigger_json, content_json, status,
        created_by, created_at, updated_at, next_fire_at, last_fired_at, fire_count
      )
      SELECT
        pulse_id,
        workspace_id,
        persistence,
        NULLIF(scope_id, 'default'),
        trigger_json,
        content_json,
        status,
        created_by,
        created_at,
        updated_at,
        next_fire_at,
        last_fired_at,
        fire_count
      FROM pulses;

      DROP TABLE pulses;
      ALTER TABLE pulses_next RENAME TO pulses;

      CREATE INDEX IF NOT EXISTS idx_pulses_workspace
        ON pulses(workspace_id, status);

      CREATE INDEX IF NOT EXISTS idx_pulses_next_fire
        ON pulses(status, next_fire_at);

      CREATE INDEX IF NOT EXISTS idx_pulses_workspace_scope
        ON pulses(workspace_id, scope_id, status);
    `);
  }

  private backfillEventDestinationJson(): void {
    this.db.exec(`
      UPDATE events
      SET destination_json = json_object('kind','endpoint','endpoint_id',destination_endpoint_id)
      WHERE (destination_json IS NULL OR destination_json = '')
        AND destination_endpoint_id IS NOT NULL
    `);
  }

  private backfillEventResponseJson(): void {
    this.db.exec(`
      UPDATE events
      SET response_json = '{"expected":false,"mode":"open","correlation_id":null,"timeout_at":null}'
      WHERE response_json IS NULL OR response_json = ''
    `);
  }

  private backfillEventScopeId(): void {
    this.db.exec(`
      UPDATE events
      SET scope_id = (
        SELECT contexts.scope_id
        FROM contexts
        WHERE contexts.context_id = events.context_id
      )
      WHERE context_id IS NOT NULL
    `);
  }

  listWorkspaces(): unknown[] {
    return this.db.prepare("SELECT * FROM workspaces ORDER BY created_at DESC").all();
  }

  registerWorkspace(input: { locator: string; name?: string; init_authorized?: boolean }, broadcast: Broadcast): unknown {
    const timestamp = now();
    const locator = input.locator;
    const workspaceId = workspaceIdForLocator(locator);
    const name = input.name?.trim() || locator.split(/[\\/]/).filter(Boolean).at(-1) || workspaceId;
    this.db.prepare(`
      INSERT INTO workspaces (workspace_id, name, locator, status, init_authorized, created_at, updated_at)
      VALUES (?, ?, ?, 'registered', ?, ?, ?)
      ON CONFLICT(locator) DO UPDATE SET
        name = excluded.name,
        init_authorized = max(workspaces.init_authorized, excluded.init_authorized),
        updated_at = excluded.updated_at
    `).run(workspaceId, name, locator, input.init_authorized ? 1 : 0, timestamp, timestamp);
    const workspace = this.getWorkspace(workspaceId);
    broadcast("workspace_registered", { workspace });
    broadcast("workspace_attachment_requested", { workspace });
    return workspace;
  }

  selectWorkspace(workspaceId: string, broadcast: Broadcast): unknown {
    const timestamp = now();
    this.db.prepare("UPDATE workspaces SET selected_at = ?, updated_at = ? WHERE workspace_id = ?")
      .run(timestamp, timestamp, workspaceId);
    const workspace = this.getWorkspace(workspaceId);
    broadcast("workspace_selected", { workspace });
    broadcast("workspace_attachment_requested", { workspace });
    return workspace;
  }

  getWorkspace(workspaceId: string): unknown {
    return this.db.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId);
  }

  listScopes(workspaceId: string): ScopeRecord[] {
    return this.scopeStore.listScopes(workspaceId);
  }

  getScope(workspaceId: string, scopeId: string): ScopeRecord | null {
    return this.scopeStore.getScope(workspaceId, scopeId);
  }

  createScope(input: {
    workspace_id: string;
    scope_id?: string;
    title: string;
    description?: string | null;
  }, broadcast: Broadcast): ScopeRecord {
    const scope = this.scopeStore.createScope(input);
    broadcast("scope_created", { scope });
    return scope;
  }

  updateScope(input: {
    workspace_id: string;
    scope_id: string;
    title?: string;
    description?: string | null;
  }, broadcast: Broadcast): ScopeRecord | null {
    const scope = this.scopeStore.updateScope(input);
    if (scope) broadcast("scope_updated", { scope });
    return scope;
  }

  deleteScope(workspaceId: string, scopeId: string, broadcast: Broadcast): void {
    const scope = this.scopeStore.getScope(workspaceId, scopeId);
    if (!scope) {
      throw new ScopeNotFoundError(workspaceId, scopeId);
    }
    if (scopeId === RESERVED_DEFAULT_SCOPE_ID) {
      throw new ScopeReservedIdError(workspaceId, scopeId);
    }
    const contextCount = this.contextStore.listContextsForScope(workspaceId, scopeId).length;
    const pulseCount = this.listPulses({ workspace_id: workspaceId, scope_id: scopeId }).length;
    if (contextCount > 0 || pulseCount > 0) {
      throw new ScopeNotEmptyError(workspaceId, scopeId, contextCount, pulseCount);
    }
    this.scopeStore.deleteScope(workspaceId, scopeId);
    broadcast("scope_deleted", { workspace_id: workspaceId, scope_id: scopeId });
  }

  private validateScopeId(workspaceId: string, scopeId: string): string {
    if (!this.scopeStore.getScope(workspaceId, scopeId)) {
      throw new ScopeNotFoundError(workspaceId, scopeId);
    }
    return scopeId;
  }

  private requireScopeId(workspaceId: string, scopeId: string | null | undefined, reason: string): string {
    if (!scopeId) throw new ScopeRequiredError(workspaceId, reason);
    return this.validateScopeId(workspaceId, scopeId);
  }

  private getContextAnchor(workspaceId: string, contextId: string): ContextRecord {
    const context = this.contextStore.getContext(contextId);
    if (!context || context.workspace_id !== workspaceId) {
      throw new ContextNotFoundError(workspaceId, contextId);
    }
    return context;
  }

  private requireEndpointContextAnchor(workspaceId: string, contextId: string, endpointId: string): ContextRecord {
    const context = this.getContextAnchor(workspaceId, contextId);
    if (!context.scope_id && !this.contextStore.isParticipant(contextId, endpointId)) {
      throw new ContextAnchorError(
        workspaceId,
        contextId,
        "unscoped endpoint delivery Context must include the target endpoint as a participant"
      );
    }
    return context;
  }

  private validatePulseSubscriberAnchor(input: {
    workspace_id: string;
    pulse_scope_id: string | null;
    subscriber: PulseSubscriber;
    allow_missing_generated_scope?: boolean;
  }): { creates_generated_delivery_context: boolean; anchor_scope_id: string | null } {
    const { workspace_id: workspaceId, pulse_scope_id: pulseScopeId, subscriber } = input;
    if (subscriber.kind === "context") {
      return {
        creates_generated_delivery_context: false,
        anchor_scope_id: this.getContextAnchor(workspaceId, subscriber.context_id).scope_id
      };
    }

    if (subscriber.context_id) {
      const endpointId = this.resolveSubscriberEndpointId(workspaceId, subscriber.endpoint_ref);
      return {
        creates_generated_delivery_context: false,
        anchor_scope_id: this.requireEndpointContextAnchor(workspaceId, subscriber.context_id, endpointId).scope_id
      };
    }

    if (!pulseScopeId && !input.allow_missing_generated_scope) {
      throw new ScopeRequiredError(
        workspaceId,
        "pulse must be configured with a Scope before adding generated endpoint delivery"
      );
    }

    return { creates_generated_delivery_context: true, anchor_scope_id: null };
  }

  listRuntimeBindings(workspaceId?: string): RuntimeBindingRecord[] {
    const rows = workspaceId
      ? this.db.prepare("SELECT * FROM runtime_bindings WHERE workspace_id = ? OR scope = 'global_default' ORDER BY scope, endpoint_id").all(workspaceId) as any[]
      : this.db.prepare("SELECT * FROM runtime_bindings ORDER BY scope, workspace_id, endpoint_id").all() as any[];
    return rows.map((row) => this.rowToRuntimeBinding(row));
  }

  getRuntimeBindingResolution(workspaceId: string, endpointId: string): {
    endpoint_auth_profile: string | null;
    workspace_auth_profile: string | null;
    global_auth_profile: string | null;
    endpoint_model: string | null;
    workspace_model: string | null;
    global_model: string | null;
    endpoint_thinking_level: string | null;
    workspace_thinking_level: string | null;
    global_thinking_level: string | null;
  } {
    const endpoint = this.db.prepare(`
      SELECT auth_profile, model, thinking_level
      FROM runtime_bindings
      WHERE scope = 'agent' AND workspace_id = ? AND endpoint_id = ?
      LIMIT 1
    `).get(workspaceId, endpointId) as { auth_profile: string; model: string | null; thinking_level: string | null } | undefined;
    const workspace = this.db.prepare(`
      SELECT auth_profile, model, thinking_level
      FROM runtime_bindings
      WHERE scope = 'workspace_default' AND workspace_id = ?
      LIMIT 1
    `).get(workspaceId) as { auth_profile: string; model: string | null; thinking_level: string | null } | undefined;
    const global = this.db.prepare(`
      SELECT auth_profile, model, thinking_level
      FROM runtime_bindings
      WHERE scope = 'global_default'
      LIMIT 1
    `).get() as { auth_profile: string; model: string | null; thinking_level: string | null } | undefined;
    return {
      endpoint_auth_profile: endpoint?.auth_profile ?? null,
      workspace_auth_profile: workspace?.auth_profile ?? null,
      global_auth_profile: global?.auth_profile ?? null,
      endpoint_model: endpoint?.model ?? null,
      workspace_model: workspace?.model ?? null,
      global_model: global?.model ?? null,
      endpoint_thinking_level: endpoint?.thinking_level ?? null,
      workspace_thinking_level: workspace?.thinking_level ?? null,
      global_thinking_level: global?.thinking_level ?? null
    };
  }

  upsertRuntimeBinding(input: {
    scope: RuntimeBindingScope;
    workspace_id?: string | null;
    endpoint_id?: string | null;
    auth_profile: string;
    model?: string | null;
    thinking_level?: string | null;
  }, broadcast: Broadcast): RuntimeBindingRecord {
    const timestamp = now();
    const bindingKey = runtimeBindingKey(input.scope, input.workspace_id ?? null, input.endpoint_id ?? null);
    this.db.prepare(`
      INSERT INTO runtime_bindings (
        binding_key, scope, workspace_id, endpoint_id, auth_profile, model, thinking_level, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(binding_key) DO UPDATE SET
        auth_profile = excluded.auth_profile,
        model = excluded.model,
        thinking_level = excluded.thinking_level,
        updated_at = excluded.updated_at
    `).run(
      bindingKey,
      input.scope,
      input.workspace_id ?? null,
      input.endpoint_id ?? null,
      input.auth_profile,
      input.model ?? null,
      input.thinking_level ?? null,
      timestamp,
      timestamp
    );
    const row = this.db.prepare("SELECT * FROM runtime_bindings WHERE binding_key = ?").get(bindingKey) as any;
    const binding = this.rowToRuntimeBinding(row);
    broadcast("runtime_binding_updated", { binding });
    return binding;
  }

  clearRuntimeBinding(input: {
    scope: RuntimeBindingScope;
    workspace_id?: string | null;
    endpoint_id?: string | null;
  }, broadcast: Broadcast): { ok: true; binding_key: string } {
    const bindingKey = runtimeBindingKey(input.scope, input.workspace_id ?? null, input.endpoint_id ?? null);
    this.db.prepare("DELETE FROM runtime_bindings WHERE binding_key = ?").run(bindingKey);
    broadcast("runtime_binding_cleared", { binding_key: bindingKey });
    return { ok: true, binding_key: bindingKey };
  }

  listBridges(): BridgeRecord[] {
    const rows = this.db.prepare("SELECT * FROM bridges ORDER BY created_at, bridge_id").all() as any[];
    return rows.map((row) => ({
      bridge_id: String(row.bridge_id),
      status: String(row.status),
      capabilities: parseJson<Record<string, unknown>>(String(row.capabilities_json ?? "{}")),
      last_seen_at: String(row.last_seen_at),
      created_at: String(row.created_at)
    }));
  }

  deleteWorkspace(workspaceId: string, options: { delete_locator?: boolean }, broadcast: Broadcast): {
    ok: true;
    workspace_id: string;
    locator: string;
    locator_deleted: boolean;
  } {
    const workspace = this.getWorkspace(workspaceId) as any;
    if (!workspace) throw new Error(`Unknown workspace_id: ${workspaceId}`);
    const locator = String(workspace.locator ?? "");
    const deleteLocator = !!options.delete_locator;
    let locatorDeleted = false;
    if (deleteLocator) locatorDeleted = deleteWorkspaceLocator(locator);
    this.transaction(() => {
      this.db.prepare("DELETE FROM event_queue WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM delivery_bundles WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM pending_responses WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM runtime_telemetry WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM events WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM pulse_delivery_contexts WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare(`
        DELETE FROM context_participants
        WHERE context_id IN (SELECT context_id FROM contexts WHERE workspace_id = ?)
      `).run(workspaceId);
      this.db.prepare("DELETE FROM contexts WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM scopes WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM endpoints WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM runtime_bindings WHERE workspace_id = ?").run(workspaceId);
      this.db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").run(workspaceId);
    });
    const payload = {
      workspace_id: workspaceId,
      locator,
      delete_locator: deleteLocator,
      locator_deleted: locatorDeleted
    };
    broadcast("workspace_deleted", payload);
    return { ok: true, workspace_id: workspaceId, locator, locator_deleted: locatorDeleted };
  }

  deleteContext(contextId: string, broadcast: Broadcast): {
    ok: true;
    context_id: string;
    workspace_id: string;
    events_deleted: number;
    delivery_bundles_deleted: number;
    pulse_subscribers_deleted: number;
  } | null {
    const context = this.contextStore.getContext(contextId);
    if (!context) return null;
    const deliveryIdsWithDeletedContext = new Set<string>();
    const deliveryIdsToDelete = new Set<string>();
    let eventsDeleted = 0;
    let pulseSubscribersDeleted = 0;

    this.transaction(() => {
      const eventIds = (this.db
        .prepare("SELECT event_id FROM events WHERE context_id = ?")
        .all(contextId) as Array<{ event_id: string }>).map((row) => row.event_id);
      eventsDeleted = eventIds.length;

      const bundles = this.db.prepare("SELECT delivery_id, events_json FROM delivery_bundles WHERE workspace_id = ?")
        .all(context.workspace_id) as Array<{ delivery_id: string; events_json: string }>;
      for (const bundle of bundles) {
        const events = parseJson<EventEnvelope[]>(bundle.events_json);
        const remainingEvents = events.filter((event) => event.context_id !== contextId);
        if (remainingEvents.length === events.length) continue;
        deliveryIdsWithDeletedContext.add(bundle.delivery_id);
        if (remainingEvents.length === 0) {
          deliveryIdsToDelete.add(bundle.delivery_id);
          this.db.prepare("DELETE FROM delivery_bundles WHERE delivery_id = ?").run(bundle.delivery_id);
          continue;
        }
        this.db.prepare(`
          UPDATE delivery_bundles
          SET trigger_event_id = ?, events_json = ?
          WHERE delivery_id = ?
        `).run(remainingEvents[0].event_id, json(remainingEvents), bundle.delivery_id);
      }

      for (const eventId of eventIds) {
        const queuedRows = this.db.prepare("SELECT delivery_id FROM event_queue WHERE event_id = ?")
          .all(eventId) as Array<{ delivery_id: string | null }>;
        for (const row of queuedRows) {
          if (row.delivery_id) deliveryIdsWithDeletedContext.add(row.delivery_id);
        }
        this.db.prepare("DELETE FROM event_queue WHERE event_id = ?").run(eventId);
        this.db.prepare("DELETE FROM pending_responses WHERE source_event_id = ?").run(eventId);
        this.db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);
      }

      for (const deliveryId of deliveryIdsWithDeletedContext) {
        this.db.prepare("DELETE FROM runtime_telemetry WHERE delivery_id = ?").run(deliveryId);
      }
      for (const deliveryId of deliveryIdsToDelete) {
        this.db.prepare("DELETE FROM event_queue WHERE delivery_id = ?").run(deliveryId);
      }

      const subscribers = this.db.prepare(`
        SELECT ps.pulse_id, ps.subscriber_json
        FROM pulse_subscribers ps
        JOIN pulses p ON p.pulse_id = ps.pulse_id
        WHERE p.workspace_id = ?
      `).all(context.workspace_id) as Array<{ pulse_id: string; subscriber_json: string }>;
      for (const subscriberRow of subscribers) {
        const subscriber = parseJson<PulseSubscriber>(subscriberRow.subscriber_json);
        if (subscriber.context_id !== contextId) continue;
        const result = this.db.prepare("DELETE FROM pulse_subscribers WHERE pulse_id = ? AND subscriber_json = ?")
          .run(subscriberRow.pulse_id, subscriberRow.subscriber_json);
        pulseSubscribersDeleted += Number(result.changes ?? 0);
      }

      this.db.prepare("UPDATE contexts SET parent_context_id = NULL WHERE parent_context_id = ?").run(contextId);
      this.db.prepare("DELETE FROM context_participants WHERE context_id = ?").run(contextId);
      this.db.prepare("DELETE FROM contexts WHERE context_id = ?").run(contextId);
    });

    const result = {
      ok: true as const,
      context_id: contextId,
      workspace_id: context.workspace_id,
      events_deleted: eventsDeleted,
      delivery_bundles_deleted: deliveryIdsToDelete.size,
      pulse_subscribers_deleted: pulseSubscribersDeleted
    };
    broadcast("context_deleted", result);
    return result;
  }

  assignContextScope(input: {
    workspace_id: string;
    context_id: string;
    scope_id: string;
    assigned_by?: string | null;
    reason?: string | null;
  }, broadcast: Broadcast): {
    ok: true;
    context: ContextRecord & { participants: string[] };
    audit_event: EventEnvelope;
  } {
    const result = this.transaction(() => {
      const context = this.getContextAnchor(input.workspace_id, input.context_id);
      const scopeId = this.validateScopeId(input.workspace_id, input.scope_id);
      const participants = this.contextStore.getContextParticipants(input.context_id);
      if (context.scope_id) {
        throw new ContextScopeAssignmentError(input.workspace_id, input.context_id, "context_already_scoped");
      }
      if (participants.length === 0) {
        throw new ContextScopeAssignmentError(input.workspace_id, input.context_id, "orphan_context");
      }

      const updated = this.contextStore.setContextScope(input.context_id, scopeId);
      if (!updated) throw new ContextNotFoundError(input.workspace_id, input.context_id);

      const auditEvent = this.insertEvent(
        {
          type: "context.scope_assigned",
          workspace_id: input.workspace_id,
          source_endpoint_id: null,
          destination: { kind: "context", context_id: input.context_id },
          thread_id: undefined,
          correlation_id: null,
          content: {},
          metadata: {
            previous_scope_id: context.scope_id,
            scope_id: scopeId,
            ...(input.assigned_by ? { assigned_by: input.assigned_by } : {}),
            ...(input.reason ? { reason: input.reason } : {})
          },
          idempotency_key: null
        },
        this.normalizeResponse({ expected: false }),
        input.context_id
      );

      return {
        ok: true as const,
        context: { ...updated, participants },
        audit_event: auditEvent
      };
    });

    broadcast("context_scope_assigned", {
      context: result.context,
      audit_event: result.audit_event
    });
    this.broadcastEventSubmission(result.audit_event, broadcast);
    return result;
  }

  registerBridge(input: { bridge_id: string; capabilities?: Record<string, unknown> }, broadcast: Broadcast): unknown {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', ?, ?, ?)
      ON CONFLICT(bridge_id) DO UPDATE SET
        status = 'online',
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at
    `).run(input.bridge_id, json(input.capabilities ?? {}), timestamp, timestamp);
    const bridge = this.db.prepare("SELECT * FROM bridges WHERE bridge_id = ?").get(input.bridge_id);
    broadcast("bridge_registered", { bridge });
    return bridge;
  }

  reportBridgeLiveness(bridgeId: string): void {
    this.db.prepare("UPDATE bridges SET status = 'online', last_seen_at = ? WHERE bridge_id = ?").run(now(), bridgeId);
  }

  registerEndpoint(input: {
    endpoint_id: string;
    workspace_id: string;
    name: string;
    agent_id?: string | null;
    bridge_id?: string | null;
    status?: string;
    metadata?: Record<string, unknown>;
  }, broadcast: Broadcast): unknown {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO endpoints (
        endpoint_id, workspace_id, name, agent_id, bridge_id, status,
        metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        name = excluded.name,
        agent_id = excluded.agent_id,
        bridge_id = excluded.bridge_id,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      input.endpoint_id,
      input.workspace_id,
      input.name,
      input.agent_id ?? null,
      input.bridge_id ?? null,
      input.status ?? "idle",
      json(input.metadata ?? {}),
      timestamp,
      timestamp
    );
    const endpoint = this.getEndpoint(input.endpoint_id);
    broadcast("endpoint_registered", { endpoint });
    this.tryCreateDeliveryForEndpoint(input.endpoint_id, broadcast);
    return endpoint;
  }

  listEndpoints(workspaceId?: string): unknown[] {
    if (workspaceId) return this.db.prepare("SELECT * FROM endpoints WHERE workspace_id = ? ORDER BY name").all(workspaceId);
    return this.db.prepare("SELECT * FROM endpoints ORDER BY workspace_id, name").all();
  }

  getEndpoint(endpointId: string): any {
    return this.db.prepare("SELECT * FROM endpoints WHERE endpoint_id = ?").get(endpointId) as any;
  }

  updateEndpointStatus(endpointId: string, status: string, broadcast: Broadcast): unknown {
    this.db.prepare("UPDATE endpoints SET status = ?, updated_at = ? WHERE endpoint_id = ?").run(status, now(), endpointId);
    const endpoint = this.getEndpoint(endpointId);
    broadcast("status_changed", { endpoint });
    if (status === "idle" || status === "waiting") this.tryCreateDeliveryForEndpoint(endpointId, broadcast);
    return endpoint;
  }

  reportAttachment(input: {
    workspace_id: string;
    status: string;
    bridge_id: string;
    config_hash?: string | null;
    error_code?: string | null;
    validation?: unknown;
  }, broadcast: Broadcast): unknown {
    const timestamp = now();
    this.db.prepare(`
      UPDATE workspaces
      SET status = ?,
        active_config_hash = CASE
          WHEN ? = 'config_drift' THEN active_config_hash
          ELSE COALESCE(?, active_config_hash)
        END,
        updated_at = ?
      WHERE workspace_id = ?
    `).run(input.status, input.status, input.config_hash ?? null, timestamp, input.workspace_id);
    const workspace = this.getWorkspace(input.workspace_id);
    broadcast("workspace_attachment_result", {
      workspace,
      bridge_id: input.bridge_id,
      error_code: input.error_code ?? null,
      validation: input.validation ?? null
    });
    return workspace;
  }

  submitEvent(command: EventCommand, broadcast: Broadcast): { event: EventEnvelope; deliveries_created: number } {
    const response = this.normalizeResponse(command.response);
    const event = this.transaction(() => {
      if (command.idempotency_key) {
        const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?").get(command.idempotency_key) as any;
        if (existing) return this.rowToEvent(existing);
      }
      const explicitScopeId = command.scope_id ? this.validateScopeId(command.workspace_id, command.scope_id) : null;

      const resolution = resolveContext(
        {
          source_endpoint_id: command.source_endpoint_id,
          destination: command.destination,
          supplied_context_id: command.context_id ?? null,
          current_delivery_context_id: command.current_delivery_context_id ?? null,
          workspace_id: command.workspace_id
        },
        this.contextStore
      );
      if ("error" in resolution) throw new ContextParticipantError(resolution.payload);
      if (resolution.created) {
        this.contextStore.createContext({
          workspace_id: command.workspace_id,
          scope_id: explicitScopeId,
          created_by_endpoint_id: command.source_endpoint_id,
          participants: resolution.participants ?? [command.source_endpoint_id],
          context_id: resolution.context_id
        });
      }
      const resolvedContextId = resolution.context_id;

      const inserted = this.insertEvent(
        {
          type: command.type,
          workspace_id: command.workspace_id,
          source_endpoint_id: command.source_endpoint_id,
          destination: command.destination,
          thread_id: command.thread_id,
          correlation_id: command.correlation_id ?? null,
          content: command.content,
          metadata: command.metadata ?? {},
          idempotency_key: command.idempotency_key ?? null
        },
        response,
        resolvedContextId
      );
      const destinationEndpointIds = this.resolveDestinations(inserted);
      for (const destinationEndpointId of destinationEndpointIds) this.queueEvent(inserted.event_id, inserted.workspace_id, destinationEndpointId);
      if (inserted.response.expected) this.createPendingResponse(inserted);
      this.resolvePendingResponsesForIncoming(inserted);
      return inserted;
    });

    return this.broadcastEventSubmission(event, broadcast);
  }

  /**
   * Bus-originated trigger emission (design §3.1.6).
   *
   * Always creates a fresh, target-only context (`participants = [target_endpoint_id]`).
   * The event row's `source_endpoint_id` is `null` — never a synthetic
   * `system:*` or `webhook:*` endpoint, never added to the participant set.
   * The resolver participant-aware rule is intentionally bypassed: triggers
   * are not actor-to-actor messages.
   */
  emitTriggerEvent(command: TriggerEventCommand, broadcast: Broadcast): EventEnvelope {
    const event = this.transaction(() => {
      if (command.idempotency_key) {
        const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?").get(command.idempotency_key) as any;
        if (existing) return this.rowToEvent(existing);
      }
      if (command.scope_id) this.validateScopeId(command.workspace_id, command.scope_id);

      let contextId: string;
      if (command.context_id) {
        this.requireEndpointContextAnchor(command.workspace_id, command.context_id, command.target_endpoint_id);
        contextId = command.context_id;
      } else {
        const scopeId = this.requireScopeId(command.workspace_id, command.scope_id, "trigger event creates an operational Context");
        contextId = this.contextStore.createContext({
          workspace_id: command.workspace_id,
          scope_id: scopeId,
          created_by_endpoint_id: command.target_endpoint_id,
          participants: [command.target_endpoint_id]
        });
      }

      const inserted = this.insertEvent(
        {
          type: command.type,
          workspace_id: command.workspace_id,
          source_endpoint_id: null,
          destination: { kind: "endpoint", endpoint_id: command.target_endpoint_id },
          thread_id: undefined,
          correlation_id: command.correlation_id ?? null,
          content: command.content,
          metadata: command.metadata,
          idempotency_key: command.idempotency_key ?? null
        },
        this.normalizeResponse({ expected: false }),
        contextId
      );
      const destinationEndpointIds = this.resolveDestinations(inserted);
      for (const destinationEndpointId of destinationEndpointIds) this.queueEvent(inserted.event_id, inserted.workspace_id, destinationEndpointId);
      // No pending-response: triggers do not expect a reply.
      // No resolvePendingResponsesForIncoming: trigger has no source actor.
      return inserted;
    });

    return this.broadcastEventSubmission(event, broadcast).event;
  }

  appendContextEvent(command: {
    type: string;
    workspace_id: string;
    context_id: string;
    content: Record<string, unknown>;
    metadata: Record<string, unknown>;
    correlation_id?: string | null;
    idempotency_key?: string | null;
  }, broadcast: Broadcast): EventEnvelope {
    const event = this.transaction(() => {
      if (command.idempotency_key) {
        const existing = this.db.prepare("SELECT * FROM events WHERE idempotency_key = ?").get(command.idempotency_key) as any;
        if (existing) return this.rowToEvent(existing);
      }

      const context = this.contextStore.getContext(command.context_id);
      if (!context || context.workspace_id !== command.workspace_id) {
        throw new Error(`Context not found for pulse subscriber: ${command.context_id}`);
      }

      return this.insertEvent(
        {
          type: command.type,
          workspace_id: command.workspace_id,
          source_endpoint_id: null,
          destination: { kind: "context", context_id: command.context_id },
          thread_id: undefined,
          correlation_id: command.correlation_id ?? null,
          content: command.content,
          metadata: command.metadata,
          idempotency_key: command.idempotency_key ?? null
        },
        this.normalizeResponse({ expected: false }),
        command.context_id
      );
    });

    return this.broadcastEventSubmission(event, broadcast).event;
  }

  private broadcastEventSubmission(event: EventEnvelope, broadcast: Broadcast): { event: EventEnvelope; deliveries_created: number } {
    const resolved = this.db.prepare(`
      SELECT destination_endpoint_id
      FROM event_queue
      WHERE event_id = ?
    `).all(event.event_id) as Array<{ destination_endpoint_id: string }>;
    broadcast("event_submitted", { event });
    broadcast("destination_selector_resolved", {
      event_id: event.event_id,
      destinations: resolved.map((row) => row.destination_endpoint_id)
    });
    for (const row of resolved) {
      broadcast("delivery_created", { event_id: event.event_id, destination_endpoint_id: row.destination_endpoint_id });
      this.tryCreateDeliveryForEndpoint(row.destination_endpoint_id, broadcast);
    }
    return { event, deliveries_created: resolved.length };
  }

  reportTurnEnd(endpointId: string, broadcast: Broadcast): unknown {
    const current = this.getEndpoint(endpointId);
    if (current?.status === "runtime_unconfigured") {
      broadcast("turn_end_observed", { endpoint_id: endpointId, status: "runtime_unconfigured" });
      return current;
    }
    const openPending = this.db.prepare(`
      SELECT count(*) AS c
      FROM pending_responses
      WHERE waiting_endpoint_id = ? AND status = 'pending'
    `).get(endpointId) as { c: number };
    const queued = this.db.prepare(`
      SELECT count(*) AS c
      FROM event_queue
      WHERE destination_endpoint_id = ? AND state IN ('queued', 'reserved', 'delivered_to_bridge', 'injected_to_runtime')
    `).get(endpointId) as { c: number };
    const status = openPending.c > 0 ? "waiting" : queued.c > 0 ? "queued" : "idle";
    const endpoint = this.updateEndpointStatus(endpointId, status, broadcast);
    if (status === "queued") this.tryCreateDeliveryForEndpoint(endpointId, broadcast);
    broadcast("turn_end_observed", { endpoint_id: endpointId, status });
    return this.getEndpoint(endpointId) ?? endpoint;
  }

  claimDeliveries(bridgeId: string, limit: number, broadcast: Broadcast): DeliveryBundle[] {
    this.requeueExpiredDeliveryLeases(broadcast);
    const rows = this.db.prepare(`
      SELECT db.*
      FROM delivery_bundles db
      JOIN endpoints e ON e.endpoint_id = db.endpoint_id
      WHERE db.state = 'reserved' AND e.bridge_id = ?
      ORDER BY db.created_at ASC
      LIMIT ?
    `).all(bridgeId, limit) as any[];
    const claimedAt = now();
    for (const row of rows) {
      this.db.prepare("UPDATE delivery_bundles SET state = 'delivered_to_bridge', claimed_at = ? WHERE delivery_id = ?")
        .run(claimedAt, row.delivery_id);
      this.db.prepare("UPDATE event_queue SET state = 'delivered_to_bridge' WHERE delivery_id = ? AND state = 'reserved'")
        .run(row.delivery_id);
      broadcast("delivery_reserved", { delivery_id: row.delivery_id, endpoint_id: row.endpoint_id });
      broadcast("delivery_delivered_to_bridge", { delivery_id: row.delivery_id, bridge_id: bridgeId });
    }
    return rows.map((row) => this.rowToDelivery(row));
  }

  reportDeliveryStatus(input: {
    bridge_id: string;
    delivery_id: string;
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered" | "deferred";
    error?: string | null;
  }, broadcast: Broadcast): unknown {
    const delivery = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id) as any;
    if (!delivery) throw new Error(`Unknown delivery_id: ${input.delivery_id}`);
    if (delivery.state === "acknowledged") return delivery;

    if (input.state === "deferred") {
      this.db.prepare("UPDATE delivery_bundles SET state = 'deferred', last_error = ? WHERE delivery_id = ?")
        .run(input.error ?? null, input.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = 'queued',
            delivery_id = NULL,
            lease_expires_at = NULL,
            last_error = ?
        WHERE delivery_id = ?
      `).run(input.error ?? null, input.delivery_id);
      this.db.prepare(`
        UPDATE endpoints
        SET status = CASE WHEN bridge_id IS NOT NULL THEN 'runtime_unconfigured' ELSE status END,
            updated_at = ?
        WHERE endpoint_id = ?
      `).run(now(), delivery.endpoint_id);
      const endpoint = this.getEndpoint(delivery.endpoint_id);
      broadcast("delivery_deferred", {
        bridge_id: input.bridge_id,
        delivery_id: input.delivery_id,
        error: input.error ?? null
      });
      broadcast("status_changed", { endpoint });
      return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id);
    }

    if (input.state === "failed") {
      const attempts = Number(delivery.attempt_count ?? 1);
      const queueState = attempts >= 3 ? "dead_lettered" : "queued";
      const bundleState = attempts >= 3 ? "dead_lettered" : "failed";
      this.db.prepare("UPDATE delivery_bundles SET state = ?, last_error = ? WHERE delivery_id = ?")
        .run(bundleState, input.error ?? null, input.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = ?, delivery_id = CASE WHEN ? = 'queued' THEN NULL ELSE delivery_id END,
            lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?
      `).run(queueState, queueState, input.error ?? null, input.delivery_id);
      broadcast(bundleState === "dead_lettered" ? "delivery_dead_lettered" : "delivery_failed", {
        bridge_id: input.bridge_id,
        delivery_id: input.delivery_id,
        error: input.error ?? null
      });
      return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id);
    }

    this.db.prepare("UPDATE delivery_bundles SET state = ?, last_error = NULL WHERE delivery_id = ?")
      .run(input.state, input.delivery_id);
    this.db.prepare("UPDATE event_queue SET state = ?, last_error = NULL WHERE delivery_id = ?")
      .run(input.state, input.delivery_id);
    if (input.state === "acknowledged") {
      this.db.prepare("UPDATE event_queue SET delivered_at = ? WHERE delivery_id = ?").run(now(), input.delivery_id);
    }
    broadcast(`delivery_${input.state}`, {
      bridge_id: input.bridge_id,
      delivery_id: input.delivery_id
    });
    return this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id);
  }

  appendRuntimeTelemetry(input: {
    workspace_id: string;
    endpoint_id: string;
    delivery_id?: string | null;
    kind: string;
    payload: Record<string, unknown>;
  }, broadcast: Broadcast): unknown {
    const telemetry = {
      telemetry_id: `tel_${randomUUID()}`,
      workspace_id: input.workspace_id,
      endpoint_id: input.endpoint_id,
      delivery_id: input.delivery_id ?? null,
      kind: input.kind,
      payload_json: json(input.payload),
      created_at: now()
    };
    this.db.prepare(`
      INSERT INTO runtime_telemetry (
        telemetry_id, workspace_id, endpoint_id, delivery_id, kind, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      telemetry.telemetry_id,
      telemetry.workspace_id,
      telemetry.endpoint_id,
      telemetry.delivery_id,
      telemetry.kind,
      telemetry.payload_json,
      telemetry.created_at
    );
    broadcast("runtime_telemetry", { telemetry: { ...telemetry, payload: input.payload } });
    return telemetry;
  }

  listRuntimeTelemetry(filters: { workspace_id?: string; delivery_id?: string; limit?: number }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters.workspace_id) {
      conditions.push("workspace_id = ?");
      params.push(filters.workspace_id);
    }
    if (filters.delivery_id) {
      conditions.push("delivery_id = ?");
      params.push(filters.delivery_id);
    }
    let sql = "SELECT * FROM runtime_telemetry";
    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
    // Newest first for the LIMIT, then reverse so the caller gets chronological order.
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params)).reverse();
  }

  getEvent(eventId: string): EventEnvelope | null {
    const row = this.db.prepare("SELECT * FROM events WHERE event_id = ?").get(eventId) as any;
    return row ? this.rowToEvent(row) : null;
  }

  /**
   * The work that produced an Event: the runtime trace of the turn that emitted it.
   * Emitted events carry their producing turn as `metadata.delivery_id`; telemetry is
   * keyed by `delivery_id`. System-originated events (pulse.fired, webhook ingest) have
   * no producing turn — `delivery_id` is null and the trace is empty. Returns null only
   * when the Event itself does not exist. Work-log prose is not served here: it lives as
   * committed files retrievable by an actor, not through the bus.
   */
  getEventTrace(eventId: string): { event_id: string; delivery_id: string | null; telemetry: unknown[] } | null {
    const event = this.getEvent(eventId);
    if (!event) return null;
    const deliveryId = typeof event.metadata?.delivery_id === "string" ? event.metadata.delivery_id : null;
    const telemetry = deliveryId
      ? this.listRuntimeTelemetry({ workspace_id: event.workspace_id, delivery_id: deliveryId })
      : [];
    return { event_id: eventId, delivery_id: deliveryId, telemetry };
  }

  listEvents(filters: {
    workspace_id?: string;
    thread_id?: string;
    context_id?: string;
    scope_id?: string;
    since?: string;
    limit?: number;
  }): EventEnvelope[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const conditions: string[] = [];
    const params: any[] = [];
    if (filters.context_id) {
      conditions.push("context_id = ?");
      params.push(filters.context_id);
    }
    if (filters.workspace_id) {
      conditions.push("workspace_id = ?");
      params.push(filters.workspace_id);
    }
    if (filters.thread_id) {
      conditions.push("thread_id = ?");
      params.push(filters.thread_id);
    }
    if (filters.scope_id) {
      conditions.push("scope_id = ?");
      params.push(filters.scope_id);
    }
    if (filters.since) {
      const cursor = decodeEventCursor(filters.since);
      // Strictly after the cursor in (created_at, event_id) order. The event_id
      // tie-break is what makes same-instant Events safe to page past.
      conditions.push("(created_at > ? OR (created_at = ? AND event_id > ?))");
      params.push(cursor.created_at, cursor.created_at, cursor.event_id);
    }
    let sql = "SELECT * FROM events";
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY created_at ASC, event_id ASC LIMIT ?";
    params.push(limit);
    return (this.db.prepare(sql).all(...params) as any[]).map((row) => this.rowToEvent(row));
  }

  getEndpointWatermark(workspaceId: string, endpointId: string): EndpointWatermark | null {
    return this.endpointWatermarkStore.get(workspaceId, endpointId);
  }

  setEndpointWatermark(workspaceId: string, endpointId: string, cursor: string): EndpointWatermark {
    return this.endpointWatermarkStore.set(workspaceId, endpointId, cursor);
  }

  listDeliveries(filters: { workspace_id?: string; limit?: number }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    if (filters.workspace_id) {
      return this.db.prepare(`
        SELECT * FROM delivery_bundles
        WHERE workspace_id = ?
        ORDER BY created_at ASC
        LIMIT ?
      `).all(filters.workspace_id, limit);
    }
    return this.db.prepare("SELECT * FROM delivery_bundles ORDER BY created_at ASC LIMIT ?").all(limit);
  }

  listPendingResponses(filters: { workspace_id?: string; limit?: number }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    if (filters.workspace_id) {
      return this.db.prepare(`
        SELECT * FROM pending_responses WHERE workspace_id = ?
        ORDER BY created_at ASC LIMIT ?
      `).all(filters.workspace_id, limit);
    }
    return this.db.prepare("SELECT * FROM pending_responses ORDER BY created_at ASC LIMIT ?").all(limit);
  }

  listConfigs(): unknown[] {
    return this.db.prepare("SELECT * FROM saved_configs ORDER BY updated_at DESC").all();
  }

  createConfig(input: { name: string; config: Record<string, unknown> }, broadcast: Broadcast): unknown {
    const timestamp = now();
    const configId = `cfg_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO saved_configs (config_id, name, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(configId, input.name, json(input.config), timestamp, timestamp);
    const record = this.db.prepare("SELECT * FROM saved_configs WHERE config_id = ?").get(configId);
    broadcast("saved_config_created", { config: record });
    return record;
  }

  requestConfigSnapshot(workspaceId: string, broadcast: Broadcast): { ok: true } {
    broadcast("config_snapshot_requested", { workspace_id: workspaceId });
    return { ok: true };
  }

  importConfigSnapshot(workspaceId: string, snapshot: Record<string, unknown>, broadcast: Broadcast): unknown {
    const configHash = typeof snapshot.config_hash === "string" ? snapshot.config_hash : null;
    if (configHash) {
      this.db.prepare(`
        UPDATE workspaces
        SET active_config_hash = ?, status = 'attached', updated_at = ?
        WHERE workspace_id = ?
      `).run(configHash, now(), workspaceId);
    }
    const workspace = this.getWorkspace(workspaceId);
    broadcast("config_snapshot_imported", { workspace, snapshot });
    return workspace;
  }

  requestApplyConfig(workspaceId: string, configId: string | null, broadcast: Broadcast): { ok: true } {
    broadcast("config_apply_requested", { workspace_id: workspaceId, config_id: configId });
    return { ok: true };
  }

  ingestWebhook(
    workspaceId: string,
    routeId: string,
    body: Record<string, unknown>,
    broadcast: Broadcast,
    configuredScopeId?: string | null
  ): EventEnvelope {
    const destination = this.db.prepare(`
      SELECT endpoint_id FROM endpoints
      WHERE workspace_id = ? AND bridge_id IS NOT NULL
      ORDER BY created_at ASC LIMIT 1
    `).get(workspaceId) as any;
    if (!destination) throw new Error("No agent endpoint is registered for this workspace");
    const scopeId = this.requireScopeId(workspaceId, configuredScopeId, "webhook route must be configured with a Scope");
    // Per design §3.1.6: webhook ingest is a non-actor trigger. Bus creates a
    // target-only context and emits with source_endpoint_id = null.
    return this.emitTriggerEvent(
      {
        type: "webhook_received",
        workspace_id: workspaceId,
        target_endpoint_id: destination.endpoint_id,
        scope_id: scopeId,
        correlation_id: typeof body.correlation_id === "string" ? body.correlation_id : null,
        content: {
          text: typeof body.text === "string" ? body.text : `Webhook ${routeId} received`,
          data: body
        },
        metadata: { trigger_kind: "webhook", route_id: routeId }
      },
      broadcast
    );
  }

  // ---------------------------------------------------------------------------
  // Pulse CRUD
  // ---------------------------------------------------------------------------

  createPulse(input: {
    pulse_id: string;
    workspace_id: string;
    persistence?: PulsePersistence;
    scope_id?: string | null;
    current_context_id?: string | null;
    trigger: { type: string; at?: string; schedule?: string; timezone?: string };
    content: Record<string, unknown>;
    subscribers: PulseSubscriber[];
    created_by?: string;
  }, broadcast: Broadcast): unknown {
    const timestamp = now();
    const nextFireAt = this.calculateNextFireAt(input.trigger);
    const currentContext = input.current_context_id
      ? this.getContextAnchor(input.workspace_id, input.current_context_id)
      : null;
    let scopeId: string | null = input.scope_id
      ? this.validateScopeId(input.workspace_id, input.scope_id)
      : currentContext?.scope_id ?? null;
    let createsGeneratedDeliveryContext = false;
    const explicitAnchorScopes = new Set<string>();
    const subscribersToValidate = new Map<string, PulseSubscriber>();
    for (const subscriber of this.getPulseSubscribers(input.pulse_id)) {
      subscribersToValidate.set(json(subscriber), subscriber);
    }
    for (const subscriber of input.subscribers) {
      subscribersToValidate.set(json(subscriber), subscriber);
    }

    for (const subscriber of subscribersToValidate.values()) {
      const anchor = this.validatePulseSubscriberAnchor({
        workspace_id: input.workspace_id,
        pulse_scope_id: scopeId,
        subscriber,
        allow_missing_generated_scope: true
      });
      if (anchor.creates_generated_delivery_context) createsGeneratedDeliveryContext = true;
      if (anchor.anchor_scope_id) explicitAnchorScopes.add(anchor.anchor_scope_id);
    }

    if (!scopeId && !createsGeneratedDeliveryContext && explicitAnchorScopes.size === 1) {
      scopeId = [...explicitAnchorScopes][0];
    }

    if (createsGeneratedDeliveryContext && !scopeId) {
      throw new ScopeRequiredError(
        input.workspace_id,
        "pulse must be configured with a Scope or scoped current Context"
      );
    }

    if (!scopeId && subscribersToValidate.size === 0) {
      throw new ScopeRequiredError(
        input.workspace_id,
        "pulse must be configured with a Scope or explicit Context anchor"
      );
    }
    this.db.prepare(`
      INSERT INTO pulses (pulse_id, workspace_id, persistence, scope_id, trigger_json, content_json, status, created_by, created_at, updated_at, next_fire_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
      ON CONFLICT(pulse_id) DO UPDATE SET
        trigger_json = excluded.trigger_json,
        content_json = excluded.content_json,
        persistence = excluded.persistence,
        scope_id = excluded.scope_id,
        updated_at = excluded.updated_at,
        next_fire_at = excluded.next_fire_at,
        status = CASE WHEN pulses.status = 'cancelled' THEN pulses.status ELSE excluded.status END
    `).run(
      input.pulse_id,
      input.workspace_id,
      input.persistence ?? "local",
      scopeId,
      json(input.trigger),
      json(input.content),
      input.created_by ?? null,
      timestamp,
      timestamp,
      nextFireAt
    );
    // Upsert subscribers
    for (const subscriber of input.subscribers) {
      this.db.prepare(`
        INSERT OR IGNORE INTO pulse_subscribers (pulse_id, subscriber_json, created_at)
        VALUES (?, ?, ?)
      `).run(input.pulse_id, json(subscriber), timestamp);
    }
    const pulse = this.getPulse(input.pulse_id);
    broadcast("pulse_created", { pulse });
    return pulse;
  }

  getPulse(pulseId: string): unknown {
    const row = this.db.prepare("SELECT * FROM pulses WHERE pulse_id = ?").get(pulseId) as any;
    if (!row) return null;
    return this.rowToPulse(row);
  }

  listPulses(filters: { workspace_id?: string; status?: string; scope_id?: string }): unknown[] {
    let query = "SELECT * FROM pulses WHERE 1=1";
    const params: string[] = [];
    if (filters.workspace_id) {
      query += " AND workspace_id = ?";
      params.push(filters.workspace_id);
    }
    if (filters.status) {
      query += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.scope_id) {
      query += " AND scope_id = ?";
      params.push(filters.scope_id);
    }
    query += " ORDER BY created_at DESC";
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map((row) => this.rowToPulse(row));
  }

  getPulseSubscribers(pulseId: string): PulseSubscriber[] {
    const rows = this.db.prepare("SELECT subscriber_json FROM pulse_subscribers WHERE pulse_id = ?")
      .all(pulseId) as Array<{ subscriber_json: string }>;
    return rows.map((row) => parseJson<PulseSubscriber>(row.subscriber_json));
  }

  getOrCreatePulseDeliveryContext(input: {
    pulse_id: string;
    workspace_id: string;
    scope_id: string;
    subscriber: Extract<PulseSubscriber, { endpoint_ref: string }>;
    endpoint_id: string;
  }): string {
    if (!input.scope_id) {
      throw new ScopeRequiredError(input.workspace_id, "generated pulse delivery Context requires Scope");
    }
    const subscriberKey = this.pulseDeliverySubscriberKey(input.subscriber);
    const contextId = `ctx_pulse_${stableHash(`${input.workspace_id}\0${input.pulse_id}\0${subscriberKey}`).slice(0, 32)}`;
    const timestamp = now();
    return this.transaction(() => {
      const existing = this.db.prepare(`
        SELECT context_id
        FROM pulse_delivery_contexts
        WHERE pulse_id = ? AND subscriber_key = ?
      `).get(input.pulse_id, subscriberKey) as { context_id: string } | undefined;
      const mappedContextId = existing?.context_id ?? contextId;
      const existingContext = this.contextStore.getContext(mappedContextId);
      if (!existing) {
        this.db.prepare(`
          INSERT INTO pulse_delivery_contexts (
            pulse_id, subscriber_key, context_id, workspace_id, endpoint_ref, endpoint_id, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.pulse_id,
          subscriberKey,
          mappedContextId,
          input.workspace_id,
          input.subscriber.endpoint_ref,
          input.endpoint_id,
          timestamp,
          timestamp
        );
      } else {
        this.db.prepare(`
          UPDATE pulse_delivery_contexts
          SET endpoint_ref = ?, endpoint_id = ?, workspace_id = ?, updated_at = ?
          WHERE pulse_id = ? AND subscriber_key = ?
        `).run(input.subscriber.endpoint_ref, input.endpoint_id, input.workspace_id, timestamp, input.pulse_id, subscriberKey);
      }
      if (existingContext && existingContext.workspace_id === input.workspace_id) return mappedContextId;
      this.contextStore.createContext({
        workspace_id: input.workspace_id,
        scope_id: input.scope_id,
        created_by_endpoint_id: input.endpoint_id,
        participants: [input.endpoint_id],
        context_id: mappedContextId
      });
      return mappedContextId;
    });
  }

  updatePulseStatus(pulseId: string, status: string, broadcast: Broadcast): unknown {
    const timestamp = now();
    this.db.prepare("UPDATE pulses SET status = ?, updated_at = ? WHERE pulse_id = ?")
      .run(status, timestamp, pulseId);
    const pulse = this.getPulse(pulseId);
    broadcast(`pulse_${status}`, { pulse });
    return pulse;
  }

  addPulseSubscriber(pulseId: string, subscriber: PulseSubscriber): void {
    const pulse = this.db.prepare("SELECT workspace_id, scope_id FROM pulses WHERE pulse_id = ?")
      .get(pulseId) as { workspace_id: string; scope_id: string | null } | undefined;
    if (!pulse) throw new PulseNotFoundError(pulseId);
    this.validatePulseSubscriberAnchor({
      workspace_id: pulse.workspace_id,
      pulse_scope_id: pulse.scope_id,
      subscriber
    });
    this.db.prepare(`
      INSERT OR IGNORE INTO pulse_subscribers (pulse_id, subscriber_json, created_at)
      VALUES (?, ?, ?)
    `).run(pulseId, json(subscriber), now());
  }

  removePulseSubscriber(pulseId: string, subscriber: PulseSubscriber): void {
    this.db.prepare("DELETE FROM pulse_subscribers WHERE pulse_id = ? AND subscriber_json = ?")
      .run(pulseId, json(subscriber));
  }

  recordPulseFired(pulseId: string, nextFireAt: string | null): void {
    const timestamp = now();
    const status = nextFireAt ? "active" : "completed";
    this.db.prepare(`
      UPDATE pulses
      SET last_fired_at = ?, fire_count = fire_count + 1, next_fire_at = ?, status = ?, updated_at = ?
      WHERE pulse_id = ?
    `).run(timestamp, nextFireAt, status, timestamp, pulseId);
  }

  getActivePulsesForScheduler(): Array<{
    pulse_id: string;
    workspace_id: string;
    trigger: { type: string; at?: string; schedule?: string; timezone?: string };
    content: Record<string, unknown>;
    next_fire_at: string | null;
  }> {
    const rows = this.db.prepare(`
      SELECT pulse_id, workspace_id, trigger_json, content_json, next_fire_at
      FROM pulses
      WHERE status = 'active' AND next_fire_at IS NOT NULL
      ORDER BY next_fire_at ASC
    `).all() as any[];
    return rows.map((row) => ({
      pulse_id: row.pulse_id,
      workspace_id: row.workspace_id,
      trigger: parseJson<{ type: string; at?: string; schedule?: string; timezone?: string }>(row.trigger_json),
      content: parseJson<Record<string, unknown>>(row.content_json),
      next_fire_at: row.next_fire_at
    }));
  }

  resolveSubscriberEndpointId(workspaceId: string, endpointRef: string): string {
    // Strip legacy type prefix (agent:/human:/user:) from endpoint refs
    const bareId = endpointRef.replace(/^(agent|human|user):/, "");
    const fullId = `actor:${workspaceId}:${bareId}`;
    const endpoint = this.db.prepare("SELECT endpoint_id FROM endpoints WHERE endpoint_id = ?").get(fullId) as any;
    if (endpoint) return endpoint.endpoint_id;
    // Try with the ref as-is (for refs that don't have a type prefix)
    const fullIdRaw = `actor:${workspaceId}:${endpointRef}`;
    const endpointRaw = this.db.prepare("SELECT endpoint_id FROM endpoints WHERE endpoint_id = ?").get(fullIdRaw) as any;
    if (endpointRaw) return endpointRaw.endpoint_id;
    // Try direct match
    const direct = this.db.prepare("SELECT endpoint_id FROM endpoints WHERE endpoint_id = ?").get(endpointRef) as any;
    if (direct) return direct.endpoint_id;
    return fullId;
  }

  calculateNextFireAt(trigger: { type: string; at?: string; schedule?: string; timezone?: string }, fromDate?: Date): string | null {
    if (trigger.type === "once" && trigger.at) {
      return new Date(trigger.at).toISOString();
    }
    if (trigger.type === "cron" && trigger.schedule) {
      try {
        const options: { currentDate?: Date; tz?: string } = {};
        if (fromDate) options.currentDate = fromDate;
        if (trigger.timezone) options.tz = trigger.timezone;
        const expr = CronExpressionParser.parse(trigger.schedule, options);
        const next = expr.next();
        return next.toDate().toISOString();
      } catch {
        return null;
      }
    }
    return null;
  }

  private rowToPulse(row: any): Record<string, unknown> {
    return {
      pulse_id: row.pulse_id,
      workspace_id: row.workspace_id,
      persistence: row.persistence,
      scope_id: row.scope_id,
      trigger: parseJson<unknown>(row.trigger_json),
      content: parseJson<unknown>(row.content_json),
      subscribers: this.getPulseSubscribers(row.pulse_id),
      status: row.status,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_fire_at: row.next_fire_at,
      last_fired_at: row.last_fired_at,
      fire_count: row.fire_count
    };
  }

  private normalizeResponse(response?: ResponseExpectation): ResponseExpectation {
    return {
      expected: !!response?.expected,
      mode: response?.mode ?? "open",
      correlation_id: response?.correlation_id ?? null,
      timeout_at: response?.timeout_at ?? null
    };
  }

  private contextScopeId(contextId: string): string | null {
    return this.contextStore.getContext(contextId)?.scope_id ?? null;
  }

  private pulseDeliverySubscriberKey(subscriber: Extract<PulseSubscriber, { endpoint_ref: string }>): string {
    return stableHash(canonicalJson({
      kind: "endpoint",
      endpoint_ref: subscriber.endpoint_ref,
      context_id: null
    }));
  }

  private insertEvent(
    input: {
      type: string;
      workspace_id: string;
      source_endpoint_id: string | null;
      destination: DestinationSelector;
      thread_id?: string;
      correlation_id: string | null;
      content: Record<string, unknown>;
      metadata: Record<string, unknown>;
      idempotency_key: string | null;
    },
    response: ResponseExpectation,
    contextId: string
  ): EventEnvelope {
    const destinationEndpointId =
      input.destination.kind === "endpoint"
        ? input.destination.endpoint_id
        : input.destination.kind === "context"
        ? `context:${input.destination.context_id}`
        : `broadcast:${input.destination.scope}:${input.destination.target}`;
    // Legacy thread_id storage: write the resolved context_id so the existing
    // NOT NULL column is satisfied. No new flow reads thread_id.
    const threadIdForStorage = input.thread_id && input.thread_id.length > 0 ? input.thread_id : contextId;
    const envelope: EventEnvelope = {
      event_id: `evt_${randomUUID()}`,
      type: input.type,
      workspace_id: input.workspace_id,
      source_endpoint_id: input.source_endpoint_id,
      thread_id: threadIdForStorage,
      context_id: contextId,
      scope_id: this.contextScopeId(contextId),
      correlation_id: input.correlation_id ?? null,
      destination_json: input.destination,
      content: input.content,
      response,
      metadata: input.metadata ?? {},
      created_at: now()
    };
    this.db.prepare(`
      INSERT INTO events (
        event_id, type, workspace_id, source_endpoint_id, destination_endpoint_id, thread_id, context_id, correlation_id,
        scope_id, destination_json, content_json, response_json, metadata_json, idempotency_key, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.event_id,
      envelope.type,
      envelope.workspace_id,
      envelope.source_endpoint_id,
      destinationEndpointId,
      envelope.thread_id,
      envelope.context_id,
      envelope.correlation_id,
      envelope.scope_id,
      json(envelope.destination_json),
      json(envelope.content),
      json(envelope.response),
      json(envelope.metadata),
      input.idempotency_key ?? null,
      envelope.created_at
    );
    return envelope;
  }

  private resolveDestinations(event: EventEnvelope): string[] {
    const destination = event.destination_json;
    if (destination.kind === "context") return [];
    if (destination.kind === "endpoint") return [destination.endpoint_id];
    const target = destination.target;
    const query = `
      SELECT endpoint_id
      FROM endpoints
      WHERE workspace_id = ?
        AND (
          (? = 'all')
          OR (? = 'active' AND status = 'active')
          OR (? = 'with_delivery_processor' AND bridge_id IS NOT NULL)
          OR (? = 'without_delivery_processor' AND bridge_id IS NULL)
          OR (? = 'active_with_delivery_processor' AND bridge_id IS NOT NULL AND status = 'active')
          OR (? = 'active_without_delivery_processor' AND bridge_id IS NULL AND status = 'active')
        )
    `;
    const rows = this.db.prepare(query).all(
      event.workspace_id,
      target,
      target,
      target,
      target,
      target,
      target
    ) as Array<{ endpoint_id: string }>;
    return rows
      .map((row) => row.endpoint_id)
      .filter((endpointId) => !(destination.exclude_source && endpointId === event.source_endpoint_id));
  }

  private queueEvent(eventId: string, workspaceId: string, destinationEndpointId: string): void {
    this.db.prepare(`
      INSERT INTO event_queue (queue_id, event_id, workspace_id, destination_endpoint_id, state, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?)
    `).run(`q_${randomUUID()}`, eventId, workspaceId, destinationEndpointId, now());
    this.db.prepare(`
      UPDATE endpoints
      SET status = CASE WHEN status IN ('active', 'runtime_unconfigured') THEN status ELSE 'queued' END,
          updated_at = ?
      WHERE endpoint_id = ?
    `).run(now(), destinationEndpointId);
  }

  private createPendingResponse(event: EventEnvelope): void {
    const pending = {
      pending_id: `pr_${randomUUID()}`,
      workspace_id: event.workspace_id,
      waiting_endpoint_id: event.source_endpoint_id,
      source_event_id: event.event_id,
      mode: event.response.mode ?? "open",
      thread_id: event.thread_id,
      correlation_id: event.response.correlation_id ?? event.correlation_id,
      timeout_at: event.response.timeout_at ?? null,
      status: "pending",
      created_at: now(),
      resolved_at: null as string | null
    };
    this.db.prepare(`
      INSERT INTO pending_responses (
        pending_id, workspace_id, waiting_endpoint_id, source_event_id, mode, thread_id,
        correlation_id, timeout_at, status, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pending.pending_id,
      pending.workspace_id,
      pending.waiting_endpoint_id,
      pending.source_event_id,
      pending.mode,
      pending.thread_id,
      pending.correlation_id,
      pending.timeout_at,
      pending.status,
      pending.created_at,
      pending.resolved_at
    );
  }

  private resolvePendingResponsesForIncoming(incoming: EventEnvelope): void {
    const rows = this.db.prepare(`
      SELECT * FROM pending_responses
      WHERE waiting_endpoint_id = ? AND status = 'pending'
      ORDER BY created_at ASC
    `).all(incoming.destination_json.kind === "endpoint" ? incoming.destination_json.endpoint_id : "") as any[];
    for (const pending of rows) {
      if (pending.mode === "thread_affine" && pending.thread_id !== incoming.thread_id) continue;
      if (pending.mode === "correlated") {
        const incomingCorrelation = incoming.correlation_id ?? null;
        if (!pending.correlation_id || incomingCorrelation !== pending.correlation_id) continue;
      }
      this.db.prepare("UPDATE pending_responses SET status = 'resolved', resolved_at = ? WHERE pending_id = ?")
        .run(now(), pending.pending_id);
    }
  }

  private tryCreateDeliveryForEndpoint(endpointId: string, broadcast: Broadcast): DeliveryBundle | null {
    const endpoint = this.getEndpoint(endpointId);
    if (!endpoint || !endpoint.bridge_id) return null;
    if (endpoint.status === "active" || endpoint.status === "error" || endpoint.status === "runtime_unconfigured") return null;

    const queuedRows = this.db.prepare(`
      SELECT q.*, e.*
      FROM event_queue q
      JOIN events e ON e.event_id = q.event_id
      WHERE q.destination_endpoint_id = ?
        AND q.state = 'queued'
      ORDER BY q.created_at ASC
      LIMIT 25
    `).all(endpointId) as any[];
    if (queuedRows.length === 0) return null;

    const deliveredAt = now();
    const deliveryId = `del_${randomUUID()}`;
    const leaseExpiresAt = this.deliveryLeaseExpiresAt();
    for (const row of queuedRows) {
      this.db.prepare(`
        UPDATE event_queue
        SET state = 'reserved',
          delivery_id = ?,
          lease_expires_at = ?,
          attempt_count = attempt_count + 1,
          last_error = NULL
        WHERE queue_id = ? AND state = 'queued'
      `).run(deliveryId, leaseExpiresAt, row.queue_id);
    }
    const events = queuedRows.map((row) => this.rowToEvent(row));
    const bundle: DeliveryBundle = {
      delivery_id: deliveryId,
      endpoint_id: endpointId,
      workspace_id: endpoint.workspace_id,
      trigger_event_id: events[0].event_id,
      events,
      delivered_at: deliveredAt
    };
    this.db.prepare(`
      INSERT INTO delivery_bundles (
        delivery_id, wait_id, endpoint_id, workspace_id, resume_reason, trigger_event_id,
        events_json, state, lease_expires_at, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
    `).run(
      bundle.delivery_id,
      null,
      bundle.endpoint_id,
      bundle.workspace_id,
      "event",
      bundle.trigger_event_id,
      json(bundle.events),
      leaseExpiresAt,
      bundle.delivered_at
    );
    this.db.prepare("UPDATE endpoints SET status = 'active', updated_at = ? WHERE endpoint_id = ?")
      .run(now(), endpointId);
    broadcast("delivery_bundle_available", { delivery: bundle });
    return bundle;
  }

  private deliveryLeaseExpiresAt(): string {
    return new Date(Date.now() + 30_000).toISOString();
  }

  private requeueExpiredDeliveryLeases(broadcast: Broadcast): void {
    const timestamp = now();
    const expired = this.db.prepare(`
      SELECT * FROM delivery_bundles
      WHERE state IN ('reserved', 'delivered_to_bridge', 'injected_to_runtime')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      LIMIT 100
    `).all(timestamp) as any[];
    for (const row of expired) {
      const attempts = Number(row.attempt_count ?? 1);
      const queueState = attempts >= 3 ? "dead_lettered" : "queued";
      const bundleState = attempts >= 3 ? "dead_lettered" : "failed";
      this.db.prepare("UPDATE delivery_bundles SET state = ?, last_error = ? WHERE delivery_id = ?")
        .run(bundleState, "delivery lease expired", row.delivery_id);
      this.db.prepare(`
        UPDATE event_queue
        SET state = ?, delivery_id = CASE WHEN ? = 'queued' THEN NULL ELSE delivery_id END,
          lease_expires_at = NULL, last_error = ?
        WHERE delivery_id = ?
      `).run(queueState, queueState, "delivery lease expired", row.delivery_id);
      broadcast(bundleState === "dead_lettered" ? "delivery_dead_lettered" : "delivery_failed", {
        delivery_id: row.delivery_id,
        error: "delivery lease expired"
      });
      if (queueState === "queued") this.tryCreateDeliveryForEndpoint(row.endpoint_id, broadcast);
    }
  }

  private rowToEvent(row: any): EventEnvelope {
    return {
      event_id: row.event_id,
      type: row.type,
      workspace_id: row.workspace_id,
      source_endpoint_id: row.source_endpoint_id,
      thread_id: row.thread_id,
      context_id: row.context_id ?? row.thread_id,
      scope_id: row.scope_id ?? null,
      correlation_id: row.correlation_id ?? null,
      destination_json: parseJson<DestinationSelector>(row.destination_json),
      content: parseJson<Record<string, unknown>>(row.content_json),
      response: parseJson<ResponseExpectation>(row.response_json),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json),
      created_at: row.created_at
    };
  }

  private rowToDelivery(row: any): DeliveryBundle {
    return {
      delivery_id: row.delivery_id,
      endpoint_id: row.endpoint_id,
      workspace_id: row.workspace_id,
      trigger_event_id: row.trigger_event_id,
      events: parseJson<EventEnvelope[]>(row.events_json),
      delivered_at: row.created_at
    };
  }

  private rowToRuntimeBinding(row: any): RuntimeBindingRecord {
    return {
      binding_key: String(row.binding_key),
      scope: row.scope as RuntimeBindingScope,
      workspace_id: row.workspace_id ?? null,
      endpoint_id: row.endpoint_id ?? null,
      auth_profile: String(row.auth_profile),
      model: row.model ?? null,
      thinking_level: row.thinking_level ?? null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function runtimeBindingKey(scope: RuntimeBindingScope, workspaceId: string | null, endpointId: string | null): string {
  if (scope === "global_default") return "runtime:global:default";
  if (!workspaceId) throw new Error(`workspace_id is required for scope '${scope}'`);
  if (scope === "workspace_default") return `runtime:${workspaceId}:default`;
  if (!endpointId) throw new Error("endpoint_id is required for scope 'agent'");
  return `runtime:${workspaceId}:endpoint:${endpointId}`;
}

function deleteWorkspaceLocator(locator: string): boolean {
  const resolved = resolve(locator);
  if (!existsSync(resolved)) return false;
  const root = parse(resolved).root;
  if (resolved === root) {
    throw new Error(`Refusing to delete root path '${resolved}'.`);
  }
  rmSync(resolved, { recursive: true, force: true });
  return true;
}
