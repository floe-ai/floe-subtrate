import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ContextRef, DeliveryRow, EndpointRef } from "../../bus-client/types.ts";
import { listContextTree, listDeliveries, subscribeEvents } from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { tk } from "../../theme.ts";

const ACTIVE_DELIVERY_STATES = new Set(["reserved", "delivered_to_bridge", "injected_to_runtime"]);
const FAILED_DELIVERY_STATES = new Set(["failed", "dead_lettered", "deferred"]);

export type ContextWorkStatus = "working" | "attention" | "responded" | "stopped" | "queued" | "context";

export type ContextWorkNode = {
  context: ContextRef;
  depth: number;
  title: string;
  collaborators: string;
  status: ContextWorkStatus;
};

export type ContextWorkProjection = {
  nodes: ContextWorkNode[];
  links: Array<{ sourceContextId: string; targetContextId: string }>;
};

function endpointName(endpointId: string, endpoints: EndpointRef[]): string {
  const endpoint = endpoints.find(candidate => candidate.endpoint_id === endpointId);
  return endpoint?.name?.trim() || endpoint?.agent_id || endpointId.split(":").at(-1) || "Collaborator";
}

function contextIdsInDelivery(delivery: DeliveryRow): Set<string> {
  try {
    const events = JSON.parse(delivery.events_json) as Array<{ context_id?: unknown }>;
    return new Set(events.flatMap(event => typeof event.context_id === "string" ? [event.context_id] : []));
  } catch {
    return new Set();
  }
}

function statusForContext(contextId: string, deliveries: DeliveryRow[]): ContextWorkStatus {
  const relevant = deliveries
    .filter(delivery => contextIdsInDelivery(delivery).has(contextId))
    .sort((left, right) => left.created_at.localeCompare(right.created_at));
  if (relevant.some(delivery => ACTIVE_DELIVERY_STATES.has(delivery.state))) return "working";
  const latest = relevant.at(-1);
  if (!latest) return "context";
  if (FAILED_DELIVERY_STATES.has(latest.state)) return "attention";
  if (latest.state === "acknowledged") return "responded";
  if (latest.state === "cancelled") return "stopped";
  return "queued";
}

function workTitle(context: ContextRef, depth: number): string {
  const candidate = context.title?.trim() || context.first_message_preview?.trim();
  if (!candidate) return depth === 0 ? "Conversation" : "Untitled context";
  return candidate.length > 92 ? `${candidate.slice(0, 89)}…` : candidate;
}

/**
 * Read-only client projection. Every node is an existing Context and every
 * link is an exact parent_context_id relationship; no workflow state is stored.
 */
export function buildContextWorkProjection(
  contexts: ContextRef[],
  deliveries: DeliveryRow[],
  endpoints: EndpointRef[],
  rootContextId: string,
): ContextWorkProjection {
  const byId = new Map(contexts.map(context => [context.context_id, context]));
  const depthCache = new Map<string, number | null>([[rootContextId, 0]]);

  function depthFor(contextId: string, visiting = new Set<string>()): number | null {
    const cached = depthCache.get(contextId);
    if (cached !== undefined) return cached;
    if (visiting.has(contextId)) return null;
    const context = byId.get(contextId);
    if (!context?.parent_context_id) return null;
    const nextVisiting = new Set(visiting).add(contextId);
    const parentDepth = depthFor(context.parent_context_id, nextVisiting);
    const depth = parentDepth == null ? null : parentDepth + 1;
    depthCache.set(contextId, depth);
    return depth;
  }

  const nodes = contexts
    .flatMap(context => {
      const depth = depthFor(context.context_id);
      if (depth == null) return [];
      const collaborators = context.participants
        .map(participant => endpointName(participant, endpoints))
        .join(", ") || "No participants";
      return [{
        context,
        depth,
        title: workTitle(context, depth),
        collaborators,
        status: statusForContext(context.context_id, deliveries),
      } satisfies ContextWorkNode];
    })
    .sort((left, right) => left.context.created_at.localeCompare(right.context.created_at));

  const included = new Set(nodes.map(node => node.context.context_id));
  const links = nodes.flatMap(node => {
    const parentId = node.context.parent_context_id;
    return parentId && included.has(parentId)
      ? [{ sourceContextId: parentId, targetContextId: node.context.context_id }]
      : [];
  });

  return { nodes, links };
}

type PositionedNode = ContextWorkNode & { x: number; y: number };

