import React, { useMemo } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { tk } from "../../theme.ts";
import { ArtifactPreview } from "./ArtifactPreview.tsx";
import type { ArtifactLineageGraph, ArtifactLineageNode } from "./ArtifactLineageView.tsx";

type ProjectionNode = { artifact: ArtifactLineageNode; rank: number };

export function artifactGraphNeighborhood(
  graph: ArtifactLineageGraph,
  centerId: string,
  depth = 2,
  limit = 34,
): { nodes: ProjectionNode[]; edges: ArtifactLineageGraph["edges"] } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const ranks = new Map<string, number>([[centerId, 0]]);
  const queue: Array<{ id: string; remaining: number }> = [{ id: centerId, remaining: depth }];

  while (queue.length > 0 && ranks.size < limit) {
    const current = queue.shift()!;
    if (current.remaining <= 0) continue;
    const currentRank = ranks.get(current.id) ?? 0;
    const neighbors = graph.edges.flatMap((edge) => {
      if (edge.to === current.id) return [{ id: edge.from, rank: currentRank - 1 }];
      if (edge.from === current.id) return [{ id: edge.to, rank: currentRank + 1 }];
      return [];
    });
    for (const neighbor of neighbors) {
      if (ranks.size >= limit) break;
      if (!byId.has(neighbor.id) || ranks.has(neighbor.id)) continue;
      ranks.set(neighbor.id, neighbor.rank);
      queue.push({ id: neighbor.id, remaining: current.remaining - 1 });
    }
  }

  const included = new Set(ranks.keys());
  return {
    nodes: [...ranks.entries()].flatMap(([id, rank]) => {
      const artifact = byId.get(id);
      return artifact ? [{ artifact, rank }] : [];
    }),
    edges: graph.edges.filter((edge) => included.has(edge.from) && included.has(edge.to)),
  };
}

type ArtifactNodeData = {
  artifact: ArtifactLineageNode;
  workspace: WorkspaceFsRef;
  selected: boolean;
  onSelect: (id: string) => void;
};
type ArtifactFlowNode = Node<ArtifactNodeData, "artifact">;

function displayType(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function nodeLabel(node: ArtifactLineageNode): string {
  const named = node.raw["display_name"] ?? node.raw["component_name"] ?? node.raw["file_name"];
  if (typeof named === "string" && named.trim()) return named;
  return node.path?.split(/[\\/]/).at(-1) ?? node.id;
}

function ArtifactFlowNodeView({ data }: NodeProps<ArtifactFlowNode>): React.ReactElement {
  const { artifact, workspace, selected, onSelect } = data;
  return (
    <button
      type="button"
      onClick={() => onSelect(artifact.id)}
      aria-label={`Open artifact ${artifact.id}`}
      style={{
        width: 220, padding: 8, textAlign: "left", cursor: "pointer", color: tk.ink,
        background: selected ? tk.accentSoft : tk.surface,
        border: `1px solid ${selected ? tk.accent : tk.border}`,
        borderRadius: tk.r3, boxShadow: selected ? `0 0 0 2px ${tk.accentRing}` : "0 8px 22px rgba(0,0,0,0.16)",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: tk.accent, border: "none" }} />
      <ArtifactPreview workspace={workspace} node={artifact} variant="graph" />
      <span style={{ display: "block", marginTop: 7, color: tk.accent, fontSize: 9, letterSpacing: "0.07em", textTransform: "uppercase" }}>
        {displayType(artifact.type)}
      </span>
      <span style={{ display: "block", marginTop: 3, fontSize: 11.5, fontWeight: 570, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {nodeLabel(artifact)}
      </span>
      <span style={{ display: "block", marginTop: 4, color: tk.ink3, fontSize: 9.5 }}>
        {artifact.status}{artifact.revision != null ? ` · r${artifact.revision}` : ""}
      </span>
      <Handle type="source" position={Position.Right} style={{ background: tk.accent, border: "none" }} />
    </button>
  );
}

const nodeTypes = { artifact: ArtifactFlowNodeView };

export function ArtifactRelationshipGraph({
  workspace,
  graph,
  selectedId,
  onSelect,
}: {
  workspace: WorkspaceFsRef;
  graph: ArtifactLineageGraph;
  selectedId: string;
  onSelect: (id: string) => void;
}): React.ReactElement {
  const projection = useMemo(
    () => artifactGraphNeighborhood(graph, selectedId),
    [graph, selectedId],
  );
  const flowNodes = useMemo<ArtifactFlowNode[]>(() => {
    const groups = new Map<number, ProjectionNode[]>();
    for (const item of projection.nodes) groups.set(item.rank, [...(groups.get(item.rank) ?? []), item]);
    const maxRows = 5;
    let nextX = 40;
    return [...groups.entries()].sort(([left], [right]) => left - right).flatMap(([, items]) => {
      const columns = Math.ceil(items.length / maxRows);
      const rows = Math.min(items.length, maxRows);
      const groupX = nextX;
      nextX += columns * 260 + 110;
      return items.map((item, index) => ({
        id: item.artifact.id,
        type: "artifact" as const,
        position: {
          x: groupX + Math.floor(index / maxRows) * 260,
          y: 40 + ((maxRows - rows) * 155) / 2 + (index % maxRows) * 155,
        },
        data: { artifact: item.artifact, workspace, selected: item.artifact.id === selectedId, onSelect },
        draggable: false,
        selectable: true,
      }));
    });
  }, [onSelect, projection.nodes, selectedId, workspace]);
  const flowEdges = useMemo<Edge[]>(() => projection.edges.map((edge, index) => ({
    id: `${edge.from}:${edge.to}:${edge.relation}:${index}`,
    source: edge.from,
    target: edge.to,
    label: displayType(edge.relation),
    markerEnd: { type: MarkerType.ArrowClosed, color: tk.accent },
    style: { stroke: tk.accent, strokeWidth: 1.35 },
    labelStyle: { fill: tk.ink3, fontSize: 9.5 },
    labelBgStyle: { fill: tk.canvas, fillOpacity: 0.9 },
  })), [projection.edges]);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <div style={{ position: "absolute", zIndex: 4, top: 10, left: 12, padding: "5px 8px", color: tk.ink3, background: "rgba(8,9,10,0.82)", border: `1px solid ${tk.border}`, borderRadius: tk.r2, fontSize: 10.5 }}>
        {projection.nodes.length} nearby artifacts · select one to follow its relationships
      </div>
      <ReactFlow
        key={selectedId}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.5}
        nodesConnectable={false}
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background color="rgba(138,168,156,0.12)" gap={22} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => node.id === selectedId ? tk.accent : tk.ink4}
          maskColor="rgba(8,9,10,0.72)"
          style={{ background: tk.surface, border: `1px solid ${tk.border}` }}
        />
      </ReactFlow>
    </div>
  );
}
