/**
 * Thread substrate tests — peer context model.
 *
 * Invariants under test:
 *  1. applyThreadSchema backfills a root thread for every existing context.
 *  2. Every context created via submitEvent has a root thread (thread_id = context_id).
 *  3. A runtime emit to a non-participant creates a PEER CONTEXT (NOT a side thread).
 *     The peer context's root thread = peer context_id.
 *  4. A reply to a context participant stays in that context (Rule 2 — unchanged).
 *  5. main/side derivation: parent_thread_id IS NULL ⟹ main; IS NOT NULL ⟹ side.
 *  6. Closing a side thread (manually created) flips its status to 'closed'.
 *  7. Emitting with an explicitly-closed thread_id (not the resolved root) throws ClosedThreadError.
 *  8. Root/main threads cannot be closed (throws RootThreadCloseError).
 *
 * Side threads are NOT created by submitEvent routing. The ThreadStore.createThread API
 * still exists for future use (e.g. the threads REST endpoint for manual side threads).
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { applyContextSchema, ContextStore } from "./store.js";
import { applyThreadSchema, ThreadStore, RootThreadCloseError, ThreadNotFoundError, ClosedThreadError } from "./threads.js";
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
// BusStore integration — peer context model (Rule 3 runtime)
// ---------------------------------------------------------------------------

const noop = () => {};

function makeStore(extraEndpoints: string[] = []): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-peer-ctx-"));
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

describe("BusStore — peer context creation (Rule 3 runtime)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  // ------- Test 2: cross-actor emit creates peer context (not side thread) -------
  it("emitting to a non-participant creates a peer context linked to origin (not a side thread)", () => {
    // E1 and E2 are in ctx_base. E3 is NOT a participant.
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId; // root thread_id === context_id

    // E1 (participant) emits to E3 (non-participant) while processing in ctx_base.
    const result = store.submitEvent(
      cmd({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        thread_id: rootThreadId,          // turn.thread_id = origin root thread
        current_delivery_context_id: ctxId,
      }),
      noop
    );

    const event = result.event;

    // Event must land in a NEW peer context (NOT the origin context).
    expect(event.context_id).not.toBe(ctxId);
    expect(event.context_id).toMatch(/^ctx_/);

    // The peer context's root thread = peer context_id.
    expect(event.thread_id).toBe(event.context_id);

    // The peer context must be linked to the origin via parent_context_id.
    const peerCtx = store.contextStore.getContext(event.context_id!);
    expect(peerCtx?.parent_context_id).toBe(ctxId);

    // The peer context participants must be {E1, E3}.
    const peerParticipants = store.contextStore.getContextParticipants(event.context_id!);
    expect(peerParticipants.sort()).toEqual([E1, E3].sort());

    // NO side threads in the origin context — only its root thread exists.
    const originThreads = store.threadStore.listThreadsForContext(ctxId);
    expect(originThreads).toHaveLength(1);
    expect(originThreads[0]?.parent_thread_id).toBeNull();
  });

  // ------- Test 3: addressee reply stays in the peer context (Rule 2) -------
  it("addressee reply carries stays in the peer context — both participants of peer", () => {
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId;

    // E1 asks E3 → peer context created.
    const ask = store.submitEvent(
      cmd({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        thread_id: rootThreadId,
        current_delivery_context_id: ctxId,
      }),
      noop
    );
    const peerCtxId = ask.event.context_id!;
    expect(peerCtxId).not.toBe(ctxId);

    // E3 replies to E1. Both are participants of the peer context → Rule 2: stay in peer.
    const reply = store.submitEvent(
      cmd({
        source_endpoint_id: E3,
        destination: { kind: "endpoint", endpoint_id: E1 },
        thread_id: peerCtxId,            // turn.thread_id = peer root thread
        current_delivery_context_id: peerCtxId, // acting in the peer context
      }),
      noop
    );

    // Reply must be in the SAME peer context.
    expect(reply.event.context_id).toBe(peerCtxId);
    // And on the peer context's root thread.
    expect(reply.event.thread_id).toBe(peerCtxId);
    // No new context created.
    const originCtxs = store.contextStore.listContextsForWorkspace(WS, {});
    expect(originCtxs).toHaveLength(2); // origin + peer
  });

  // ------- Test 4: reply to context participant stays in origin context (Rule 2) -------
  it("reply to a context participant does NOT create a side thread or peer context", () => {
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId;

    // E1 replies to E2 (both participants). No side thread, no new context.
    const result = store.submitEvent(
      cmd({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        thread_id: rootThreadId,
        current_delivery_context_id: ctxId,
      }),
      noop
    );

    // Event stays in same context on the root thread.
    expect(result.event.context_id).toBe(ctxId);
    expect(result.event.thread_id).toBe(rootThreadId);

    // Only the origin context exists — no peer context created.
    const originCtxs = store.contextStore.listContextsForWorkspace(WS, {});
    expect(originCtxs).toHaveLength(1);
    // Only the root thread in origin — no side thread.
    const threads = store.threadStore.listThreadsForContext(ctxId);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.parent_thread_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ThreadStore — close lifecycle
// ---------------------------------------------------------------------------

describe("ThreadStore — close lifecycle", () => {
  let db: DatabaseSync;
  let ctxStore: ContextStore;
  let thrStore: ThreadStore;

  beforeEach(() => {
    const freshDb2 = new DatabaseSync(":memory:");
    freshDb2.exec("PRAGMA foreign_keys = ON");
    freshDb2.exec(`
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
    applyContextSchema(freshDb2);
    db = freshDb2;
    ctxStore = new ContextStore(db);
    thrStore = new ThreadStore(db);
  });

  afterEach(() => { try { db.close(); } catch {} });

  // ------- Test 6: close a side thread -------
  it("closeThread flips status to 'closed' for a side thread", () => {
    const ctxId = ctxStore.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const sideId = thrStore.createThread({
      context_id: ctxId,
      parent_thread_id: ctxId,
      created_by_endpoint_id: E1,
    });

    const before = thrStore.getThread(sideId)!;
    expect(before.status).toBe("open");

    const closed = thrStore.closeThread(sideId);
    expect(closed.status).toBe("closed");
    expect(closed.thread_id).toBe(sideId);

    const after = thrStore.getThread(sideId)!;
    expect(after.status).toBe("closed");
  });

  it("closeThread is idempotent — closing an already-closed thread is a no-op", () => {
    const ctxId = ctxStore.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    const sideId = thrStore.createThread({
      context_id: ctxId,
      parent_thread_id: ctxId,
      created_by_endpoint_id: E1,
    });
    thrStore.closeThread(sideId);
    // Second close should not throw.
    const closed2 = thrStore.closeThread(sideId);
    expect(closed2.status).toBe("closed");
  });

  // ------- Test 8: root thread cannot be closed -------
  it("closeThread throws RootThreadCloseError for a root/main thread", () => {
    const ctxId = ctxStore.createContext({ workspace_id: WS, created_by_endpoint_id: E1, participants: [E1] });
    // Root thread id === context id.
    expect(() => thrStore.closeThread(ctxId)).toThrow(RootThreadCloseError);
  });

  it("closeThread throws ThreadNotFoundError for an unknown thread", () => {
    expect(() => thrStore.closeThread("thr_nonexistent")).toThrow(ThreadNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// BusStore — closed thread rejects events (guard still works for explicit thread_id)
// ---------------------------------------------------------------------------

describe("BusStore — closed thread rejects new events (Test 7)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  it("emitting onto a closed side thread throws ClosedThreadError", () => {
    // Create a context, manually create a side thread, close it, then attempt to emit onto it.
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId;

    // Manually create a side thread (this can happen via the REST API or future features).
    const sideThreadId = store.threadStore.createThread({
      context_id: ctxId,
      parent_thread_id: rootThreadId,
      created_by_endpoint_id: E1,
    });

    // Close the side thread.
    store.threadStore.closeThread(sideThreadId);

    // Attempting to emit with the closed side thread_id must throw ClosedThreadError.
    // The guard fires because command.thread_id (sideThreadId) ≠ resolvedContextId.
    expect(() =>
      store.submitEvent(
        cmd({
          source_endpoint_id: E1,
          destination: { kind: "endpoint", endpoint_id: E2 },
          thread_id: sideThreadId,  // explicitly passing a closed thread_id
          context_id: ctxId,        // Rule 1: stay in ctxId
          current_delivery_context_id: ctxId,
        }),
        noop
      )
    ).toThrow(ClosedThreadError);
  });

  it("emitting on the main thread is unaffected by a closed side thread", () => {
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId;

    // Create and close a side thread.
    const sideId = store.threadStore.createThread({
      context_id: ctxId,
      parent_thread_id: rootThreadId,
      created_by_endpoint_id: E1,
    });
    store.threadStore.closeThread(sideId);

    // E1 can still emit on the main thread — thread_id=rootThreadId = resolvedContextId.
    const result = store.submitEvent(
      cmd({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        thread_id: rootThreadId,
        current_delivery_context_id: ctxId,
      }),
      noop
    );
    expect(result.event.context_id).toBe(ctxId);
    expect(result.event.thread_id).toBe(rootThreadId);
  });

  it("BusStore.closeThread broadcasts thread_closed", () => {
    const ctxId = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: E1,
      participants: [E1, E2],
    });
    const rootThreadId = ctxId;

    // Manually create a side thread to close.
    const sideThreadId = store.threadStore.createThread({
      context_id: ctxId,
      parent_thread_id: rootThreadId,
      created_by_endpoint_id: E1,
    });

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    const captureBroadcast = (type: string, payload: unknown) =>
      broadcasts.push({ type, payload });

    store.closeThread(sideThreadId, captureBroadcast);

    const threadClosedEvents = broadcasts.filter(b => b.type === "thread_closed");
    expect(threadClosedEvents).toHaveLength(1);
    expect((threadClosedEvents[0]!.payload as any).thread_id).toBe(sideThreadId);
    expect((threadClosedEvents[0]!.payload as any).context_id).toBe(ctxId);
    expect((threadClosedEvents[0]!.payload as any).parent_thread_id).toBe(rootThreadId);
  });
});
