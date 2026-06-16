/**
 * Tests for the Field module — pure function coverage.
 *
 * projectionToFlow is pure (no DOM, no network); vitest runs it natively.
 */
import { describe, it, expect } from "vitest";
import { projectionToFlow } from "./projectionToFlow.ts";
import type { ScopeProjection, FieldLayout } from "../bus-client/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeProjection(
  overrides: Partial<ScopeProjection> = {}
): ScopeProjection {
  return {
    workspace_id: "ws-1",
    scope_id: "scope-1",
    generated_at: "2026-06-12T00:00:00Z",
    refs: {
      contexts: [],
      pulses: [],
      events: [],
      activity: [],
    },
    relationships: {
      context_participants: [],
      pulse_subscribers: [],
      event_context_ownership: [],
    },
    unsupported: [],
    ...overrides,
  };
}

function makeContext(
  id: string,
  parentId: string | null = null
): ScopeProjection["refs"]["contexts"][number] {
  return {
    context_id: id,
    workspace_id: "ws-1",
    scope_id: "scope-1",
    parent_context_id: parentId,
    created_by_endpoint_id: null,
    created_at: "2026-06-12T00:00:00Z",
    last_event_at: null,
    first_message_preview: null,
  };
}

function makePulse(id: string): ScopeProjection["refs"]["pulses"][number] {
  return {
    pulse_id: id,
    workspace_id: "ws-1",
    scope_id: "scope-1",
    persistence: "workspace",
    status: "active",
    trigger: { kind: "interval", interval_ms: 60000 },
    next_fire_at: null,
    last_fired_at: null,
    fire_count: 0,
    created_at: "2026-06-12T00:00:00Z",
    updated_at: "2026-06-12T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// projectionToFlow
// ---------------------------------------------------------------------------

describe("projectionToFlow", () => {
  it("maps Contexts and Pulses to nodes, derived relationships to edges", () => {
    const ctxA = makeContext("ctx-a");
    const ctxB = makeContext("ctx-b", "ctx-a"); // child of ctxA
    const pulse = makePulse("pulse-1");

    const projection = makeProjection({
      refs: {
        contexts: [ctxA, ctxB],
        pulses: [pulse],
        events: [],
        activity: [],
      },
      relationships: {
        context_participants: [],
        pulse_subscribers: [
          { pulse_id: "pulse-1", subscriber: { context_id: "ctx-a" } },
        ],
        event_context_ownership: [],
      },
    });

    const { nodes, edges } = projectionToFlow(projection, null);

    // ---------- Node counts ----------
    // 2 contexts + 1 pulse = 3 nodes
    expect(nodes).toHaveLength(3);

    const contextNodes = nodes.filter((n) => n.type === "contextTile");
    const pulseNodes = nodes.filter((n) => n.type === "pulse");
    expect(contextNodes).toHaveLength(2);
    expect(pulseNodes).toHaveLength(1);

    // ---------- Node ids are prefixed correctly ----------
    const nodeIds = nodes.map((n) => n.id);
    expect(nodeIds).toContain("ctx-ctx-a");
    expect(nodeIds).toContain("ctx-ctx-b");
    expect(nodeIds).toContain("pulse-pulse-1");

    // ---------- Context nodes carry the ref in data ----------
    const nodeA = contextNodes.find((n) => n.id === "ctx-ctx-a");
    expect(nodeA).toBeDefined();
    expect((nodeA!.data as { contextRef: { context_id: string } }).contextRef.context_id).toBe("ctx-a");

    // ---------- Pulse node carries the ref in data ----------
    const pulseNode = pulseNodes[0];
    expect((pulseNode.data as { pulseRef: { pulse_id: string } }).pulseRef.pulse_id).toBe("pulse-1");

    // ---------- Edges ----------
    // 1 parent→child context edge + 1 pulse→context subscriber edge = 2 edges
    expect(edges).toHaveLength(2);

    const parentChildEdge = edges.find(
      (e) => e.source === "ctx-ctx-a" && e.target === "ctx-ctx-b"
    );
    expect(parentChildEdge).toBeDefined();

    const pulseCtxEdge = edges.find(
      (e) => e.source === "pulse-pulse-1" && e.target === "ctx-ctx-a"
    );
    expect(pulseCtxEdge).toBeDefined();
  });

  it("returns empty nodes and edges for an empty projection", () => {
    const { nodes, edges } = projectionToFlow(makeProjection(), null);
    expect(nodes).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("applies saved positions from layout over deterministic fallback", () => {
    const ctx = makeContext("ctx-positioned");
    const projection = makeProjection({
      refs: {
        contexts: [ctx],
        pulses: [],
        events: [],
        activity: [],
      },
    });

    const layout: FieldLayout = {
      workspace_id: "ws-1",
      scope_id: "scope-1",
      renderer: "react-flow",
      nodes: [{ id: "ctx-ctx-positioned", position: { x: 999, y: 888 }, data: {} }],
      edges: [],
      updated_at: "2026-06-12T00:00:00Z",
    };

    const { nodes } = projectionToFlow(projection, layout);
    expect(nodes[0].position).toEqual({ x: 999, y: 888 });
  });

  it("falls back to deterministic grid when layout is null", () => {
    const ctxA = makeContext("ctx-a");
    const ctxB = makeContext("ctx-b");
    const projection = makeProjection({
      refs: {
        contexts: [ctxA, ctxB],
        pulses: [],
        events: [],
        activity: [],
      },
    });

    const { nodes } = projectionToFlow(projection, null);
    // Both nodes should have finite, distinct y positions
    const ys = nodes.map((n) => n.position.y);
    expect(ys[0]).not.toBe(ys[1]);
    // x should be the context column x
    expect(nodes[0].position.x).toBeGreaterThan(0);
  });

  it("does not emit a parent-child edge when parent is not in the projection", () => {
    // ctxB's parent (ctx-ghost) is not in refs.contexts
    const ctxB = makeContext("ctx-b", "ctx-ghost");
    const projection = makeProjection({
      refs: {
        contexts: [ctxB],
        pulses: [],
        events: [],
        activity: [],
      },
    });

    const { edges } = projectionToFlow(projection, null);
    expect(edges).toHaveLength(0);
  });

  it("does not emit pulse→context edge when subscriber has no context_id", () => {
    const pulse = makePulse("pulse-1");
    const projection = makeProjection({
      refs: {
        contexts: [],
        pulses: [pulse],
        events: [],
        activity: [],
      },
      relationships: {
        context_participants: [],
        pulse_subscribers: [
          { pulse_id: "pulse-1", subscriber: { kind: "broadcast" } },
        ],
        event_context_ownership: [],
      },
    });

    const { edges } = projectionToFlow(projection, null);
    expect(edges).toHaveLength(0);
  });
});
