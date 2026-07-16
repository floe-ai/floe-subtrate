/**
 * Peer context relay model — end-to-end integration tests.
 *
 * Tests the complete peer context lifecycle:
 * - Cross-actor emit creates a peer context (not a side thread)
 * - D1 reuse: repeat cross-actor emits reuse the existing peer context
 * - Peer context is linked to origin via parent_context_id
 * - Reply within a peer context stays in the peer context (Rule 2)
 * - Relay: actor in peer context emits back to origin via explicit context_id (Rule 1)
 * - No side threads are created anywhere
 * - Originating context flow is unchanged (single-context exchanges)
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "../store.js";
import { defaultConfig } from "../config.js";

const noop = () => {};

const WS = "workspace:peer-relay-test";
const OPERATOR = "actor:peer:operator";
const SNOWBALL = "actor:peer:snowball";
const FLOE = "actor:peer:floe";

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-peer-relay-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  for (const id of [OPERATOR, SNOWBALL, FLOE]) {
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
    }
  };
}

function emit(
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
    correlation_id: null,
    content: overrides.content ?? { text: "hello" },
    metadata: overrides.metadata ?? {},
    idempotency_key: null,
    context_id: overrides.context_id,
    current_delivery_context_id: overrides.current_delivery_context_id,
  };
}

describe("Peer context relay — end-to-end (no live LLM)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  it("cross-actor emit creates a peer context linked to origin — NOT a side thread", () => {
    // Operator → snowball exchange in origin context C.
    const r1 = store.submitEvent(
      emit({ source_endpoint_id: OPERATOR, destination: { kind: "endpoint", endpoint_id: SNOWBALL } }),
      noop
    );
    const originCtxId = r1.event.context_id!;
    expect(originCtxId).toMatch(/^ctx_/);

    // Snowball (in C) asks floe (not in C) → peer context C' created.
    const r2 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: FLOE },
        current_delivery_context_id: originCtxId
      }),
      noop
    );

    // Must land in a NEW peer context, not the origin.
    const peerCtxId = r2.event.context_id!;
    expect(peerCtxId).not.toBe(originCtxId);
    expect(peerCtxId).toMatch(/^ctx_/);

    // Peer context root thread = peer context_id (no side thread).
    expect(r2.event.thread_id).toBe(peerCtxId);

    // Peer context is linked to origin.
    const peerCtx = store.contextStore.getContext(peerCtxId);
    expect(peerCtx?.parent_context_id).toBe(originCtxId);

    // Peer context participants are exactly {snowball, floe}.
    const peerParticipants = store.contextStore.getContextParticipants(peerCtxId).sort();
    expect(peerParticipants).toEqual([SNOWBALL, FLOE].sort());

    // Origin context participants are unchanged.
    const originParticipants = store.contextStore.getContextParticipants(originCtxId).sort();
    expect(originParticipants).toEqual([OPERATOR, SNOWBALL].sort());

    // No side threads anywhere — only root threads exist.
    const allThreads = store.db.prepare("SELECT * FROM threads").all() as any[];
    expect(allThreads.every(t => t.parent_thread_id === null)).toBe(true);
  });

  it("D1 reuse — repeat snowball→floe emit reuses the existing peer context", () => {
    const r1 = store.submitEvent(
      emit({ source_endpoint_id: OPERATOR, destination: { kind: "endpoint", endpoint_id: SNOWBALL } }),
      noop
    );
    const originCtxId = r1.event.context_id!;

    // First snowball→floe: creates peer context C'.
    const r2 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: FLOE },
        current_delivery_context_id: originCtxId
      }),
      noop
    );
    const peerCtxId = r2.event.context_id!;
    expect(peerCtxId).not.toBe(originCtxId);

    // Second snowball→floe: MUST reuse C', not create a new context.
    const r3 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: FLOE },
        current_delivery_context_id: originCtxId
      }),
      noop
    );
    expect(r3.event.context_id).toBe(peerCtxId);

    // Still exactly 2 contexts in total (origin + peer).
    const allContexts = store.contextStore.listContextsForWorkspace(WS, {});
    expect(allContexts).toHaveLength(2);
  });

  it("floe replies to snowball in the peer context (Rule 2 — both participants)", () => {
    const r1 = store.submitEvent(
      emit({ source_endpoint_id: OPERATOR, destination: { kind: "endpoint", endpoint_id: SNOWBALL } }),
      noop
    );
    const originCtxId = r1.event.context_id!;

    // Snowball asks floe → peer context.
    const r2 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: FLOE },
        current_delivery_context_id: originCtxId
      }),
      noop
    );
    const peerCtxId = r2.event.context_id!;

    // Floe replies to snowball (both in peer context → Rule 2: stay in peer).
    const r3 = store.submitEvent(
      emit({
        source_endpoint_id: FLOE,
        destination: { kind: "endpoint", endpoint_id: SNOWBALL },
        current_delivery_context_id: peerCtxId
      }),
      noop
    );

    // Must stay in peer context.
    expect(r3.event.context_id).toBe(peerCtxId);
    expect(r3.event.thread_id).toBe(peerCtxId);

    // No new context created.
    const allContexts = store.contextStore.listContextsForWorkspace(WS, {});
    expect(allContexts).toHaveLength(2); // origin + peer only
  });

  it("relay — snowball acting in peer context emits result back to operator in origin (Rule 1)", () => {
    const r1 = store.submitEvent(
      emit({ source_endpoint_id: OPERATOR, destination: { kind: "endpoint", endpoint_id: SNOWBALL } }),
      noop
    );
    const originCtxId = r1.event.context_id!;

    // Snowball asks floe → peer context.
    const r2 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: FLOE },
        current_delivery_context_id: originCtxId
      }),
      noop
    );
    const peerCtxId = r2.event.context_id!;

    // Floe answers in peer context.
    store.submitEvent(
      emit({
        source_endpoint_id: FLOE,
        destination: { kind: "endpoint", endpoint_id: SNOWBALL },
        current_delivery_context_id: peerCtxId
      }),
      noop
    );

    // Snowball relays floe's answer back to operator in origin context.
    // Snowball is a participant of BOTH peer context AND origin context.
    // Explicit context_id=origin (Rule 1: snowball ∈ origin → valid).
    const r5 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: OPERATOR },
        context_id: originCtxId,             // explicit relay target
        current_delivery_context_id: peerCtxId  // currently acting in peer
      }),
      noop
    );

    // Must land in origin context.
    expect(r5.event.context_id).toBe(originCtxId);
    expect(r5.event.thread_id).toBe(originCtxId);

    // Exactly 2 contexts throughout.
    const allContexts = store.contextStore.listContextsForWorkspace(WS, {});
    expect(allContexts).toHaveLength(2);
  });

  it("plain operator↔snowball exchange in origin context — no peer context created", () => {
    // Establish origin context.
    const r1 = store.submitEvent(
      emit({ source_endpoint_id: OPERATOR, destination: { kind: "endpoint", endpoint_id: SNOWBALL } }),
      noop
    );
    const originCtxId = r1.event.context_id!;

    // Snowball replies to operator (both participants).
    const r2 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: OPERATOR },
        current_delivery_context_id: originCtxId
      }),
      noop
    );

    // Must stay in origin context — no peer context.
    expect(r2.event.context_id).toBe(originCtxId);
    expect(r2.event.thread_id).toBe(originCtxId);

    // Exactly 1 context.
    const allContexts = store.contextStore.listContextsForWorkspace(WS, {});
    expect(allContexts).toHaveLength(1);

    // No side threads — only root thread.
    const allThreads = store.db.prepare("SELECT * FROM threads").all() as any[];
    expect(allThreads).toHaveLength(1);
    expect(allThreads[0].parent_thread_id).toBeNull();
  });

  it("peer context has its own root thread (thread_id = peer context_id)", () => {
    const r1 = store.submitEvent(
      emit({ source_endpoint_id: OPERATOR, destination: { kind: "endpoint", endpoint_id: SNOWBALL } }),
      noop
    );
    const originCtxId = r1.event.context_id!;

    const r2 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: FLOE },
        current_delivery_context_id: originCtxId
      }),
      noop
    );
    const peerCtxId = r2.event.context_id!;

    // Peer context has its own root thread.
    const peerRootThread = store.threadStore.getThread(peerCtxId);
    expect(peerRootThread).not.toBeNull();
    expect(peerRootThread?.thread_id).toBe(peerCtxId);
    expect(peerRootThread?.context_id).toBe(peerCtxId);
    expect(peerRootThread?.parent_thread_id).toBeNull();
    expect(peerRootThread?.status).toBe("open");

    // Origin context also has its root thread.
    const originRootThread = store.threadStore.getThread(originCtxId);
    expect(originRootThread?.thread_id).toBe(originCtxId);
    expect(originRootThread?.parent_thread_id).toBeNull();
  });

  it("NO side threads created — all threads are root threads throughout the relay flow", () => {
    const r1 = store.submitEvent(
      emit({ source_endpoint_id: OPERATOR, destination: { kind: "endpoint", endpoint_id: SNOWBALL } }),
      noop
    );
    const originCtxId = r1.event.context_id!;

    // Full relay flow.
    const r2 = store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: FLOE },
        current_delivery_context_id: originCtxId
      }),
      noop
    );
    const peerCtxId = r2.event.context_id!;

    store.submitEvent(
      emit({
        source_endpoint_id: FLOE,
        destination: { kind: "endpoint", endpoint_id: SNOWBALL },
        current_delivery_context_id: peerCtxId
      }),
      noop
    );

    store.submitEvent(
      emit({
        source_endpoint_id: SNOWBALL,
        destination: { kind: "endpoint", endpoint_id: OPERATOR },
        context_id: originCtxId,
        current_delivery_context_id: peerCtxId
      }),
      noop
    );

    // Check: NO side threads (parent_thread_id IS NOT NULL).
    const allThreads = store.db.prepare("SELECT * FROM threads").all() as any[];
    const sideThreads = allThreads.filter((t: any) => t.parent_thread_id !== null);
    expect(sideThreads).toHaveLength(0);

    // Exactly 2 root threads (one per context).
    expect(allThreads).toHaveLength(2);
  });
});
