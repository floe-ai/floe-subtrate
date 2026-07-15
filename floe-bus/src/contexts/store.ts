import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ContextRecord = {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  title: string | null;
};

export type ContextListRow = ContextRecord & {
  participants: string[];
  last_event_at: string | null;
  topic: string | null;
};

export type ContextScopeFilter = "all" | "scoped" | "unscoped";

/**
 * Read-only surface used by the context resolver. Keeps the resolver decoupled
 * from the BusStore so it can be unit-tested in isolation.
 */
export interface ContextStoreReader {
  getContext(context_id: string): ContextRecord | null;
  getContextParticipants(context_id: string): string[];
  isParticipant(context_id: string, endpoint_id: string): boolean;
  listContextsForParticipant(endpoint_id: string): ContextListRow[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function relaxContextAnchorColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(contexts)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const scope = columns.find((item) => item.name === "scope_id");
  const createdBy = columns.find((item) => item.name === "created_by_endpoint_id");
  const needsRebuild =
    scope?.notnull === 1 ||
    scope?.dflt_value != null ||
    createdBy?.notnull === 1;
  if (!needsRebuild) return;

  db.exec(`
    CREATE TABLE contexts_next (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO contexts_next (
      context_id, workspace_id, scope_id, parent_context_id, created_by_endpoint_id, created_at
    )
    SELECT
      context_id,
      workspace_id,
      NULLIF(scope_id, 'default'),
      parent_context_id,
      created_by_endpoint_id,
      created_at
    FROM contexts;

    DROP TABLE contexts;
    ALTER TABLE contexts_next RENAME TO contexts;
  `);
}

export function applyContextSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contexts_workspace
      ON contexts(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS context_participants (
      context_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (context_id, endpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_participants_endpoint
      ON context_participants(endpoint_id, context_id);
  `);
  addColumnIfMissing(db, "contexts", "scope_id", "TEXT");
  relaxContextAnchorColumns(db);
  addColumnIfMissing(db, "contexts", "title", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contexts_workspace_scope
      ON contexts(workspace_id, scope_id, created_at);

    -- Slice 1 Track B: index for parent↔child context linking
    CREATE INDEX IF NOT EXISTS idx_contexts_parent
      ON contexts(parent_context_id, created_at);

    -- Slice 2: per-actor, per-context, per-event-type subscriptions
    CREATE TABLE IF NOT EXISTS context_subscriptions (
      context_id   TEXT NOT NULL,
      endpoint_id  TEXT NOT NULL,
      event_types  TEXT NOT NULL DEFAULT '["*"]',
      subscribed_at TEXT NOT NULL,
      PRIMARY KEY (context_id, endpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_subscriptions_endpoint
      ON context_subscriptions(endpoint_id, context_id);
  `);
}

export class ContextStore implements ContextStoreReader {
  constructor(readonly db: DatabaseSync) {}

  createContext(input: {
    workspace_id: string;
    scope_id?: string | null;
    created_by_endpoint_id: string | null;
    participants: readonly string[];
    parent_context_id?: string | null;
    context_id?: string;
    title?: string | null;
  }): string {
    const id = input.context_id ?? `ctx_${randomUUID()}`;
    const ts = nowIso();
    const participants = Array.from(new Set(input.participants));
    if (!input.scope_id && participants.length === 0) {
      throw new Error("Context requires at least one actor participant or Scope");
    }
    const insertContext = this.db.prepare(`
      INSERT INTO contexts (context_id, workspace_id, scope_id, parent_context_id, created_by_endpoint_id, created_at, title)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertParticipant = this.db.prepare(`
      INSERT OR IGNORE INTO context_participants (context_id, endpoint_id, joined_at)
      VALUES (?, ?, ?)
    `);
    insertContext.run(id, input.workspace_id, input.scope_id ?? null, input.parent_context_id ?? null, input.created_by_endpoint_id, ts, input.title ?? null);
    for (const ep of participants) {
      insertParticipant.run(id, ep, ts);
    }
    return id;
  }

  getContext(context_id: string): ContextRecord | null {
    const row = this.db.prepare("SELECT * FROM contexts WHERE context_id = ?").get(context_id) as any;
    if (!row) return null;
    return {
      context_id: row.context_id,
      workspace_id: row.workspace_id,
      scope_id: row.scope_id ?? null,
      parent_context_id: row.parent_context_id ?? null,
      created_by_endpoint_id: row.created_by_endpoint_id ?? null,
      created_at: row.created_at,
      title: (row.title as string | null) ?? null
    };
  }

  getContextParticipants(context_id: string): string[] {
    const rows = this.db
      .prepare("SELECT endpoint_id FROM context_participants WHERE context_id = ? ORDER BY joined_at ASC")
      .all(context_id) as Array<{ endpoint_id: string }>;
    return rows.map((r) => r.endpoint_id);
  }

  isParticipant(context_id: string, endpoint_id: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM context_participants WHERE context_id = ? AND endpoint_id = ?")
      .get(context_id, endpoint_id);
    return !!row;
  }

  // ---------------------------------------------------------------------------
  // Slice 1 Track A — Dynamic participants
  // ---------------------------------------------------------------------------

  /**
   * Add an endpoint as a participant in a context (idempotent — INSERT OR IGNORE).
   * Returns true when the endpoint was newly added, false when it was already present.
   */
  addParticipant(context_id: string, endpoint_id: string): boolean {
    const ts = nowIso();
    const result = this.db
      .prepare("INSERT OR IGNORE INTO context_participants (context_id, endpoint_id, joined_at) VALUES (?, ?, ?)")
      .run(context_id, endpoint_id, ts);
    return Number(result.changes ?? 0) > 0;
  }

  /**
   * Remove an endpoint from a context's participant list (idempotent).
   * Returns true when the endpoint was removed, false when it was not present.
   * Does NOT affect the endpoint's subscription record — that is managed
   * separately via unsubscribeFromContext.
   */
  removeParticipant(context_id: string, endpoint_id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM context_participants WHERE context_id = ? AND endpoint_id = ?")
      .run(context_id, endpoint_id);
    return Number(result.changes ?? 0) > 0;
  }

  // ---------------------------------------------------------------------------
  // Slice 1 Track B — Context linking
  // ---------------------------------------------------------------------------

  /**
   * Walk the parent chain starting from `startId` and return true if `candidateId`
   * appears anywhere in that chain (which would create a cycle).
   * Bounded to 100 hops — any legitimate hierarchy is far shallower.
   */
  wouldCreateCycle(startId: string, candidateId: string): boolean {
    const stmt = this.db.prepare("SELECT parent_context_id FROM contexts WHERE context_id = ?");
    let current: string | null = startId;
    let hops = 0;
    while (current !== null && hops < 100) {
      if (current === candidateId) return true;
      const row = stmt.get(current) as { parent_context_id: string | null } | undefined;
      if (!row) break;
      current = row.parent_context_id;
      hops++;
    }
    return false;
  }

  /**
   * List direct children of a parent context (contexts whose parent_context_id
   * equals the given parentId).  Ordered by created_at ascending.
   */
  listContextsForParent(parentId: string): ContextListRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM contexts c
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE c.parent_context_id = ?
        GROUP BY c.context_id
        ORDER BY c.created_at ASC
      `
      )
      .all(parentId) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  setContextScope(context_id: string, scope_id: string): ContextRecord | null {
    this.db.prepare("UPDATE contexts SET scope_id = ? WHERE context_id = ?").run(scope_id, context_id);
    return this.getContext(context_id);
  }

  getLastEventAt(context_id: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(created_at) AS last FROM events WHERE context_id = ?")
      .get(context_id) as any;
    return (row?.last as string | null) ?? null;
  }

  getFirstMessagePreview(context_id: string, maxChars = 80): string | null {
    const row = this.db
      .prepare(
        "SELECT content_json FROM events WHERE context_id = ? AND type = 'message' ORDER BY created_at ASC LIMIT 1"
      )
      .get(context_id) as { content_json: string | null } | undefined;
    if (!row || !row.content_json) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(row.content_json);
    } catch {
      return null;
    }
    const text = parsed && typeof parsed.text === "string" ? parsed.text : null;
    if (!text) return null;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "…";
  }

  private mapContextListRow(row: any): ContextListRow {
    return {
      context_id: row.context_id,
      workspace_id: row.workspace_id,
      scope_id: row.scope_id ?? null,
      parent_context_id: row.parent_context_id ?? null,
      created_by_endpoint_id: row.created_by_endpoint_id ?? null,
      created_at: row.created_at,
      title: (row.title as string | null) ?? null,
      last_event_at: (row.last_event_at as string | null) ?? null,
      topic: null,
      participants: this.getContextParticipants(row.context_id)
    };
  }

  listContextsForParticipant(endpoint_id: string): ContextListRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM context_participants cp
        JOIN contexts c ON c.context_id = cp.context_id
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE cp.endpoint_id = ?
        GROUP BY c.context_id
        ORDER BY (last_event_at IS NULL) ASC, last_event_at DESC, c.created_at DESC
      `
      )
      .all(endpoint_id) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  listContextsForWorkspace(
    workspace_id: string,
    options: { scope?: ContextScopeFilter; limit?: number } = {}
  ): ContextListRow[] {
    const params: Array<string | number> = [workspace_id];
    let scopeClause = "";
    if (options.scope === "scoped") {
      scopeClause = "AND c.scope_id IS NOT NULL";
    } else if (options.scope === "unscoped") {
      scopeClause = "AND c.scope_id IS NULL";
    }
    const limit = options.limit ?? 50;
    params.push(limit);
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM contexts c
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE c.workspace_id = ? ${scopeClause}
        GROUP BY c.context_id
        ORDER BY (last_event_at IS NULL) ASC, last_event_at DESC, c.created_at DESC
        LIMIT ?
      `
      )
      .all(...params) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  // ---------------------------------------------------------------------------
  // Slice 0 — Context compaction + clear-history
  // ---------------------------------------------------------------------------

  /**
   * Delete all events for a context without deleting the context itself.
   *
   * Replicates the delivery-bundle cleanup from deleteContext so in-flight
   * bundles are kept consistent.  Must NOT be called while a delivery is
   * `active` — callers should check first.
   *
   * Keeps: contexts row, context_participants rows, pulse_subscribers rows.
   * Deletes: events, queued event_queue rows, pending_responses, and
   *          delivery_bundles whose events are all from this context.
   */
  clearContextHistory(contextId: string): { events_deleted: number } {
    const eventIds = (this.db
      .prepare("SELECT event_id FROM events WHERE context_id = ?")
      .all(contextId) as Array<{ event_id: string }>).map((r) => r.event_id);

    if (eventIds.length === 0) return { events_deleted: 0 };

    // Patch/delete delivery bundles that reference this context's events.
    const bundles = this.db
      .prepare("SELECT delivery_id, events_json FROM delivery_bundles")
      .all() as Array<{ delivery_id: string; events_json: string }>;

    const eventSet = new Set(eventIds);
    const bundlesToDelete = new Set<string>();
    const bundlesPatched = new Set<string>();

    for (const bundle of bundles) {
      const events = JSON.parse(bundle.events_json) as Array<{ event_id: string }>;
      const remaining = events.filter((e) => !eventSet.has(e.event_id));
      if (remaining.length === events.length) continue;
      bundlesPatched.add(bundle.delivery_id);
      if (remaining.length === 0) {
        bundlesToDelete.add(bundle.delivery_id);
        this.db.prepare("DELETE FROM delivery_bundles WHERE delivery_id = ?").run(bundle.delivery_id);
      } else {
        this.db.prepare(`
          UPDATE delivery_bundles
          SET trigger_event_id = ?, events_json = ?
          WHERE delivery_id = ?
        `).run(remaining[0].event_id, JSON.stringify(remaining), bundle.delivery_id);
      }
    }

    for (const eventId of eventIds) {
      this.db.prepare("DELETE FROM event_queue WHERE event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM pending_responses WHERE source_event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);
    }

    for (const deliveryId of bundlesPatched) {
      this.db.prepare("DELETE FROM runtime_telemetry WHERE delivery_id = ?").run(deliveryId);
    }
    for (const deliveryId of bundlesToDelete) {
      this.db.prepare("DELETE FROM event_queue WHERE delivery_id = ?").run(deliveryId);
    }

    return { events_deleted: eventIds.length };
  }

  /**
   * Compact a context's history: delete events older than `before_event_id`
   * (or all events when omitted), then insert one synthetic
   * `context.compacted` event carrying `summary` as the record.
   *
   * Returns the summary event's id.
   */
  compactContext(contextId: string, summary: string, beforeEventId?: string): string {
    const watermark = beforeEventId
      ? (this.db
          .prepare("SELECT created_at FROM events WHERE event_id = ? AND context_id = ?")
          .get(beforeEventId, contextId) as { created_at: string } | undefined)
        ?.created_at
      : undefined;

    // Determine events to delete.
    const eventIds = ((
      watermark
        ? this.db
            .prepare("SELECT event_id FROM events WHERE context_id = ? AND created_at < ?")
            .all(contextId, watermark)
        : this.db
            .prepare("SELECT event_id FROM events WHERE context_id = ?")
            .all(contextId)
    ) as Array<{ event_id: string }>).map((r) => r.event_id);

    // Patch/delete delivery bundles referencing removed events.
    const bundles = this.db
      .prepare("SELECT delivery_id, events_json FROM delivery_bundles")
      .all() as Array<{ delivery_id: string; events_json: string }>;

    const eventSet = new Set(eventIds);
    const bundlesToDelete = new Set<string>();
    const bundlesPatched = new Set<string>();

    for (const bundle of bundles) {
      const events = JSON.parse(bundle.events_json) as Array<{ event_id: string }>;
      const remaining = events.filter((e) => !eventSet.has(e.event_id));
      if (remaining.length === events.length) continue;
      bundlesPatched.add(bundle.delivery_id);
      if (remaining.length === 0) {
        bundlesToDelete.add(bundle.delivery_id);
        this.db.prepare("DELETE FROM delivery_bundles WHERE delivery_id = ?").run(bundle.delivery_id);
      } else {
        this.db.prepare(`
          UPDATE delivery_bundles
          SET trigger_event_id = ?, events_json = ?
          WHERE delivery_id = ?
        `).run(remaining[0].event_id, JSON.stringify(remaining), bundle.delivery_id);
      }
    }

    for (const eventId of eventIds) {
      this.db.prepare("DELETE FROM event_queue WHERE event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM pending_responses WHERE source_event_id = ?").run(eventId);
      this.db.prepare("DELETE FROM events WHERE event_id = ?").run(eventId);
    }

    for (const deliveryId of bundlesPatched) {
      this.db.prepare("DELETE FROM runtime_telemetry WHERE delivery_id = ?").run(deliveryId);
    }
    for (const deliveryId of bundlesToDelete) {
      this.db.prepare("DELETE FROM event_queue WHERE delivery_id = ?").run(deliveryId);
    }

    // Insert the synthetic summary event.
    const summaryEventId = `evt_${randomUUID()}`;
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO events (
        event_id, type, workspace_id, source_endpoint_id, context_id, thread_id, scope_id,
        correlation_id, destination_json, content_json, response_json,
        metadata_json, idempotency_key, created_at
      )
      SELECT
        ?, 'context.compacted', c.workspace_id, NULL, ?, '', c.scope_id,
        NULL,
        json_object('kind','context','context_id',?),
        json_object('summary',?),
        json_object('expected', json('false')),
        json_object('compacted_event_count',?),
        NULL, ?
      FROM contexts c
      WHERE c.context_id = ?
    `).run(summaryEventId, contextId, contextId, summary, eventIds.length, ts, contextId);

    return summaryEventId;
  }

  listContextsForScope(workspace_id: string, scope_id: string): ContextListRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM contexts c
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE c.workspace_id = ? AND c.scope_id = ?
        GROUP BY c.context_id
        ORDER BY (last_event_at IS NULL) ASC, last_event_at DESC, c.created_at DESC
      `
      )
      .all(workspace_id, scope_id) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  // ---------------------------------------------------------------------------
  // Slice 2 — Per-actor, per-context, per-event-type subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe an endpoint to events in a context.
   *
   * `eventTypes` is a JSON-serialisable array of event type strings.  The
   * special value `["*"]` (the default) means "all event types".
   *
   * Idempotent: if a subscription already exists it is replaced (UPSERT).
   */
  subscribeToContext(
    contextId: string,
    endpointId: string,
    eventTypes: string[] = ["*"]
  ): void {
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO context_subscriptions (context_id, endpoint_id, event_types, subscribed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(context_id, endpoint_id) DO UPDATE SET
        event_types  = excluded.event_types,
        subscribed_at = excluded.subscribed_at
    `).run(contextId, endpointId, JSON.stringify(eventTypes), ts);
  }

  /**
   * Remove a subscription for an endpoint from a context (idempotent).
   */
  unsubscribeFromContext(contextId: string, endpointId: string): void {
    this.db.prepare(
      "DELETE FROM context_subscriptions WHERE context_id = ? AND endpoint_id = ?"
    ).run(contextId, endpointId);
  }

  /**
   * Return all active subscriptions for a context.
   */
  getContextSubscriptions(contextId: string): Array<{
    endpoint_id: string;
    event_types: string[];
    subscribed_at: string;
  }> {
    const rows = this.db
      .prepare(
        "SELECT endpoint_id, event_types, subscribed_at FROM context_subscriptions WHERE context_id = ? ORDER BY subscribed_at ASC"
      )
      .all(contextId) as Array<{ endpoint_id: string; event_types: string; subscribed_at: string }>;
    return rows.map((r) => ({
      endpoint_id: r.endpoint_id,
      event_types: JSON.parse(r.event_types) as string[],
      subscribed_at: r.subscribed_at,
    }));
  }

  // ---------------------------------------------------------------------------
  // Batch apply — participants + subscriptions in one atomic transaction
  // ---------------------------------------------------------------------------

  /**
   * Atomically apply a set of participant + subscription changes to a context.
   *
   * - `entries`: each entry idempotently adds `endpoint_id` as a participant
   *   AND upserts its subscription with the given `event_types`.
   *   `event_types: []` means "participant but never woken" (silent watcher).
   * - `participantsOnly`: endpoints added as participants with NO subscription
   *   change — useful for acting actors who must be able to emit but are not
   *   subscribed to any event type.
   *
   * All changes are applied in a single SQLite transaction.
   */
  applyContextSubscriptions(
    contextId: string,
    entries: Array<{ endpoint_id: string; event_types: string[] }>,
    participantsOnly: string[] = []
  ): void {
    const ts = nowIso();
    const insertParticipant = this.db.prepare(
      "INSERT OR IGNORE INTO context_participants (context_id, endpoint_id, joined_at) VALUES (?, ?, ?)"
    );
    const upsertSubscription = this.db.prepare(`
      INSERT INTO context_subscriptions (context_id, endpoint_id, event_types, subscribed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(context_id, endpoint_id) DO UPDATE SET
        event_types   = excluded.event_types,
        subscribed_at = excluded.subscribed_at
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const ep of participantsOnly) {
        insertParticipant.run(contextId, ep, ts);
      }
      for (const entry of entries) {
        insertParticipant.run(contextId, entry.endpoint_id, ts);
        upsertSubscription.run(contextId, entry.endpoint_id, JSON.stringify(entry.event_types), ts);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Check whether an endpoint's subscription matches a given event type.
   *
   * Returns false when no subscription row exists.
   * Returns true when the subscription covers `"*"` or the exact eventType.
   */
  isSubscribed(contextId: string, endpointId: string, eventType: string): boolean {
    const row = this.db
      .prepare(
        "SELECT event_types FROM context_subscriptions WHERE context_id = ? AND endpoint_id = ?"
      )
      .get(contextId, endpointId) as { event_types: string } | undefined;
    if (!row) return false;
    const types = JSON.parse(row.event_types) as string[];
    return types.includes("*") || types.includes(eventType);
  }
}
