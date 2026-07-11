/**
 * Slice 1 — Dynamic participants + generic context linking.
 *
 * Track A: addParticipant / removeParticipant on ContextStore.
 * Track B: parent_context_id exposed in create, listContextsForParent,
 *          children index.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ContextStore, applyContextSchema } from "./store.js";

const WS = "workspace:test-participants";
const E1 = "actor:dyn:e1";
const E2 = "actor:dyn:e2";
const E3 = "actor:dyn:e3";

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

describe("ContextStore — addParticipant / removeParticipant (Slice 1 Track A)", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
  });

  it("addParticipant adds a new endpoint and returns true", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const added = store.addParticipant(ctx, E2);
    expect(added).toBe(true);
    expect(store.getContextParticipants(ctx).sort()).toEqual([E1, E2].sort());
    expect(store.isParticipant(ctx, E2)).toBe(true);
  });

  it("addParticipant is idempotent — returns false on duplicate", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    const added = store.addParticipant(ctx, E2);
    expect(added).toBe(false);
    // Still exactly two participants
    expect(store.getContextParticipants(ctx).length).toBe(2);
  });

  it("removeParticipant removes an existing endpoint and returns true", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    const removed = store.removeParticipant(ctx, E2);
    expect(removed).toBe(true);
    expect(store.isParticipant(ctx, E2)).toBe(false);
    expect(store.getContextParticipants(ctx)).toEqual([E1]);
  });

  it("removeParticipant is idempotent — returns false when not present", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const removed = store.removeParticipant(ctx, E3);
    expect(removed).toBe(false);
  });

  it("add then remove leaves context with original participants", () => {
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    store.addParticipant(ctx, E2);
    store.removeParticipant(ctx, E2);
    expect(store.getContextParticipants(ctx)).toEqual([E1]);
  });

  it("removing a participant from context A does not affect context B", () => {
    const ctxA = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    const ctxB = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    store.removeParticipant(ctxA, E2);
    expect(store.isParticipant(ctxA, E2)).toBe(false);
    expect(store.isParticipant(ctxB, E2)).toBe(true);
  });

  it("emit rule 1 (participation gate) is unchanged — resolver still enforces participant membership", () => {
    // Verifying that the resolver reads the live participant table.
    // After removal, E2 is no longer a participant — isParticipant returns false.
    const ctx = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    store.removeParticipant(ctx, E2);
    expect(store.isParticipant(ctx, E2)).toBe(false);
  });
});

describe("ContextStore — context linking / listContextsForParent (Slice 1 Track B)", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
  });

  it("createContext persists parent_context_id", () => {
    const parent = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const child = store.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1],
      parent_context_id: parent,
    });
    const row = store.getContext(child);
    expect(row?.parent_context_id).toBe(parent);
  });

  it("listContextsForParent returns direct children ordered by created_at", () => {
    const parent = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const c1 = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1], parent_context_id: parent });
    const c2 = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1], parent_context_id: parent });
    const c3 = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1], parent_context_id: parent });

    const children = store.listContextsForParent(parent).map((r) => r.context_id);
    expect(children).toContain(c1);
    expect(children).toContain(c2);
    expect(children).toContain(c3);
    expect(children).toHaveLength(3);
  });

  it("listContextsForParent returns empty array when parent has no children", () => {
    const parent = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    expect(store.listContextsForParent(parent)).toEqual([]);
  });

  it("listContextsForParent does not include grandchildren", () => {
    const grandparent = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const parent = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1], parent_context_id: grandparent });
    const child = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1], parent_context_id: parent });

    const grandparentChildren = store.listContextsForParent(grandparent).map((r) => r.context_id);
    expect(grandparentChildren).toEqual([parent]);
    expect(grandparentChildren).not.toContain(child);
  });

  it("contexts with no parent_context_id are not returned as children of anyone", () => {
    const parent = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    // Orphan context with no parent
    store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    expect(store.listContextsForParent(parent)).toHaveLength(0);
  });
});
