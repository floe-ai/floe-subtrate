import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ContextRef,
  DeliveryRow,
  EndpointRef,
  EventEnvelope,
  ScopeComposition,
  ScopeRef,
} from "../../bus-client/types.ts";
import {
  listContextsForScope,
  listDeliveries,
  listEvents,
  listScopeCompositions,
  retireScope,
  subscribeEvents,
} from "../../bus-client/client.ts";
import { ContextConversation } from "../../scope/ContextConversation.tsx";
import { tk } from "../../theme.ts";
import type { WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { readWorkspaceFile } from "../../fs/workspaceFs.ts";
import {
  ArtifactLineageView,
  findArtifactGraphPath,
  parseArtifactLineageGraph,
  type ArtifactLineageGraph,
} from "./ArtifactLineageView.tsx";
import { ScopePipelineFocusView } from "./ScopePipelineFocusView.tsx";

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

export function ScopeWorkView({
  workspaceId,
  workspace,
  scope,
  endpoints,
  operatorEndpointId,
  onBack,
}: {
  workspaceId: string;
  workspace?: WorkspaceFsRef;
  scope: ScopeRef;
  endpoints: EndpointRef[];
  operatorEndpointId: string;
  onBack: () => void;
}): React.ReactElement {
  const [compositions, setCompositions] = useState<ScopeComposition[]>([]);
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([]);
  const [artifactGraph, setArtifactGraph] = useState<ArtifactLineageGraph | null>(null);
  const [shownContextId, setShownContextId] = useState<string | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await listScopeCompositions(workspaceId, scope.scope_id);
      const current = next.at(-1);
      const [historyPage, workspaceDeliveries, scopeContexts] = current
        ? await Promise.all([
            listEvents({
              workspace_id: workspaceId,
              scope_id: scope.scope_id,
              direction: "backward",
              limit: 500,
            }),
            listDeliveries({ workspace_id: workspaceId, limit: 500 }).catch(() => []),
            listContextsForScope(workspaceId, scope.scope_id).catch(() => []),
          ])
        : [{ events: [], next_cursor: null }, [], []];
      const history = historyPage.events;
      const graphPath = findArtifactGraphPath(history);
      const nextArtifactGraph = workspace && graphPath
        ? await readWorkspaceFile(workspace, graphPath)
            .then(parseArtifactLineageGraph)
            .catch(() => null)
        : null;
      setCompositions(next);
      setContexts(scopeContexts);
      setEvents(history);
      setDeliveries(workspaceDeliveries);
      setArtifactGraph(nextArtifactGraph);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load organised work");
    } finally {
      setLoading(false);
    }
  }, [scope.scope_id, workspace?.locator, workspace?.workspace_id, workspaceId]);

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
  const participantNodes = nodes.filter((node) => node.kind !== "trigger");
  const operation = useMemo(
    () => composition ? scopeOperationState(composition.context_id, events, deliveries) : null,
    [composition, deliveries, events],
  );
  const operationPresentation = operation?.state === "working"
    ? { label: `${operation.activeCount} working`, color: tk.accentHov, background: tk.accentSoft2 }
    : operation?.state === "attention"
      ? { label: "Needs attention", color: "#d18a82", background: "rgba(184,90,90,0.12)" }
      : { label: "Settled", color: tk.ink3, background: tk.surfaceHov };
  const artifactGraphPath = useMemo(() => findArtifactGraphPath(events), [events]);
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
              {!loading && composition && (
                <span style={{ color: tk.ink4, fontSize: 11.5 }}>
                  {participantNodes.length} {participantNodes.length === 1 ? "participant" : "participants"}
                </span>
              )}
              {!loading && composition && operation && (
                <span role="status" style={{ padding: "2px 7px", borderRadius: 999, color: operationPresentation.color, background: operationPresentation.background, fontSize: 10.5 }}>
                  {operationPresentation.label}
                </span>
              )}
            </div>
            <p style={{ margin: "5px 0 0", color: tk.ink3, fontSize: 12.5, lineHeight: 1.45 }}>
              Follow the current plan one real step at a time. Each step shows its exact execution, Context, and current Artifact references.
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
                onClick={() => {
                  setShownContextId((value) => value ? null : composition.context_id);
                  setShowArtifacts(false);
                }}
                style={{ padding: "7px 10px", color: shownContextId ? tk.ink : tk.accentHov, background: shownContextId ? tk.surfaceHov : "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 12 }}
              >
                {shownContextId ? "Back to pipeline" : "Context history"}
              </button>
              {workspace && artifactGraphPath && (
                <button
                  type="button"
                  onClick={() => {
                    setShowArtifacts((value) => !value);
                    setShownContextId(null);
                  }}
                  style={{ padding: "7px 10px", color: showArtifacts ? tk.ink : tk.accentHov, background: showArtifacts ? tk.surfaceHov : "transparent", border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 12 }}
                >
                  {showArtifacts ? "Back to plan" : "Artifacts"}
                </button>
              )}
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
      ) : shownContextId ? (
        <ContextConversation
          contextId={shownContextId}
          workspaceId={workspaceId}
          endpoints={endpoints}
          alignRightEndpointId={operatorEndpointId}
          showWorkEvents
          readOnly
        />
      ) : showArtifacts && workspace && artifactGraphPath ? (
        <ArtifactLineageView
          workspace={workspace}
          graphPath={artifactGraphPath}
          endpoints={endpoints}
          operatorEndpointId={operatorEndpointId}
        />
      ) : (
        <ScopePipelineFocusView
          composition={composition}
          contexts={contexts}
          events={events}
          deliveries={deliveries}
          endpoints={endpoints}
          workspace={workspace}
          artifactGraph={artifactGraph}
          onOpenContext={(contextId) => {
            setShownContextId(contextId);
            setShowArtifacts(false);
          }}
        />
      )}
    </div>
  );
}
