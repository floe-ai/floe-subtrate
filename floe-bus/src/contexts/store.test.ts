import { describe, expect, it, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ContextStore, applyContextSchema } from "./store.js";

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // Bare-minimum events table for last_event_at aggregate.
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_endpoint_id TEXT NOT NULL,
      context_id TEXT,
      created_at TEXT NOT NULL
    );
  `);
  applyContextSchema(db);
  return db;
}

const WS = "workspace:test";
const E1 = "endpoint:test:agent:e1";
const E2 = "endpoint:test:agent:e2";
const E3 = "endpoint:test:agent:e3";

describe("ContextStore CRUD", () => {
  let db: DatabaseSync;
  let store: ContextStore;

  beforeEach(() => {
    db = freshDb();
    store = new ContextStore(db);
  });

  it("T1: createContext({participants:[E1,E2]}) creates row with both as participants", () => {
    const id = store.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2]
    });
    expect(id).toMatch(/^ctx_/);
    const ctx = store.getContext(id);
    expect(ctx).toMatchObject({ context_id: id, workspace_id: WS, created_by_endpoint_id: E1 });
    const parts = store.getContextParticipants(id).sort();
    expect(parts).toEqual([E1, E2].sort());
  });

  it("isParticipant returns correct truthiness", () => {
    const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    expect(store.isParticipant(id, E1)).toBe(true);
    expect(store.isParticipant(id, E2)).toBe(true);
    expect(store.isParticipant(id, E3)).toBe(false);
    expect(store.isParticipant("ctx_missing", E1)).toBe(false);
  });

  it("getContext returns null when missing", () => {
    expect(store.getContext("ctx_missing")).toBeNull();
  });

  it("listContextsForParticipant only returns contexts where endpoint participates", () => {
    const a = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    const b = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E3] });
    const c = store.createContext({ workspace_id: WS, created_by_endpoint_id: E2, participants: [E2, E3] });
    const e1List = store.listContextsForParticipant(E1).map((x) => x.context_id).sort();
    expect(e1List).toEqual([a, b].sort());
    const e3List = store.listContextsForParticipant(E3).map((x) => x.context_id).sort();
    expect(e3List).toEqual([b, c].sort());
  });

  it("getLastEventAt aggregates MAX(events.created_at) for the context", () => {
    const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    expect(store.getLastEventAt(id)).toBeNull();
    db.prepare(
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("evt_1", "message", WS, E1, id, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("evt_2", "message", WS, E2, id, "2026-01-02T00:00:00.000Z");
    expect(store.getLastEventAt(id)).toBe("2026-01-02T00:00:00.000Z");
  });

  it("listContextsForParticipant orders by last_event_at descending", () => {
    const a = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    const b = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    db.prepare(
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("evt_a", "message", WS, E1, a, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("evt_b", "message", WS, E1, b, "2026-01-02T00:00:00.000Z");
    const list = store.listContextsForParticipant(E1).map((x) => x.context_id);
    expect(list).toEqual([b, a]);
  });

  it("createContext with single participant (self-emit case) works", () => {
    const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    expect(store.getContextParticipants(id)).toEqual([E1]);
  });

  it("createContext deduplicates participants", () => {
    const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E1, E2] });
    expect(store.getContextParticipants(id).sort()).toEqual([E1, E2].sort());
  });
});
