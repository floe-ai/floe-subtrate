import React, { useCallback, useEffect, useMemo, useState } from "react";
import { MiniMarkdown } from "../../actors/markdown.tsx";
import type {
  DeliveryRow,
  EndpointRef,
  EventEnvelope,
  ScopeComposition,
  ScopeCompositionNode,
  ScopeRef,
} from "../../bus-client/types.ts";
import {
  listContextEvents,
  listDeliveries,
  listScopeCompositions,
  retireScope,
  subscribeEvents,
} from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { tk } from "../../theme.ts";

export type ScopeWorkLink = {
  source: string;
  target: string;
  label: string;
};

export type ScopeNodeExecution = {
  executionId: string;
  createdAt: string;
  state: string;
  eventType: string;
  summary: string;
  content: Record<string, unknown>;
};

export type ScopeOperationState = {
  state: "working" | "attention" | "settled";
  activeCount: number;
  attentionCount: number;
};

export function scopeOperationState(
  contextId: string,
  events: EventEnvelope[],
  deliveries: DeliveryRow[],
): ScopeOperationState {
  const eventIds = new Set(events.filter(event => event.context_id === contextId).map(event => event.event_id));
  const latestByInvocation = new Map<string, DeliveryRow>();
  for (const delivery of deliveries) {
    if (!eventIds.has(delivery.trigger_event_id)) continue;
    latestByInvocation.set(`${delivery.endpoint_id}:${delivery.trigger_event_id}`, delivery);
  }
  const latest = [...latestByInvocation.values()];
  const activeCount = latest.filter(delivery =>
    ["reserved", "delivered_to_bridge", "injected_to_runtime"].includes(delivery.state)
  ).length;
  const attentionCount = latest.filter(delivery =>
    ["failed", "dead_lettered", "deferred"].includes(delivery.state)
  ).length;
  return {
    state: activeCount > 0 ? "working" : attentionCount > 0 ? "attention" : "settled",
    activeCount,
    attentionCount,
  };
}

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

