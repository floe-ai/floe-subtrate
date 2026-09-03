import React, { useEffect, useMemo, useState } from "react";
import type {
  ContextRef,
  DeliveryRow,
  EndpointRef,
  EventEnvelope,
  ScopeComposition,
  ScopeCompositionNode,
} from "../../bus-client/types.ts";
import type { WorkspaceFsRef } from "../../fs/workspaceFs.ts";
import { tk } from "../../theme.ts";
import type { ArtifactLineageGraph, ArtifactLineageNode } from "./ArtifactLineageView.tsx";
import { artifactFileKind, ArtifactPreview } from "./ArtifactPreview.tsx";
import "./ScopePipelineFocusView.css";

export type ScopePipelineRoute = {
  sourceNodeId: string;
  targetNodeId: string;
  kind: "subscription" | "command-result" | "actor-emission";
  eventType: string;
  sourceExecutionId: string | null;
  targetExecutionId: string | null;
};

export type ScopePipelineExecution = {
  executionId: string;
  nodeId: string;
  kind: "event" | "delivery";
  contextId: string;
  createdAt: string;
  state: string;
  eventId: string | null;
  eventIds: string[];
  deliveryId: string | null;
  triggerEventId: string | null;
  resultEventId: string | null;
  summary: string;
  attachedFilePath: string | null;
  arrivedArtifacts: ArtifactLineageNode[];
  producedArtifacts: ArtifactLineageNode[];
};

export type ScopePipelineNode = {
  node: ScopeCompositionNode;
  executions: ScopePipelineExecution[];
};

export type ScopePipelineFocusProjection = {
  nodes: ScopePipelineNode[];
  routes: ScopePipelineRoute[];
};

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function subscriptionFor(node: ScopeCompositionNode, eventType: string): string | null {
  if (node.kind === "trigger") return null;
  const eventTypes = node.event_types ?? ["*"];
  if (eventTypes.includes(eventType)) return eventType;
  return eventTypes.includes("*") ? "*" : null;
}

function isCurrentArtifact(artifact: ArtifactLineageNode): boolean {
  const status = artifact.status.trim().toLowerCase();
  return status === "current" || status.startsWith("current_");
}

function strictRuntimeResult(
  events: EventEnvelope[],
  delivery: DeliveryRow,
  trigger: EventEnvelope,
): EventEnvelope | null {
  return events.find((event) =>
    event.type === "message"
    && event.context_id === trigger.context_id
    && event.source_endpoint_id === delivery.endpoint_id
    && event.metadata?.origin === "runtime_turn_result"
    && event.metadata?.delivery_id === delivery.delivery_id
    && event.metadata?.cause_event_id === delivery.trigger_event_id
  ) ?? null;
}

function conciseEventText(event: EventEnvelope): string {
  for (const key of ["file_name", "text", "summary", "message"]) {
    const value = event.content?.[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/\s+/g, " ");
      return text.length > 64 ? `${text.slice(0, 61)}…` : text;
    }
  }
  return event.type;
}

function safeAttachedFilePath(node: ScopeCompositionNode, event: EventEnvelope): string | null {
  if (node.kind !== "trigger" || node.source?.kind !== "folder") return null;
  const fileName = stringMetadata(event.content?.["file_name"]);
  const folder = node.source.path.replace(/\\/g, "/").replace(/\/$/, "");
  if (!fileName || /[\\/]/.test(fileName) || fileName === "." || fileName === "..") return null;
  if (!folder || folder.includes("..") || /^[A-Za-z]:[\\/]/.test(folder) || folder.startsWith("/")) return null;
  return `${folder}/${fileName}`;
}

function latestDeliveriesByInvocation(deliveries: DeliveryRow[]): DeliveryRow[] {
  const latest = new Map<string, DeliveryRow>();
  for (const delivery of deliveries.slice().sort((left, right) => left.created_at.localeCompare(right.created_at))) {
    latest.set(`${delivery.endpoint_id}:${delivery.trigger_event_id}`, delivery);
  }
  return [...latest.values()];
}

/**
 * A read-only projection over exact substrate evidence. Scope routes come from
 * stored subscriptions. Executions require an exact fired-node, Delivery, or
 * runtime-emission identifier. Artifacts require an explicit current status and
 * raw event_refs; Context membership alone is never stage attribution.
 */
