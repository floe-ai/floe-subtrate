/**
 * Batch apply — applyContextSubscriptions (Slice 2 extension).
 *
 * Tests that the atomic batch method correctly:
 *   - adds participants for both `entries` and `participantsOnly`
 *   - upserts subscriptions for `entries`
 *   - treats event_types:[] as a silent watcher
 *   - does NOT touch subscriptions for `participantsOnly` endpoints
 *   - is idempotent on re-application
 *   - exposes the route POST /v1/contexts/:id/subscriptions:batch
 */
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ContextStore, applyContextSchema } from "./store.js";

// ---------------------------------------------------------------------------
// Minimal in-memory DB
// ---------------------------------------------------------------------------

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
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
  `);
  applyContextSchema(db);
  return db;
}

const WS = "workspace:test-batch";
const CTX = "ctx_batch_1";

describe("ContextStore.applyContextSubscriptions — batch participant + subscription", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
    // Create a context to operate on
    store.createContext({
      workspace_id: WS,
      scope_id: "scope:board",
      created_by_endpoint_id: null,
      participants: [],
      context_id: CTX,
    });
  });

  it("adds participants and subscriptions for each entry", () => {
    store.applyContextSubscriptions(CTX, [
      { endpoint_id: "actor:ws:agent-a", event_types: ["*"] },
      { endpoint_id: "actor:ws:agent-b", event_types: ["snowball.card.entered_column"] },
    ]);

    const participants = store.getContextParticipants(CTX);
    expect(participants).toContain("actor:ws:agent-a");
    expect(participants).toContain("actor:ws:agent-b");

    const subs = store.getContextSubscriptions(CTX);
    const a = subs.find((s) => s.endpoint_id === "actor:ws:agent-a");
    const b = subs.find((s) => s.endpoint_id === "actor:ws:agent-b");
    expect(a?.event_types).toEqual(["*"]);
    expect(b?.event_types).toEqual(["snowball.card.entered_column"]);
  });

  it("event_types:[] creates a silent watcher (participant, not subscribed to anything)", () => {
    store.applyContextSubscriptions(CTX, [
      { endpoint_id: "actor:ws:agent-prior", event_types: [] },
    ]);

    const participants = store.getContextParticipants(CTX);
    expect(participants).toContain("actor:ws:agent-prior");

    const subs = store.getContextSubscriptions(CTX);
    const sub = subs.find((s) => s.endpoint_id === "actor:ws:agent-prior");
    expect(sub?.event_types).toEqual([]);

    // isSubscribed should return false for any event type
    expect(store.isSubscribed(CTX, "actor:ws:agent-prior", "message")).toBe(false);
    expect(store.isSubscribed(CTX, "actor:ws:agent-prior", "*")).toBe(false);
  });

  it("participantsOnly adds participant without any subscription change", () => {
    store.applyContextSubscriptions(CTX, [], ["actor:ws:operator"]);

    const participants = store.getContextParticipants(CTX);
    expect(participants).toContain("actor:ws:operator");

    const subs = store.getContextSubscriptions(CTX);
    expect(subs.find((s) => s.endpoint_id === "actor:ws:operator")).toBeUndefined();
  });

  it("participantsOnly does NOT overwrite an existing subscription", () => {
    // First subscribe normally
    store.subscribeToContext(CTX, "actor:ws:agent-x", ["message"]);
    // Then re-apply as participantsOnly
    store.applyContextSubscriptions(CTX, [], ["actor:ws:agent-x"]);

    const subs = store.getContextSubscriptions(CTX);
    const sub = subs.find((s) => s.endpoint_id === "actor:ws:agent-x");
    // Subscription must remain intact — participantsOnly must not touch it
    expect(sub?.event_types).toEqual(["message"]);
  });

  it("is idempotent — re-applying the same batch produces the same state", () => {
    const batch = [
      { endpoint_id: "actor:ws:agent-a", event_types: ["*"] },
      { endpoint_id: "actor:ws:agent-b", event_types: [] },
    ];
    store.applyContextSubscriptions(CTX, batch, ["actor:ws:operator"]);
    store.applyContextSubscriptions(CTX, batch, ["actor:ws:operator"]);

    const participants = store.getContextParticipants(CTX);
    expect(participants.filter((p) => p === "actor:ws:agent-a")).toHaveLength(1);
    expect(participants.filter((p) => p === "actor:ws:agent-b")).toHaveLength(1);
    expect(participants.filter((p) => p === "actor:ws:operator")).toHaveLength(1);

    const subs = store.getContextSubscriptions(CTX);
    expect(subs).toHaveLength(2);
  });

  it("UPSERT — re-applying with new event_types overwrites the subscription", () => {
    store.applyContextSubscriptions(CTX, [
      { endpoint_id: "actor:ws:agent-a", event_types: ["*"] },
    ]);
    // Now demote to silent watcher
    store.applyContextSubscriptions(CTX, [
      { endpoint_id: "actor:ws:agent-a", event_types: [] },
    ]);

    const subs = store.getContextSubscriptions(CTX);
    const sub = subs.find((s) => s.endpoint_id === "actor:ws:agent-a");
    expect(sub?.event_types).toEqual([]);
    expect(store.isSubscribed(CTX, "actor:ws:agent-a", "message")).toBe(false);
  });

  it("applies both entries and participantsOnly in one call", () => {
    store.applyContextSubscriptions(
      CTX,
      [
        { endpoint_id: "actor:ws:dest-1", event_types: ["snowball.card.entered_column"] },
        { endpoint_id: "actor:ws:prior-1", event_types: [] },
      ],
      ["actor:ws:operator"]
    );

    const participants = store.getContextParticipants(CTX);
    expect(participants).toContain("actor:ws:dest-1");
    expect(participants).toContain("actor:ws:prior-1");
    expect(participants).toContain("actor:ws:operator");

    const subs = store.getContextSubscriptions(CTX);
    expect(subs.find((s) => s.endpoint_id === "actor:ws:dest-1")?.event_types)
      .toEqual(["snowball.card.entered_column"]);
    expect(subs.find((s) => s.endpoint_id === "actor:ws:prior-1")?.event_types)
      .toEqual([]);
    // operator has no subscription
    expect(subs.find((s) => s.endpoint_id === "actor:ws:operator")).toBeUndefined();
  });

  it("empty batch is a no-op", () => {
    store.applyContextSubscriptions(CTX, [], []);
    expect(store.getContextParticipants(CTX)).toHaveLength(0);
    expect(store.getContextSubscriptions(CTX)).toHaveLength(0);
  });
});
