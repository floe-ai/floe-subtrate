import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EndpointRef,
  ScopeComposition,
  ScopeCompositionNode,
  ScopeRef,
} from "../../bus-client/types.ts";
import { listScopeCompositions, subscribeEvents } from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { tk } from "../../theme.ts";

export type ScopeWorkLink = {
  source: string;
  target: string;
  label: string;
};

export function buildScopeWorkLinks(nodes: ScopeCompositionNode[]): ScopeWorkLink[] {
  const events = nodes.filter((node) => node.kind === "trigger");
  const participants = nodes.filter((node) => node.kind === "actor" || node.kind === "command");
  const links: ScopeWorkLink[] = [];
  for (const event of events) {
    for (const participant of participants) {
      const types = participant.event_types ?? ["*"];
      if (types.includes("*") || types.includes(event.event_type)) {
        links.push({ source: event.node_id, target: participant.node_id, label: event.event_type });
      }
    }
  }
  for (const command of participants) {
    if (command.kind !== "command" || !command.result_event_type) continue;
    const event = events.find((candidate) => candidate.event_type === command.result_event_type);
    if (event) links.push({ source: command.node_id, target: event.node_id, label: command.result_event_type });
  }
  return links;
}

type PositionedNode = {
  node: ScopeCompositionNode;
  x: number;
  y: number;
};

function positionNodes(nodes: ScopeCompositionNode[], links: ScopeWorkLink[]): {
  nodes: PositionedNode[];
  width: number;
  height: number;
} {
  const events = nodes.filter((node) => node.kind === "trigger");
  const participants = nodes.filter((node) => node.kind === "actor" || node.kind === "command");
  const eventY = new Map(events.map((node, index) => [node.node_id, 30 + index * 88]));
  const participantOrder = participants
    .map((node) => {
      const incoming = links
        .filter((link) => link.target === node.node_id && eventY.has(link.source))
        .map((link) => eventY.get(link.source) as number);
      return {
        node,
        preferredY: incoming.length > 0
          ? incoming.reduce((sum, value) => sum + value, 0) / incoming.length
          : 30,
      };
    })
    .sort((left, right) => left.preferredY - right.preferredY);
  let lastParticipantY = -70;
  const positionedParticipants = participantOrder.map(({ node, preferredY }) => {
    const y = Math.max(preferredY, lastParticipantY + 104);
    lastParticipantY = y;
    return { node, x: 430, y };
  });
  const positionedEvents = events.map((node) => ({ node, x: 30, y: eventY.get(node.node_id) as number }));
  const maxY = [...positionedEvents, ...positionedParticipants].reduce((value, item) => Math.max(value, item.y), 0);
  return { nodes: [...positionedEvents, ...positionedParticipants], width: 740, height: Math.max(320, maxY + 100) };
}

const endpointState: Record<string, { label: string; color: string; background: string }> = {
  active: { label: "Working", color: tk.accentHov, background: tk.accentSoft2 },
  waiting: { label: "Waiting", color: "#c9a14a", background: "rgba(201,161,74,0.10)" },
  queued: { label: "Queued", color: "#c9a14a", background: "rgba(201,161,74,0.10)" },
  error: { label: "Error", color: "#d18a82", background: "rgba(184,90,90,0.12)" },
  offline: { label: "Offline", color: "#d18a82", background: "rgba(184,90,90,0.12)" },
  runtime_unconfigured: { label: "Not configured", color: "#d18a82", background: "rgba(184,90,90,0.12)" },
  retired: { label: "Retired", color: tk.ink4, background: tk.surfaceHov },
  idle: { label: "Ready", color: tk.ink3, background: tk.surfaceHov },
};

function displayLabel(node: ScopeCompositionNode): string {
  return node.label?.trim() || node.node_id;
}

