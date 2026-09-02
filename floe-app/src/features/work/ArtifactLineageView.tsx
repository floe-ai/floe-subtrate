import React, { useEffect, useMemo, useState } from "react";
import type { EndpointRef, EventEnvelope } from "../../bus-client/types.ts";
import { readWorkspaceFile, type WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { tk } from "../../theme.ts";
import { ArtifactPreview } from "./ArtifactPreview.tsx";
import { ArtifactRelationshipGraph } from "./ArtifactRelationshipGraph.tsx";

export type ArtifactLineageNode = {
  id: string;
  type: string;
  path: string | null;
  status: string;
  revision: string | number | null;
  conceptName: string | null;
  contextRefs: string[];
  raw: Record<string, unknown>;
};

export type ArtifactLineageEdge = {
  from: string;
  to: string;
  relation: string;
};

export type ArtifactLineageGraph = {
  graphId: string | null;
  nodes: ArtifactLineageNode[];
  edges: ArtifactLineageEdge[];
};

function parseEventObject(event: EventEnvelope): Record<string, unknown> | null {
  const direct = event.content?.["data"];
  const directObject = direct && typeof direct === "object" && !Array.isArray(direct)
    ? direct as Record<string, unknown>
    : null;
  const text = event.content?.["text"];
  if (typeof text !== "string") return directObject;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>), ...(directObject ?? {}) }
      : directObject;
  } catch {
    return directObject;
  }
}