function readableEventContent(event: EventEnvelope | undefined): string {
  if (!event) return "";
  for (const key of ["text", "summary", "message", "result", "output"]) {
    const value = event.content?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function executionsForScopeNode(
  node: ScopeCompositionNode,
  events: EventEnvelope[],
  deliveries: DeliveryRow[],
): ScopeNodeExecution[] {
  if (node.kind === "trigger") {
    return events
      .filter((event) => event.type === node.event_type)
      .map((event) => ({
        executionId: event.event_id,
        createdAt: event.created_at,
        state: "observed",
        eventType: event.type,
        summary: readableEventContent(event) || event.type,
        content: event.content,
      }));
  }

  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  return deliveries
    .filter((delivery) => delivery.endpoint_id === node.endpoint_id && eventsById.has(delivery.trigger_event_id))
    .map((delivery) => {
      const trigger = eventsById.get(delivery.trigger_event_id);
      const result = events.find((event) => event.metadata?.delivery_id === delivery.delivery_id);
      return {
        executionId: delivery.delivery_id,
        createdAt: delivery.created_at,
        state: delivery.state,
        eventType: trigger?.type ?? "delivery",
        summary: readableEventContent(result) || readableEventContent(trigger) || trigger?.type || "Execution",
        content: result?.content ?? trigger?.content ?? {},
      };
    });
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

const executionState: Record<string, string> = {
  acknowledged: "Completed",
  failed: "Failed",
  dead_lettered: "Failed",
  cancelled: "Stopped",
  deferred: "Deferred",
  reserved: "Queued",
  delivered_to_bridge: "Working",
  injected_to_runtime: "Working",
  observed: "Observed",
};

function displayLabel(node: ScopeCompositionNode): string {
  return node.label?.trim() || node.node_id;
}

function eventLabel(eventType: string, nodes: ScopeCompositionNode[]): string {
  const event = nodes.find((node) => node.kind === "trigger" && node.event_type === eventType);
  return event ? displayLabel(event) : eventType;
}

function formatTime(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function PlanNodeButton({
  node,
  endpoints,
  executions,
  selected,
  compact = false,
  onSelect,
}: {
  node: ScopeCompositionNode;
  endpoints: EndpointRef[];
  executions: number;
  selected: boolean;
  compact?: boolean;
  onSelect: () => void;
}): React.ReactElement {
  const endpoint = node.kind === "trigger" ? null : endpoints.find((item) => item.endpoint_id === node.endpoint_id);
  const state = endpoint ? endpointState[endpoint.status] ?? endpointState.idle : null;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        minWidth: compact ? 168 : 210,
        maxWidth: compact ? 230 : 280,
        padding: compact ? "8px 10px" : "11px 12px",
        textAlign: "left",
        color: tk.ink,
        background: selected ? tk.accentSoft : tk.surface,
        border: `1px solid ${selected ? tk.accent : tk.border}`,
        borderRadius: tk.r3,
        cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{ color: node.kind === "trigger" ? tk.accent : tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          {node.kind === "trigger" ? "When" : node.kind === "command" ? "Command" : "Actor"}
        </span>
        {state && (
          <span style={{ padding: "2px 6px", borderRadius: 999, color: state.color, background: state.background, fontSize: 9.5 }}>
            {state.label}
          </span>
        )}
      </span>
      <span style={{ display: "block", marginTop: 5, fontSize: 12.5, fontWeight: 570, lineHeight: 1.3 }}>
        {displayLabel(node)}
      </span>
      <span style={{ display: "block", marginTop: 4, color: tk.ink3, fontSize: 10.5 }}>
        {executions} {executions === 1 ? "execution" : "executions"}
      </span>
    </button>
  );
}

function ScopeNodeInspector({
  node,
  nodes,
  endpoints,
  events,
  deliveries,
}: {
  node: ScopeCompositionNode;
  nodes: ScopeCompositionNode[];
  endpoints: EndpointRef[];
  events: EventEnvelope[];
  deliveries: DeliveryRow[];
}): React.ReactElement {
  const executions = executionsForScopeNode(node, events, deliveries).slice().reverse();
  const endpoint = node.kind === "trigger" ? null : endpoints.find((item) => item.endpoint_id === node.endpoint_id);
  const instruction = node.kind === "actor"
    ? node.bindings?.find((binding) => binding.kind === "instructions")?.text
    : null;
  const listensTo = node.kind === "trigger" ? [] : (node.event_types ?? ["*"]);
  const routesTo = node.kind === "trigger"
    ? nodes.filter((candidate) => candidate.kind !== "trigger" && (candidate.event_types ?? ["*"]).some((type) => type === "*" || type === node.event_type))
    : [];

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "20px 20px 32px" }}>
      <div style={{ color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>
        {node.kind === "trigger" ? "Planned event route" : node.kind === "command" ? "Planned command" : "Planned responsibility"}
      </div>
      <h3 style={{ margin: "7px 0 4px", color: tk.ink, fontSize: 18, fontWeight: 570 }}>{displayLabel(node)}</h3>
      {endpoint && <div style={{ color: tk.ink3, fontSize: 12 }}>{endpoint.name}</div>}

      <section style={{ marginTop: 22 }}>
        <h4 style={{ margin: "0 0 10px", color: tk.ink2, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>Plan</h4>
        {node.kind === "trigger" ? (
          <>
            <div style={{ color: tk.ink3, fontSize: 12.5, lineHeight: 1.5 }}>
              When <code>{node.event_type}</code> lands, it routes work to:
            </div>
            <div style={{ marginTop: 8, color: tk.ink2, fontSize: 12.5 }}>
              {routesTo.length > 0 ? routesTo.map(displayLabel).join(", ") : "No participant is currently subscribed."}
            </div>
            {node.source?.kind === "folder" && (
              <div style={{ marginTop: 10, color: tk.ink3, fontSize: 12 }}>Source folder: <code>{node.source.path}</code></div>
            )}
          </>
        ) : (
          <>
            <div style={{ color: tk.ink3, fontSize: 12.5, lineHeight: 1.5 }}>
              Starts when: {listensTo.map((type) => eventLabel(type, nodes)).join(", ")}
            </div>
            {instruction && (
              <div style={{ marginTop: 14, padding: 12, background: tk.canvas, border: `1px solid ${tk.border2}`, borderRadius: tk.r2 }}>
                <MiniMarkdown source={instruction} />
              </div>
            )}
            {node.kind === "command" && (
              <>
                <pre style={{ margin: "14px 0 0", padding: 10, overflow: "auto", whiteSpace: "pre-wrap", color: tk.ink2, background: tk.canvas, border: `1px solid ${tk.border2}`, borderRadius: tk.r2, fontSize: 11.5 }}>
                  {node.command}
                </pre>
                {node.result_event_type && (
                  <div style={{ marginTop: 9, color: tk.ink3, fontSize: 12 }}>Produces: {eventLabel(node.result_event_type, nodes)}</div>
                )}
              </>
            )}
          </>
        )}
      </section>

      <section style={{ marginTop: 24 }}>
        <h4 style={{ margin: "0 0 10px", color: tk.ink2, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Executions · {executions.length}
        </h4>
        {executions.length === 0 ? (
          <div style={{ color: tk.ink4, fontSize: 12.5, fontStyle: "italic" }}>No execution has reached this node yet.</div>
        ) : executions.map((execution) => (
          <details key={execution.executionId} style={{ marginBottom: 8, padding: "9px 10px", background: tk.surface, border: `1px solid ${tk.border2}`, borderRadius: tk.r2 }}>
            <summary style={{ cursor: "pointer", color: tk.ink2, fontSize: 12, lineHeight: 1.45 }}>
              <span style={{ color: execution.state.includes("fail") || execution.state === "dead_lettered" ? tk.danger : tk.accentHov }}>
                {executionState[execution.state] ?? execution.state}
              </span>
              {" · "}{formatTime(execution.createdAt)}
              <span style={{ display: "block", margin: "3px 0 0 14px", color: tk.ink3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {execution.summary}
              </span>
            </summary>
            <pre style={{ margin: "10px 0 0", padding: 9, overflow: "auto", whiteSpace: "pre-wrap", color: tk.ink3, background: tk.canvas, borderRadius: tk.r2, fontSize: 10.5 }}>
              {JSON.stringify(execution.content, null, 2)}
            </pre>
          </details>
        ))}
      </section>
    </div>
  );
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
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listScopeCompositions(workspaceId, scope.scope_id);
      const current = next.at(-1);
      const [history, workspaceDeliveries] = current
        ? await Promise.all([
            listContextEvents(current.context_id, { all: true }),
            listDeliveries({ workspace_id: workspaceId, limit: 500 }).catch(() => []),
          ])
        : [[], []];
      setCompositions(next);
      setEvents(history);
      setDeliveries(workspaceDeliveries);
      setSelectedNodeId((selected) =>
        selected && !current?.nodes.some((node) => node.node_id === selected) ? null : selected
      );
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
    if (message.type === "scope_graph_created" || message.type === "scope_graph_updated") {
      const graph = (message.payload as { graph?: { workspace_id?: string; scope_id?: string } }).graph;
      if (graph?.workspace_id === workspaceId && graph.scope_id === scope.scope_id) void load();
    }
    if (message.type === "event_submitted") {
      const event = (message.payload as { event?: { context_id?: string } }).event;
      const current = compositions.at(-1);
      if (event?.context_id === current?.context_id) void load();
    }
    if ([
      "delivery_bundle_available",
      "delivery_delivered_to_bridge",
      "delivery_injected_to_runtime",
      "delivery_acknowledged",
      "delivery_deferred",
      "delivery_failed",
      "delivery_dead_lettered",
      "delivery_cancelled",
      "scope_retired",
      "turn_end_observed",
    ].includes(message.type)) void load();
  }), [compositions, load, scope.scope_id, workspaceId]);

  const composition = compositions.at(-1) ?? null;
  const nodes = composition?.nodes ?? [];
  const links = useMemo(() => buildScopeWorkLinks(nodes), [nodes]);
  const eventNodes = nodes.filter((node) => node.kind === "trigger");
  const participantNodes = nodes.filter((node) => node.kind !== "trigger");
  const selectedNode = nodes.find((node) => node.node_id === selectedNodeId) ?? null;
  const executionCounts = useMemo(() => new Map(nodes.map((node) => [
    node.node_id,
    executionsForScopeNode(node, events, deliveries).length,
  ])), [deliveries, events, nodes]);
  const operation = useMemo(
    () => composition ? scopeOperationState(composition.context_id, events, deliveries) : null,
    [composition, deliveries, events],
  );
  const operationPresentation = operation?.state === "working"
    ? { label: `${operation.activeCount} working`, color: tk.accentHov, background: tk.accentSoft2 }
    : operation?.state === "attention"
      ? { label: "Needs attention", color: "#d18a82", background: "rgba(184,90,90,0.12)" }
      : { label: "Settled", color: tk.ink3, background: tk.surfaceHov };
  const stopWork = useCallback(async () => {
    if (stopping) return;
    if (!window.confirm(`Stop ${scope.title || scope.scope_id}? Active turns, queued work, folder monitoring, and scheduled pulses will stop. History will be kept.`)) return;
    setStopping(true);
    setError(null);
    try {
      await retireScope(workspaceId, scope.scope_id);
      onBack();
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "Could not stop this work");
      setStopping(false);
    }
  }, [onBack, scope.scope_id, scope.title, stopping, workspaceId]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: tk.fontUi }}>
      <header style={{ padding: "16px 22px 13px", borderBottom: `1px solid ${tk.border}`, background: tk.surface }}>
        <button type="button" onClick={onBack} style={{ padding: 0, border: "none", background: "transparent", color: tk.ink3, fontSize: 12.5, cursor: "pointer" }}>
          ← Workspace
        </button>
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <h2 style={{ margin: 0, color: tk.ink, fontSize: 19, fontWeight: 550 }}>{scope.title || scope.scope_id}</h2>
              {!loading && composition && <span style={{ color: tk.ink4, fontSize: 11.5 }}>{participantNodes.length} participants</span>}
              {!loading && composition && operation && (
                <span role="status" style={{ padding: "2px 7px", borderRadius: 999, color: operationPresentation.color, background: operationPresentation.background, fontSize: 10.5 }}>
                  {operationPresentation.label}
                </span>
              )}
            </div>
            <p style={{ margin: "5px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45 }}>
              The current plan Floe authored. Each route shows what starts a participant; select a node to inspect its responsibility and executions.
            </p>
          </div>
          {composition && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                type="button"
                onClick={() => void stopWork()}
                disabled={stopping}
                style={{ padding: "7px 10px", color: tk.danger, background: "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: stopping ? "wait" : "pointer", fontSize: 12 }}
              >
                {stopping ? "Stopping…" : "Stop work"}
              </button>
              <button
                type="button"
                onClick={() => setShowContext((value) => !value)}
                style={{ padding: "7px 10px", color: showContext ? tk.ink : tk.accentHov, background: showContext ? tk.surfaceHov : "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 12 }}
              >
                {showContext ? "Back to plan" : "Context history"}
              </button>
            </div>
          )}
        </div>
      </header>

      {loading ? (
        <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>Loading organised work…</div>
      ) : error ? (
        <div role="alert" style={{ padding: 28, color: tk.danger, fontSize: 13 }}>{error}</div>
      ) : !composition ? (
        <div style={{ padding: 28, color: tk.ink3, fontSize: 13 }}>This Scope has no composed plan yet.</div>
      ) : showContext ? (
        <ContextConversation
          contextId={composition.context_id}
          workspaceId={workspaceId}
          endpoints={endpoints}
          alignRightEndpointId={operatorEndpointId}
          showWorkEvents
          readOnly
        />
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: "flex", overflow: "hidden" }}>
          <section aria-label="Current scope plan" style={{ flex: 1, minWidth: 520, overflow: "auto", padding: "20px 22px 38px", background: tk.canvas }}>
            {compositions.length > 1 && (
              <div role="status" style={{ marginBottom: 16, padding: "9px 11px", color: "#c9a14a", background: "rgba(201,161,74,0.08)", border: "1px solid rgba(201,161,74,0.2)", borderRadius: tk.r2, fontSize: 11.5 }}>
                This Scope contains {compositions.length} stored compositions from an older runtime. The newest plan is shown; recomposing now updates it in place.
              </div>
            )}

            <div style={{ marginBottom: 22 }}>
              <div style={{ marginBottom: 9, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Participants</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                {participantNodes.map((node) => (
                  <PlanNodeButton
                    key={node.node_id}
                    node={node}
                    endpoints={endpoints}
                    executions={executionCounts.get(node.node_id) ?? 0}
                    selected={selectedNodeId === node.node_id}
                    onSelect={() => setSelectedNodeId(node.node_id)}
                  />
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 9, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Planned routes</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {eventNodes.map((eventNode) => {
                const targets = links
                  .filter((link) => link.source === eventNode.node_id)
                  .map((link) => nodes.find((node) => node.node_id === link.target))
                  .filter((node): node is ScopeCompositionNode => !!node);
                return (
                  <div key={eventNode.node_id} style={{ display: "grid", gridTemplateColumns: "minmax(190px, 0.8fr) 32px minmax(220px, 1.2fr)", alignItems: "center", gap: 8, padding: 9, background: tk.surface, border: `1px solid ${tk.border2}`, borderRadius: tk.r3 }}>
                    <PlanNodeButton
                      node={eventNode}
                      endpoints={endpoints}
                      executions={executionCounts.get(eventNode.node_id) ?? 0}
                      selected={selectedNodeId === eventNode.node_id}
                      compact
                      onSelect={() => setSelectedNodeId(eventNode.node_id)}
                    />
                    <div aria-hidden="true" style={{ color: tk.accent, textAlign: "center", fontSize: 17 }}>→</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                      {targets.length > 0 ? targets.map((target) => (
                        <button
                          key={target.node_id}
                          type="button"
                          onClick={() => setSelectedNodeId(target.node_id)}
                          style={{ padding: "6px 8px", color: selectedNodeId === target.node_id ? tk.ink : tk.ink2, background: selectedNodeId === target.node_id ? tk.accentSoft : tk.canvas, border: `1px solid ${selectedNodeId === target.node_id ? tk.accent : tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 11.5 }}
                        >
                          {displayLabel(target)}
                        </button>
                      )) : <span style={{ color: tk.ink4, fontSize: 11.5 }}>No participant subscribed</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <aside aria-label="Plan node details" style={{ width: "min(40%, 500px)", minWidth: 360, borderLeft: `1px solid ${tk.border}`, background: tk.canvas }}>
            {selectedNode ? (
              <ScopeNodeInspector
                node={selectedNode}
                nodes={nodes}
                endpoints={endpoints}
                events={events}
                deliveries={deliveries}
              />
            ) : (
              <div style={{ padding: "24px 22px", color: tk.ink3 }}>
                <div style={{ color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Plan overview</div>
                <h3 style={{ margin: "8px 0 9px", color: tk.ink, fontSize: 17, fontWeight: 560 }}>How this work is organised</h3>
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55 }}>{scope.description || "Floe has connected these participants through the planned event routes shown here."}</p>
                <p style={{ margin: "16px 0 0", color: tk.ink4, fontSize: 12.5, lineHeight: 1.5 }}>Select a participant or route to see what it is meant to do and the executions that have reached it.</p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