export function ScopeWorkView({
  workspaceId,
  scope,
  endpoints,
  operatorEndpointId,
  onBack,
}: {
  workspaceId: string;
  scope: ScopeRef;
  endpoints: EndpointRef[];
  operatorEndpointId: string;
  onBack: () => void;
}): React.ReactElement {
  const [compositions, setCompositions] = useState<ScopeComposition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listScopeCompositions(workspaceId, scope.scope_id);
      setCompositions(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load organised work");
    } finally {
      setLoading(false);
    }
  }, [scope.scope_id, workspaceId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  useEffect(() => subscribeEvents((message) => {
    if (message.type !== "scope_graph_created" && message.type !== "scope_graph_updated") return;
    const graph = (message.payload as { graph?: { workspace_id?: string; scope_id?: string } }).graph;
    if (graph?.workspace_id === workspaceId && graph.scope_id === scope.scope_id) void load();
  }), [load, scope.scope_id, workspaceId]);

  const composition = compositions.at(-1) ?? null;
  const links = useMemo(() => buildScopeWorkLinks(composition?.nodes ?? []), [composition]);
  const positioned = useMemo(() => positionNodes(composition?.nodes ?? [], links), [composition, links]);
  const byId = new Map(positioned.nodes.map((item) => [item.node.node_id, item]));
  const participantCount = composition?.nodes.filter((node) => node.kind !== "trigger").length ?? 0;
  const workingCount = composition?.nodes.filter((node) => {
    if (node.kind === "trigger") return false;
    const endpoint = endpoints.find((candidate) => candidate.endpoint_id === node.endpoint_id);
    return endpoint?.status === "active";
  }).length ?? 0;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: tk.fontUi }}>
      <header style={{ padding: "16px 22px 13px", borderBottom: `1px solid ${tk.border}`, background: tk.surface }}>
        <button type="button" onClick={onBack} style={{ padding: 0, border: "none", background: "transparent", color: tk.ink3, fontSize: 12.5, cursor: "pointer" }}>
          ← Workspace
        </button>
        <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ margin: 0, color: tk.ink, fontSize: 19, fontWeight: 550 }}>{scope.title || scope.scope_id}</h2>
          {!loading && composition && (
            <span style={{ color: tk.ink4, fontSize: 11.5 }}>
              {participantCount} {participantCount === 1 ? "participant" : "participants"} · {workingCount} working
            </span>
          )}
        </div>
        <p style={{ margin: "5px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45 }}>
          Events are on the left; the Actors and Commands they wake are on the right. Status comes from the live endpoint.
        </p>
      </header>

      {loading ? (
        <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>Loading organised work…</div>
      ) : error ? (
        <div role="alert" style={{ padding: 28, color: tk.danger, fontSize: 13 }}>{error}</div>
      ) : !composition ? (
        <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>This Scope has no composed work yet.</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
          <section aria-label="Current scope organisation" style={{ flex: 1, minWidth: 420, overflow: "auto", background: tk.canvas }}>
            {compositions.length > 1 && (
              <div role="status" style={{ margin: "14px 20px 0", padding: "9px 11px", color: "#c9a14a", background: "rgba(201,161,74,0.08)", border: "1px solid rgba(201,161,74,0.2)", borderRadius: tk.r2, fontSize: 11.5 }}>
                This Scope contains {compositions.length} stored compositions from an older runtime. The newest is shown; recomposing now will update it in place.
              </div>
            )}
            <div style={{ position: "relative", width: positioned.width, height: positioned.height }}>
              <div style={{ position: "absolute", left: 30, top: 10, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Events</div>
              <div style={{ position: "absolute", left: 430, top: 10, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Participants</div>
              <svg aria-hidden="true" width={positioned.width} height={positioned.height} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                {links.map((link, index) => {
                  const source = byId.get(link.source);
                  const target = byId.get(link.target);
                  if (!source || !target) return null;
                  const fromRight = source.x < target.x;
                  const sourceX = source.x + (fromRight ? 280 : 0);
                  const targetX = target.x + (fromRight ? 0 : 280);
                  const sourceY = source.y + 34;
                  const targetY = target.y + 34;
                  const bend = (sourceX + targetX) / 2;
                  return <path key={`${link.source}:${link.target}:${index}`} d={`M ${sourceX} ${sourceY} C ${bend} ${sourceY}, ${bend} ${targetY}, ${targetX} ${targetY}`} fill="none" stroke="rgba(138,168,156,0.34)" strokeWidth="1.4" />;
                })}
              </svg>
              {positioned.nodes.map(({ node, x, y }) => {
                const endpoint = node.kind === "trigger" ? null : endpoints.find((candidate) => candidate.endpoint_id === node.endpoint_id);
                const state = node.kind === "trigger" ? null : endpointState[endpoint?.status ?? "offline"] ?? endpointState.idle;
                return (
                  <article key={node.node_id} style={{ position: "absolute", left: x, top: y, width: 280, minHeight: 68, boxSizing: "border-box", padding: "10px 11px", color: tk.ink, background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ color: node.kind === "trigger" ? tk.accent : tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        {node.kind === "trigger" ? "Event" : node.kind === "command" ? "Command" : "Actor"}
                      </span>
                      {state && <span style={{ padding: "2px 6px", borderRadius: 999, color: state.color, background: state.background, fontSize: 9.5 }}>{state.label}</span>}
                    </div>
                    <div style={{ marginTop: 5, fontSize: 12.5, fontWeight: 570, lineHeight: 1.25 }}>{displayLabel(node)}</div>
                    <div style={{ marginTop: 4, color: tk.ink3, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {node.kind === "trigger" ? node.event_type : endpoint?.name || node.endpoint_id}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <aside aria-label="Scope context conversation" style={{ width: "min(46%, 560px)", minWidth: 390, borderLeft: `1px solid ${tk.border}`, background: tk.canvas }}>
            <ContextConversation
              contextId={composition.context_id}
              workspaceId={workspaceId}
              endpoints={endpoints}
              alignRightEndpointId={operatorEndpointId}
              showWorkEvents
              readOnly
            />
          </aside>
        </div>
      )}
    </div>
  );
}
