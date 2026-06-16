/**
 * Field — the scope-level canvas lens.
 *
 * Renders a @xyflow/react canvas of Contexts and Pulses within a Scope.
 * Loads projection + layout from the bus; persists layout on node drag-stop.
 * Clicking a context tile calls onOpenContext.
 */
import "@xyflow/react/dist/style.css";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
} from "@xyflow/react";
import type {
  Node,
  Edge,
  NodeChange,
  EdgeChange,
  OnNodeDrag,
} from "@xyflow/react";

import type { ScopeProjection, FieldLayout } from "../bus-client/types.ts";
import {
  getScopeProjection,
  getFieldLayout,
  putFieldLayout,
} from "../bus-client/client.ts";
import { projectionToFlow } from "./projectionToFlow.ts";
import { ContextTile } from "./ContextTile.tsx";

// ---------------------------------------------------------------------------
// Node types registration
// ---------------------------------------------------------------------------

// Must be defined outside the component to avoid re-registering on every render.
const nodeTypes = {
  contextTile: ContextTile,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type FieldProps = {
  workspaceId: string;
  scopeId: string;
  onOpenContext: (contextId: string) => void;
};

// ---------------------------------------------------------------------------
// Field component
// ---------------------------------------------------------------------------

export function Field({ workspaceId, scopeId, onOpenContext }: FieldProps) {
  const [projection, setProjection] = useState<ScopeProjection | null>(null);
  const [layout, setLayout] = useState<FieldLayout | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Derived flow graph from projection + persisted layout
  const { nodes: initialNodes, edges: initialEdges } = useMemo(
    () =>
      projection
        ? projectionToFlow(projection, layout)
        : { nodes: [], edges: [] },
    [projection, layout]
  );

  const [nodes, setNodes] = useState<Node[]>(initialNodes);
  const [edges, setEdges] = useState<Edge[]>(initialEdges);

  // Sync nodes/edges when projection or layout changes
  useEffect(() => {
    setNodes(initialNodes);
    setEdges(initialEdges);
  }, [initialNodes, initialEdges]);

  // Load projection + layout in parallel on mount / when scope changes
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);

    Promise.all([
      getScopeProjection(workspaceId, scopeId),
      getFieldLayout(workspaceId, scopeId, "react-flow"),
    ])
      .then(([proj, lay]) => {
        if (!cancelled) {
          setProjection(proj);
          setLayout(lay);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load field data"
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, scopeId]);

  // React Flow change handlers
  const onNodesChange = useCallback(
    (changes: NodeChange[]) =>
      setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) =>
      setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  // Persist layout after a node drag completes
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, _node, allNodes) => {
      if (!projection) return;

      const persistedLayout: FieldLayout = {
        workspace_id: workspaceId,
        scope_id: scopeId,
        renderer: "react-flow",
        nodes: allNodes.map((n) => ({
          id: n.id,
          position: n.position,
          data: n.data as Record<string, unknown>,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          data: (e.data as Record<string, unknown> | undefined) ?? {},
        })),
        updated_at: new Date().toISOString(),
      };

      // Fire-and-forget; surface errors only in dev
      putFieldLayout(workspaceId, scopeId, "react-flow", persistedLayout).catch(
        (err: unknown) => {
          console.error("[Field] putFieldLayout failed:", err);
        }
      );
    },
    [workspaceId, scopeId, projection, edges]
  );

  // Click on a context-tile node → open context panel
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (node.type === "contextTile") {
        const data = node.data as { contextRef?: { context_id?: string } };
        const contextId = data.contextRef?.context_id;
        if (contextId) {
          onOpenContext(contextId);
        }
      }
    },
    [onOpenContext]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loadError) {
    return (
      <div
        data-testid="field-error"
        role="alert"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          color: "#f87171",
          fontFamily: "inherit",
          fontSize: 14,
        }}
      >
        Field unavailable: {loadError}
      </div>
    );
  }

  if (!projection) {
    return (
      <div
        data-testid="field-loading"
        role="status"
        aria-live="polite"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          color: "#64748b",
          fontFamily: "inherit",
          fontSize: 14,
        }}
      >
        Loading field…
      </div>
    );
  }

  return (
    <div
      data-testid="field"
      style={{ width: "100%", height: "100%" }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        fitView
        colorMode="dark"
        aria-label={`Field canvas for scope ${scopeId}`}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