export function buildScopePipelineFocusProjection({
  composition,
  contexts,
  events,
  deliveries,
  artifactGraph,
}: {
  composition: ScopeComposition;
  contexts: ContextRef[];
  events: EventEnvelope[];
  deliveries: DeliveryRow[];
  artifactGraph?: ArtifactLineageGraph | null;
}): ScopePipelineFocusProjection {
  const scopedContextIds = new Set(
    contexts.filter((context) => context.scope_id === composition.scope_id).map((context) => context.context_id),
  );
  const scopedEvents = events.filter((event) =>
    event.scope_id === composition.scope_id || scopedContextIds.has(event.context_id)
  );
  const eventsById = new Map(scopedEvents.map((event) => [event.event_id, event]));
  const deliveriesById = new Map(deliveries.map((delivery) => [delivery.delivery_id, delivery]));
  const eventNodes = composition.nodes.filter((node) => node.kind === "trigger");
  const participantNodes = composition.nodes.filter((node) => node.kind !== "trigger");
  const eventNodeIdsByType = new Map<string, string[]>();
  for (const node of eventNodes) {
    eventNodeIdsByType.set(node.event_type, [...(eventNodeIdsByType.get(node.event_type) ?? []), node.node_id]);
  }

  const routes: ScopePipelineRoute[] = [];
  const routeKeys = new Set<string>();
  function addRoute(route: ScopePipelineRoute) {
    const key = [route.sourceNodeId, route.targetNodeId, route.kind, route.eventType, route.sourceExecutionId, route.targetExecutionId].join(":");
    if (routeKeys.has(key)) return;
    routeKeys.add(key);
    routes.push(route);
  }

  for (const eventNode of eventNodes) {
    for (const participantNode of participantNodes) {
      const subscribed = subscriptionFor(participantNode, eventNode.event_type);
      if (subscribed == null) continue;
      addRoute({
        sourceNodeId: eventNode.node_id,
        targetNodeId: participantNode.node_id,
        kind: "subscription",
        eventType: subscribed,
        sourceExecutionId: null,
        targetExecutionId: null,
      });
    }
  }
  for (const node of participantNodes) {
    if (node.kind !== "command" || !node.result_event_type) continue;
    for (const eventNode of eventNodes) {
      if (eventNode.event_type !== node.result_event_type) continue;
      addRoute({
        sourceNodeId: node.node_id,
        targetNodeId: eventNode.node_id,
        kind: "command-result",
        eventType: node.result_event_type,
        sourceExecutionId: null,
        targetExecutionId: null,
      });
    }
  }

  const eventAssignments = new Map<string, string>();
  for (const event of scopedEvents) {
    if (
      event.metadata?.trigger_kind === "scope_graph"
      && event.metadata?.graph_id === composition.graph_id
      && typeof event.metadata?.node_id === "string"
      && eventNodes.some((node) => node.node_id === event.metadata.node_id)
    ) {
      eventAssignments.set(event.event_id, event.metadata.node_id);
    }
  }

  for (const event of scopedEvents) {
    if (event.metadata?.origin === "runtime_turn_result") continue;
    const deliveryId = stringMetadata(event.metadata?.delivery_id);
    const delivery = deliveryId ? deliveriesById.get(deliveryId) : null;
    if (deliveryId && (!delivery || delivery.endpoint_id !== event.source_endpoint_id)) continue;

    const commandNodeId = event.metadata?.command_node === true
      && event.metadata?.graph_id === composition.graph_id
      ? stringMetadata(event.metadata?.node_id)
      : null;
    const sourceNodes = commandNodeId
      ? participantNodes.filter((node) =>
        node.kind === "command"
        && node.node_id === commandNodeId
        && node.endpoint_id === event.source_endpoint_id
        && node.result_event_type === event.type
      )
      : delivery
        ? participantNodes.filter((node) =>
          node.kind === "actor" && node.endpoint_id === delivery.endpoint_id
        )
        : [];
    const targetNodeIds = eventNodeIdsByType.get(event.type) ?? [];
    if (sourceNodes.length !== 1 || targetNodeIds.length !== 1) continue;
    const sourceNode = sourceNodes[0]!;
    const targetNodeId = targetNodeIds[0]!;
    eventAssignments.set(event.event_id, targetNodeId);
    addRoute({
      sourceNodeId: sourceNode.node_id,
      targetNodeId,
      kind: sourceNode.kind === "command" ? "command-result" : "actor-emission",
      eventType: event.type,
      sourceExecutionId: delivery?.delivery_id ?? null,
      targetExecutionId: event.event_id,
    });
  }

  const currentArtifacts = (artifactGraph?.nodes ?? []).filter(isCurrentArtifact);
  function artifactsForEventIds(eventIds: Array<string | null>): ArtifactLineageNode[] {
    const evidence = new Set(eventIds.filter((eventId): eventId is string => !!eventId));
    return currentArtifacts.filter((artifact) =>
      stringList(artifact.raw["event_refs"]).some((eventId) => evidence.has(eventId))
    );
  }

  const executionsByNode = new Map<string, ScopePipelineExecution[]>();
  function addExecution(execution: ScopePipelineExecution) {
    executionsByNode.set(execution.nodeId, [...(executionsByNode.get(execution.nodeId) ?? []), execution]);
  }

  const assignedEventGroups = new Map<string, { nodeId: string; events: EventEnvelope[] }>();
  for (const [eventId, nodeId] of eventAssignments) {
    const event = eventsById.get(eventId);
    if (!event) continue;
    const triggerFireId = event.metadata?.trigger_kind === "scope_graph"
      ? stringMetadata(event.metadata?.trigger_fire_id)
      : null;
    const groupKey = triggerFireId
      ? `${nodeId}:trigger-fire:${triggerFireId}`
      : `${nodeId}:event:${event.event_id}`;
    const group = assignedEventGroups.get(groupKey) ?? { nodeId, events: [] };
    group.events.push(event);
    assignedEventGroups.set(groupKey, group);
  }

  for (const [groupKey, group] of assignedEventGroups) {
    const groupedEvents = group.events.slice().sort((left, right) => left.created_at.localeCompare(right.created_at));
    const event = groupedEvents[0];
    if (!event) continue;
    const eventIds = groupedEvents.map((candidate) => candidate.event_id);
    addExecution({
      executionId: groupKey,
      nodeId: group.nodeId,
      kind: "event",
      contextId: event.context_id,
      createdAt: event.created_at,
      state: "observed",
      eventId: event.event_id,
      eventIds,
      deliveryId: stringMetadata(event.metadata?.delivery_id),
      triggerEventId: null,
      resultEventId: null,
      summary: conciseEventText(event),
      attachedFilePath: safeAttachedFilePath(
        composition.nodes.find((node) => node.node_id === group.nodeId)!,
        event,
      ),
      arrivedArtifacts: artifactsForEventIds(eventIds),
      producedArtifacts: [],
    });
  }

  const latestDeliveries = latestDeliveriesByInvocation(
    deliveries.filter((delivery) => delivery.workspace_id === composition.workspace_id),
  );
  for (const delivery of latestDeliveries) {
    const trigger = eventsById.get(delivery.trigger_event_id);
    if (!trigger || !eventAssignments.has(trigger.event_id)) continue;
    const candidateNodes = participantNodes.filter((candidate) =>
      candidate.endpoint_id === delivery.endpoint_id && subscriptionFor(candidate, trigger.type) != null
    );
    if (candidateNodes.length !== 1) continue;
    const node = candidateNodes[0]!;
    const result = node.kind === "actor" ? strictRuntimeResult(scopedEvents, delivery, trigger) : null;
    const emitted = scopedEvents.filter((event) =>
      event.source_endpoint_id === delivery.endpoint_id
      && event.metadata?.delivery_id === delivery.delivery_id
      && event.metadata?.origin !== "runtime_turn_result"
    );
    addExecution({
      executionId: delivery.delivery_id,
      nodeId: node.node_id,
      kind: "delivery",
      contextId: trigger.context_id,
      createdAt: delivery.created_at,
      state: delivery.state,
      eventId: null,
      eventIds: [],
      deliveryId: delivery.delivery_id,
      triggerEventId: trigger.event_id,
      resultEventId: result?.event_id ?? null,
      summary: result ? conciseEventText(result) : conciseEventText(trigger),
      attachedFilePath: null,
      arrivedArtifacts: artifactsForEventIds([trigger.event_id]),
      producedArtifacts: artifactsForEventIds([
        result?.event_id ?? null,
        ...emitted.map((event) => event.event_id),
      ]),
    });
  }

  return {
    nodes: composition.nodes.map((node) => ({
      node,
      executions: (executionsByNode.get(node.node_id) ?? [])
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    })),
    routes,
  };
}

