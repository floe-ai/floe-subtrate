/**
 * Side-thread substrate tests.
 *
 * Invariants under test:
 *  1. applyThreadSchema backfills a root thread for every existing context.
 *  2. A runtime emit to a non-participant creates a side thread and the
 *     message carries the new thread_id.
 *  3. A reply from the addressee defaults onto the SAME side thread.
 *  4. A reply to an existing context participant stays on the main thread
 *     (no side thread created).
 *  5. main/side derivation: parent_thread_id IS NULL ⟹ main; IS NOT NULL ⟹ side.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { applyContextSchema, ContextStore } from "./store.js";
import { applyThreadSchema, ThreadStore } from "./threads.js";
import { BusStore, type EventCommand } from "../store.js";
import { defaultConfig } from "../config.js";

// ---------------------------------------------------------------------------
// Helpers — ThreadStore unit tests use a lightweight in-memory DB
// ---------------------------------------------------------------------------

const WS = "workspace:test-threads";
const E1 = "actor:thr:e1";
const E2 = "actor:thr:e2";
const E3 = "actor:thr:e3";

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
  applyContextSchema(db); // also calls applyThreadSchema internally
  return db;
}

// ---------------------------------------------------------------------------
// ThreadStore unit tests
// ---------------------------------------------------------------------------

describe("ThreadStore — schema + CRUD", () => {
  let db: DatabaseSync;
  let ctxStore: ContextStore;
  let thrStore: ThreadStore;

  beforeEach(() => {
    db = freshDb();
    ctxStore = new ContextStore(db);
    thrStore = new ThreadStore(db);
  });

  // ------- Test 1: backfill -------
  it("applyThreadSchema backfills root thread for every existing context", () => {
    // Create two contexts directly so we can verify backfill independently.
    const db2 = new DatabaseSync(":memory:");
    db2.exec(`
      CREATE TABLE contexts (
        context_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        scope_id TEXT,
        parent_context_id TEXT,
        created_by_endpoint_id TEXT,
        created_at TEXT NOT NULL,
        title TEXT
      );
    `);
    // Insert two contexts BEFORE creating the threads table.
    db2.prepare(
      "INSERT INTO contexts (context_id, workspace_id, created_by_endpoint_id, created_at) VALUES (?, ?, ?, ?)"
    ).run("ctx_alpha", WS, E1, "2025-01-01T00:00:00.000Z");
    db2.prepare(
      "INSERT INTO contexts (context_id, workspace_id, created_by_endpoint_id, created_at) VALUES (?, ?, ?, ?)"
    ).run("ctx_beta", WS, E2, "2025-01-02T00:00:00.000Z");

    // Now apply the thread schema — this should backfill both contexts.
    applyThreadSchema(db2);

    const thrStore2 = new ThreadStore(db2);
    const alpha = thrStore2.getThread("ctx_alpha");
    const beta = thrStore2.getThread("ctx_beta");

    expect(alpha).not.toBeNull();
    expect(alpha?.thread_id).toBe("ctx_alpha");
    expect(alpha?.context_id).toBe("ctx_alpha");
    expect(alpha?.parent_thread_id).toBeNull();
    expect(alpha?.status).toBe("open");

    expect(beta).not.toBeNull();
    expect(beta?.thread_id).toBe("ctx_beta");
    expect(beta?.parent_thread_id).toBeNull();
    db2.close();
  });

  // ------- Test 5: main/side derivation -------
  it("parent_thread_id IS NULL ⟹ main thread; IS NOT NULL ⟹ side thread", () => {
    const ctxId = ctxStore.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    // The root thread was auto-created by applyContextSchema → applyThreadSchema backfill.
    const root = thrStore.getThread(ctxId);
    expect(root).not.toBeNull();
    expect(root?.parent_thread_id).toBeNull(); // main

    const sideId = thrStore.createThread({
      context_id: ctxId,
      parent_thread_id: ctxId,
      created_by_endpoint_id: E1,
    });
    const side = thrStore.getThread(sideId);
    expect(side?.parent_thread_id).toBe(ctxId); // side
  });

  it("listThreadsForContext returns root first, then side threads", () => {
    const ctxId = ctxStore.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const s1 = thrStore.createThread({ context_id: ctxId, parent_thread_id: ctxId, created_by_endpoint_id: E1 });
    const s2 = thrStore.createThread({ context_id: ctxId, parent_thread_id: ctxId, created_by_endpoint_id: E2 });

    const threads = thrStore.listThreadsForContext(ctxId);
    // Root (ctxId) should be first because it was inserted at context-creation time.
    expect(threads[0]?.thread_id).toBe(ctxId);
    expect(threads.map((t) => t.thread_id)).toContain(s1);
    expect(threads.map((t) => t.thread_id)).toContain(s2);
    expect(threads).toHaveLength(3);
  });

  it("ensureRootThread is idempotent", () => {
    const ctxId = ctxStore.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    // Call twice — should not throw or create duplicate.
    thrStore.ensureRootThread(ctxId, E1, "2025-01-01T00:00:00.000Z");
    thrStore.ensureRootThread(ctxId, E1, "2025-01-01T00:00:00.000Z");
    const threads = thrStore.listThreadsForContext(ctxId);
    const roots = threads.filter((t) => t.parent_thread_id === null);
    expect(roots).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// BusStore integration — side thread creation via submitEvent
// ---------------------------------------------------------------------------

const noop = () => {};

function makeStore(extraEndpoints: string[] = []): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-side-thread-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  for (const id of [E1, E2, E3, ...extraEndpoints]) {
    store.registerEndpoint(
      { endpoint_id: id, workspace_id: WS, name: id, bridge_id: null, status: "idle" },
      noop
    );
  }
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function cmd(
  overrides: Partial<EventCommand> & {
    source_endpoint_id: string;
    destination: EventCommand["destination"];
  }
): EventCommand {
  return {
    type: overrides.type ?? "message",
    workspace_id: overrides.workspace_id ?? WS,
    source_endpoint_id: overrides.source_endpoint_id,
    destination: overrides.destination,
    thread_id: overrides.thread_id ?? undefined,
    correlation_id: overrides.correlation_id ?? null,
    content: overrides.content ?? { text: "hello" },
    response: overrides.response,
    metadata: overrides.metadata ?? {},
    idempotency_key: overrides.idempotency_key ?? null,
    context_id: overrides.context_id,
    current_delivery_context_id: overrides.current_delivery_context_id,
  };
}

describe("BusStore — side thread creation (Rule 3 runtime)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  // ------- Test 2: cross-actor emit creates side thread -------
  it("emitting to a non-participant creates a side thread with parent = origin thread", () => {
    // E1 and E2 are in ctx_base. E3 is NOT a participant.
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    // The root thread should exist (backfilled at context creation by applyContextSchema).
    const rootThreadId = ctxId; // root thread_id === context_id

    // E1 (participant) emits to E3 (non-participant) while processing in ctx_base.
    const result = store.submitEvent(
      cmd({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        thread_id: rootThreadId,          // turn.thread_id = root thread
        current_delivery_context_id: ctxId,
      }),
      noop
    );

    const event = result.event;

    // Event must stay in the SAME context.
    expect(event.context_id).toBe(ctxId);

    // thread_id must be a NEW thread (not the root).
    expect(event.thread_id).not.toBe(rootThreadId);
    expect(event.thread_id).toMatch(/^thr_/);

    // That thread must exist in the threads table with parent = root.
    const sideThread = store.threadStore.getThread(event.thread_id);
    expect(sideThread).not.toBeNull();
    expect(sideThread?.context_id).toBe(ctxId);
    expect(sideThread?.parent_thread_id).toBe(rootThreadId);
    expect(sideThread?.created_by_endpoint_id).toBe(E1);
  });

  // ------- Test 3: reply from addressee defaults onto same side thread -------
  it("addressee reply carries the same side thread_id", () => {
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId;

    // E1 asks E3 → side thread created.
    const ask = store.submitEvent(
      cmd({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        thread_id: rootThreadId,
        current_delivery_context_id: ctxId,
      }),
      noop
    );
    const sideThreadId = ask.event.thread_id;
    expect(sideThreadId).not.toBe(rootThreadId); // sanity

    // E3 replies to E1 (participant of ctxId). E3's turn thread_id = sideThreadId.
    // D-B guard: E3 is NOT a participant of ctxId, so context_id is omitted
    // (null). The resolver uses current_delivery_context_id + destination
    // participant check (Rule 2: E1 IS participant → continue context).
    const reply = store.submitEvent(
      cmd({
        source_endpoint_id: E3,
        destination: { kind: "endpoint", endpoint_id: E1 },
        thread_id: sideThreadId,            // turn.thread_id = side thread
        context_id: null,                   // D-B guard: E3 is not a participant
        current_delivery_context_id: ctxId, // from the delivery
      }),
      noop
    );

    // Reply must be on the SAME side thread.
    expect(reply.event.thread_id).toBe(sideThreadId);
    // And in the same context.
    expect(reply.event.context_id).toBe(ctxId);
    // No new side thread created for the reply (Rule 2).
    const threads = store.threadStore.listThreadsForContext(ctxId);
    expect(threads).toHaveLength(2); // root + one side thread
  });

  // ------- Test 4: reply to context participant stays on main thread -------
  it("reply to a context participant does NOT create a side thread", () => {
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId;

    // E1 replies to E2 (both participants). No side thread.
    const result = store.submitEvent(
      cmd({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        thread_id: rootThreadId,
        current_delivery_context_id: ctxId,
      }),
      noop
    );

    // Event stays in same context on the main thread.
    expect(result.event.context_id).toBe(ctxId);
    expect(result.event.thread_id).toBe(rootThreadId);

    // Only the root thread exists — no side thread was created.
    const threads = store.threadStore.listThreadsForContext(ctxId);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.parent_thread_id).toBeNull();
  });
});
