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

type ContextEntry = {
  participants: string[];
  topic?: string | null;
  parent_context_id?: string | null;
};

function makeReader(
  contexts: Record<string, ContextEntry>,
  peerContexts: Array<{ parent_context_id: string; participants: string[]; context_id: string }> = []
): ContextStoreReader {
  return {
    getContext(id) {
      if (!contexts[id]) return null;
      return {
        context_id: id,
        workspace_id: WS,
        scope_id: null,
        parent_context_id: contexts[id].parent_context_id ?? null,
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
          parent_context_id: v.parent_context_id ?? null,
          created_by_endpoint_id: v.participants[0],
          created_at: "2026-01-01T00:00:00.000Z",
          last_event_at: null,
          topic: v.topic ?? null,
          title: null,
          participants: v.participants.slice()
        }));
    },
    findLinkedPeerContext(linkedToContextId, endpointA, endpointB) {
      const match = peerContexts.find(
        (pc) =>
          pc.parent_context_id === linkedToContextId &&
          pc.participants.includes(endpointA) &&
          pc.participants.includes(endpointB) &&
          pc.participants.length === 2
      );
      if (!match) return null;
      return {
        context_id: match.context_id,
        workspace_id: WS,
        scope_id: null,
        parent_context_id: match.parent_context_id,
        created_by_endpoint_id: match.participants[0],
        created_at: "2026-01-01T00:00:00.000Z",
        title: null
      };
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
    // No peer link for UI-originated context (no origin to link to).
    expect("peer_link_to" in result).toBe(false);
  });

  it("Runtime, no supplied id, destination ∈ current ctx → continues current context (Rule 2)", () => {
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
    // Both participants → stay in current context.
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("Runtime, no supplied id, destination ∉ current ctx → creates peer context linked to origin (Rule 3)", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    // Must create a NEW peer context (not modify ctx_a).
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).not.toBe("ctx_a");
      expect(result.created).toBe(true);
      expect(result.participants).toEqual(expect.arrayContaining([E1, E3]));
      expect(result.participants).toHaveLength(2);
      // Must carry the peer link back to the origin context.
      expect(result.peer_link_to).toBe("ctx_a");
    }
  });

  it("Runtime Rule 3 — D1 reuse: returns existing peer context when one already exists for the pair", () => {
    // An existing peer context ctx_peer = {E1, E3} linked to ctx_a already exists.
    const reader = makeReader(
      { ctx_a: { participants: [E1, E2] } },
      [{ parent_context_id: "ctx_a", participants: [E1, E3], context_id: "ctx_peer_existing" }]
    );
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    // Must reuse the existing peer context, not create a new one.
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).toBe("ctx_peer_existing");
      expect(result.created).toBe(false);
    }
  });

  it("Supplied context + source is participant → succeeds (rule 1 positive)", () => {
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
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("Supplied context + source is participant + destination NOT participant → still emits to supplied context (Rule 1)", () => {
    // Rule 1 validates source participation only. Destination can be non-participant
    // (event is stored; no delivery created for non-participant dest — that's correct).
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),  // E3 NOT in ctx_a
        supplied_context_id: "ctx_a",
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    // Emits to the supplied context. No side thread, no peer context creation.
    expect(result).toEqual({ context_id: "ctx_a", created: false });
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
    const map: Record<string, ContextEntry> = {
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

  it("UI-originated emit with explicit context_id continues that context (T19)", () => {
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
    // Rule 1 positive: stays in ctx_a (no force_root_thread, no side thread).
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("Runtime self-emit (source == destination) stays in current context, never creates peer", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E1),  // self
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    // Self-emit stays in current context regardless.
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("Runtime Rule 2: non-participant source emitting to a participant stays in current context", () => {
    // Scenario: snowball (E3, NOT a participant of ctx_a) is acting in ctx_a via some delivery.
    // It emits to floe (E1, participant). Rule 2: dest ∈ current context → stay.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E3,  // NOT a participant (but has a delivery from ctx_a)
        destination: endpointDest(E1),  // participant
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    expect("context_id" in result).toBe(true);
    if ("context_id" in result) {
      expect(result.context_id).toBe("ctx_a");
      expect(result.created).toBe(false);
    }
  });

  it("Peer context in context: when S acts in C' and emits to D (also in C'), stays in C' (Rule 2)", () => {
    // C' = {E1, E3} is a peer context. E1 acts in C' and replies to E3.
    const reader = makeReader({
      ctx_a: { participants: [E1, E2] },
      ctx_peer: { participants: [E1, E3], parent_context_id: "ctx_a" }
    });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_peer",
        workspace_id: WS
      },
      reader
    );
    // E3 ∈ ctx_peer → stay in ctx_peer (Rule 2).
    expect(result).toEqual({ context_id: "ctx_peer", created: false });
  });

  it("Relay: actor S in peer context C' emits to origin context C via explicit context_id (Rule 1)", () => {
    // S (E1) is in both C (ctx_a) and C' (ctx_peer). S acting in C' wants to relay
    // back to operator (E2) in C. S passes explicit context_id=ctx_a.
    const reader = makeReader({
      ctx_a: { participants: [E1, E2] },
      ctx_peer: { participants: [E1, E3], parent_context_id: "ctx_a" }
    });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E2),
        supplied_context_id: "ctx_a",  // explicit relay to origin
        current_delivery_context_id: "ctx_peer",
        workspace_id: WS
      },
      reader
    );
    // Rule 1: E1 ∈ ctx_a → emit to ctx_a. Clean relay.
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("NO side threads created: Rule 3 always creates a peer context, never a side thread", () => {
    // This is the key invariant: the resolver never returns a side_thread signal.
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    if ("context_id" in result) {
      expect((result as any).side_thread).toBeUndefined();
      expect((result as any).force_root_thread).toBeUndefined();
    }
  });

  it("Broadcast destination in a runtime context stays in the current context", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const result = resolveContext(
      {
        source_endpoint_id: E1,
        destination: { kind: "broadcast", scope: "workspace", target: "active" },
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    // Broadcast: no specific endpoint → stay in current context.
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("New peer context has a unique context_id each time (no reuse when no existing peer)", () => {
    const reader = makeReader({ ctx_a: { participants: [E1, E2] } });
    const r1 = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    const r2 = resolveContext(
      {
        source_endpoint_id: E1,
        destination: endpointDest(E3),
        supplied_context_id: null,
        current_delivery_context_id: "ctx_a",
        workspace_id: WS
      },
      reader
    );
    // Without an existing peer context, two calls produce two different ids.
    if ("context_id" in r1 && "context_id" in r2) {
      expect(r1.context_id).not.toBe(r2.context_id);
    }
  });
});
