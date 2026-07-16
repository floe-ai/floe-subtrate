import { describe, expect, it } from "vitest";
import { resolveContext } from "./resolver.js";
import type { ContextStoreReader } from "./store.js";
import type { DestinationSelector } from "../store.js";

const WS = "workspace:test";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";
const E3 = "actor:test:e3";

function endpointDest(id: string): DestinationSelector {
  return { kind: "endpoint", endpoint_id: id };
}

function makeReader(contexts: Record<string, { participants: string[]; topic?: string | null }>): ContextStoreReader {
  return {
    getContext(id) {
      if (!contexts[id]) return null;
      return {
        context_id: id,
        workspace_id: WS,
        scope_id: null,
        parent_context_id: null,
        created_by_endpoint_id: contexts[id].participants[0],
        created_at: "2026-01-01T00:00:00.000Z",
        title: null
      };
    },
    getContextParticipants(id) {
      return contexts[id]?.participants ?? [];
    },
    isParticipant(id, endpointId) {
      return (contexts[id]?.participants ?? []).includes(endpointId);
    },
    listContextsForParticipant(endpointId) {
      return Object.entries(contexts)
        .filter(([, v]) => v.participants.includes(endpointId))
        .map(([id, v]) => ({
          context_id: id,
          workspace_id: WS,
          scope_id: null,
          parent_context_id: null,
          created_by_endpoint_id: v.participants[0],
          created_at: "2026-01-01T00:00:00.000Z",
          last_event_at: null,
          topic: v.topic ?? null,
          title: null,
          participants: v.participants.slice()
        }));
    }
  };
}

