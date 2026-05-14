import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "../store.js";
import { defaultConfig } from "../config.js";

const noop = () => {};

const WS = "workspace:test-int";
const E1 = "endpoint:test:agent:e1";
const E2 = "endpoint:test:agent:e2";
const E3 = "endpoint:test:agent:e3";

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

  it("T4: emit where destination ∉ current delivery context → opens new context with {source, destination}", () => {
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
    expect(r2.event.context_id).not.toBe(ctxA);
    const parts = store.contextStore.getContextParticipants(r2.event.context_id!).sort();
    expect(parts).toEqual([E1, E3].sort());
    // T11: original A's participants unchanged
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

  it("T10: no add/remove participant API exists; participants frozen across emit cycle", () => {
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
    expect((store as any).addParticipant).toBeUndefined();
    expect((store as any).removeParticipant).toBeUndefined();
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
});
