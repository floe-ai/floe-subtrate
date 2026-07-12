/**
 * Slice 0 — Context compaction + clear-history.
 *
 * Tests ContextStore.clearContextHistory() and ContextStore.compactContext()
 * using a minimal but structurally correct events table so the INSERT in
 * compactContext can succeed.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ContextStore, applyContextSchema } from "./store.js";

const WS = "workspace:test-compact";
const E1 = "actor:compact:e1";
const E2 = "actor:compact:e2";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // Full events table matching BusStore's DDL (context_id via addColumnIfMissing).
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_endpoint_id TEXT,
      context_id TEXT,
      thread_id TEXT NOT NULL DEFAULT '',
      scope_id TEXT,
      correlation_id TEXT,
      destination_json TEXT NOT NULL DEFAULT '{"kind":"context","context_id":""}',
      content_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{"expected":false}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE contexts (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT,
      created_at TEXT NOT NULL,
      title TEXT
    );
    CREATE TABLE delivery_bundles (
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
    CREATE TABLE event_queue (
      queue_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      destination_endpoint_id TEXT NOT NULL,
      delivery_id TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL
    );
    CREATE TABLE runtime_telemetry (
      telemetry_id TEXT PRIMARY KEY,
      delivery_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE pending_responses (
      pending_id TEXT PRIMARY KEY,
      source_event_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  applyContextSchema(db);
  return db;
}

function insertEvent(db: DatabaseSync, opts: {
  id: string;
  contextId: string;
  workspaceId?: string;
  at?: string;
}): void {
  db.prepare(`
    INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, thread_id, destination_json, content_json, response_json, metadata_json, created_at)
    VALUES (?, 'message', ?, ?, ?, '', '{"kind":"context","context_id":""}', '{"text":"hi"}', '{"expected":false}', '{}', ?)
  `).run(opts.id, opts.workspaceId ?? WS, E1, opts.contextId, opts.at ?? new Date().toISOString());
}

describe("ContextStore — clearContextHistory (Slice 0)", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
  });

  it("returns 0 events_deleted when context has no events", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    const result = store.clearContextHistory(ctx);
    expect(result).toEqual({ events_deleted: 0 });
  });

  it("deletes all events for the context and preserves the context row + participants", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    insertEvent(db, { id: "ev1", contextId: ctx });
    insertEvent(db, { id: "ev2", contextId: ctx });

    const result = store.clearContextHistory(ctx);
    expect(result.events_deleted).toBe(2);

    // Context row survives
    expect(store.getContext(ctx)).not.toBeNull();
    // Participants survive
    expect(store.getContextParticipants(ctx).sort()).toEqual([E1, E2].sort());
    // Events gone
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM events WHERE context_id = ?").get(ctx) as any;
    expect(remaining.c).toBe(0);
  });

  it("does not delete events belonging to other contexts", () => {
    const ctxA = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const ctxB = store.createContext({ workspace_id: WS, created_by_endpoint_id: E2, participants: [E2] });
    insertEvent(db, { id: "ev_a", contextId: ctxA });
    insertEvent(db, { id: "ev_b", contextId: ctxB });

    store.clearContextHistory(ctxA);

    const remainingA = db.prepare("SELECT COUNT(*) AS c FROM events WHERE context_id = ?").get(ctxA) as any;
    const remainingB = db.prepare("SELECT COUNT(*) AS c FROM events WHERE context_id = ?").get(ctxB) as any;
    expect(remainingA.c).toBe(0);
    expect(remainingB.c).toBe(1);
  });

  it("cleans up delivery_bundles whose events are all from this context", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    insertEvent(db, { id: "ev1", contextId: ctx });

    // Simulate a delivery bundle containing only this event.
    db.prepare(`
      INSERT INTO delivery_bundles (delivery_id, endpoint_id, workspace_id, trigger_event_id, events_json, state, created_at)
      VALUES ('del1', '${E1}', '${WS}', 'ev1', '[{"event_id":"ev1","context_id":"${ctx}"}]', 'pending', '2026-01-01T00:00:00.000Z')
    `).run();

    store.clearContextHistory(ctx);

    const bundle = db.prepare("SELECT * FROM delivery_bundles WHERE delivery_id = 'del1'").get();
    expect(bundle).toBeUndefined();
  });

  it("patches delivery_bundles that contain events from multiple contexts", () => {
    const ctxA = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const ctxB = store.createContext({ workspace_id: WS, created_by_endpoint_id: E2, participants: [E2] });
    insertEvent(db, { id: "ev_a", contextId: ctxA });
    insertEvent(db, { id: "ev_b", contextId: ctxB });

    db.prepare(`
      INSERT INTO delivery_bundles (delivery_id, endpoint_id, workspace_id, trigger_event_id, events_json, state, created_at)
      VALUES ('del2', '${E1}', '${WS}', 'ev_a',
        '[{"event_id":"ev_a","context_id":"${ctxA}"},{"event_id":"ev_b","context_id":"${ctxB}"}]',
        'pending', '2026-01-01T00:00:00.000Z')
    `).run();

    store.clearContextHistory(ctxA);

    const bundle = db.prepare("SELECT events_json FROM delivery_bundles WHERE delivery_id = 'del2'").get() as any;
    expect(bundle).not.toBeUndefined();
    const events = JSON.parse(bundle.events_json);
    expect(events).toHaveLength(1);
    expect(events[0].event_id).toBe("ev_b");
  });
});

describe("ContextStore — compactContext (Slice 0)", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
  });

  it("inserts a synthetic context.compacted event and returns its event_id", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    insertEvent(db, { id: "ev1", contextId: ctx, at: "2026-01-01T00:00:00.000Z" });
    insertEvent(db, { id: "ev2", contextId: ctx, at: "2026-01-02T00:00:00.000Z" });

    const summaryId = store.compactContext(ctx, "Two messages handled.");

    expect(summaryId).toMatch(/^evt_/);
    const summaryRow = db.prepare("SELECT * FROM events WHERE event_id = ?").get(summaryId) as any;
    expect(summaryRow).not.toBeUndefined();
    expect(summaryRow.type).toBe("context.compacted");
    expect(summaryRow.context_id).toBe(ctx);
    const content = JSON.parse(summaryRow.content_json);
    expect(content.summary).toBe("Two messages handled.");
  });

  it("deletes all events when no before_event_id is given", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    insertEvent(db, { id: "ev1", contextId: ctx, at: "2026-01-01T00:00:00.000Z" });
    insertEvent(db, { id: "ev2", contextId: ctx, at: "2026-01-02T00:00:00.000Z" });

    const summaryId = store.compactContext(ctx, "Summary of all.");

    const remaining = db.prepare("SELECT event_id FROM events WHERE context_id = ?").all(ctx) as any[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].event_id).toBe(summaryId);
  });

  it("deletes only events before the watermark event when before_event_id is given", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    insertEvent(db, { id: "ev1", contextId: ctx, at: "2026-01-01T00:00:00.000Z" });
    insertEvent(db, { id: "ev2", contextId: ctx, at: "2026-01-02T00:00:00.000Z" });
    insertEvent(db, { id: "ev3", contextId: ctx, at: "2026-01-03T00:00:00.000Z" });

    const summaryId = store.compactContext(ctx, "Compacted up to ev2.", "ev2");

    const remaining = db.prepare("SELECT event_id FROM events WHERE context_id = ? ORDER BY created_at").all(ctx) as any[];
    const ids = remaining.map((r: any) => r.event_id);
    // ev1 is before ev2's timestamp → deleted; ev2 itself and ev3 remain; summary added
    expect(ids).toContain(summaryId);
    expect(ids).toContain("ev2");
    expect(ids).toContain("ev3");
    expect(ids).not.toContain("ev1");
  });

  it("preserves the context row and participants after compaction", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    insertEvent(db, { id: "ev1", contextId: ctx });

    store.compactContext(ctx, "Done.");

    expect(store.getContext(ctx)).not.toBeNull();
    expect(store.getContextParticipants(ctx).sort()).toEqual([E1, E2].sort());
  });
});