describe("resolveContext rule matrix", () => {
  it("UI-originated, no supplied context, no delivery context → opens new with {source, destination}", () => {
    const reader = makeReader({});
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: null,
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    expect(result).toEqual({ context_id: expect.any(String), created: true, participants: [E1, E2] });
  });

  it("Runtime, no supplied id, destination ∈ current ctx → continues current on ROOT thread", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    // Both source (E1) and destination (E2) are participants → force root thread.
    expect(result).toEqual({ context_id: "ctx_a", created: false, force_root_thread: true });
  });

  it("Runtime, no supplied id, destination ∉ current ctx → creates side thread in same context (Rule 3)", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "thr_root",
        workspace_id: WS
      },
      reader
    );
    // Must stay in the SAME context (not open a new one).
    expect("context_id" in result && result.context_id).toBe("ctx_a");
    if ("context_id" in result) {
      expect(result.created).toBe(false);
      expect(result.side_thread).toMatchObject({ parent_thread_id: "thr_root" });
    }
  });

  it("Runtime, Rule 3 — falls back to context_id as parent_thread_id when no delivery thread given", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: null,
        workspace_id: WS
      },
      reader
    );
    if ("context_id" in result) {
      expect(result.side_thread).toMatchObject({ parent_thread_id: "ctx_a" });
    }
  });

  it("Supplied context + source is participant + dest is participant → succeeds with force_root_thread (rule 1 positive)", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    // Both source and destination are participants → force root thread.
    expect(result).toEqual({ context_id: "ctx_a", created: false, force_root_thread: true });
  });

  it("Supplied context + source is NOT participant → E_NOT_CONTEXT_PARTICIPANT (rule 1 negative)", () => {
    const reader = makeReader({
      ctx_a: { participants: [E2, E3], topic: null },
      ctx_other: { participants: [E1, E2], topic: null }
    });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    expect("error" in result && result.error).toBe("E_NOT_CONTEXT_PARTICIPANT");
    if ("error" in result) {
      expect(result.payload.code).toBe("E_NOT_CONTEXT_PARTICIPANT");
      expect(result.payload.context_id).toBe("ctx_a");
      expect(result.payload.source_endpoint_id).toBe(E1);
      expect(result.payload.available_contexts).toHaveLength(1);
      expect(result.payload.available_contexts[0].context_id).toBe("ctx_other");
      expect(result.payload.recovery).toBeInstanceOf(Array);
      expect(result.payload.recovery.length).toBeGreaterThan(0);
    }
  });

  it("Supplied context that does not exist → rejection (rule 1 negative)", () => {
    const reader = makeReader({});
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: "ctx_missing",
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    expect("error" in result && result.error).toBe("E_NOT_CONTEXT_PARTICIPANT");
  });

  it("available_contexts is bounded (cap at 10)", () => {
    const map: Record<string, { participants: string[] }> = {
      ctx_target: { participants: [E2, E3] }
    };
    for (let i = 0; i < 25; i++) map[`ctx_avail_${i}`] = { participants: [E1, E2] };
    const reader = makeReader(map);
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: "ctx_target",
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    expect("error" in result && result.error).toBe("E_NOT_CONTEXT_PARTICIPANT");
    if ("error" in result) {
      expect(result.payload.available_contexts.length).toBeLessThanOrEqual(10);
    }
  });

  it("Self-emit (source==destination) into existing context where source is participant → succeeds", () => {
    const reader = makeReader({ ctx_a: { participants: [E1] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E1),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("Self-emit (source==destination) with no supplied/no current → opens new with [source]", () => {
    const reader = makeReader({});
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E1),
        supplied_context_id: null,
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    expect(result).toMatchObject({ created: true, participants: [E1] });
  });

  it("UI-originated emit with explicit context_id continues that context with force_root_thread (T19)", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: null,
        workspace_id: WS
      },
      reader
    );
    // Both participants → force root thread.
    expect(result).toEqual({ context_id: "ctx_a", created: false, force_root_thread: true });
  });

  it("Rule 1 hardening: supplied context + source participant + destination NOT participant → side thread", () => {
    // E1 and E2 are in ctx_a; E3 is NOT. When E1 emits to E3 with supplied context_id
    // (e.g. because D-B stamped it), the resolver must open a side thread instead of
    // landing E3 on the main thread.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "thr_main",
        workspace_id: WS
      },
      reader
    );
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      // Must stay in the SAME context, not open a new one.
      expect(result.context_id).toBe("ctx_a");
      expect(result.created).toBe(false);
      // Must signal a side thread rooted at the delivery thread.
      expect(result.side_thread).toMatchObject({ parent_thread_id: "thr_main" });
    }
  });

  it("Rule 1 hardening: supplied context + source participant + destination NOT participant — falls back to context_id as parent when no delivery thread", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: null,
        workspace_id: WS
      },
      reader
    );
    if ("context_id" in result) {
      expect(result.side_thread).toMatchObject({ parent_thread_id: "ctx_a" });
    }
  });

  it("Rule 1 hardening: self-emit into supplied context (source == destination) stays on main thread", () => {
    // Self-emit is exempt from the side-thread rule regardless of participant list.
    const reader = makeReader({ ctx_a: { participants: [E1] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E1),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "thr_main",
        workspace_id: WS
      },
      reader
    );
    // Self-emit: no side thread.
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  // --- Cross-thread reply routing tests ---

  it("Cross-thread: participant emitting to another participant from a side-thread delivery → force_root_thread (Rule 2)", () => {
    // Scenario: Floe (E1) is processing a delivery on side thread thr_X.
    // Floe emits to operator (E2), also a participant. Reply MUST land on root.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "thr_X",  // side thread
        workspace_id: WS
      },
      reader
    );
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).toBe("ctx_a");
      expect(result.created).toBe(false);
      expect(result.force_root_thread).toBe(true);
      expect(result.side_thread).toBeFalsy();
    }
  });

  it("Cross-thread: non-participant source (snowball) replying to a participant stays on current side thread", () => {
    // Scenario: snowball (E3, NOT a participant) is replying to floe (E1, participant).
    // The reply must stay on the current side thread, not be forced to root.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });  // E3 NOT in ctx_a
    const result = resolveContext(
      {
        source_endpoint_id: E3,  // NOT a participant
        destination: endpointDest(E1),  // IS a participant
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "thr_X",
        workspace_id: WS
      },
      reader
    );
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).toBe("ctx_a");
      expect(result.created).toBe(false);
      // Source is NOT a participant → do NOT force root; stay on current thread.
      expect(result.force_root_thread).toBeFalsy();
      expect(result.side_thread).toBeFalsy();
    }
  });

  it("Cross-thread: participant→non-participant (floe→snowball) still opens side thread (Rule 3)", () => {
    // Floe (E1, participant) emitting to snowball (E3, NOT participant) → Rule 3 side thread.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });  // E3 NOT in ctx_a
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),  // NOT a participant
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "thr_root",
        workspace_id: WS
      },
      reader
    );
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).toBe("ctx_a");
      expect(result.created).toBe(false);
      expect(result.side_thread).toMatchObject({ parent_thread_id: "thr_root" });
      expect(result.force_root_thread).toBeFalsy();
    }
  });

  it("Cross-thread: Rule 1 path — participant emitting to participant via supplied_context_id from side thread → force_root_thread", () => {
    // D-B default: emit tool stamps context_id from delivery origin context.
    // Floe (E1) on side thread thr_X emits to operator (E2) with context_id=ctx_a.
    // Both are participants → resolver must signal force_root_thread.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: "ctx_a",
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "thr_X",
        workspace_id: WS
      },
      reader
    );
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).toBe("ctx_a");
      expect(result.created).toBe(false);
      expect(result.force_root_thread).toBe(true);
      expect(result.side_thread).toBeFalsy();
    }
  });

  it("Cross-thread: plain operator↔floe main-thread reply unchanged (no side thread, no force when on root)", () => {
    // Main-thread delivery (thread_id = context_id = root). Both participants.
    // force_root_thread is still set but resolvedThreadId will be context_id anyway — no-op.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        current_delivery_thread_id: "ctx_a",  // root thread = context_id
        workspace_id: WS
      },
      reader
    );
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).toBe("ctx_a");
      expect(result.created).toBe(false);
      // force_root_thread is set; submitEvent will set resolvedThreadId=ctx_a (same as root).
      expect(result.force_root_thread).toBe(true);
      expect(result.side_thread).toBeFalsy();
    }
  });
});

