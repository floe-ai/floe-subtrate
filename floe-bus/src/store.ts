import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { LocalConfig } from "./config.js";
import { resolveLocalPath } from "./config.js";

type Broadcast = (type: string, payload: Record<string, unknown>) => void;

export type DestinationSelector =
  | { kind: "endpoint"; endpoint_id: string }
  | {
      kind: "broadcast";
      scope: "workspace";
      target: "all" | "agents" | "humans" | "active_agents" | "active_humans";
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
  thread_id: string;
  correlation_id?: string | null;
  content: Record<string, unknown>;
  response?: ResponseExpectation;
  metadata?: Record<string, unknown>;
  idempotency_key?: string | null;
};

export type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  source_endpoint_id: string;
  thread_id: string;
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

function now(): string {
  return new Date().toISOString();
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function workspaceIdForLocator(locator: string): string {
  const hash = createHash("sha256").update(locator.toLowerCase()).digest("hex").slice(0, 16);
  return `workspace:${hash}`;
}

export class BusStore {
  readonly db: DatabaseSync;

  constructor(configPath: string, readonly config: LocalConfig) {
    const dataDir = resolveLocalPath(configPath, config.home, config.bus.data_dir);
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "floe-bus.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
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
        actor_type TEXT NOT NULL,
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
        source_endpoint_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
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
    `);
    this.addColumnIfMissing("events", "destination_endpoint_id", "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing("events", "destination_json", "TEXT");
    this.addColumnIfMissing("events", "response_json", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "wait_id", "TEXT");
    this.addColumnIfMissing("delivery_bundles", "resume_reason", "TEXT NOT NULL DEFAULT 'event'");
    this.addColumnIfMissing("runtime_telemetry", "delivery_id", "TEXT");
    this.backfillEventDestinationJson();
    this.backfillEventResponseJson();
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as any[];
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
    actor_type: "human" | "agent";
    name: string;
    agent_id?: string | null;
    bridge_id?: string | null;
    status?: string;
    metadata?: Record<string, unknown>;
  }, broadcast: Broadcast): unknown {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO endpoints (
        endpoint_id, workspace_id, actor_type, name, agent_id, bridge_id, status,
        metadata_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        actor_type = excluded.actor_type,
        name = excluded.name,
        agent_id = excluded.agent_id,
        bridge_id = excluded.bridge_id,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      input.endpoint_id,
      input.workspace_id,
      input.actor_type,
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
    if (workspaceId) return this.db.prepare("SELECT * FROM endpoints WHERE workspace_id = ? ORDER BY actor_type, name").all(workspaceId);
    return this.db.prepare("SELECT * FROM endpoints ORDER BY workspace_id, actor_type, name").all();
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
      const inserted = this.insertEvent(command, response);
      const destinationEndpointIds = this.resolveDestinations(inserted);
      for (const destinationEndpointId of destinationEndpointIds) this.queueEvent(inserted.event_id, inserted.workspace_id, destinationEndpointId);
      if (inserted.response.expected) this.createPendingResponse(inserted);
      this.resolvePendingResponsesForIncoming(inserted);
      return inserted;
    });

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
    broadcast("turn_end_observed", { endpoint_id: endpointId, status });
    return endpoint;
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
    state: "injected_to_runtime" | "acknowledged" | "failed" | "dead_lettered";
    error?: string | null;
  }, broadcast: Broadcast): unknown {
    const delivery = this.db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = ?").get(input.delivery_id) as any;
    if (!delivery) throw new Error(`Unknown delivery_id: ${input.delivery_id}`);
    if (delivery.state === "acknowledged") return delivery;

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

  listRuntimeTelemetry(filters: { workspace_id?: string; limit?: number }): unknown[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    if (filters.workspace_id) {
      return this.db.prepare(`
        SELECT * FROM runtime_telemetry WHERE workspace_id = ?
        ORDER BY created_at ASC LIMIT ?
      `).all(filters.workspace_id, limit);
    }
    return this.db.prepare("SELECT * FROM runtime_telemetry ORDER BY created_at ASC LIMIT ?").all(limit);
  }

  listEvents(filters: { workspace_id?: string; thread_id?: string; limit?: number }): EventEnvelope[] {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    if (filters.workspace_id && filters.thread_id) {
      return (this.db.prepare(`
        SELECT * FROM events WHERE workspace_id = ? AND thread_id = ? ORDER BY created_at ASC LIMIT ?
      `).all(filters.workspace_id, filters.thread_id, limit) as any[]).map((row) => this.rowToEvent(row));
    }
    if (filters.workspace_id) {
      return (this.db.prepare(`
        SELECT * FROM events WHERE workspace_id = ? ORDER BY created_at ASC LIMIT ?
      `).all(filters.workspace_id, limit) as any[]).map((row) => this.rowToEvent(row));
    }
    return (this.db.prepare("SELECT * FROM events ORDER BY created_at ASC LIMIT ?").all(limit) as any[])
      .map((row) => this.rowToEvent(row));
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

  ingestWebhook(workspaceId: string, routeId: string, body: Record<string, unknown>, broadcast: Broadcast): EventEnvelope {
    const destination = this.db.prepare(`
      SELECT endpoint_id FROM endpoints
      WHERE workspace_id = ? AND actor_type = 'agent'
      ORDER BY created_at ASC LIMIT 1
    `).get(workspaceId) as any;
    const human = this.db.prepare(`
      SELECT endpoint_id FROM endpoints
      WHERE workspace_id = ? AND actor_type = 'human'
      ORDER BY created_at ASC LIMIT 1
    `).get(workspaceId) as any;
    if (!destination) throw new Error("No agent endpoint is registered for this workspace");
    const command: EventCommand = {
      type: "webhook_received",
      workspace_id: workspaceId,
      source_endpoint_id: human?.endpoint_id ?? `endpoint:${workspaceId}:webhook:${routeId}`,
      destination: { kind: "endpoint", endpoint_id: destination.endpoint_id },
      thread_id: `webhook:${routeId}:${randomUUID()}`,
      correlation_id: typeof body.correlation_id === "string" ? body.correlation_id : null,
      content: {
        text: typeof body.text === "string" ? body.text : `Webhook ${routeId} received`,
        data: body
      },
      metadata: { route_id: routeId }
    };
    return this.submitEvent(command, broadcast).event;
  }

  private normalizeResponse(response?: ResponseExpectation): ResponseExpectation {
    return {
      expected: !!response?.expected,
      mode: response?.mode ?? "open",
      correlation_id: response?.correlation_id ?? null,
      timeout_at: response?.timeout_at ?? null
    };
  }

  private insertEvent(command: EventCommand, response: ResponseExpectation): EventEnvelope {
    const destinationEndpointId =
      command.destination.kind === "endpoint"
        ? command.destination.endpoint_id
        : `broadcast:${command.destination.scope}:${command.destination.target}`;
    const envelope: EventEnvelope = {
      event_id: `evt_${randomUUID()}`,
      type: command.type,
      workspace_id: command.workspace_id,
      source_endpoint_id: command.source_endpoint_id,
      thread_id: command.thread_id,
      correlation_id: command.correlation_id ?? null,
      destination_json: command.destination,
      content: command.content,
      response,
      metadata: command.metadata ?? {},
      created_at: now()
    };
    this.db.prepare(`
      INSERT INTO events (
        event_id, type, workspace_id, source_endpoint_id, destination_endpoint_id, thread_id, correlation_id,
        destination_json, content_json, response_json, metadata_json, idempotency_key, created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.event_id,
      envelope.type,
      envelope.workspace_id,
      envelope.source_endpoint_id,
      destinationEndpointId,
      envelope.thread_id,
      envelope.correlation_id,
      json(envelope.destination_json),
      json(envelope.content),
      json(envelope.response),
      json(envelope.metadata),
      command.idempotency_key ?? null,
      envelope.created_at
    );
    return envelope;
  }

  private resolveDestinations(event: EventEnvelope): string[] {
    const destination = event.destination_json;
    if (destination.kind === "endpoint") return [destination.endpoint_id];
    const target = destination.target;
    const query = `
      SELECT endpoint_id
      FROM endpoints
      WHERE workspace_id = ?
        AND (
          (? = 'all')
          OR (? = 'agents' AND actor_type = 'agent')
          OR (? = 'humans' AND actor_type = 'human')
          OR (? = 'active_agents' AND actor_type = 'agent' AND status = 'active')
          OR (? = 'active_humans' AND actor_type = 'human' AND status = 'active')
        )
    `;
    const rows = this.db.prepare(query).all(
      event.workspace_id,
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
    this.db.prepare("UPDATE endpoints SET status = 'queued', updated_at = ? WHERE endpoint_id = ?")
      .run(now(), destinationEndpointId);
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
    if (!endpoint || endpoint.actor_type !== "agent") return null;
    if (endpoint.status === "active" || endpoint.status === "error") return null;

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
