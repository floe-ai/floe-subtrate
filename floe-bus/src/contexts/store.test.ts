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
      content_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
  applyContextSchema(db);
  return db;
}

const WS = "workspace:test";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";
const E3 = "actor:test:e3";

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

  it("migrates a pre-existing contexts table by adding Default Scope before scope indexes", () => {
    const legacyDb = new DatabaseSync(":memory:");
    legacyDb.exec("PRAGMA foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE contexts (
        context_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        parent_context_id TEXT,
        created_by_endpoint_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO contexts (
        context_id, workspace_id, parent_context_id, created_by_endpoint_id, created_at
      ) VALUES (
        'ctx_legacy', '${WS}', NULL, '${E1}', '2026-01-01T00:00:00.000Z'
      );
    `);

    expect(() => applyContextSchema(legacyDb)).not.toThrow();
    const migrated = new ContextStore(legacyDb).getContext("ctx_legacy");
    expect(migrated?.scope_id).toBe("default");
    legacyDb.close();
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
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("evt_1", "message", WS, E1, id, null, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("evt_2", "message", WS, E2, id, null, "2026-01-02T00:00:00.000Z");
    expect(store.getLastEventAt(id)).toBe("2026-01-02T00:00:00.000Z");
  });

  it("listContextsForParticipant orders by last_event_at descending", () => {
    const a = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    const b = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1, E2] });
    db.prepare(
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("evt_a", "message", WS, E1, a, null, "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("evt_b", "message", WS, E1, b, null, "2026-01-02T00:00:00.000Z");
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

  describe("getFirstMessagePreview", () => {
    function insertEvent(opts: { id: string; type: string; ctx: string; text?: string; at: string }) {
      db.prepare(
        "INSERT INTO events (event_id, type, workspace_id, source_endpoint_id, context_id, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run(opts.id, opts.type, WS, E1, opts.ctx, opts.text === undefined ? null : JSON.stringify({ text: opts.text }), opts.at);
    }

    it("returns null when context has no events", () => {
      const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      expect(store.getFirstMessagePreview(id)).toBeNull();
    });

    it("returns null when context has only non-message events", () => {
      const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      insertEvent({ id: "e1", type: "pulse.fired", ctx: id, text: "ignored", at: "2026-01-01T00:00:00.000Z" });
      expect(store.getFirstMessagePreview(id)).toBeNull();
    });

    it("returns text of the first (chronologically earliest) message event", () => {
      const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      insertEvent({ id: "e1", type: "message", ctx: id, text: "first", at: "2026-01-01T00:00:00.000Z" });
      insertEvent({ id: "e2", type: "message", ctx: id, text: "second", at: "2026-01-02T00:00:00.000Z" });
      expect(store.getFirstMessagePreview(id)).toBe("first");
    });

    it("skips non-message events when looking for first message", () => {
      const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      insertEvent({ id: "e0", type: "pulse.fired", ctx: id, text: "trigger", at: "2026-01-01T00:00:00.000Z" });
      insertEvent({ id: "e1", type: "message", ctx: id, text: "hello", at: "2026-01-02T00:00:00.000Z" });
      expect(store.getFirstMessagePreview(id)).toBe("hello");
    });

    it("truncates long text to ~80 chars with ellipsis", () => {
      const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      const long = "x".repeat(200);
      insertEvent({ id: "e1", type: "message", ctx: id, text: long, at: "2026-01-01T00:00:00.000Z" });
      const preview = store.getFirstMessagePreview(id);
      expect(preview).not.toBeNull();
      expect(preview!.length).toBeLessThanOrEqual(81);
      expect(preview!.startsWith("xxxx")).toBe(true);
      expect(preview!.endsWith("…")).toBe(true);
    });

    it("does not truncate short text", () => {
      const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      insertEvent({ id: "e1", type: "message", ctx: id, text: "short", at: "2026-01-01T00:00:00.000Z" });
      expect(store.getFirstMessagePreview(id)).toBe("short");
    });

    it("returns null when first message has no text", () => {
      const id = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      insertEvent({ id: "e1", type: "message", ctx: id, at: "2026-01-01T00:00:00.000Z" });
      expect(store.getFirstMessagePreview(id)).toBeNull();
    });

    it("only considers events for the given context", () => {
      const a = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      const b = store.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
      insertEvent({ id: "e1", type: "message", ctx: b, text: "from-b", at: "2026-01-01T00:00:00.000Z" });
      expect(store.getFirstMessagePreview(a)).toBeNull();
      expect(store.getFirstMessagePreview(b)).toBe("from-b");
    });
  });
});
