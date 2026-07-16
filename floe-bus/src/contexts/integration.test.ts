import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "../store.js";
import { defaultConfig } from "../config.js";

const noop = () => {};

const WS = "workspace:test-int";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";
const E3 = "actor:test:e3";

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-ctx-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  // Register endpoints so destination resolution / delivery works
  for (const id of [E1, E2, E3]) {
    store.registerEndpoint({
      endpoint_id: id,
      workspace_id: WS,
      name: id,
      bridge_id: null,
      status: "idle"
    }, noop);
  }
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function makeStoreWithLegacyEventScopeSchema(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-ctx-legacy-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const dataDir = join(tmp, "bus");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "floe-bus.sqlite"));
  db.exec(`
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      source_endpoint_id TEXT,
      thread_id TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      correlation_id TEXT,
      content_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
  `);
  db.close();
  const store = new BusStore(cfgPath, cfg);
  for (const id of [E1, E2, E3]) {
    store.registerEndpoint({
      endpoint_id: id,
      workspace_id: WS,
      name: id,
      bridge_id: null,
      status: "idle"
    }, noop);
  }
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function emitCommand(overrides: Partial<EventCommand> & { source_endpoint_id: string; destination: EventCommand["destination"] }): EventCommand {
  return {
    type: overrides.type ?? "message",
    workspace_id: overrides.workspace_id ?? WS,
    source_endpoint_id: overrides.source_endpoint_id,
    destination: overrides.destination,
    thread_id: overrides.thread_id ?? "",
    correlation_id: overrides.correlation_id ?? null,
    content: overrides.content ?? { text: "hi" },
    response: overrides.response,
    metadata: overrides.metadata ?? {},
    idempotency_key: overrides.idempotency_key ?? null,
    context_id: overrides.context_id,
    current_delivery_context_id: overrides.current_delivery_context_id
  };
}