function positionProjection(projection: ContextWorkProjection): {
  nodes: PositionedNode[];
  width: number;
  height: number;
} {
  const byParent = new Map<string, ContextWorkNode[]>();
  for (const node of projection.nodes) {
    const parentId = node.context.parent_context_id;
    if (!parentId) continue;
    const children = byParent.get(parentId) ?? [];
    children.push(node);
    byParent.set(parentId, children);
  }
  for (const children of byParent.values()) {
    children.sort((left, right) => left.context.created_at.localeCompare(right.context.created_at));
  }

  const ordered: ContextWorkNode[] = [];
  const root = projection.nodes.find(node => node.depth === 0);
  function visit(node: ContextWorkNode) {
    ordered.push(node);
    for (const child of byParent.get(node.context.context_id) ?? []) visit(child);
  }
  if (root) visit(root);

  const nodes = ordered.map((node, index) => ({
    ...node,
    x: 28 + node.depth * 260,
    y: 28 + index * 112,
  }));
  const maxDepth = nodes.reduce((current, node) => Math.max(current, node.depth), 0);
  return {
    nodes,
    width: Math.max(620, 28 + maxDepth * 260 + 244),
    height: Math.max(260, 28 + nodes.length * 112),
  };
}

const statusPresentation: Record<ContextWorkStatus, { label: string; color: string; background: string }> = {
  working: { label: "Working", color: tk.accentHov, background: tk.accentSoft2 },
  attention: { label: "Needs attention", color: "#d18a82", background: "rgba(184,90,90,0.12)" },
  responded: { label: "Responded", color: tk.ink3, background: tk.surfaceHov },
  stopped: { label: "Stopped", color: tk.ink4, background: tk.surfaceHov },
  queued: { label: "Queued", color: "#c9a14a", background: "rgba(201,161,74,0.10)" },
  context: { label: "Context", color: tk.ink4, background: tk.surfaceHov },
};

