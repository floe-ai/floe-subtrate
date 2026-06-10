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
        created_at: "2026-01-01T00:00:00.000Z"
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

  it("Runtime, no supplied id, destination ∈ current ctx → continues current", () => {
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
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });

  it("Runtime, no supplied id, destination ∉ current ctx → opens new with {source, destination}", () => {
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
    expect(result).toMatchObject({ created: true, participants: [E1, E3] });
    if ("context_id" in result) expect(result.context_id).not.toBe("ctx_a");
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
    expect(result).toEqual({ context_id: "ctx_a", created: false });
  });
});