describe("submitEvent context wiring", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  it("T2: emit without context_id and no current delivery context opens a new context with {source, destination}", () => {
    const result = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    expect(result.event.context_id).toMatch(/^ctx_/);
    const parts = store.contextStore.getContextParticipants(result.event.context_id!).sort();
    expect(parts).toEqual([E1, E2].sort());
  });

  it("actor emit without scope creates a Workspace-level unscoped Context and Event", () => {
    const result = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );

    const context = store.contextStore.getContext(result.event.context_id!);
    const [event] = store.listEvents({ workspace_id: WS, context_id: result.event.context_id! });

    expect(context?.scope_id).toBeNull();
    expect(result.event.scope_id).toBeNull();
    expect(event.scope_id).toBeNull();
  });

  it("upgrades legacy Event scope columns before persisting unscoped actor Events", () => {
    cleanup();
    const made = makeStoreWithLegacyEventScopeSchema();
    store = made.store;
    cleanup = made.cleanup;

    const result = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );

    expect(result.event.scope_id).toBeNull();
    expect(store.listEvents({ workspace_id: WS })[0].scope_id).toBeNull();
  });

  it("T3: emit where destination ∈ current delivery context's participants → continues current context", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E2,
        destination: { kind: "endpoint", endpoint_id: E1 },
        current_delivery_context_id: ctxA
      }),
      noop
    );
    expect(r2.event.context_id).toBe(ctxA);
  });

  it("T4: emit where destination ∉ current delivery context → creates peer context linked to origin (Rule 3)", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA
      }),
      noop
    );
    // Must land in a NEW peer context (not ctxA — peer context model, not side thread).
    expect(r2.event.context_id).not.toBe(ctxA);
    expect(r2.event.context_id).toMatch(/^ctx_/);
    // Peer context root thread = peer context_id.
    expect(r2.event.thread_id).toBe(r2.event.context_id);
    // The peer context must be linked to ctxA via parent_context_id.
    const peerCtx = store.contextStore.getContext(r2.event.context_id!);
    expect(peerCtx?.parent_context_id).toBe(ctxA);
    // T11: ctxA's participants unchanged — E3 is NOT added to ctxA, only to the peer.
    expect(store.contextStore.getContextParticipants(ctxA).sort()).toEqual([E1, E2].sort());
  });

  it("T5/T13: emit with context_id where source ∉ A's participants → rejected with E_NOT_CONTEXT_PARTICIPANT, no event persisted", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E2, destination: { kind: "endpoint", endpoint_id: E3 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const eventCountBefore = store.listEvents({ workspace_id: WS }).length;
    expect(() => store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA
      }),
      noop
    )).toThrow(/E_NOT_CONTEXT_PARTICIPANT/);
    const eventCountAfter = store.listEvents({ workspace_id: WS }).length;
    expect(eventCountAfter).toBe(eventCountBefore);
  });

  it("T13: rejection error carries bounded available_contexts payload", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E2, destination: { kind: "endpoint", endpoint_id: E3 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    // Give E1 some contexts
    store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    try {
      store.submitEvent(
        emitCommand({
          source_endpoint_id: E1,
          destination: { kind: "endpoint", endpoint_id: E2 },
          context_id: ctxA
        }),
        noop
      );
      throw new Error("should have thrown");
    } catch (err: any) {
      expect(err.code).toBe("E_NOT_CONTEXT_PARTICIPANT");
      expect(err.payload.context_id).toBe(ctxA);
      expect(err.payload.source_endpoint_id).toBe(E1);
      expect(Array.isArray(err.payload.available_contexts)).toBe(true);
      expect(err.payload.available_contexts.length).toBeGreaterThan(0);
      expect(err.payload.available_contexts.length).toBeLessThanOrEqual(10);
      expect(Array.isArray(err.payload.recovery)).toBe(true);
    }
  });

  it("T7: events filtered by context_id return only events for that context", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const r2 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E3 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const ctxB = r2.event.context_id!;
    expect(ctxA).not.toBe(ctxB);
    const aEvents = store.listEvents({ workspace_id: WS, context_id: ctxA });
    const bEvents = store.listEvents({ workspace_id: WS, context_id: ctxB });
    expect(aEvents.every((e) => e.context_id === ctxA)).toBe(true);
    expect(bEvents.every((e) => e.context_id === ctxB)).toBe(true);
    expect(aEvents.map((e) => e.event_id)).toContain(r1.event.event_id);
    expect(bEvents.map((e) => e.event_id)).toContain(r2.event.event_id);
  });

  it("T10: participants are stable across the emit cycle (implicit routing does not mutate membership)", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const before = store.contextStore.getContextParticipants(ctxA).sort();
    // E1 → E2 reply continuing
    store.submitEvent(
      emitCommand({
        source_endpoint_id: E2,
        destination: { kind: "endpoint", endpoint_id: E1 },
        context_id: ctxA
      }),
      noop
    );
    // E1 → E3 (opens new context — should NOT mutate A)
    store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA
      }),
      noop
    );
    const after = store.contextStore.getContextParticipants(ctxA).sort();
    expect(after).toEqual(before);
    // Dynamic participant API now exists on contextStore (Slice 1)
    expect(typeof store.contextStore.addParticipant).toBe("function");
    expect(typeof store.contextStore.removeParticipant).toBe("function");
  });

  it("T12: emit with context_id where source ∈ A → succeeds", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA
      }),
      noop
    );
    expect(r2.event.context_id).toBe(ctxA);
  });

  it("T14: self-emit (source == destination) into a context source participates in succeeds", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E1 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E1 },
        context_id: ctxA
      }),
      noop
    );
    expect(r2.event.context_id).toBe(ctxA);
    expect(store.contextStore.getContextParticipants(ctxA)).toEqual([E1]);
  });

  it("T18: UI-originated emit with context_id null and no delivery context → opens new context, ignores any 'previous selection'", () => {
    // Even with prior emits, an emit without context_id and without current_delivery_context_id opens fresh.
    store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: null,
        current_delivery_context_id: null
      }),
      noop
    );
    expect(r2.event.context_id).toMatch(/^ctx_/);
    // Two distinct contexts now exist for E1↔E2
    const all = store.contextStore.listContextsForParticipant(E1);
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  it("T19: UI-originated emit with explicit context_id continues that context", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA,
        current_delivery_context_id: null
      }),
      noop
    );
    expect(r2.event.context_id).toBe(ctxA);
  });

  it("Persisted event row carries context_id column", () => {
    const r = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const row = store.db.prepare("SELECT context_id FROM events WHERE event_id = ?").get(r.event.event_id) as any;
    expect(row.context_id).toBe(r.event.context_id);
  });

  it("Rejected emit creates no delivery rows", () => {
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E2, destination: { kind: "endpoint", endpoint_id: E3 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    const queueBefore = store.db.prepare("SELECT COUNT(*) AS c FROM event_queue").get() as any;
    expect(() => store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA
      }),
      noop
    )).toThrow();
    const queueAfter = store.db.prepare("SELECT COUNT(*) AS c FROM event_queue").get() as any;
    expect(queueAfter.c).toBe(queueBefore.c);
  });

  // --- Peer context routing tests (replaces side-thread tests) ---

  it("T-CR1: participant emitting to non-participant creates a peer context linked to origin (Rule 3)", () => {
    // Step 1: create context with E1+E2 as participants.
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    // Step 2: E1 emits to E3 (non-participant) → Rule 3 creates peer context C' linked to ctxA.
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA,
        thread_id: ctxA  // origin delivery thread
      }),
      noop
    );
    // Event must land in a NEW peer context (not ctxA).
    expect(r2.event.context_id).not.toBe(ctxA);
    expect(r2.event.context_id).toMatch(/^ctx_/);
    // The peer context's root thread = peer context_id.
    expect(r2.event.thread_id).toBe(r2.event.context_id);
    // The peer context must be linked to ctxA via parent_context_id.
    const peerCtx = store.contextStore.getContext(r2.event.context_id!);
    expect(peerCtx?.parent_context_id).toBe(ctxA);
    // The peer context participants must be {E1, E3}.
    const peerParticipants = store.contextStore.getContextParticipants(r2.event.context_id!);
    expect(peerParticipants.sort()).toEqual([E1, E3].sort());
  });

  it("T-CR2: D1 reuse — repeat cross-actor emit reuses the existing peer context", () => {
    // Step 1: create origin context {E1, E2}.
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    // Step 2: E1 emits to E3 → creates peer context C' = {E1, E3} linked to ctxA.
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA,
        thread_id: ctxA
      }),
      noop
    );
    const peerCtxId = r2.event.context_id!;
    expect(peerCtxId).not.toBe(ctxA);

    // Step 3: E1 emits to E3 again (repeat) → MUST reuse C', not create a new context.
    const r3 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA,
        thread_id: ctxA
      }),
      noop
    );
    expect(r3.event.context_id).toBe(peerCtxId);
  });

  it("T-CR3: both-participant exchange stays in origin context (Rule 2 — unchanged)", () => {
    // E1 and E2 are both in ctxA. E1 replies to E2 while handling a delivery from ctxA.
    // Must stay in ctxA — no peer context created.
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;

    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E2,
        destination: { kind: "endpoint", endpoint_id: E1 },
        current_delivery_context_id: ctxA,
        thread_id: ctxA
      }),
      noop
    );
    // Must stay in ctxA (Rule 2).
    expect(r2.event.context_id).toBe(ctxA);
    expect(r2.event.thread_id).toBe(ctxA);
    // No new context was created.
    const allContexts = store.contextStore.listContextsForWorkspace(WS, {});
    expect(allContexts).toHaveLength(1);
  });

  it("T-CR4: relay — actor acting in peer context C' emits back to origin via explicit context_id", () => {
    // Step 1: {E1, E2} origin context.
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    // Step 2: E1 emits to E3 → peer context C' created.
    const r2 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA
      }),
      noop
    );
    const peerCtxId = r2.event.context_id!;
    expect(peerCtxId).not.toBe(ctxA);
    // Step 3: E3 replies to E1 in C' (both participants of C' — Rule 2).
    const r3 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E3,
        destination: { kind: "endpoint", endpoint_id: E1 },
        current_delivery_context_id: peerCtxId
      }),
      noop
    );
    expect(r3.event.context_id).toBe(peerCtxId);
    // Step 4: E1 (participant of both ctxA and peerCtx) acts in C' and relays back to E2 in ctxA.
    // Explicit context_id=ctxA (Rule 1) — E1 ∈ ctxA → relay lands in ctxA.
    const r4 = store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E2 },
        context_id: ctxA,               // explicit relay target
        current_delivery_context_id: peerCtxId  // currently acting in peer
      }),
      noop
    );
    expect(r4.event.context_id).toBe(ctxA);
    expect(r4.event.thread_id).toBe(ctxA);  // root thread of ctxA
  });

  it("T-CR5: NO side threads — Rule 3 never creates a thread with thr_ prefix", () => {
    // Sanity check: ensure the threads table only has root threads after cross-actor emits.
    const r1 = store.submitEvent(
      emitCommand({ source_endpoint_id: E1, destination: { kind: "endpoint", endpoint_id: E2 } }),
      noop
    );
    const ctxA = r1.event.context_id!;
    // Multiple cross-actor emits.
    store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA
      }),
      noop
    );
    store.submitEvent(
      emitCommand({
        source_endpoint_id: E1,
        destination: { kind: "endpoint", endpoint_id: E3 },
        current_delivery_context_id: ctxA
      }),
      noop
    );
    // All threads in the DB must be root threads (thread_id = context_id, parent = NULL).
    const allThreads = store.db.prepare("SELECT * FROM threads").all() as any[];
    const sideThreads = allThreads.filter((t) => t.parent_thread_id !== null);
    expect(sideThreads).toHaveLength(0);
  });
});

