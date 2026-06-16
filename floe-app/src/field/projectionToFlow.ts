/**
 * Maps a ScopeProjection to React Flow nodes and edges for the Field lens.
 * Contexts and Pulses become nodes; derived relationships become edges.
 *
 * Pure function — no side effects, no I/O.
 */
import type { ScopeProjection, FieldLayout } from "../bus-client/types.ts";
import type { Node, Edge } from "@xyflow/react";

// ---------------------------------------------------------------------------
// Opaque node/edge types for Field
// ---------------------------------------------------------------------------

export type ContextNodeData = {
  contextRef: {
    context_id: string;
    workspace_id: string;
    scope_id: string;
    parent_context_id: string | null;
    created_by_endpoint_id: string | null;
    created_at: string;
    last_event_at: string | null;
    first_message_preview: string | null;
  };
};

export type PulseNodeData = {
  pulseRef: {
    pulse_id: string;
    workspace_id: string;
    scope_id: string;
    persistence: "workspace" | "local";
    status: string;
    trigger: unknown;
    next_fire_at: string | null;
    last_fired_at: string | null;
    fire_count: number;
    created_at: string;
    updated_at: string;
  };
};

export type FlowNode = Node<ContextNodeData | PulseNodeData>;
export type FlowEdge = Edge;

export type FlowGraph = {
  nodes: FlowNode[];
  edges: FlowEdge[];
};

// ---------------------------------------------------------------------------
// Deterministic fallback layout
//
// Contexts form a vertical column on the left, pulses on the right.
// Each row is spaced by STEP_Y pixels.
// ---------------------------------------------------------------------------

const CONTEXT_X = 60;
const PULSE_X = 400;
const STEP_Y = 160;
const ORIGIN_Y = 60;

function savedPosition(
  layout: FieldLayout | null,
  nodeId: string
): { x: number; y: number } | null {
  if (!layout) return null;
  const hit = layout.nodes.find((n) => n.id === nodeId);
  return hit ? hit.position : null;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function projectionToFlow(
  projection: ScopeProjection,
  layout: FieldLayout | null
): FlowGraph {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // --- Context nodes ---
  projection.refs.contexts.forEach((ctx, idx) => {
    const id = `ctx-${ctx.context_id}`;
    const pos = savedPosition(layout, id) ?? {
      x: CONTEXT_X,
      y: ORIGIN_Y + idx * STEP_Y,
    };
    nodes.push({
      id,
      type: "contextTile",
      position: pos,
      data: { contextRef: ctx } as ContextNodeData,
    });
  });

  // --- Pulse nodes ---
  projection.refs.pulses.forEach((pulse, idx) => {
    const id = `pulse-${pulse.pulse_id}`;
    const pos = savedPosition(layout, id) ?? {
      x: PULSE_X,
      y: ORIGIN_Y + idx * STEP_Y,
    };
    nodes.push({
      id,
      type: "pulse",
      position: pos,
      data: { pulseRef: pulse } as PulseNodeData,
    });
  });

  // --- Derived edges: parent → child between contexts ---
  projection.refs.contexts.forEach((ctx) => {
    if (ctx.parent_context_id) {
      const parentNodeId = `ctx-${ctx.parent_context_id}`;
      const childNodeId = `ctx-${ctx.context_id}`;
      // Only emit if both ends exist in the projection
      const parentExists = projection.refs.contexts.some(
        (c) => c.context_id === ctx.parent_context_id
      );
      if (parentExists) {
        edges.push({
          id: `edge-ctx-parent-${ctx.parent_context_id}-${ctx.context_id}`,
          source: parentNodeId,
          target: childNodeId,
          type: "smoothstep",
        });
      }
    }
  });

  // --- Derived edges: pulse → context via pulse_subscribers ---
  // pulse_subscribers carries { pulse_id, subscriber } where subscriber
  // may reference a context. We look for subscriber objects that contain
  // a context_id field.
  projection.relationships.pulse_subscribers.forEach((rel) => {
    const subscriber = rel.subscriber as Record<string, unknown> | null;
    if (!subscriber) return;
    const contextId =
      typeof subscriber["context_id"] === "string"
        ? subscriber["context_id"]
        : null;
    if (!contextId) return;

    const pulseNodeId = `pulse-${rel.pulse_id}`;
    const ctxNodeId = `ctx-${contextId}`;
    const pulseExists = projection.refs.pulses.some(
      (p) => p.pulse_id === rel.pulse_id
    );
    const ctxExists = projection.refs.contexts.some(
      (c) => c.context_id === contextId
    );
    if (pulseExists && ctxExists) {
      edges.push({
        id: `edge-pulse-${rel.pulse_id}-ctx-${contextId}`,
        source: pulseNodeId,
        target: ctxNodeId,
        type: "smoothstep",
        animated: true,
      });
    }
  });

  return { nodes, edges };
}