/** Discover the extension-owned lineage document from its public update Event. */
export function findArtifactGraphPath(events: EventEnvelope[]): string | null {
  for (const event of [...events].reverse()) {
    if (event.type !== "lineage.updated" && event.type !== "artifact.lineage.updated") continue;
    const content = parseEventObject(event);
    const value = content?.["artifact_graph"]
      ?? content?.["artifact_graph_path"]
      ?? content?.["graph_path"]
      ?? content?.["graph"];
    if (typeof value === "string" && value.trim() && !value.includes("..") && !/^[A-Za-z]:[\\/]/.test(value)) {
      return value.replace(/\\/g, "/");
    }
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseArtifactLineageGraph(raw: string): ArtifactLineageGraph {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed["nodes"]) || !Array.isArray(parsed["edges"])) {
    throw new Error("The lineage document does not contain nodes and links.");
  }
  const nodes = parsed["nodes"].flatMap((item): ArtifactLineageNode[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (typeof value["id"] !== "string" || !value["id"].trim()) return [];
    return [{
      id: value["id"],
      type: typeof value["type"] === "string"
        ? value["type"]
        : typeof value["kind"] === "string" ? value["kind"] : "artifact",
      path: typeof value["path"] === "string" ? value["path"] : null,
      status: typeof value["status"] === "string" ? value["status"] : "unknown",
      revision: typeof value["revision"] === "string" || typeof value["revision"] === "number"
        ? value["revision"] : null,
      conceptName: typeof value["concept_name"] === "string" ? value["concept_name"] : null,
      contextRefs: stringList(value["context_refs"]),
      raw: value,
    }];
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = parsed["edges"].flatMap((item): ArtifactLineageEdge[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    if (typeof value["from"] !== "string" || typeof value["to"] !== "string") return [];
    if (!nodeIds.has(value["from"]) || !nodeIds.has(value["to"])) return [];
    return [{
      from: value["from"],
      to: value["to"],
      relation: typeof value["relation"] === "string" ? value["relation"] : "related-to",
    }];
  });
  return {
    graphId: typeof parsed["graph_id"] === "string" ? parsed["graph_id"] : null,
    nodes,
    edges,
  };
}

export function artifactNeighborhood(graph: ArtifactLineageGraph, nodeId: string): {
  upstream: Array<{ node: ArtifactLineageNode; relation: string }>;
  downstream: Array<{ node: ArtifactLineageNode; relation: string }>;
} {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    upstream: graph.edges.flatMap((edge) => edge.to === nodeId && byId.has(edge.from)
      ? [{ node: byId.get(edge.from)!, relation: edge.relation }]
      : []),
    downstream: graph.edges.flatMap((edge) => edge.from === nodeId && byId.has(edge.to)
      ? [{ node: byId.get(edge.to)!, relation: edge.relation }]
      : []),
  };
}

function displayType(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function artifactLabel(node: ArtifactLineageNode): string {
  const named = node.raw["display_name"] ?? node.raw["component_name"] ?? node.raw["file_name"];
  if (typeof named === "string" && named.trim()) return named;
  return node.path?.split(/[\\/]/).at(-1) ?? node.id;
}

function ArtifactButton({
  workspace,
  node,
  relation,
  selected,
  onSelect,
}: {
  workspace: WorkspaceFsRef;
  node: ArtifactLineageNode;
  relation?: string;
  selected?: boolean;
  onSelect: () => void;
}): React.ReactElement {
  return (
    <button type="button" onClick={onSelect} aria-label={`Open artifact ${node.id}`} style={{
      width: "100%", padding: 8, textAlign: "left", cursor: "pointer",
      border: `1px solid ${selected ? tk.accent : tk.border}`, borderRadius: tk.r2,
      background: selected ? tk.accentSoft : tk.surface, color: tk.ink,
    }}>
      <ArtifactPreview workspace={workspace} node={node} />
      {relation && <span style={{ display: "block", color: tk.accent, fontSize: 9.5, marginTop: 7 }}>{displayType(relation)}</span>}
      <span style={{ display: "block", marginTop: relation ? 3 : 7, fontSize: 12, fontWeight: 560, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{artifactLabel(node)}</span>
      <span style={{ display: "block", marginTop: 3, color: tk.ink3, fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {displayType(node.type)} · {node.status}
      </span>
    </button>
  );
}

function SelectedArtifactCard({
  workspace,
  node,
  onOpenContext,
}: {
  workspace: WorkspaceFsRef;
  node: ArtifactLineageNode;
  onOpenContext: (contextId: string) => void;
}): React.ReactElement {
  return (
    <section style={{ alignSelf: "start", padding: 14, border: `1px solid ${tk.accent}`, borderRadius: tk.r3, background: tk.accentSoft }}>
      <ArtifactPreview workspace={workspace} node={node} variant="hero" showText />
      <div style={{ marginTop: 12, color: tk.accent, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>{displayType(node.type)}</div>
      <h4 style={{ margin: "6px 0 0", color: tk.ink, fontSize: 15, fontWeight: 570, overflowWrap: "anywhere" }}>{artifactLabel(node)}</h4>
      {node.path && <div title={node.path} style={{ marginTop: 5, color: tk.ink3, fontSize: 10.5, overflowWrap: "anywhere" }}>{node.path}</div>}
      <div style={{ marginTop: 11, display: "flex", gap: 7, flexWrap: "wrap" }}>
        <span style={{ color: tk.ink2, background: tk.surfaceHov, borderRadius: 999, padding: "3px 7px", fontSize: 10.5 }}>Status: {node.status}</span>
        {node.revision != null && <span style={{ color: tk.ink2, background: tk.surfaceHov, borderRadius: 999, padding: "3px 7px", fontSize: 10.5 }}>Revision: {node.revision}</span>}
      </div>
      <code style={{ display: "block", marginTop: 12, color: tk.ink4, fontSize: 9.5, overflowWrap: "anywhere" }}>{node.id}</code>
      {node.contextRefs.length > 0 && (
        <button type="button" onClick={() => onOpenContext(node.contextRefs[0]!)} style={{
          marginTop: 13, border: `1px solid ${tk.border}`, borderRadius: tk.r2,
          background: tk.surface, color: tk.accentHov, padding: "7px 10px", fontSize: 11.5, cursor: "pointer",
        }}>Open related conversation</button>
      )}
    </section>
  );
}

export function ArtifactLineageView({
  workspace,
  graphPath,
  endpoints,
  operatorEndpointId,
}: {
  workspace: WorkspaceFsRef;
  graphPath: string;
  endpoints: EndpointRef[];
  operatorEndpointId: string;
}): React.ReactElement {
  const [graph, setGraph] = useState<ArtifactLineageGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [relatedContextId, setRelatedContextId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<"trail" | "graph">("trail");

  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    setError(null);
    void readWorkspaceFile(workspace, graphPath)
      .then(parseArtifactLineageGraph)
      .then((value) => {
        if (cancelled) return;
        setGraph(value);
        const source = value.nodes.find((node) => node.type === "source-concept") ?? value.nodes[0] ?? null;
        setSelectedId(source?.id ?? null);
      })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { cancelled = true; };
  }, [graphPath, workspace.locator, workspace.workspace_id]);

  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;
  const neighborhood = useMemo(
    () => graph && selected ? artifactNeighborhood(graph, selected.id) : { upstream: [], downstream: [] },
    [graph, selected],
  );
  const searchResults = useMemo(() => {
    if (!graph || !search.trim()) return [];
    const needle = search.trim().toLowerCase();
    return graph.nodes.filter((node) =>
      node.id.toLowerCase().includes(needle)
      || node.type.toLowerCase().includes(needle)
      || node.path?.toLowerCase().includes(needle)
    ).slice(0, 12);
  }, [graph, search]);

  if (error) return <div role="alert" style={{ padding: 26, color: tk.danger, fontSize: 12.5 }}>{error}</div>;
  if (!graph || !selected) return <div style={{ padding: 26, color: tk.ink3, fontSize: 12.5 }}>Loading artifact lineage…</div>;
  if (relatedContextId) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "10px 18px", borderBottom: `1px solid ${tk.border}` }}>
          <button type="button" onClick={() => setRelatedContextId(null)} style={{ border: "none", background: "transparent", color: tk.accentHov, padding: 0, cursor: "pointer" }}>
            ← Artifact lineage
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ContextConversation
            contextId={relatedContextId}
            workspaceId={workspace.workspace_id}
            endpoints={endpoints}
            alignRightEndpointId={operatorEndpointId}
            showWorkEvents
            readOnly
          />
        </div>
      </div>
    );
  }

  const sourceNodes = graph.nodes.filter((node) => node.type === "source-concept");
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", background: tk.canvas }}>
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${tk.border}`, background: tk.surface }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, color: tk.ink, fontSize: 16, fontWeight: 560 }}>Artifact lineage</h3>
            <p style={{ margin: "4px 0 0", color: tk.ink3, fontSize: 11.5 }}>
              {graph.nodes.length} artifacts · {graph.edges.length} links · extension-owned state at {graphPath}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div aria-label="Artifact view prototype" style={{ display: "flex", padding: 2, border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: tk.canvas }}>
              {([['trail', 'Visual trail'], ['graph', 'Relationship graph']] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={viewMode === value} onClick={() => setViewMode(value)} style={{
                  border: "none", borderRadius: tk.r1, padding: "6px 8px", cursor: "pointer", fontSize: 10.5,
                  color: viewMode === value ? tk.ink : tk.ink3, background: viewMode === value ? tk.surfaceHov : "transparent",
                }}>{label}</button>
              ))}
            </div>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find an artifact…" aria-label="Find an artifact" style={{
              width: 230, border: `1px solid ${tk.border}`, borderRadius: tk.r2,
              background: tk.canvas, color: tk.ink, padding: "7px 9px", fontSize: 11.5,
            }} />
          </div>
        </div>
        {searchResults.length > 0 && (
          <div role="list" aria-label="Artifact search results" style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {searchResults.map((node) => (
              <button key={node.id} type="button" onClick={() => { setSelectedId(node.id); setSearch(""); }} style={{
                border: `1px solid ${tk.border}`, borderRadius: 999, background: tk.surfaceHov,
                color: tk.ink2, padding: "4px 8px", fontSize: 10.5, cursor: "pointer",
              }}>{node.path?.split(/[\\/]/).at(-1) ?? node.id}</button>
            ))}
          </div>
        )}
      </div>
      {viewMode === "trail" ? (
        <>
          <div style={{ padding: "12px 18px", borderBottom: `1px solid ${tk.border2}`, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 8, overflowX: "auto" }}>
            {sourceNodes.map((node) => (
              <ArtifactButton key={node.id} workspace={workspace} node={node} selected={node.id === selected.id} onSelect={() => setSelectedId(node.id)} />
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(220px, 0.85fr) minmax(340px, 1.3fr) minmax(220px, 0.85fr)", gap: 16, padding: 18, overflow: "auto" }}>
            <section>
              <div style={{ marginBottom: 8, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Produced from</div>
              <div style={{ display: "grid", gap: 7 }}>
                {neighborhood.upstream.length > 0 ? neighborhood.upstream.slice(0, 24).map(({ node, relation }) => (
                  <ArtifactButton key={`${node.id}:${relation}`} workspace={workspace} node={node} relation={relation} onSelect={() => setSelectedId(node.id)} />
                )) : <div style={{ color: tk.ink4, fontSize: 11.5 }}>No upstream artifact.</div>}
              </div>
            </section>
            <SelectedArtifactCard workspace={workspace} node={selected} onOpenContext={setRelatedContextId} />
            <section>
              <div style={{ marginBottom: 8, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Produces</div>
              <div style={{ display: "grid", gap: 7 }}>
                {neighborhood.downstream.length > 0 ? neighborhood.downstream.slice(0, 24).map(({ node, relation }) => (
                  <ArtifactButton key={`${node.id}:${relation}`} workspace={workspace} node={node} relation={relation} onSelect={() => setSelectedId(node.id)} />
                )) : <div style={{ color: tk.ink4, fontSize: 11.5 }}>No downstream artifact.</div>}
              </div>
            </section>
          </div>
        </>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
          <section aria-label="Artifact relationship graph" style={{ flex: 1, minWidth: 420, background: tk.canvas }}>
            <ArtifactRelationshipGraph workspace={workspace} graph={graph} selectedId={selected.id} onSelect={setSelectedId} />
          </section>
          <aside style={{ width: "min(34%, 390px)", minWidth: 320, padding: 14, overflow: "auto", borderLeft: `1px solid ${tk.border}`, background: tk.canvas }}>
            <div style={{ marginBottom: 10, color: tk.ink3, fontSize: 10.5 }}>
              {neighborhood.upstream.length} upstream · {neighborhood.downstream.length} downstream
            </div>
            <SelectedArtifactCard workspace={workspace} node={selected} onOpenContext={setRelatedContextId} />
          </aside>
        </div>
      )}
    </div>
  );
}