function nodeLabel(node: ScopeCompositionNode): string {
  return node.label?.trim() || node.node_id;
}

function nodeKind(node: ScopeCompositionNode): "Event" | "Actor" | "Command" {
  if (node.kind === "trigger") return "Event";
  return node.kind === "actor" ? "Actor" : "Command";
}

function nodeDetail(node: ScopeCompositionNode, endpoints: EndpointRef[]): string {
  if (node.kind === "trigger") return node.event_type;
  return endpoints.find((endpoint) => endpoint.endpoint_id === node.endpoint_id)?.name || node.endpoint_id;
}

function executionContextLabel(execution: ScopePipelineExecution, contexts: ContextRef[]): string {
  const context = contexts.find((candidate) => candidate.context_id === execution.contextId);
  return context?.title?.trim()
    || context?.first_message_preview?.trim()
    || execution.contextId;
}

function artifactLabel(artifact: ArtifactLineageNode): string {
  for (const key of ["display_name", "component_name", "file_name"] as const) {
    const value = artifact.raw[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return artifact.path || artifact.id;
}

function attachedFilePreviewNode(execution: ScopePipelineExecution): ArtifactLineageNode | null {
  if (!execution.attachedFilePath) return null;
  return {
    id: `attached-file:${execution.eventId ?? execution.executionId}`,
    type: "file",
    path: execution.attachedFilePath,
    status: "current",
    revision: null,
    conceptName: null,
    contextRefs: [],
    raw: {},
  };
}

function executionPreviewNode(execution: ScopePipelineExecution | null): ArtifactLineageNode | null {
  if (!execution) return null;
  return attachedFilePreviewNode(execution)
    ?? execution.producedArtifacts[0]
    ?? execution.arrivedArtifacts[0]
    ?? null;
}

function sameWorkspacePath(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const normalise = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  return normalise(left) === normalise(right);
}

function executionChoiceLabel(execution: ScopePipelineExecution, sequence: number): string {
  const artifact = execution.producedArtifacts[0] ?? execution.arrivedArtifacts[0] ?? null;
  const subject = artifact ? artifactLabel(artifact) : execution.summary;
  const time = new Date(execution.createdAt).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  return `Run ${sequence} · ${subject} · ${time}`;
}

function routeLabel(route: ScopePipelineRoute): string {
  if (route.kind === "command-result") return `Produces ${route.eventType}`;
  if (route.kind === "actor-emission") return `Emits ${route.eventType}`;
  return route.eventType === "*" ? "Receives any Event" : `Receives ${route.eventType}`;
}

function nodeAccent(node: ScopeCompositionNode): { color: string; soft: string } {
  if (node.kind === "trigger") return { color: "#b39bd8", soft: "#292233" };
  if (node.kind === "actor") return { color: "#91b9a5", soft: "#1e3028" };
  return { color: "#d5ae73", soft: "#332a1d" };
}

function NodeCard({
  node,
  endpoints,
  execution,
  workspace,
  compact = false,
  onClick,
}: {
  node: ScopeCompositionNode;
  endpoints: EndpointRef[];
  execution: ScopePipelineExecution | null;
  workspace?: WorkspaceFsRef;
  compact?: boolean;
  onClick?: () => void;
}): React.ReactElement {
  const Tag = onClick ? "button" : "article";
  const previewNode = executionPreviewNode(execution);
  const previewIsImage = previewNode ? artifactFileKind(previewNode.path) === "image" : false;
  const accent = nodeAccent(node);
  return (
    <Tag
      {...(onClick ? { type: "button" as const, onClick } : {})}
      data-node-kind={nodeKind(node).toLowerCase()}
      style={{
        width: "100%", padding: compact ? 12 : 17, textAlign: "left", color: tk.ink,
        background: compact ? tk.surface : accent.soft,
        border: `1px solid ${accent.color}`,
        borderRadius: tk.r3, cursor: onClick ? "pointer" : "default",
        boxShadow: compact ? "none" : `0 0 0 2px ${accent.soft}`,
      }}
    >
      {!compact && workspace && previewNode && (
        <div className={`scope-pipeline-focus__focus-preview${previewIsImage ? " scope-pipeline-focus__focus-preview--image" : ""}`}>
          <ArtifactPreview workspace={workspace} node={previewNode} variant={previewIsImage ? "hero" : "graph"} />
          <span>{execution?.attachedFilePath ? "File attached to Event" : "Current Artifact"}</span>
          <strong>{execution?.attachedFilePath ?? artifactLabel(previewNode)}</strong>
        </div>
      )}
      <span style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <span className="scope-pipeline-focus__kind" style={{ color: accent.color }}>{nodeKind(node)}</span>
        <span style={{ color: tk.ink4, fontSize: 10 }}>{execution?.state ?? "No execution selected"}</span>
      </span>
      {compact ? (
        <strong style={{ display: "block", marginTop: 6, fontSize: 12.5, fontWeight: 570 }}>{nodeLabel(node)}</strong>
      ) : (
        <h3 style={{ margin: "6px 0 0", fontSize: 17, fontWeight: 570 }}>{nodeLabel(node)}</h3>
      )}
      <span style={{ display: "block", marginTop: 4, color: tk.ink3, fontSize: 11.5, overflowWrap: "anywhere" }}>{nodeDetail(node, endpoints)}</span>
      {compact && workspace && previewNode && (
        <div className="scope-pipeline-focus__compact-preview">
          <ArtifactPreview workspace={workspace} node={previewNode} variant="graph" />
          <span>{execution?.attachedFilePath ? "File attached to Event" : "Current Artifact"}</span>
          <strong>{execution?.attachedFilePath ?? artifactLabel(previewNode)}</strong>
        </div>
      )}
      {node.kind === "trigger" && node.source?.kind === "folder" && !compact && (
        <span style={{ display: "block", marginTop: 11, color: tk.ink3, fontSize: 11 }}>Folder source · <code>{node.source.path}</code></span>
      )}
      {node.kind === "command" && !compact && (
        <code style={{ display: "block", marginTop: 11, color: tk.ink3, fontSize: 11, overflowWrap: "anywhere" }}>{node.command}</code>
      )}
    </Tag>
  );
}

function ArtifactEvidenceList({
  label,
  artifacts,
  workspace,
}: {
  label: string;
  artifacts: ArtifactLineageNode[];
  workspace?: WorkspaceFsRef;
}): React.ReactElement | null {
  if (artifacts.length === 0) return null;
  return (
    <section style={{ marginTop: 11 }}>
      <div style={{ marginBottom: 7, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))", gap: 7 }}>
        {artifacts.map((artifact) => (
          <div key={artifact.id} style={{ padding: 8, minWidth: 0, background: tk.surface, border: `1px solid ${tk.border2}`, borderRadius: tk.r2 }}>
            {workspace && <ArtifactPreview workspace={workspace} node={artifact} />}
            <div style={{ marginTop: workspace ? 7 : 0, color: tk.ink, fontSize: 11.5, fontWeight: 550, overflowWrap: "anywhere" }}>{artifactLabel(artifact)}</div>
            <div style={{ marginTop: 3, color: tk.ink4, fontSize: 10 }}>{artifact.type} · {artifact.status}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ExecutionEvidence({
  node,
  execution,
  contexts,
  workspace,
  onOpenContext,
}: {
  node: ScopeCompositionNode;
  execution: ScopePipelineExecution | null;
  contexts: ContextRef[];
  workspace?: WorkspaceFsRef;
  onOpenContext?: (contextId: string) => void;
}): React.ReactElement {
  if (!execution) {
    return <div style={{ marginTop: 14, color: tk.ink4, fontSize: 12 }}>No exact execution is selected for this route.</div>;
  }
  const context = contexts.find((candidate) => candidate.context_id === execution.contextId) ?? null;
  const attachedFile = attachedFilePreviewNode(execution);
  const attachedImageIntegrated = !!workspace && !!attachedFile && artifactFileKind(attachedFile.path) === "image";
  const arrivedArtifacts = attachedImageIntegrated
    ? execution.arrivedArtifacts.filter((artifact) => !sameWorkspacePath(artifact.path, attachedFile.path))
    : execution.arrivedArtifacts;
  return (
    <section style={{ marginTop: 16 }} aria-label="Selected execution evidence">
      <div style={{ marginBottom: 8, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Selected execution</div>
      {context && (
        <article style={{ padding: 11, background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div>
              <div style={{ color: tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Context</div>
              <div style={{ marginTop: 5, color: tk.ink, fontSize: 12.5, fontWeight: 560 }}>{executionContextLabel(execution, contexts)}</div>
              <code style={{ display: "block", marginTop: 4, color: tk.ink4, fontSize: 9.5, overflowWrap: "anywhere" }}>{context.context_id}</code>
            </div>
            {onOpenContext && (
              <button type="button" onClick={() => onOpenContext(context.context_id)} style={{
                flex: "0 0 auto", padding: "6px 8px", color: tk.accentHov, background: "transparent",
                border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 11,
              }}>Open Context</button>
            )}
          </div>
        </article>
      )}
      {node.kind === "trigger" && attachedFile && !attachedImageIntegrated && (
        <section style={{ marginTop: 11 }}>
          <div style={{ marginBottom: 7, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase" }}>File attached to Event</div>
          <div style={{ padding: 8, background: tk.surface, border: `1px solid ${tk.border2}`, borderRadius: tk.r2 }}>
            {workspace && <ArtifactPreview workspace={workspace} node={attachedFile} />}
            <div style={{ marginTop: workspace ? 7 : 0, color: tk.ink, fontSize: 11.5, fontWeight: 550, overflowWrap: "anywhere" }}>{execution.attachedFilePath}</div>
          </div>
        </section>
      )}
      <ArtifactEvidenceList label="Arrived with this Event" artifacts={arrivedArtifacts} workspace={workspace} />
      <ArtifactEvidenceList label="Current Artifacts from this execution" artifacts={execution.producedArtifacts} workspace={workspace} />
      {execution.arrivedArtifacts.length === 0 && execution.producedArtifacts.length === 0 && (
        <div style={{ marginTop: 10, color: tk.ink4, fontSize: 11.5 }}>No current Artifact has an event reference to this execution.</div>
      )}
    </section>
  );
}

type TrailEntry = {
  graphId: string;
  nodeId: string;
  executionId: string | null;
  selection: "latest" | "exact" | "none";
};

export function ScopePipelineFocusView({
  composition,
  contexts,
  events,
  deliveries,
  endpoints,
  workspace,
  artifactGraph,
  onOpenContext,
}: {
  composition: ScopeComposition;
  contexts: ContextRef[];
  events: EventEnvelope[];
  deliveries: DeliveryRow[];
  endpoints: EndpointRef[];
  workspace?: WorkspaceFsRef;
  artifactGraph?: ArtifactLineageGraph | null;
  onOpenContext?: (contextId: string) => void;
}): React.ReactElement {
  const projection = useMemo(
    () => buildScopePipelineFocusProjection({ composition, contexts, events, deliveries, artifactGraph }),
    [artifactGraph, composition, contexts, deliveries, events],
  );
  const initialEntry = useMemo<TrailEntry | null>(() => {
    const incoming = new Set(projection.routes.map((route) => route.targetNodeId));
    const item = projection.nodes.find((candidate) => candidate.node.kind === "trigger" && !incoming.has(candidate.node.node_id))
      ?? projection.nodes.find((candidate) => candidate.node.kind === "trigger")
      ?? projection.nodes[0]
      ?? null;
    return item ? {
      graphId: composition.graph_id,
      nodeId: item.node.node_id,
      executionId: null,
      selection: "latest",
    } : null;
  }, [composition.graph_id, projection]);
  const [trail, setTrail] = useState<TrailEntry[]>(() => initialEntry ? [initialEntry] : []);
  const [expandedExecutionNodeIds, setExpandedExecutionNodeIds] = useState<string[]>([]);
  const [openExecutionPickerNodeIds, setOpenExecutionPickerNodeIds] = useState<string[]>([]);

  useEffect(() => {
    setTrail((current) => {
      if (current.some((entry) => entry.graphId !== composition.graph_id)) {
        return initialEntry ? [initialEntry] : [];
      }
      const valid = current.filter((entry) => projection.nodes.some((item) => item.node.node_id === entry.nodeId));
      return valid.length > 0 ? valid : initialEntry ? [initialEntry] : [];
    });
  }, [composition.graph_id, initialEntry, projection.nodes]);

  const currentEntry = trail.at(-1) ?? null;
  const selected = projection.nodes.find((item) => item.node.node_id === currentEntry?.nodeId) ?? null;
  const selectedExecutionId = currentEntry?.selection === "latest"
    ? selected?.executions.at(-1)?.executionId ?? null
    : currentEntry?.executionId ?? null;
  const selectedExecution = selected?.executions.find((execution) => execution.executionId === selectedExecutionId) ?? null;
  const previousEntry = trail.at(-2) ?? null;
  const previous = projection.nodes.find((item) => item.node.node_id === previousEntry?.nodeId) ?? null;
  const previousExecutionId = previousEntry?.selection === "latest"
    ? previous?.executions.at(-1)?.executionId ?? null
    : previousEntry?.executionId ?? null;
  const previousExecution = previous?.executions.find((execution) => execution.executionId === previousExecutionId) ?? null;

  const candidateRoutes = selected ? projection.routes.filter((route) => {
    if (route.sourceNodeId !== selected.node.node_id) return false;
    if (route.kind === "actor-emission") {
      return !!selectedExecution?.deliveryId && route.sourceExecutionId === selectedExecution.deliveryId;
    }
    if (route.kind === "command-result" && route.sourceExecutionId) {
      return !!selectedExecution?.deliveryId && route.sourceExecutionId === selectedExecution.deliveryId;
    }
    return true;
  }) : [];
  const observedRouteKeys = new Set(candidateRoutes
    .filter((route) => route.targetExecutionId)
    .map((route) => [route.sourceNodeId, route.targetNodeId, route.kind, route.eventType].join(":")));
  const visibleRoutes = candidateRoutes.filter((route) =>
    !!route.targetExecutionId
    || !observedRouteKeys.has([route.sourceNodeId, route.targetNodeId, route.kind, route.eventType].join(":"))
  );
  const downstream = visibleRoutes.flatMap((route) => {
    const target = projection.nodes.find((item) => item.node.node_id === route.targetNodeId);
    return target ? [{ route, target }] : [];
  });

  function preferredExecution(route: ScopePipelineRoute, target: ScopePipelineNode): string | null {
    if (route.targetExecutionId) {
      return target.executions.find((execution) =>
        execution.executionId === route.targetExecutionId
        || execution.eventIds.includes(route.targetExecutionId!)
      )?.executionId ?? null;
    }
    if (route.kind === "subscription" && selectedExecution?.eventIds.length) {
      return target.executions.find((execution) =>
        !!execution.triggerEventId && selectedExecution.eventIds.includes(execution.triggerEventId)
      )?.executionId ?? null;
    }
    return null;
  }

  const downstreamWithEvidence = downstream.map(({ route, target }) => {
    const executionId = preferredExecution(route, target);
    const execution = target.executions.find((candidate) => candidate.executionId === executionId) ?? null;
    return { route, target, execution };
  });
  const actualDownstream = downstreamWithEvidence.filter((item) => item.execution != null);
  const primaryDownstream = actualDownstream.length > 0 ? actualDownstream : downstreamWithEvidence;
  const secondaryDownstream = actualDownstream.length > 0
    ? downstreamWithEvidence.filter((item) => item.execution == null)
    : [];

  const executionChoices = selected?.executions.slice().reverse() ?? [];
  const executionsExpanded = !!selected && expandedExecutionNodeIds.includes(selected.node.node_id);
  const executionPickerOpen = !!selected && openExecutionPickerNodeIds.includes(selected.node.node_id);
  const selectedExecutionIsEarlier = !!selectedExecution
    && executionChoices.findIndex((execution) => execution.executionId === selectedExecution.executionId) >= 6;
  const visibleExecutionChoices = executionsExpanded
    ? executionChoices
    : [
      ...executionChoices.slice(0, 6),
      ...(selectedExecutionIsEarlier ? [selectedExecution] : []),
    ];
  const earlierExecutionCount = Math.max(0, executionChoices.length - 6);
  const selectedExecutionSequence = selectedExecution && selected
    ? selected.executions.findIndex((execution) => execution.executionId === selectedExecution.executionId) + 1
    : 0;
  const selectedExecutionLabel = selectedExecution
    ? executionChoiceLabel(selectedExecution, selectedExecutionSequence)
    : "No execution selected";

  function follow(route: ScopePipelineRoute, target: ScopePipelineNode) {
    const executionId = preferredExecution(route, target);
    const next: TrailEntry = {
      graphId: composition.graph_id,
      nodeId: target.node.node_id,
      executionId,
      selection: executionId ? "exact" : "none",
    };
    setTrail((current) => [...current, next]);
  }

  function renderDownstreamRoute({
    route,
    target,
    execution,
  }: (typeof downstreamWithEvidence)[number]): React.ReactElement {
    const accent = nodeAccent(target.node);
    return (
      <button key={[route.sourceNodeId, route.targetNodeId, route.kind, route.eventType, route.targetExecutionId].join(":")} type="button" data-node-kind={nodeKind(target.node).toLowerCase()} onClick={() => follow(route, target)} aria-label={`Follow ${nodeLabel(target.node)}`} style={{
        width: "100%", padding: 12, textAlign: "left", color: tk.ink, background: execution ? accent.soft : tk.surface,
        border: `1px solid ${accent.color}`, borderRadius: tk.r3, cursor: "pointer",
      }}>
        <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span className="scope-pipeline-focus__kind" style={{ color: accent.color }}>{nodeKind(target.node)}</span>
          <span style={{ color: tk.ink4, fontSize: 10 }}>{execution?.state ?? "Planned"}</span>
        </span>
        <strong style={{ display: "block", marginTop: 6, fontSize: 12.5, fontWeight: 560 }}>{nodeLabel(target.node)}</strong>
        <span style={{ display: "block", marginTop: 4, color: tk.ink3, fontSize: 10.5 }}>{routeLabel(route)}</span>
      </button>
    );
  }

  if (!selected) {
    return <div style={{ padding: 24, color: tk.ink3, fontSize: 12.5 }}>This Scope has no composed nodes.</div>;
  }

  return (
    <section className="scope-pipeline-focus" aria-label="Focused Scope pipeline" style={{ height: "100%", overflow: "auto", padding: "18px 22px 34px", background: tk.canvas }}>
      <nav aria-label="Current pipeline path" style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
        {trail.map((entry, index) => {
          const item = projection.nodes.find((candidate) => candidate.node.node_id === entry.nodeId);
          if (!item) return null;
          const current = index === trail.length - 1;
          return (
            <React.Fragment key={`${entry.graphId}:${entry.nodeId}:${entry.selection}:${entry.executionId ?? "none"}:${index}`}>
              {index > 0 && <span aria-hidden="true" style={{ color: tk.ink4, fontSize: 11 }}>›</span>}
              <button type="button" onClick={() => setTrail(trail.slice(0, index + 1))} aria-current={current ? "step" : undefined} style={{
                padding: "4px 6px", color: current ? tk.ink : tk.ink3,
                background: current ? tk.surfaceHov : "transparent", border: "none",
                borderRadius: tk.r1, cursor: "pointer", fontSize: 11.5,
              }}>{nodeLabel(item.node)}</button>
            </React.Fragment>
          );
        })}
      </nav>

      <div className="scope-pipeline-focus__layout">
        <section aria-label="Previous pipeline step">
          <div style={{ marginBottom: 8, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Previous layer</div>
          {previous ? (
            <NodeCard node={previous.node} endpoints={endpoints} execution={previousExecution} workspace={workspace} compact onClick={() => setTrail(trail.slice(0, -1))} />
          ) : (
            <div style={{ padding: 12, color: tk.ink4, fontSize: 11.5 }}>Start of the selected path.</div>
          )}
        </section>
        {previous ? <div className="scope-pipeline-focus__connector" aria-hidden="true" /> : <div aria-hidden="true" />}
        <section aria-label="Focused pipeline step">
          <div style={{ marginBottom: 8, color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Focused step</div>
          <NodeCard node={selected.node} endpoints={endpoints} execution={selectedExecution} workspace={workspace} />
          {selected.executions.length > 1 && (
            <div className="scope-pipeline-focus__run-picker">
              <button
                type="button"
                aria-expanded={executionPickerOpen}
                onClick={() => setOpenExecutionPickerNodeIds((current) => executionPickerOpen
                  ? current.filter((nodeId) => nodeId !== selected.node.node_id)
                  : [...current, selected.node.node_id]
                )}
              >
                <span>{selectedExecutionLabel}</span>
                <strong>{executionPickerOpen ? "Hide runs" : "Change run"}</strong>
              </button>
              {executionPickerOpen && (
                <div aria-label="Executions for focused step" className="scope-pipeline-focus__run-choices">
                  {visibleExecutionChoices.map((execution) => (
                    <button key={execution.executionId} type="button" aria-pressed={execution.executionId === selectedExecution?.executionId} onClick={() => {
                      setTrail((current) => [...current.slice(0, -1), {
                        graphId: composition.graph_id,
                        nodeId: selected.node.node_id,
                        executionId: execution.executionId,
                        selection: "exact",
                      }]);
                      setOpenExecutionPickerNodeIds((current) => current.filter((nodeId) => nodeId !== selected.node.node_id));
                    }} style={{
                      padding: "5px 7px", color: execution.executionId === selectedExecution?.executionId ? tk.ink : tk.ink3,
                      background: execution.executionId === selectedExecution?.executionId ? tk.accentSoft : "transparent",
                      border: `1px solid ${execution.executionId === selectedExecution?.executionId ? tk.accent : tk.border}`,
                      borderRadius: tk.r2, cursor: "pointer", fontSize: 10.5,
                    }}>{executionChoiceLabel(execution, selected.executions.findIndex((candidate) => candidate.executionId === execution.executionId) + 1)}</button>
                  ))}
                  {earlierExecutionCount > 0 && (
                    <button type="button" onClick={() => setExpandedExecutionNodeIds((current) => executionsExpanded
                      ? current.filter((nodeId) => nodeId !== selected.node.node_id)
                      : [...current, selected.node.node_id]
                    )} style={{
                      padding: "5px 7px", color: tk.accentHov, background: "transparent",
                      border: `1px solid ${tk.border}`, borderRadius: tk.r2, cursor: "pointer", fontSize: 10.5,
                    }}>{executionsExpanded ? "Show latest 6" : `Show ${earlierExecutionCount} earlier ${earlierExecutionCount === 1 ? "run" : "runs"}`}</button>
                  )}
                </div>
              )}
            </div>
          )}
          <ExecutionEvidence node={selected.node} execution={selectedExecution} contexts={contexts} workspace={workspace} onOpenContext={onOpenContext} />
        </section>
        {primaryDownstream.length > 0 ? <div className="scope-pipeline-focus__connector" aria-hidden="true" /> : <div aria-hidden="true" />}
        <aside aria-label="Immediate downstream Scope nodes">
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
            <span style={{ color: tk.ink4, fontSize: 9.5, letterSpacing: "0.09em", textTransform: "uppercase" }}>Next layer</span>
            <span style={{ color: tk.ink4, fontSize: 10 }}>{actualDownstream.length > 0 ? `${actualDownstream.length} observed` : `${downstream.length} planned`}</span>
          </div>
          {primaryDownstream.length > 0 ? (
            <div style={{ display: "grid", gap: 9 }}>
              {primaryDownstream.map(renderDownstreamRoute)}
              {secondaryDownstream.length > 0 && (
                <details className="scope-pipeline-focus__planned-routes">
                  <summary>Other planned routes ({secondaryDownstream.length})</summary>
                  <div>{secondaryDownstream.map(renderDownstreamRoute)}</div>
                </details>
              )}
            </div>
          ) : (
            <div style={{ padding: 12, color: tk.ink4, fontSize: 11.5 }}>No exact downstream route is available from this selected execution.</div>
          )}
        </aside>
      </div>
    </section>
  );
}