export function ContextWorkView({
  workspaceId,
  rootContextId,
  endpoints,
  operatorEndpointId,
  onBackToConversation,
}: {
  workspaceId: string;
  rootContextId: string;
  endpoints: EndpointRef[];
  operatorEndpointId: string;
  onBackToConversation: () => void;
}): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [selectedContextId, setSelectedContextId] = useState(rootContextId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const loadSequence = useRef(0);
  const selectionInitialized = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const [tree, nextDeliveries] = await Promise.all([
        listContextTree(rootContextId, 200),
        listDeliveries({ workspace_id: workspaceId, limit: 500 }),
      ]);
      if (sequence !== loadSequence.current) return;
      setContexts(tree.contexts);
      setTruncated(tree.truncated);
      setDeliveries(nextDeliveries);
      setError(null);
    } catch (loadError) {
      if (sequence !== loadSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "Failed to load work contexts");
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [rootContextId, workspaceId]);

  useEffect(() => {
    selectionInitialized.current = false;
    setSelectedContextId(rootContextId);
    setLoading(true);
    void load();
  }, [load, rootContextId]);

  useEffect(() => {
    const unsubscribe = subscribeEvents(message => {
      const eventWorkspaceId = (message.payload as {
        event?: { workspace_id?: string };
        context?: { workspace_id?: string };
        delivery?: { workspace_id?: string };
        workspace_id?: string;
      }).event?.workspace_id
        ?? (message.payload as { context?: { workspace_id?: string } }).context?.workspace_id
        ?? (message.payload as { delivery?: { workspace_id?: string } }).delivery?.workspace_id
        ?? (message.payload as { workspace_id?: string }).workspace_id;
      const relevantType = message.type === "event_submitted"
        || message.type === "context_created"
        || message.type === "context_deleted"
        || message.type === "delivery_bundle_available"
        || message.type === "delivery_deferred"
        || message.type === "delivery_failed"
        || message.type === "delivery_dead_lettered"
        || message.type === "delivery_cancelled"
        || message.type === "turn_end_observed";
      if (relevantType && (!eventWorkspaceId || eventWorkspaceId === workspaceId)) void load();
    });
    return unsubscribe;
  }, [load, workspaceId]);

  const projection = useMemo(
    () => buildContextWorkProjection(contexts, deliveries, endpoints, rootContextId),
    [contexts, deliveries, endpoints, rootContextId],
  );
  const positioned = useMemo(() => positionProjection(projection), [projection]);

  useEffect(() => {
    if (projection.nodes.length === 0) return;
    const stillVisible = projection.nodes.some(node => node.context.context_id === selectedContextId);
    if (!selectionInitialized.current || !stillVisible) {
      const active = projection.nodes.find(node => node.status === "working");
      setSelectedContextId(active?.context.context_id ?? rootContextId);
      selectionInitialized.current = true;
    }
  }, [projection, rootContextId, selectedContextId]);

  const positionById = new Map(positioned.nodes.map(node => [node.context.context_id, node]));
  const descendantCount = Math.max(0, projection.nodes.length - 1);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: tk.fontUi }}>
      <header style={{ padding: "16px 22px 13px", borderBottom: `1px solid ${tk.border}`, background: tk.surface }}>
        <button
          type="button"
          onClick={onBackToConversation}
          style={{ padding: 0, border: "none", background: "transparent", color: tk.ink3, fontSize: 12.5, cursor: "pointer" }}
        >
          ← Conversation
        </button>
        <div style={{ marginTop: 10, display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 style={{ margin: 0, color: tk.ink, fontSize: 19, fontWeight: 550 }}>Work behind this conversation</h2>
          {!loading && <span style={{ color: tk.ink4, fontSize: 11.5 }}>{descendantCount} connected {descendantCount === 1 ? "context" : "contexts"}</span>}
        </div>
        <p style={{ margin: "5px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45 }}>
          Each card is a Context Floe opened from this conversation. Lines show actual parentage; status reflects its latest delivery.
        </p>
        {truncated && (
          <div role="status" style={{ marginTop: 7, color: "#c9a14a", fontSize: 11.5 }}>
            Showing the first 200 connected Contexts. The durable history remains available.
          </div>
        )}
      </header>

      {loading ? (
        <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>Loading work…</div>
      ) : error ? (
        <div role="alert" style={{ padding: 28, color: tk.danger, fontSize: 13 }}>{error}</div>
      ) : projection.nodes.length === 0 ? (
        <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>This conversation is no longer available.</div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
          <section aria-label="Conversation work contexts" style={{ flex: 1, minWidth: 360, overflow: "auto", background: tk.canvas }}>
            <div style={{ position: "relative", width: positioned.width, height: positioned.height }}>
              <svg
                aria-hidden="true"
                width={positioned.width}
                height={positioned.height}
                style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
              >
                {projection.links.map(link => {
                  const source = positionById.get(link.sourceContextId);
                  const target = positionById.get(link.targetContextId);
                  if (!source || !target) return null;
                  const sourceX = source.x + 222;
                  const sourceY = source.y + 42;
                  const targetX = target.x;
                  const targetY = target.y + 42;
                  const bend = (sourceX + targetX) / 2;
                  return (
                    <path
                      key={`${link.sourceContextId}:${link.targetContextId}`}
                      d={`M ${sourceX} ${sourceY} C ${bend} ${sourceY}, ${bend} ${targetY}, ${targetX} ${targetY}`}
                      fill="none"
                      stroke="rgba(138,168,156,0.34)"
                      strokeWidth="1.5"
                    />
                  );
                })}
              </svg>
              {positioned.nodes.map(node => {
                const status = statusPresentation[node.status];
                const selected = node.context.context_id === selectedContextId;
                return (
                  <button
                    key={node.context.context_id}
                    type="button"
                    onClick={() => setSelectedContextId(node.context.context_id)}
                    aria-label={`Inspect ${node.title}`}
                    aria-pressed={selected}
                    style={{
                      position: "absolute", left: node.x, top: node.y, width: 222, height: 84,
                      padding: "10px 11px", textAlign: "left", cursor: "pointer", overflow: "hidden",
                      color: tk.ink, background: selected ? tk.accentSoft : tk.surface,
                      border: `1px solid ${selected ? tk.accent : tk.border}`,
                      borderRadius: tk.r3, boxShadow: selected ? `0 0 0 2px ${tk.accentRing}` : "none",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span style={{ color: node.depth === 0 ? tk.accent : tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                        {node.depth === 0 ? "Conversation" : "Context"}
                      </span>
                      <span style={{ padding: "2px 6px", borderRadius: 999, color: status.color, background: status.background, fontSize: 9.5, whiteSpace: "nowrap" }}>
                        {status.label}
                      </span>
                    </span>
                    <span style={{ display: "block", marginTop: 6, fontSize: 12.5, fontWeight: 570, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {node.title}
                    </span>
                    <span style={{ display: "block", marginTop: 4, color: tk.ink3, fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {node.collaborators}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <aside aria-label="Selected context conversation" style={{ width: "min(46%, 560px)", minWidth: 390, borderLeft: `1px solid ${tk.border}`, background: tk.canvas }}>
            <ContextConversation
              key={selectedContextId}
              contextId={selectedContextId}
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
