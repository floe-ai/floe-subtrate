import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Check,
  Edit3,
  FolderOpen,
  FolderPlus,
  Home,
  LayoutPanelLeft,
  Loader,
  MessageSquare,
  RefreshCw,
  Send,
  Settings,
  SquareDashedMousePointer,
  Workflow,
  X
} from "lucide-react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
  type Connection,
  type Edge as ReactFlowEdge,
  type EdgeChange,
  type EdgeProps,
  type Node as ReactFlowNode,
  type NodeChange,
  type NodeProps,
  type Viewport
} from "@xyflow/react";
import "./styles.css";
import {
  buildActivityRows,
  contextActivityLabel,
  filterActivityRows,
  parseTelemetryPayload,
  runtimeActivityLabel,
  summarizeTelemetry,
  telemetryContextId,
  type ActivityFilters,
  type ActivityRow
} from "./activity";
import {
  buildEmitBody,
  canAssignContextToScope,
  contextParticipationLabel,
  contextLabel,
  contextScopeAssignmentStatus,
  sortContextsForAgent,
  sortWorkspaceContexts,
  workspaceContextLabel,
  type ContextEvent,
  type ContextSummary
} from "./contexts";
import { assignContextToScope } from "./context-assignment-api";
import {
  applyNodeChangesToLayout,
  reactFlowToLayout,
  type FieldLayoutFloeweb,
  type FieldItemNodeData,
  type FieldSummary
} from "./fields";
import {
  createScope,
  getScopeProjection,
  getScopeProjectionLayout,
  listScopes,
  parseScopeProjectionStreamMessage,
  putScopeProjectionLayout,
  renameScope
} from "./scope-projection-api";
import {
  addPulseContextSubscriber,
  projectionSubscriberFromConnection,
  projectionSubscriberFromEdgeId,
  projectionToReactFlow,
  removePulseContextSubscriber,
  type ScopeProjection,
  type ScopeRecord
} from "./scope-projection";
import {
  buildActorInspectorSummary,
  buildScopeInspectorSummary,
  buildWorkspaceInspectorSummary
} from "./inspector-view-model";
import { buildWorkspaceHomeModel } from "./home-view-model";
import { DialogHost, confirm as confirmDialog, confirmWithOptions, prompt as promptDialog } from "./dialog/dialog";
import { subscribePulse, unsubscribePulse } from "./pulse-api";

type Workspace = {
  workspace_id: string;
  name: string;
  locator: string;
  status: string;
  init_authorized: number;
  active_config_hash?: string | null;
};

type Endpoint = {
  endpoint_id: string;
  workspace_id: string;
  name: string;
  status: string;
  agent_id?: string | null;
  metadata_json?: string;
};

type AuthProfile = { id: string; provider: string; model?: string; label?: string };

type RuntimeBinding = {
  binding_key: string;
  scope: "agent" | "workspace_default" | "global_default";
  workspace_id: string | null;
  endpoint_id: string | null;
  auth_profile: string;
  model: string | null;
};
type LocalConfigStatus = {
  bridge?: {
    runtime_adapter?: string | null;
  };
};

type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  contextWindow?: number;
  api?: string;
};

type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  source_endpoint_id: string | null;
  destination_json: { kind: "endpoint" | "broadcast"; endpoint_id?: string };
  thread_id?: string | null;
  context_id?: string | null;
  content: { text?: string; data?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
  created_at: string;
};

type TelemetryRecord = {
  telemetry_id: string;
  workspace_id: string;
  endpoint_id: string;
  delivery_id: string | null;
  kind: string;
  payload_json: string;
  created_at: string;
};

type RuntimeActivity= {
  id: string;
  kind: string;
  summary: string;
  time: string;
  files_touched?: string[];
  duration_ms?: number;
  toolCallId?: string;
};

type ActivityGroup = {
  id: string;
  items: RuntimeActivity[];
  status: "working" | "done";
  label: string;
};

type ChatSegment =
  | { kind: "message"; message: EventEnvelope; activity?: ActivityGroup }
  | { kind: "pulse"; event: ContextEvent }
  | { kind: "activity"; group: ActivityGroup }
  | { kind: "streaming"; turnId: string; text: string };

type View =
  | { kind: "home" }
  | { kind: "activity" }
  | { kind: "field"; fieldId: string; backStack?: string[] };

type FieldConnectionEdgeData = Record<string, unknown> & {
  label: string;
  isEditing: boolean;
  draft: string;
  onBeginEdit?: (id: string, label: string) => void;
  onDraftChange: (value: string) => void;
  onCommit: (id: string) => void;
  onCancel: () => void;
};

type FieldConnectionEdge = ReactFlowEdge<FieldConnectionEdgeData, "fieldConnection">;

type LoadedScopeProjection = {
  scope: ScopeRecord;
  projection: ScopeProjection;
  layout: FieldLayoutFloeweb | null;
};

const defaultBusUrl = localStorage.getItem("floe.busUrl") ?? "http://127.0.0.1:5377";

const runtimeErrorKinds = new Set([
  "runtime_error",
  "runtime_no_visible_output",
  "provider_auth_missing",
  "runtime_profile_provider_mismatch",
  "runtime_model_required",
  "runtime_model_unknown",
  "runtime_provider_required",
  "runtime_profile_required"
]);
const fieldPrimitiveMime = "application/x-floe-field-primitive";

function FieldItemNode({ data }: NodeProps) {
  const item = data as FieldItemNodeData & {
    context_id?: string;
    onOpenContext?: (contextId: string) => void;
    participant_count?: number;
    subscriber_count?: number;
  };
  const subtitle = item.kind === "context" && typeof item.participant_count === "number"
    ? `${item.participant_count} participant${item.participant_count === 1 ? "" : "s"}`
    : item.kind === "pulse" && typeof item.subscriber_count === "number"
    ? `${item.subscriber_count} subscriber${item.subscriber_count === 1 ? "" : "s"}`
    : "";
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <div
        className="canvas-field-node"
        title={item.kind === "actor" ? item.label : item.ref.raw}
        data-kind={item.kind}
      >
        <span>{item.label}</span>
        {subtitle && <small>{subtitle}</small>}
        {item.kind === "context" && item.context_id && item.onOpenContext && (
          <button
            type="button"
            className="canvas-node-action nodrag nopan"
            onClick={() => item.onOpenContext?.(item.context_id as string)}
          >
            Open
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

const fieldNodeTypes = {
  fieldItem: FieldItemNode
};

function FieldConnectionEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  markerStart,
  style,
  data
}: EdgeProps<FieldConnectionEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });
  const label = data?.label ?? "";
  const draft = data?.draft ?? label;
  const isEditing = data?.isEditing ?? false;
  const showLabel = isEditing || label.trim().length > 0;

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerStart={markerStart} markerEnd={markerEnd} style={style} />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className={`field-edge-label${isEditing ? " editing" : ""}`}
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all"
            }}
          >
            {isEditing ? (
              <input
                className="nodrag nopan"
                aria-label="Connection label"
                value={draft}
                placeholder="Label"
                autoFocus
                onChange={(event) => data?.onDraftChange(event.target.value)}
                onBlur={() => data?.onCommit(id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    data?.onCommit(id);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    data?.onCancel();
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="field-edge-label-button nodrag nopan"
                aria-label={`Edit connection label ${label}`}
                onClick={() => data?.onBeginEdit?.(id, label)}
              >
                {label}
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const fieldEdgeTypes = {
  fieldConnection: FieldConnectionEdgeComponent
};

function layoutsEqual(a: FieldLayoutFloeweb, b: FieldLayoutFloeweb): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type PendingLayoutSave = {
  workspaceId: string;
  fieldId: string;
  layout: FieldLayoutFloeweb;
};

function fieldLayoutKey(workspaceId: string, fieldId: string): string {
  return `${workspaceId}\u0000${fieldId}`;
}

function App() {
  const reactFlow = useReactFlow();
  const [busUrl, setBusUrl] = useState(defaultBusUrl);
  const [showBusSettings, setShowBusSettings] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [authorizeInit, setAuthorizeInit] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceCreateOpen, setWorkspaceCreateOpen] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryRecord[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [runtimeBindings, setRuntimeBindings] = useState<RuntimeBinding[]>([]);
  const [bridgeRuntimeKnown, setBridgeRuntimeKnown] = useState(false);
  const [bridgeRuntimeAdapter, setBridgeRuntimeAdapter] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const [fieldSummaries, setFieldSummaries] = useState<FieldSummary[]>([]);
  const [showAllFields, setShowAllFields] = useState(false);
  const [scopeRecords, setScopeRecords] = useState<ScopeRecord[]>([]);
  const [loadedProjection, setLoadedProjection] = useState<LoadedScopeProjection | null>(null);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [selectedFieldItemIds, setSelectedFieldItemIds] = useState<Set<string>>(() => new Set());
  const [selectedFieldConnectionId, setSelectedFieldConnectionId] = useState<string | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [channelMessage, setChannelMessage] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [contexts, setContexts] = useState<ContextSummary[]>([]);
  const [workspaceContexts, setWorkspaceContexts] = useState<ContextSummary[]>([]);
  const [activityContexts, setActivityContexts] = useState<ContextSummary[]>([]);
  const [activityFilters, setActivityFilters] = useState<ActivityFilters>({
    actorId: "all",
    kind: "all",
    scopeId: "all",
    contextId: "all"
  });
  const [selectedActivityRowId, setSelectedActivityRowId] = useState<string | null>(null);
  const [selectedContextId, setSelectedContextId] = useState<string | null>(null);
  const [contextAssignmentTargets, setContextAssignmentTargets] = useState<Record<string, string>>({});
  const [contextEventsState, setContextEventsState] = useState<{ contextId: string | null; events: ContextEvent[] }>({
    contextId: null,
    events: []
  });
  const [draftMode, setDraftMode] = useState(false);
  const [pulseLabels, setPulseLabels] = useState<Record<string, string>>({});
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("Connecting");
  const [error, setError] = useState<string | null>(null);
  const selectedWorkspaceIdRef = useRef("");
  const viewRef = useRef<View>({ kind: "home" });
  const loadedProjectionRef = useRef<LoadedScopeProjection | null>(null);
  const restoredViewportKeyRef = useRef<string | null>(null);
  const layoutSaveTimersRef = useRef<Map<string, number>>(new Map());
  const pendingLayoutSavesRef = useRef<Map<string, PendingLayoutSave>>(new Map());
  const localLayoutWriteUntilRef = useRef<Map<string, number>>(new Map());
  const autoInitializedLayoutRef = useRef<Set<string>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);
  const contextsRequestRef = useRef(0);
  const activityContextsRequestRef = useRef(0);
  const contextEventsRequestRef = useRef(0);

  const selectedWorkspace = workspaces.find((item) => item.workspace_id === selectedWorkspaceId) ?? null;
  const selfActorId = selectedWorkspace ? operatorActorId(selectedWorkspace.workspace_id) : "";
  const operatorEndpoint = endpoints.find((endpoint) => endpoint.endpoint_id === selfActorId) ?? null;
  const operatorDisplayName = endpointDisplayName(operatorEndpoint) ?? "You";
  const agents = endpoints.filter((endpoint) => endpoint.endpoint_id !== selfActorId);
  const selectedAgent =
    agents.find((endpoint) => endpoint.endpoint_id === selectedAgentId) ??
    agents.find((endpoint) => endpoint.agent_id === selectedAgentId) ??
    agents[0] ??
    null;
  const floeAgent = selectedAgent; // alias for backward compat in existing rendering code
  const humanEndpoint = selfActorId;

  const sortedContexts = useMemo(() => {
    if (!selectedAgent || !humanEndpoint) {
      return { sorted: [] as ContextSummary[], defaultContextId: null as string | null };
    }
    return sortContextsForAgent(contexts, humanEndpoint, selectedAgent.endpoint_id);
  }, [contexts, selectedAgent, humanEndpoint]);
  const scopeTitlesById = useMemo(
    () => Object.fromEntries(scopeRecords.map((scope) => [scope.scope_id, scope.title])),
    [scopeRecords]
  );
  const recentWorkspaceContexts = useMemo(
    () => sortWorkspaceContexts(workspaceContexts).slice(0, 6),
    [workspaceContexts]
  );

  const projectedSelectedContext = selectedContextId && loadedProjection
    ? (() => {
      const ref = loadedProjection.projection.refs.contexts.find((context) => context.context_id === selectedContextId);
      if (!ref) return null;
      const participants = loadedProjection.projection.relationships.context_participants
        .filter((participant) => participant.context_id === selectedContextId)
        .map((participant) => participant.endpoint_id);
      return {
        ...ref,
        created_by_endpoint_id: ref.created_by_endpoint_id || null,
        participants
      } satisfies ContextSummary;
    })()
    : null;
  const selectedContext = selectedContextId
    ? contexts.find((c) => c.context_id === selectedContextId) ??
      workspaceContexts.find((c) => c.context_id === selectedContextId) ??
      activityContexts.find((c) => c.context_id === selectedContextId) ??
      projectedSelectedContext ??
      null
    : null;
  const contextEvents = contextEventsState.contextId === selectedContextId ? contextEventsState.events : [];
  const selectedContextCanMessage = !selectedContextId
    ? true
    : selectedContext?.participants.includes(humanEndpoint) === true;
  const selectedFieldSummary = view.kind === "field"
    ? fieldSummaries.find((field) => field.id === view.fieldId) ?? null
    : null;
  const selectedScopeRecord = view.kind === "field"
    ? scopeRecords.find((scope) => scope.scope_id === view.fieldId) ?? null
    : null;
  const inspectorActor = view.kind === "home" && selectedAgentId ? selectedAgent : null;
  const rootFieldSummaries = useMemo(() => fieldSummaries, [fieldSummaries]);
  const homeFieldSummaries = showAllFields ? fieldSummaries : rootFieldSummaries;
  const nestedFieldCount = fieldSummaries.length - rootFieldSummaries.length;
  const activityRows = useMemo(() => buildActivityRows({
    events,
    telemetry,
    contexts: activityContexts,
    endpoints,
    scopes: scopeRecords
  }), [activityContexts, endpoints, events, scopeRecords, telemetry]);
  const filteredActivityRows = useMemo(
    () => filterActivityRows(activityRows, activityFilters),
    [activityFilters, activityRows]
  );
  const selectedActivityRow = useMemo<ActivityRow | null>(() => {
    if (!selectedActivityRowId) return null;
    return activityRows.find((row) => row.id === selectedActivityRowId) ?? null;
  }, [activityRows, selectedActivityRowId]);
  const selectedActivityContext = useMemo(() => {
    if (!selectedActivityRow?.contextId) return null;
    return activityContexts.find((context) => context.context_id === selectedActivityRow.contextId) ?? null;
  }, [activityContexts, selectedActivityRow]);
  const activityContextOptions = useMemo(() => {
    return sortWorkspaceContexts(activityContexts).filter((context) => {
      if (activityFilters.scopeId === "workspace") return context.scope_id === null;
      if (activityFilters.scopeId !== "all") return context.scope_id === activityFilters.scopeId;
      return true;
    });
  }, [activityContexts, activityFilters.scopeId]);
  const openedScopeContexts = useMemo(() => (
    view.kind === "field" && loadedProjection
      ? loadedProjection.projection.refs.contexts
      : []
  ), [loadedProjection, view]);
  const workspaceInspectorSummary = useMemo(() => buildWorkspaceInspectorSummary({
    namedScopeCount: scopeRecords.length,
    scopeBackedFieldCount: fieldSummaries.length,
    contexts: activityContexts,
    eventCount: events.length,
    telemetryCount: telemetry.length,
    endpointCount: endpoints.length
  }), [activityContexts, endpoints.length, events.length, fieldSummaries.length, scopeRecords.length, telemetry.length]);
  const scopeInspectorSummary = useMemo(() => (
    view.kind === "field"
      ? buildScopeInspectorSummary({
        scopeId: view.fieldId,
        projection: loadedProjection?.projection ?? null,
        activityRows
      })
      : null
  ), [activityRows, loadedProjection, view]);

  const workspaceBinding = selectedWorkspace
    ? runtimeBindings.find((binding) => binding.scope === "workspace_default" && binding.workspace_id === selectedWorkspace.workspace_id)
    : undefined;
  const agentBinding = floeAgent
    ? runtimeBindings.find((binding) => binding.scope === "agent" && binding.endpoint_id === floeAgent.endpoint_id)
    : undefined;
  const effectiveProfileId = agentBinding?.auth_profile || workspaceBinding?.auth_profile || null;
  const effectiveProfile = authProfiles.find((profile) => profile.id === effectiveProfileId) ?? null;
  const effectiveModel = agentBinding?.model ?? workspaceBinding?.model ?? null;
  const selectedAgentRuntimeAdapter = useMemo(() => endpointRuntimeAdapter(selectedAgent), [selectedAgent]);
  const workspaceModelOptions = useMemo(() => {
    const selectedModel = workspaceBinding?.model;
    if (!selectedModel || availableModels.some((model) => model.id === selectedModel)) return availableModels;
    return [
      ...availableModels,
      {
        id: selectedModel,
        name: selectedModel,
        provider: effectiveProfile?.provider ?? "",
        reasoning: false
      }
    ];
  }, [availableModels, effectiveProfile?.provider, workspaceBinding?.model]);
  const runtimeReady = !!effectiveProfileId && !!effectiveModel;
  const bridgeRuntimeAdapterName = selectedAgentRuntimeAdapter
    ? selectedAgentRuntimeAdapter
    : bridgeRuntimeKnown
    ? (bridgeRuntimeAdapter?.trim().toLowerCase() || "fake")
    : null;
  const runtimeBlockedByFakeAdapter =
    runtimeReady &&
    bridgeRuntimeAdapterName === "fake" &&
    !!effectiveProfile &&
    effectiveProfile.provider !== "fake";
  const canMessageRuntime = runtimeReady && !runtimeBlockedByFakeAdapter;
  const canUseChannelComposer = canMessageRuntime && selectedContextCanMessage;
  const homeContextsForSummary = activityContexts.length > 0 ? activityContexts : workspaceContexts;
  const homeModel = useMemo(() => buildWorkspaceHomeModel({
    scopes: scopeRecords,
    contexts: homeContextsForSummary,
    activityRows,
    endpoints,
    operatorEndpointId: selfActorId,
    authProfileCount: authProfiles.length,
    bridgeRuntimeKnown,
    bridgeRuntimeAdapter: bridgeRuntimeAdapterName,
    runtimeBindings,
    effectiveProfileId,
    effectiveModel
  }), [
    activityRows,
    authProfiles.length,
    bridgeRuntimeAdapterName,
    bridgeRuntimeKnown,
    effectiveModel,
    effectiveProfileId,
    endpoints,
    homeContextsForSummary,
    runtimeBindings,
    scopeRecords,
    selfActorId
  ]);

  const floeMessages = useMemo<EventEnvelope[]>(() => {
    if (!floeAgent || !selectedContextId) return [];
    return contextEvents
      .filter((event) => event.type === "message")
      .map((event) => ({
        event_id: event.event_id,
        type: event.type,
        workspace_id: selectedWorkspace?.workspace_id ?? "",
        source_endpoint_id: event.source_endpoint_id,
        destination_json: event.destination_json,
        context_id: event.context_id,
        content: event.content,
        metadata: event.metadata,
        created_at: event.created_at
      }))
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }, [contextEvents, floeAgent, selectedContextId, selectedWorkspace?.workspace_id]);

  const streamingTurns = useMemo(() => {
    if (!floeAgent || !selectedContextId) return {};
    // A turn is finished when its emit produced a message event in the context
    const finished = new Set<string>();
    for (const event of contextEvents) {
      if (event.type === "message" && event.source_endpoint_id === floeAgent.endpoint_id) {
        const turnId = event.content?.data?.runtime_turn_id ?? event.metadata?.runtime_turn_id;
        if (typeof turnId === "string") finished.add(turnId);
      }
    }
    const latest: Record<string, { text: string; created_at: string }> = {};
    for (const record of telemetry) {
      if (record.endpoint_id !== floeAgent.endpoint_id || record.kind !== "visible_output") continue;
      const payload = parseTelemetryPayload(record);
      if (!payload) continue;
      const turnId = payload.runtime_turn_id;
      if (typeof turnId !== "string" || finished.has(turnId)) continue;
      if (payload.context_id !== selectedContextId) continue;
      if (!latest[turnId] || record.created_at > latest[turnId].created_at) {
        latest[turnId] = { text: String(payload.text ?? ""), created_at: record.created_at };
      }
    }
    return latest;
  }, [contextEvents, floeAgent, telemetry, selectedContextId]);

  const runtimeActivity = useMemo<RuntimeActivity[]>(() => {
    if (!floeAgent) return [];
    return telemetry
      .filter((record) => record.endpoint_id === floeAgent.endpoint_id)
      .slice(-10)
      .reverse()
      .map((record) => ({
        id: record.telemetry_id,
        kind: runtimeActivityLabel(record.kind),
        summary: summarizeTelemetry(record),
        time: new Date(record.created_at).toLocaleTimeString()
      }));
  }, [floeAgent, telemetry]);

  const floeIsActive = floeAgent?.status === "active";
  const inspectorActorContexts = inspectorActor ? sortedContexts.sorted : [];
  const actorInspectorSummary = inspectorActor
    ? buildActorInspectorSummary({
      actorId: inspectorActor.endpoint_id,
      contexts: inspectorActorContexts,
      activityRows,
      runtimeBinding: agentBinding,
      adapter: selectedAgentRuntimeAdapter ?? bridgeRuntimeAdapterName
    })
    : null;

  const chatSegments = useMemo<ChatSegment[]>(() => {
    if (!floeAgent || !selectedContextId) return [];
    const excludedKinds = new Set(["usage", "runtime_config", "visible_output", "runtime_no_visible_output", "visible_output_worklog"]);
    const agentTelemetry = telemetry
      .filter((record) => record.endpoint_id === floeAgent.endpoint_id)
      .filter((record) => telemetryContextId(record) === selectedContextId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    const messages = [...floeMessages].sort((a, b) => a.created_at.localeCompare(b.created_at));

    function telemetryToActivity(record: TelemetryRecord): RuntimeActivity {
      let filesTouched: string[] | undefined;
      let durationMs: number | undefined;
      let toolCallId: string | undefined;
      const payload = parseTelemetryPayload(record);
      if (payload) {
        if (Array.isArray(payload.files_touched)) filesTouched = payload.files_touched as string[];
        if (typeof payload.duration_ms === "number") durationMs = payload.duration_ms;
        if (typeof payload.toolCallId === "string") toolCallId = payload.toolCallId;
      }
      return {
        id: record.telemetry_id,
        kind: runtimeActivityLabel(record.kind),
        summary: summarizeTelemetry(record),
        time: new Date(record.created_at).toLocaleTimeString(),
        files_touched: filesTouched,
        duration_ms: durationMs,
        toolCallId,
      };
    }

    // Merge tool activity by toolCallId: when AfterToolUse arrives for an existing
    // BeforeToolUse, replace the "Running" row with the resolved row (Completed/Failed).
    // This ensures completed tool calls show as a single final-state row.
    function mergeActivity(list: RuntimeActivity[], item: RuntimeActivity): void {
      if (item.toolCallId && (item.kind === "Completed" || item.kind === "Failed")) {
        const startIdx = list.findIndex(
          (existing) => existing.toolCallId === item.toolCallId && existing.kind === "Running"
        );
        if (startIdx !== -1) {
          // Replace the Running row with the resolved one, preserving position
          list[startIdx] = item;
          return;
        }
      }
      list.push(item);
    }

    // Semantic grouping: attach tool/runtime activity TO the agent message it precedes.
    // Only emitted messages appear as primary chat items.
    // Orphaned old telemetry before a human message is discarded (previous cycle).
    const segments: ChatSegment[] = [];
    let telemetryIndex = 0;
    let pendingActivity: RuntimeActivity[] = [];

    for (const message of messages) {
      // Collect telemetry that occurred at or before this message timestamp.
      // Use <= because tool calls (e.g. emit) often share the same second as
      // the message event they produce.
      while (telemetryIndex < agentTelemetry.length && agentTelemetry[telemetryIndex].created_at <= message.created_at) {
        const record = agentTelemetry[telemetryIndex];
        if (!excludedKinds.has(record.kind)) {
          mergeActivity(pendingActivity, telemetryToActivity(record));
        }
        telemetryIndex++;
      }
      const isSelf = message.source_endpoint_id === humanEndpoint;
      if (isSelf) {
        // Self (operator) message starts a new processing cycle.
        // Any pending activity is orphaned from a prior cycle — discard it.
        pendingActivity = [];
        segments.push({ kind: "message", message });
      } else if (pendingActivity.length > 0) {
        // Attach accumulated activity to this agent message
        segments.push({
          kind: "message",
          message,
          activity: {
            id: `activity_${pendingActivity[0].id}`,
            items: pendingActivity,
            status: "done",
            label: activityGroupLabel(pendingActivity)
          }
        });
        pendingActivity = [];
      } else {
        segments.push({ kind: "message", message });
      }
    }

    // Trailing telemetry (agent is still working or finished without emitting)
    while (telemetryIndex < agentTelemetry.length) {
      const record = agentTelemetry[telemetryIndex];
      if (!excludedKinds.has(record.kind)) {
        mergeActivity(pendingActivity, telemetryToActivity(record));
      }
      telemetryIndex++;
    }
    // Only show trailing activity if the agent is actively working OR if there
    // are genuinely unresolved items. After merging, "Running" items only exist
    // for tool calls that haven't completed yet.
    const hasUnresolved = pendingActivity.some((item) => item.kind === "Running");
    if (pendingActivity.length > 0 && (floeIsActive || hasUnresolved)) {
      segments.push({
        kind: "activity",
        group: {
          id: `activity_trailing`,
          items: pendingActivity,
          status: floeIsActive ? "working" : "done",
          label: floeIsActive ? activityWorkingLabel(pendingActivity) : activityGroupLabel(pendingActivity)
        }
      });
    }

    const pulseSegments: ChatSegment[] = contextEvents
      .filter((event) => event.type === "pulse.fired")
      .map((event) => ({ kind: "pulse", event }));
    const orderedSegments = [...segments, ...pulseSegments].sort((left, right) =>
      chatSegmentCreatedAt(left).localeCompare(chatSegmentCreatedAt(right))
    );

    // Append streaming turns
    for (const [turnId, turn] of Object.entries(streamingTurns)) {
      orderedSegments.push({ kind: "streaming", turnId, text: turn.text });
    }

    return orderedSegments;
  }, [floeAgent, floeMessages, floeIsActive, humanEndpoint, streamingTurns, telemetry, selectedContextId, contextEvents]);

  const latestRuntimeError = useMemo(() => {
    if (!floeAgent) return null;
    const items = telemetry.filter((record) => record.endpoint_id === floeAgent.endpoint_id);
    const latest = items.at(-1);
    return latest && runtimeErrorKinds.has(latest.kind) ? latest : null;
  }, [floeAgent, telemetry]);

  const refreshContexts = useCallback(async (workspaceId: string, participantEndpointId?: string) => {
    try {
      const participantId = participantEndpointId ?? selectedAgent?.endpoint_id ?? operatorActorId(workspaceId);
      const requestId = ++contextsRequestRef.current;
      const result = await api<{ contexts: ContextSummary[] }>(
        busUrl,
        `/v1/contexts?participant=${encodeURIComponent(participantId)}&workspace_id=${encodeURIComponent(workspaceId)}`
      );
      if (requestId !== contextsRequestRef.current) return;
      setContexts(result.contexts);
    } catch {
      // Non-fatal — keep showing whatever we already have.
    }
  }, [busUrl, selectedAgent?.endpoint_id]);

  const refreshWorkspaceContexts = useCallback(async (workspaceId: string) => {
    try {
      const result = await api<{ contexts: ContextSummary[] }>(
        busUrl,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope=unscoped&limit=6`
      );
      setWorkspaceContexts(result.contexts);
    } catch {
      setWorkspaceContexts([]);
    }
  }, [busUrl]);

  const refreshActivityContexts = useCallback(async (workspaceId: string) => {
    const requestId = ++activityContextsRequestRef.current;
    try {
      const result = await api<{ contexts: ContextSummary[] }>(
        busUrl,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/contexts?scope=all&limit=200`
      );
      if (requestId !== activityContextsRequestRef.current) return;
      if (workspaceId !== selectedWorkspaceIdRef.current) return;
      setActivityContexts(result.contexts);
    } catch {
      if (requestId !== activityContextsRequestRef.current) return;
      if (workspaceId !== selectedWorkspaceIdRef.current) return;
      setActivityContexts([]);
    }
  }, [busUrl]);

  const refreshContextEvents = useCallback(async (contextId: string) => {
    const requestId = ++contextEventsRequestRef.current;
    try {
      const result = await api<{ events: ContextEvent[] }>(
        busUrl,
        `/v1/contexts/${encodeURIComponent(contextId)}/events`
      );
      if (requestId !== contextEventsRequestRef.current) return;
      setContextEventsState({ contextId, events: result.events });
    } catch {
      if (requestId !== contextEventsRequestRef.current) return;
      setContextEventsState({ contextId, events: [] });
    }
  }, [busUrl]);

  function clearContextEvents() {
    contextEventsRequestRef.current += 1;
    setContextEventsState({ contextId: null, events: [] });
  }

  const openProjectedContext = useCallback((contextId: string) => {
    const projection = loadedProjectionRef.current?.projection;
    const participants = projection?.relationships.context_participants
      .filter((participant) => participant.context_id === contextId)
      .map((participant) => participant.endpoint_id) ?? [];
    const fallbackActor = participants.find((participant) =>
      participant !== selfActorId && endpoints.some((endpoint) => endpoint.endpoint_id === participant)
    );
    if (fallbackActor) {
      setSelectedAgentId(fallbackActor);
    }
    setSelectedContextId(contextId);
    setDraftMode(false);
    setChannelOpen(true);
    void refreshContextEvents(contextId);
  }, [endpoints, refreshContextEvents, selfActorId]);

  const openWorkspaceContext = useCallback((context: ContextSummary) => {
    const selectedParticipates = selectedAgent
      ? context.participants.includes(selectedAgent.endpoint_id)
      : false;
    const fallbackActor = context.participants.find((participant) =>
      participant !== selfActorId && endpoints.some((endpoint) => endpoint.endpoint_id === participant)
    );
    if (!selectedParticipates && fallbackActor) {
      setSelectedAgentId(fallbackActor);
    }
    setSelectedContextId(context.context_id);
    setDraftMode(false);
    setChannelOpen(true);
    void refreshContextEvents(context.context_id);
  }, [endpoints, refreshContextEvents, selectedAgent, selfActorId]);

  function selectActorForInspector(endpointId: string) {
    setSelectedAgentId(endpointId);
    setSelectedContextId(null);
    setDraftMode(false);
    clearContextEvents();
  }

  function openActorContexts(endpointId: string) {
    contextsRequestRef.current += 1;
    setContexts([]);
    setSelectedAgentId(endpointId);
    setSelectedContextId(null);
    setDraftMode(false);
    clearContextEvents();
    setChannelOpen(true);
    if (selectedWorkspace) {
      void refreshContexts(selectedWorkspace.workspace_id, endpointId);
    }
  }

  async function completeWorkspaceContextScopeAssignment(context: ContextSummary, scopeId: string): Promise<void> {
    await assignContextToScope(busUrl, context.workspace_id, context.context_id, {
      scopeId,
      actorId: selfActorId || null
    });
    await Promise.all([
      refreshFields(context.workspace_id),
      refreshContexts(context.workspace_id),
      refreshWorkspaceContexts(context.workspace_id),
      refreshActivityContexts(context.workspace_id),
      refreshOpenField(context.workspace_id, scopeId)
    ]);
    setSelectedContextId(context.context_id);
    openField(scopeId);
  }

  async function assignWorkspaceContextToScope(context: ContextSummary, scopeId: string): Promise<void> {
    if (!canAssignContextToScope(context)) {
      setError(contextScopeAssignmentStatus(context));
      return;
    }
    if (!scopeId) {
      setError("Choose a named Scope before assigning this Workspace-level Context.");
      return;
    }
    try {
      setError(null);
      await completeWorkspaceContextScopeAssignment(context, scopeId);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to assign Context to Scope");
    }
  }

  function validateInlineScopeName(value: string): string | null {
    const title = value.trim();
    if (!title) return "Enter a Scope name.";
    if (/^default(?:\s+(scope|field))?$/i.test(title)) {
      return "Choose a named Scope that is not Default.";
    }
    return null;
  }

  function promptCreateScopeAndAssign(context: ContextSummary): void {
    if (!canAssignContextToScope(context)) {
      setError(contextScopeAssignmentStatus(context));
      return;
    }
    void promptDialog({
      title: "Create Scope for Context",
      body: "Create a named Scope and assign this Workspace-level Context through the audited substrate path.",
      confirmLabel: "Create Scope and assign",
      cancelLabel: "Cancel",
      input: {
        label: "Scope name",
        placeholder: "Scope name",
        validate: validateInlineScopeName
      },
      onConfirm: async ({ value }) => {
        setError(null);
        const scope = await createScope(busUrl, context.workspace_id, { title: value.trim() });
        await refreshFields(context.workspace_id);
        await completeWorkspaceContextScopeAssignment(context, scope.scope_id);
      }
    });
  }

  const { nodes: fieldNodes, edges: fieldEdges } = useMemo(() => {
    if (loadedProjection) {
      const flow = projectionToReactFlow(loadedProjection.projection, loadedProjection.layout ?? undefined);
      const edges: FieldConnectionEdge[] = flow.edges.map((edge) => {
        const label = typeof edge.label === "string" ? edge.label : "";
        return {
          ...edge,
          type: "fieldConnection",
          selected: selectedFieldConnectionId === edge.id,
          reconnectable: false,
          data: {
            ...(edge.data ?? {}),
            label,
            isEditing: false,
            draft: label,
            onBeginEdit: () => undefined,
            onDraftChange: () => undefined,
            onCommit: () => undefined,
            onCancel: () => undefined
          }
        };
      });
      const nodes = flow.nodes.map((node) => {
        const contextId = typeof node.data?.context_id === "string" ? node.data.context_id : null;
        return {
          ...node,
          selected: selectedFieldItemIds.has(node.id),
          data: {
            ...(node.data ?? {}),
            ...(contextId ? { onOpenContext: openProjectedContext } : {})
          }
        };
      });
      return { nodes, edges };
    }
    return { nodes: [], edges: [] };
  }, [
    loadedProjection,
    openProjectedContext,
    selectedFieldConnectionId,
    selectedFieldItemIds
  ]);
  const fieldViewport = useMemo<Viewport>(
    () => loadedProjection?.layout?.viewport ?? { x: 0, y: 0, zoom: 1 },
    [loadedProjection?.layout?.viewport]
  );

  const refresh = useCallback(async (preferredWorkspaceId?: string) => {
    try {
      setError(null);
      const [workspaceResult, authResult, configResult] = await Promise.all([
        api<{ workspaces: Workspace[] }>(busUrl, "/v1/workspaces"),
        api<{ profiles: AuthProfile[] }>(busUrl, "/v1/auth/profiles"),
        api<LocalConfigStatus>(busUrl, "/v1/local-config/status").catch(() => null)
      ]);
      setBridgeRuntimeKnown(configResult !== null);
      setBridgeRuntimeAdapter(configResult?.bridge?.runtime_adapter ?? null);
      setWorkspaces(workspaceResult.workspaces);
      setAuthProfiles(authResult.profiles);
      const knownWorkspaceIds = new Set(workspaceResult.workspaces.map((workspace) => workspace.workspace_id));
      let nextWorkspaceId = preferredWorkspaceId ?? selectedWorkspaceIdRef.current;
      if (!nextWorkspaceId || !knownWorkspaceIds.has(nextWorkspaceId)) {
        nextWorkspaceId = workspaceResult.workspaces[0]?.workspace_id || "";
      }
      if (nextWorkspaceId !== selectedWorkspaceIdRef.current) {
        selectedWorkspaceIdRef.current = nextWorkspaceId;
        setSelectedWorkspaceId(nextWorkspaceId);
        setView({ kind: "home" });
        setActivityFilters({ actorId: "all", kind: "all", scopeId: "all", contextId: "all" });
        setSelectedActivityRowId(null);
        clearFieldEditingState();
      }
      if (nextWorkspaceId) {
        const [endpointResult, bindingResult, eventResult, telemetryResult] = await Promise.all([
          api<{ endpoints: Endpoint[] }>(busUrl, `/v1/workspaces/${encodeURIComponent(nextWorkspaceId)}/endpoints`),
          api<{ bindings: RuntimeBinding[] }>(busUrl, `/v1/runtime/bindings?workspace_id=${encodeURIComponent(nextWorkspaceId)}`),
          api<{ events: EventEnvelope[] }>(busUrl, `/v1/events?workspace_id=${encodeURIComponent(nextWorkspaceId)}&limit=200`),
          api<{ records: TelemetryRecord[] }>(busUrl, `/v1/runtime/telemetry?workspace_id=${encodeURIComponent(nextWorkspaceId)}&limit=200`)
        ]);
        setEndpoints(endpointResult.endpoints);
        setRuntimeBindings(bindingResult.bindings);
        setEvents(eventResult.events);
        setTelemetry(telemetryResult.records);
        void refreshActivityContexts(nextWorkspaceId);
      } else {
        setEndpoints([]);
        setRuntimeBindings([]);
        setEvents([]);
        setTelemetry([]);
        setActivityContexts([]);
        setScopeRecords([]);
        setFieldSummaries([]);
      }
      setStatus("Connected");
    } catch (caught) {
      setStatus("Offline");
      setError((caught as Error).message);
    }
  }, [busUrl]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    loadedProjectionRef.current = loadedProjection;
  }, [loadedProjection]);

  useEffect(() => () => {
    for (const timer of layoutSaveTimersRef.current.values()) {
      window.clearTimeout(timer);
    }
    layoutSaveTimersRef.current.clear();
    pendingLayoutSavesRef.current.clear();
  }, []);

  useEffect(() => {
    const name = endpointDisplayName(operatorEndpoint);
    if (name) localStorage.setItem("floe-operator-name", name);
  }, [operatorEndpoint?.name]);

  useEffect(() => {
    if (!effectiveProfile?.provider) {
      setAvailableModels([]);
      return;
    }
    void api<{ models: ModelInfo[] }>(busUrl, `/v1/auth/models?provider=${encodeURIComponent(effectiveProfile.provider)}`)
      .then((result) => setAvailableModels(result.models))
      .catch(() => setAvailableModels([]));
  }, [busUrl, effectiveProfile?.provider]);

  useEffect(() => {
    localStorage.setItem("floe.busUrl", busUrl);
    void refresh();
    const socketUrl = busUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "") + "/v1/events/stream";
    const socket = new WebSocket(socketUrl);
    let running = false;
    let pending = false;
    const queueRefresh = () => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      pending = false;
      void refresh().finally(() => {
        running = false;
        if (pending) queueRefresh();
      });
    };
    socket.onopen = () => setStatus("Connected");
    socket.onmessage = (event) => {
      const projectionEvent = parseScopeProjectionStreamMessage(String(event.data));
      if (projectionEvent) {
        if (
          projectionEvent.type === "scope_projection.layout.upserted" &&
          projectionEvent.payload.renderer === "floeweb"
        ) {
          const workspaceId = selectedWorkspaceIdRef.current;
          const currentView = viewRef.current;
          const scopeId = projectionEvent.payload.scope_id;
          const key = fieldLayoutKey(workspaceId, scopeId);
          const localWriteUntil = localLayoutWriteUntilRef.current.get(key);
          if (
            workspaceId &&
            workspaceId === projectionEvent.payload.workspace_id &&
            currentView.kind === "field" &&
            currentView.fieldId === scopeId &&
            (!localWriteUntil || localWriteUntil < Date.now())
          ) {
            void getScopeProjectionLayout(busUrl, workspaceId, scopeId)
              .then((layout) => {
                if (!layout) return;
                const current = loadedProjectionRef.current;
                const latestView = viewRef.current;
                if (!current || latestView.kind !== "field" || latestView.fieldId !== scopeId) return;
                const next = { ...current, layout };
                loadedProjectionRef.current = next;
                setLoadedProjection(next);
              })
              .catch((caught) => setError((caught as Error).message));
          }
        }
        return;
      }
      queueRefresh();
    };
    socket.onerror = () => setStatus((current) => current === "Offline" ? current : "Reconnecting");
    socket.onclose = () => setStatus((current) => current === "Offline" ? current : "Disconnected");
    const recovery = window.setInterval(() => void refresh(), 30_000);
    return () => {
      socket.close();
      window.clearInterval(recovery);
    };
  }, [busUrl, refresh]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [floeMessages, streamingTurns]);

  // ── Slice 5: per-agent context list + context-scoped events ──────────────
  useEffect(() => {
    if (!selectedWorkspace || !floeAgent) {
      contextsRequestRef.current += 1;
      setContexts([]);
      setSelectedContextId(null);
      clearContextEvents();
      setDraftMode(false);
      return;
    }
    void refreshContexts(selectedWorkspace.workspace_id, floeAgent.endpoint_id);
  }, [selectedWorkspace?.workspace_id, floeAgent?.endpoint_id, refreshContexts]);

  useEffect(() => {
    if (!selectedWorkspace) {
      activityContextsRequestRef.current += 1;
      setWorkspaceContexts([]);
      setActivityContexts([]);
      return;
    }
    void refreshWorkspaceContexts(selectedWorkspace.workspace_id);
    void refreshActivityContexts(selectedWorkspace.workspace_id);
  }, [selectedWorkspace?.workspace_id, refreshActivityContexts, refreshWorkspaceContexts]);

  // Auto-select default-or-most-recent context once contexts load (unless drafting).
  useEffect(() => {
    if (!channelOpen) return;
    if (draftMode) return;
    if (selectedContextId) return;
    if (sortedContexts.sorted.length === 0) return;
    const firstWritableContext = sortedContexts.sorted.find((context) =>
      context.participants.includes(humanEndpoint)
    );
    setSelectedContextId((firstWritableContext ?? sortedContexts.sorted[0]).context_id);
  }, [sortedContexts, selectedContextId, draftMode, humanEndpoint, channelOpen]);

  // Drop selection if it disappears (workspace switch, etc.)
  useEffect(() => {
    if (!selectedContextId) return;
    if (!selectedContext) {
      setSelectedContextId(null);
      clearContextEvents();
    }
  }, [selectedContext, selectedContextId]);

  useEffect(() => {
    if (!selectedContextId) {
      clearContextEvents();
      return;
    }
    void refreshContextEvents(selectedContextId);
  }, [selectedContextId, refreshContextEvents]);

  useEffect(() => {
    if (!selectedActivityRowId) return;
    if (!filteredActivityRows.some((row) => row.id === selectedActivityRowId)) {
      setSelectedActivityRowId(null);
    }
  }, [filteredActivityRows, selectedActivityRowId]);

  // When workspace-level events change (via WS refresh), re-pull context list
  // and the selected context's events so live updates flow through. Cheap.
  useEffect(() => {
    if (!selectedWorkspace || !floeAgent) return;
    void refreshContexts(selectedWorkspace.workspace_id, floeAgent.endpoint_id);
    void refreshWorkspaceContexts(selectedWorkspace.workspace_id);
    void refreshActivityContexts(selectedWorkspace.workspace_id);
    if (selectedContextId) void refreshContextEvents(selectedContextId);
  }, [events.length, selectedWorkspace?.workspace_id, floeAgent?.endpoint_id, selectedContextId, refreshContexts, refreshActivityContexts, refreshWorkspaceContexts, refreshContextEvents]);

  // Pulse-only label fallback: peek the first event of contexts that have no
  // first_message_preview so we can render "Pulse: <name>" labels.
  useEffect(() => {
    const needsPeek = contexts.filter(
      (c) => !c.first_message_preview && pulseLabels[c.context_id] === undefined
    );
    if (needsPeek.length === 0) return;
    let cancelled = false;
    void Promise.all(
      needsPeek.map(async (c) => {
        try {
          const result = await api<{ events: ContextEvent[] }>(
            busUrl,
            `/v1/contexts/${encodeURIComponent(c.context_id)}/events?limit=1`
          );
          const first = result.events[0] ?? null;
          return { id: c.context_id, label: contextLabel(c, first) };
        } catch {
          return { id: c.context_id, label: contextLabel(c, null) };
        }
      })
    ).then((labels) => {
      if (cancelled) return;
      setPulseLabels((prev) => {
        const next = { ...prev };
        for (const { id, label } of labels) next[id] = label;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [contexts, busUrl, pulseLabels]);

  const refreshFields = useCallback(async (workspaceId: string) => {
    try {
      const scopes = await listScopes(busUrl, workspaceId);
      setScopeRecords(scopes);
      setFieldSummaries(scopes.map(scopeToFieldSummary));
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [busUrl]);

  const markLocalLayoutWrite = useCallback((workspaceId: string, fieldId: string) => {
    localLayoutWriteUntilRef.current.set(fieldLayoutKey(workspaceId, fieldId), Date.now() + 2_000);
  }, []);

  const hasRecentLocalLayoutWrite = useCallback((workspaceId: string, fieldId: string) => {
    const key = fieldLayoutKey(workspaceId, fieldId);
    const until = localLayoutWriteUntilRef.current.get(key);
    if (!until) return false;
    if (until >= Date.now()) return true;
    localLayoutWriteUntilRef.current.delete(key);
    return false;
  }, []);

  const refreshOpenField = useCallback(async (workspaceId: string, fieldId: string) => {
    try {
      let scope = scopeRecords.find((candidate) => candidate.scope_id === fieldId) ?? null;
      if (!scope) {
        const scopes = await listScopes(busUrl, workspaceId);
        setScopeRecords(scopes);
        setFieldSummaries(scopes.map(scopeToFieldSummary));
        scope = scopes.find((candidate) => candidate.scope_id === fieldId) ?? null;
      }
      const projection = await getScopeProjection(busUrl, workspaceId, fieldId);
      const current = loadedProjectionRef.current;
      const layout = current?.scope.scope_id === fieldId && hasRecentLocalLayoutWrite(workspaceId, fieldId)
        ? current.layout
        : await getScopeProjectionLayout(busUrl, workspaceId, fieldId);
      const currentView = viewRef.current;
      if (selectedWorkspaceIdRef.current === workspaceId && currentView.kind === "field" && currentView.fieldId === fieldId) {
        setLoadedProjection({
          scope: scope ?? projectionScopeFallback(projection),
          projection,
          layout
        });
      }
    } catch (caught) {
      const currentView = viewRef.current;
      if (selectedWorkspaceIdRef.current === workspaceId && currentView.kind === "field" && currentView.fieldId === fieldId) {
        setLoadedProjection(null);
        clearFieldEditingState();
      }
      setError((caught as Error).message);
    }
  }, [busUrl, hasRecentLocalLayoutWrite, scopeRecords]);

  useEffect(() => {
    if (!selectedWorkspaceId || view.kind !== "field") return;
    void refreshOpenField(selectedWorkspaceId, view.fieldId);
  }, [events.length, telemetry.length, selectedWorkspaceId, view, refreshOpenField]);

  const sendFieldLayoutSave = useCallback((pending: PendingLayoutSave) => {
    markLocalLayoutWrite(pending.workspaceId, pending.fieldId);
    void putScopeProjectionLayout(busUrl, pending.workspaceId, pending.fieldId, pending.layout)
      .catch((caught) => setError((caught as Error).message));
  }, [busUrl, markLocalLayoutWrite]);

  const scheduleFieldLayoutSave = useCallback((
    workspaceId: string,
    fieldId: string,
    layout: FieldLayoutFloeweb
  ) => {
    const key = fieldLayoutKey(workspaceId, fieldId);
    pendingLayoutSavesRef.current.set(key, { workspaceId, fieldId, layout });
    const existingTimer = layoutSaveTimersRef.current.get(key);
    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }
    const timer = window.setTimeout(() => {
      const pending = pendingLayoutSavesRef.current.get(key);
      pendingLayoutSavesRef.current.delete(key);
      layoutSaveTimersRef.current.delete(key);
      if (!pending) return;
      sendFieldLayoutSave(pending);
    }, 300);
    layoutSaveTimersRef.current.set(key, timer);
  }, [sendFieldLayoutSave]);

  const updateLoadedProjectionLayout = useCallback((layout: FieldLayoutFloeweb) => {
    const current = loadedProjectionRef.current;
    if (!current || current.scope.scope_id !== layout.field_id) return;
    const next = { ...current, layout };
    loadedProjectionRef.current = next;
    setLoadedProjection(next);
  }, []);

  const handleFieldNodesChange = useCallback((changes: NodeChange[]) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const projection = loadedProjectionRef.current;
    const currentView = viewRef.current;
    if (workspaceId && projection && currentView.kind === "field" && currentView.fieldId === projection.scope.scope_id) {
      const selections = changes.filter((change) => change.type === "select");
      if (selections.length > 0) {
        setSelectedFieldItemIds((selected) => {
          const next = new Set(selected);
          for (const selection of selections) {
            if (selection.type !== "select") continue;
            if (selection.selected) next.add(selection.id);
            else next.delete(selection.id);
          }
          return next;
        });
      }
      const baseLayout = projection.layout ?? reactFlowToLayout(
        projection.scope.scope_id,
        projectionToReactFlow(projection.projection).nodes,
        { x: 0, y: 0, zoom: 1 }
      );
      const nextLayout = applyNodeChangesToLayout(baseLayout, changes);
      if (nextLayout === baseLayout) return;
      if (projection.layout && layoutsEqual(projection.layout, nextLayout)) return;
      updateLoadedProjectionLayout(nextLayout);
      scheduleFieldLayoutSave(workspaceId, projection.scope.scope_id, nextLayout);
      return;
    }
  }, [scheduleFieldLayoutSave, updateLoadedProjectionLayout]);

  const handleFieldMoveEnd = useCallback((_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const projection = loadedProjectionRef.current;
    const currentView = viewRef.current;
    if (workspaceId && projection && currentView.kind === "field" && currentView.fieldId === projection.scope.scope_id) {
      const { nodes } = projectionToReactFlow(projection.projection, projection.layout ?? undefined);
      const nextLayout = reactFlowToLayout(projection.scope.scope_id, nodes, viewport);
      if (projection.layout && layoutsEqual(projection.layout, nextLayout)) return;
      updateLoadedProjectionLayout(nextLayout);
      scheduleFieldLayoutSave(workspaceId, projection.scope.scope_id, nextLayout);
      return;
    }
  }, [scheduleFieldLayoutSave, updateLoadedProjectionLayout]);

  const handleFieldNodeDragStop = useCallback((_event: React.MouseEvent, node: ReactFlowNode) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const projection = loadedProjectionRef.current;
    const currentView = viewRef.current;
    if (workspaceId && projection && currentView.kind === "field" && currentView.fieldId === projection.scope.scope_id) {
      const baseLayout = projection.layout ?? reactFlowToLayout(
        projection.scope.scope_id,
        projectionToReactFlow(projection.projection).nodes,
        reactFlow.getViewport()
      );
      const nextLayout: FieldLayoutFloeweb = {
        ...baseLayout,
        items: {
          ...baseLayout.items,
          [node.id]: {
            ...(baseLayout.items[node.id] ?? {}),
            x: node.position.x,
            y: node.position.y
          }
        }
      };
      if (projection.layout && layoutsEqual(projection.layout, nextLayout)) return;
      updateLoadedProjectionLayout(nextLayout);
      scheduleFieldLayoutSave(workspaceId, projection.scope.scope_id, nextLayout);
      return;
    }
  }, [reactFlow, scheduleFieldLayoutSave, updateLoadedProjectionLayout]);

  const handleFieldConnect = useCallback((connection: Connection) => {
    const projection = loadedProjectionRef.current;
    const workspaceId = selectedWorkspaceIdRef.current;
    const currentView = viewRef.current;
    if (projection && workspaceId && currentView.kind === "field" && currentView.fieldId === projection.scope.scope_id) {
      const mutation = projectionSubscriberFromConnection(connection.source, connection.target);
      if (!mutation) {
        setError("Scope Projection connections currently support Pulse to Context only.");
        return;
      }
      void (async () => {
        try {
          await subscribePulse(busUrl, mutation.pulse_id, mutation.subscriber);
          const current = loadedProjectionRef.current;
          const latestView = viewRef.current;
          if (!current || latestView.kind !== "field" || latestView.fieldId !== projection.scope.scope_id) return;
          const nextProjection = addPulseContextSubscriber(
            current.projection,
            mutation.pulse_id,
            mutation.subscriber.context_id
          );
          const next = { ...current, projection: nextProjection };
          loadedProjectionRef.current = next;
          setLoadedProjection(next);
          await refreshOpenField(workspaceId, projection.scope.scope_id);
        } catch (caught) {
          setError((caught as Error).message);
        }
      })();
      return;
    }
  }, [busUrl, refreshOpenField]);

  const handleFieldEdgesChange = useCallback((changes: EdgeChange<FieldConnectionEdge>[]) => {
    const selection = [...changes].reverse().find((change) => change.type === "select");
    if (!selection || selection.type !== "select") return;
    if (selection.selected) {
      setSelectedFieldConnectionId(selection.id);
      return;
    }
    setSelectedFieldConnectionId((current) => current === selection.id ? null : current);
  }, []);

  const handleFieldEdgeDoubleClick = useCallback((_: React.MouseEvent, edge: FieldConnectionEdge) => {
    const data = edge.data as FieldConnectionEdgeData | undefined;
    if (!data?.onBeginEdit) return;
    data.onBeginEdit(edge.id, typeof edge.label === "string" ? edge.label : "");
  }, []);

  const handleFieldEdgesDelete = useCallback((edges: FieldConnectionEdge[]) => {
    const projection = loadedProjectionRef.current;
    const workspaceId = selectedWorkspaceIdRef.current;
    const currentView = viewRef.current;
    if (projection && workspaceId && currentView.kind === "field" && currentView.fieldId === projection.scope.scope_id) {
      const mutations = edges
        .map((edge) => projectionSubscriberFromEdgeId(edge.id))
        .filter((mutation): mutation is NonNullable<typeof mutation> => mutation !== null);
      if (mutations.length === 0) return;
      void (async () => {
        try {
          for (const mutation of mutations) {
            await unsubscribePulse(busUrl, mutation.pulse_id, mutation.subscriber);
          }
          const current = loadedProjectionRef.current;
          const latestView = viewRef.current;
          if (!current || latestView.kind !== "field" || latestView.fieldId !== projection.scope.scope_id) return;
          let nextProjection = current.projection;
          for (const mutation of mutations) {
            nextProjection = removePulseContextSubscriber(
              nextProjection,
              mutation.pulse_id,
              mutation.subscriber.context_id
            );
          }
          const next = { ...current, projection: nextProjection };
          loadedProjectionRef.current = next;
          setLoadedProjection(next);
          setSelectedFieldConnectionId((selected) =>
            selected && edges.some((edge) => edge.id === selected) ? null : selected
          );
          await refreshOpenField(workspaceId, projection.scope.scope_id);
        } catch (caught) {
          setError((caught as Error).message);
        }
      })();
      return;
    }
  }, [busUrl, refreshOpenField]);

  const handleFieldBeforeDelete = useCallback(async ({
    nodes
  }: {
    nodes: ReactFlowNode[];
    edges: FieldConnectionEdge[];
  }) => {
    return nodes.length === 0;
  }, []);

  const handleFieldReconnect = useCallback((oldEdge: FieldConnectionEdge, connection: Connection) => {
    // Projection edge reconnect would require unsubscribe+subscribe atomicity; use delete+connect for this slice.
    void oldEdge;
    void connection;
  }, []);

  function clearFieldEditingState(): void {
    setRenameDraft(null);
    setSelectedFieldItemIds(new Set());
    setSelectedFieldConnectionId(null);
  }

  useEffect(() => {
    const workspaceId = selectedWorkspaceIdRef.current;
    if (workspaceId && view.kind === "field" && loadedProjection && !loadedProjection.layout && fieldNodes.length > 0) {
      const key = fieldLayoutKey(workspaceId, loadedProjection.scope.scope_id);
      if (autoInitializedLayoutRef.current.has(key)) return;
      autoInitializedLayoutRef.current.add(key);
      const layout = reactFlowToLayout(loadedProjection.scope.scope_id, fieldNodes, fieldViewport);
      updateLoadedProjectionLayout(layout);
      return;
    }
  }, [
    fieldNodes,
    fieldViewport,
    loadedProjection,
    updateLoadedProjectionLayout,
    view
  ]);

  useEffect(() => {
    if (view.kind !== "field") {
      restoredViewportKeyRef.current = null;
      return;
    }
    if (loadedProjection?.layout && loadedProjection.scope.scope_id === view.fieldId) {
      const viewport = loadedProjection.layout.viewport;
      const key = `${view.fieldId}:${viewport.x}:${viewport.y}:${viewport.zoom}`;
      if (restoredViewportKeyRef.current === key) return;
      restoredViewportKeyRef.current = key;
      void reactFlow.setViewport(viewport, { duration: 0 });
      return;
    }
  }, [
    loadedProjection?.layout,
    loadedProjection?.scope.scope_id,
    reactFlow,
    view
  ]);

  useEffect(() => {
    loadedProjectionRef.current = null;
    setLoadedProjection(null);
    clearFieldEditingState();
    if (!selectedWorkspaceId) {
      setScopeRecords([]);
      setFieldSummaries([]);
      return;
    }
    void refreshFields(selectedWorkspaceId);
  }, [selectedWorkspaceId, refreshFields]);

  useEffect(() => {
    if (view.kind !== "field" || !selectedWorkspaceId) {
      loadedProjectionRef.current = null;
      setLoadedProjection(null);
      clearFieldEditingState();
      return;
    }
    if (loadedProjectionRef.current?.scope.scope_id !== view.fieldId) {
      loadedProjectionRef.current = null;
      setLoadedProjection(null);
    }
    void refreshOpenField(selectedWorkspaceId, view.fieldId);
  }, [view, selectedWorkspaceId, refreshOpenField]);

  async function registerWorkspace(createDirectory = false) {
    if (!workspacePath.trim()) return;
    try {
      const result = await api<{ workspace: Workspace }>(busUrl, "/v1/workspaces/register", {
        method: "POST",
        body: {
          locator: workspacePath.trim(),
          name: workspaceName.trim() || undefined,
          init_authorized: authorizeInit,
          create_directory: createDirectory || undefined
        }
      });
      await api(busUrl, `/v1/workspaces/${encodeURIComponent(result.workspace.workspace_id)}/select`, { method: "POST" });
      selectedWorkspaceIdRef.current = result.workspace.workspace_id;
      setSelectedWorkspaceId(result.workspace.workspace_id);
      await ensureOperator(result.workspace.workspace_id);
      await refresh(result.workspace.workspace_id);
      setWorkspacePath("");
      setWorkspaceName("");
      setWorkspaceMenuOpen(false);
      setWorkspaceCreateOpen(false);
      clearFieldEditingState();
      loadedProjectionRef.current = null;
      setLoadedProjection(null);
      setView({ kind: "home" });
    } catch (err) {
      if (err instanceof ApiError && (err.body as any)?.error === "directory_not_found") {
        const locator = (err.body as any)?.locator ?? workspacePath.trim();
        const confirmed = await confirmDialog({
          title: "Create directory?",
          body: <>The folder <strong>{locator}</strong> does not exist. Create it and register the workspace here?</>,
          confirmLabel: "Create folder",
          cancelLabel: "Cancel"
        });
        if (confirmed) return registerWorkspace(true);
        return;
      }
      throw err;
    }
  }

  async function selectWorkspace(workspaceId: string) {
    selectedWorkspaceIdRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
    setWorkspaceMenuOpen(false);
    setWorkspaceCreateOpen(false);
    clearFieldEditingState();
    loadedProjectionRef.current = null;
    setLoadedProjection(null);
    setView({ kind: "home" });
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, { method: "POST" });
    await ensureOperator(workspaceId);
    await refresh(workspaceId);
  }

  async function deleteWorkspace(workspaceId: string) {
    const workspace = workspaces.find((w) => w.workspace_id === workspaceId);
    const label = workspace?.name ?? workspaceId;
    const locator = workspace?.locator ?? "";
    const result = await confirmWithOptions({
      title: "Delete workspace",
      body: (
        <>
          Remove <strong>{label}</strong> from Floe?
          {locator ? <> The workspace folder is <code>{locator}</code>.</> : null}
        </>
      ),
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      variant: "danger",
      checkbox: {
        label: "Also delete the workspace folder and its files from disk",
        testId: "dialog-delete-locator-checkbox"
      },
      onConfirm: ({ checked }) => api(busUrl, `/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, {
        method: "POST",
        body: { delete_locator: checked }
      }).then(() => undefined)
    });
    if (!result.confirmed) return;
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId("");
      selectedWorkspaceIdRef.current = "";
      setEndpoints([]);
      setEvents([]);
      setTelemetry([]);
      setScopeRecords([]);
      setFieldSummaries([]);
      loadedProjectionRef.current = null;
      setLoadedProjection(null);
    }
    await refresh();
  }

  async function ensureOperator(workspaceId: string) {
    const existing = await fetchOperatorEndpoint(workspaceId);
    const name = endpointDisplayName(existing) ?? cachedOperatorDisplayName() ?? "You";
    await api(busUrl, "/v1/endpoints/register", {
      method: "POST",
      body: {
        endpoint_id: operatorActorId(workspaceId),
        workspace_id: workspaceId,
        name,
        status: "online",
        metadata: { registered_by: "floe-web" }
      }
    });
  }

  async function fetchOperatorEndpoint(workspaceId: string): Promise<Endpoint | null> {
    const endpointId = operatorActorId(workspaceId);
    const current = endpoints.find((endpoint) => endpoint.endpoint_id === endpointId);
    if (current) return current;
    const result = await api<{ endpoints: Endpoint[] }>(
      busUrl,
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`
    );
    return result.endpoints.find((endpoint) => endpoint.endpoint_id === endpointId) ?? null;
  }

  async function updateOperatorDisplayName(rawName: string) {
    if (!selectedWorkspace) return;
    const name = rawName.trim() || "You";
    localStorage.setItem("floe-operator-name", name);
    await api(busUrl, "/v1/endpoints/register", {
      method: "POST",
      body: {
        endpoint_id: operatorActorId(selectedWorkspace.workspace_id),
        workspace_id: selectedWorkspace.workspace_id,
        name,
        status: "online",
        metadata: { registered_by: "floe-web" }
      }
    });
    await refresh(selectedWorkspace.workspace_id);
  }

  async function setWorkspaceProfile(profileId: string) {
    if (!selectedWorkspace) return;
    if (!profileId) {
      await api(busUrl, "/v1/runtime/bindings/clear", {
        method: "POST",
        body: { scope: "workspace_default", workspace_id: selectedWorkspace.workspace_id }
      });
    } else {
      await api(busUrl, "/v1/runtime/bindings", {
        method: "POST",
        body: {
          scope: "workspace_default",
          workspace_id: selectedWorkspace.workspace_id,
          auth_profile: profileId,
          model: null
        }
      });
    }
    await refresh(selectedWorkspace.workspace_id);
  }

  async function setWorkspaceModel(modelId: string) {
    if (!selectedWorkspace || !workspaceBinding?.auth_profile) return;
    await api(busUrl, "/v1/runtime/bindings", {
      method: "POST",
      body: {
        scope: "workspace_default",
        workspace_id: selectedWorkspace.workspace_id,
        auth_profile: workspaceBinding.auth_profile,
        model: modelId || null
      }
    });
    await refresh(selectedWorkspace.workspace_id);
  }

  async function sendFloeMessage() {
    if (!selectedWorkspace || !floeAgent || !canUseChannelComposer || !channelMessage.trim()) return;
    await ensureOperator(selectedWorkspace.workspace_id);
    const text = channelMessage.trim();
    const body = buildEmitBody({
      workspaceId: selectedWorkspace.workspace_id,
      source: humanEndpoint,
      agentEndpointId: floeAgent.endpoint_id,
      selectedContextId: selectedContextId,
      text,
      contextLabelText: currentContextLabel(view, selectedWorkspace, loadedProjection?.scope.title ?? selectedFieldSummary?.title ?? null)
    });
    setChannelMessage("");
    const result = await api<{ event?: { context_id?: string | null }; ok?: boolean }>(
      busUrl,
      "/v1/events/emit",
      { method: "POST", body }
    );
    const newCtxId = result?.event?.context_id ?? null;
    if (newCtxId) {
      setSelectedContextId(newCtxId);
      setDraftMode(false);
    }
    await refreshContexts(selectedWorkspace.workspace_id, floeAgent.endpoint_id);
    if (newCtxId) {
      await refreshContextEvents(newCtxId);
    } else if (selectedContextId) {
      await refreshContextEvents(selectedContextId);
    }
  }

  function startNewConversation() {
    setSelectedContextId(null);
    setDraftMode(true);
    clearContextEvents();
  }

  async function deleteConversation(contextId: string, label: string) {
    if (!selectedWorkspace) return;
    const confirmed = await confirmDialog({
      title: "Delete conversation",
      body: <>Delete conversation <strong>{label}</strong>? This permanently deletes the conversation and its events from Floe.</>,
      confirmLabel: "Delete",
      cancelLabel: "Cancel",
      variant: "danger",
      onConfirm: () => api(busUrl, `/v1/contexts/${encodeURIComponent(contextId)}`, { method: "DELETE" }).then(() => undefined)
    });
    if (!confirmed) return;
    setContexts((prev) => prev.filter((ctx) => ctx.context_id !== contextId));
    setPulseLabels((prev) => {
      if (prev[contextId] === undefined) return prev;
      const next = { ...prev };
      delete next[contextId];
      return next;
    });
    if (selectedContextId === contextId) {
      setSelectedContextId(null);
      setDraftMode(false);
      clearContextEvents();
    }
    await refreshContexts(selectedWorkspace.workspace_id);
  }

  function beginRenameField(): void {
    const projection = loadedProjectionRef.current;
    if (!projection) return;
    setRenameDraft(projection.scope.title);
  }

  function cancelRenameField(): void {
    setRenameDraft(null);
  }

  function submitRenameField(): void {
    const current = loadedProjectionRef.current;
    if (!current || renameDraft === null) return;
    const title = renameDraft.trim();
    if (!title || title === current.scope.title) {
      setRenameDraft(null);
      return;
    }
    setRenameDraft(null);
    const workspaceId = selectedWorkspaceIdRef.current;
    if (!workspaceId) return;
    void (async () => {
      try {
        const scope = await renameScope(busUrl, workspaceId, current.scope.scope_id, { title });
        const latest = loadedProjectionRef.current;
        if (latest?.scope.scope_id === scope.scope_id) {
          const next = { ...latest, scope };
          loadedProjectionRef.current = next;
          setLoadedProjection(next);
        }
        await refreshFields(workspaceId);
      } catch (caught) {
        setError((caught as Error).message);
      }
    })();
  }

  async function createField(name?: string, options: { throwOnError?: boolean } = {}): Promise<void> {
    if (!selectedWorkspace) return;
    const workspaceId = selectedWorkspace.workspace_id;
    const nextName = name?.trim() || `Scope ${fieldSummaries.length + 1}`;
    try {
      const scope = await createScope(busUrl, workspaceId, { title: nextName });
      await refreshFields(workspaceId);
      loadedProjectionRef.current = null;
      setLoadedProjection(null);
      clearFieldEditingState();
      setView({ kind: "field", fieldId: scope.scope_id });
      await refreshOpenField(workspaceId, scope.scope_id);
    } catch (caught) {
      if (options.throwOnError) throw caught;
      setError((caught as Error).message);
    }
  }

  function openField(fieldId: string): void {
    clearFieldEditingState();
    loadedProjectionRef.current = null;
    setLoadedProjection(null);
    setView({ kind: "field", fieldId });
    if (selectedWorkspaceId) void refreshOpenField(selectedWorkspaceId, fieldId);
  }

  function deleteOpenField(fieldId: string): void {
    setError(`Scope deletion is not available yet (${fieldId}).`);
  }

  function promptCreateField(): void {
    void promptDialog({
      title: "New Scope",
      body: "Create a named Scope for intentional workspace activity.",
      confirmLabel: "Create",
      cancelLabel: "Cancel",
      input: {
        label: "Scope name",
        placeholder: "Scope name",
        validate: validateInlineScopeName
      },
      onConfirm: ({ value }) => createField(value, { throwOnError: true })
    });
  }

  function handleFieldPrimitiveClick(): void {
    promptCreateField();
  }

  function handleFieldPrimitiveDragStart(event: React.DragEvent<HTMLButtonElement>): void {
    event.dataTransfer.setData(fieldPrimitiveMime, "field");
    event.dataTransfer.effectAllowed = "copy";
  }

  function handleLibraryDragOver(event: React.DragEvent<Element>): void {
    if (!event.dataTransfer.types.includes(fieldPrimitiveMime)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleLibraryDropSurface(event: React.DragEvent<Element>): void {
    if (event.dataTransfer.getData(fieldPrimitiveMime) !== "field") return;
    event.preventDefault();
    event.stopPropagation();
    promptCreateField();
  }

  const handleFieldNodeDoubleClick = useCallback((_: React.MouseEvent, node: ReactFlowNode) => {
    const projection = loadedProjectionRef.current;
    if (projection) {
      const contextId = typeof node.data?.context_id === "string" ? node.data.context_id : null;
      if (contextId) openProjectedContext(contextId);
      return;
    }
  }, [openProjectedContext, refreshOpenField]);

  function backFromField() {
    clearFieldEditingState();
    const currentView = viewRef.current;
    if (currentView.kind === "field" && currentView.backStack?.length) {
      const backStack = currentView.backStack.slice(0, -1);
      const parentFieldId = currentView.backStack[currentView.backStack.length - 1];
      loadedProjectionRef.current = null;
      setLoadedProjection(null);
      setView({
        kind: "field",
        fieldId: parentFieldId,
        ...(backStack.length > 0 ? { backStack } : {})
      });
      const workspaceId = selectedWorkspaceIdRef.current;
      if (workspaceId) void refreshOpenField(workspaceId, parentFieldId);
      return;
    }
    setView({ kind: "home" });
  }

  function goToWorkspaceHome() {
    clearFieldEditingState();
    loadedProjectionRef.current = null;
    setLoadedProjection(null);
    setView({ kind: "home" });
  }

  function renderNoWorkspace() {
    return (
      <section className="empty-start">
        <div className="empty-start-panel">
          <div className="brand-lockup">
            <div className="brand-mark"><Workflow size={22} /></div>
            <div>
              <h1>Floe</h1>
              <p>Open a portable workspace to begin.</p>
            </div>
          </div>
          <div className="workspace-form">
            <label>
              Workspace folder
              <input
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void registerWorkspace(); }}
                placeholder="C:\\Development\\example-workspace"
              />
            </label>
            <label>
              Name
              <input
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                placeholder="Optional"
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={authorizeInit}
                onChange={(event) => setAuthorizeInit(event.target.checked)}
              />
              Allow `.floe/` initialization when needed
            </label>
            <button className="primary-action" onClick={() => void registerWorkspace()} disabled={!workspacePath.trim()}>
              <FolderPlus size={16} />
              Create Workspace
            </button>
          </div>
        </div>
      </section>
    );
  }

  function renderWorkspaceSwitcher() {
    const label = selectedWorkspace?.name ?? "Open Workspace";
    return (
      <div className="topbar-workspace-switcher">
        <button
          type="button"
          className="workspace-switcher-button"
          aria-haspopup="menu"
          aria-expanded={workspaceMenuOpen}
          onClick={() => setWorkspaceMenuOpen((current) => !current)}
        >
          <FolderOpen size={15} />
          <span>{label}</span>
          <ChevronDown size={14} />
        </button>
        {workspaceMenuOpen && (
          <div className="workspace-switcher-menu" role="menu" aria-label="Workspaces">
            <div className="workspace-menu-list">
              {workspaces.length === 0 ? (
                <p className="workspace-menu-empty">No Workspaces registered</p>
              ) : (
                workspaces.map((workspace) => (
                  <div key={workspace.workspace_id} className="workspace-menu-row">
                    <button
                      type="button"
                      role="menuitem"
                      className={`workspace-menu-item${workspace.workspace_id === selectedWorkspaceId ? " active" : ""}`}
                      onClick={() => void selectWorkspace(workspace.workspace_id)}
                    >
                      <span>
                        <strong>{workspace.name}</strong>
                        <small>{workspace.locator ?? workspace.workspace_id}</small>
                      </span>
                      {workspace.workspace_id === selectedWorkspaceId && <Check size={14} />}
                    </button>
                    <button
                      type="button"
                      className="workspace-menu-delete"
                      onClick={() => void deleteWorkspace(workspace.workspace_id)}
                      title="Remove workspace"
                      aria-label={`Remove workspace ${workspace.name}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <button
              type="button"
              role="menuitem"
              className="workspace-menu-create"
              onClick={() => setWorkspaceCreateOpen((current) => !current)}
            >
              <FolderPlus size={14} />
              New Workspace
            </button>
            {workspaceCreateOpen && (
              <div className="workspace-menu-form">
                <label>
                  Location
                  <input
                    value={workspacePath}
                    onChange={(event) => setWorkspacePath(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void registerWorkspace(); }}
                    placeholder="C:\\Development\\example-workspace"
                  />
                </label>
                <label>
                  Name
                  <input
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter") void registerWorkspace(); }}
                    placeholder="Optional"
                  />
                </label>
                <label className="check-row compact">
                  <input
                    type="checkbox"
                    checked={authorizeInit}
                    onChange={(event) => setAuthorizeInit(event.target.checked)}
                  />
                  Allow `.floe/` initialization
                </label>
                <button
                  type="button"
                  className="primary-action full"
                  onClick={() => void registerWorkspace()}
                  disabled={!workspacePath.trim()}
                >
                  Create Workspace
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderHome() {
    return (
      <section className="workspace-home" data-testid="v6-workspace-home">
        <div className="home-band hero">
          <div>
            <p className="eyebrow">Workspace Home</p>
            <h1>{selectedWorkspace?.name ?? "Workspace"}</h1>
            <p className="home-summary">Workspace index</p>
          </div>
        </div>

        <section className="home-overview-card workspace-settings-card ws-settings" data-testid="v6-home-workspace-settings">
            <div className="section-title-row">
              <div>
                <h3>Workspace settings</h3>
                <p>Home indexes Workspace state; it is not a Scope.</p>
              </div>
            </div>
            <dl className="home-detail-list">
              <div>
                <dt>Location</dt>
                <dd>{selectedWorkspace?.locator ?? "Unknown"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{selectedWorkspace ? workspaceStatusLabel(selectedWorkspace) : "No workspace"}</dd>
              </div>
              <div>
                <dt>Runtime default</dt>
                <dd>{effectiveProfile?.label ?? effectiveProfile?.id ?? "Not configured"}{effectiveModel ? ` · ${effectiveModel}` : ""}</dd>
              </div>
              <div>
                <dt>Runtime readiness</dt>
                <dd>{canMessageRuntime ? "Ready" : runtimeBlockedByFakeAdapter ? "Blocked by adapter" : "Needs setup"}</dd>
              </div>
              <div>
                <dt>Runtime adapter</dt>
                <dd>{bridgeRuntimeAdapterName ?? "unknown"}</dd>
              </div>
            </dl>
            {homeModel.systemWarnings.length > 0 && (
              <div className="home-warning-list" data-testid="v6-home-system-warnings">
                {homeModel.systemWarnings.map((warning) => (
                  <div key={warning} className="callout warning">
                    <AlertTriangle size={14} />
                    <span>{warning}</span>
                  </div>
                ))}
              </div>
            )}
        </section>

        <section className="home-actor-pane" data-testid="v6-home-actors">
          <div className="section-title-row">
            <div>
              <h3>Actors</h3>
              <p>Workspace-level identities. Selecting one updates the inspector without changing Field membership.</p>
            </div>
            <span>{agents.length}</span>
          </div>
          {agents.length === 0 ? (
            <div className="quiet-empty compact">
              <CircleDot size={22} />
              <strong>No actors available</strong>
              <span>Registered Workspace actors will appear here.</span>
            </div>
          ) : (
            <div className="home-actor-strip">
              {homeModel.actorCards
                .filter((actor) => actor.endpointId !== selfActorId)
                .map((actor) => {
                  const name = actor.name;
                  const selected = inspectorActor?.endpoint_id === actor.endpointId;
                  return (
                    <article
                      key={actor.endpointId}
                      className={`home-actor-card${selected ? " selected" : ""}`}
                    >
                      <button
                        type="button"
                        className="home-actor-summary"
                        aria-pressed={selected}
                        onClick={() => selectActorForInspector(actor.endpointId)}
                      >
                        <span className="home-actor-avatar">{actorInitial(name)}</span>
                        <span>
                          <strong>{name}</strong>
                          <small>{actor.status} · Workspace-level {actor.workspaceLevelContextCount} · Scoped {actor.scopedContextCount}</small>
                          <small>Activity {actor.activityCount} · {actor.runtimeBindingLabel} · {actor.adapterLabel}</small>
                          {actor.latestActivityDetail && <small>Latest: {actor.latestActivityDetail}</small>}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="ghost-action compact"
                        aria-label={`Open Contexts for ${name}`}
                        onClick={() => openActorContexts(actor.endpointId)}
                      >
                        Open Contexts
                      </button>
                    </article>
                  );
                })}
            </div>
          )}
        </section>

        <div className="home-grid">
          <section className="field-list-pane" data-testid="v6-home-scopes">
            <div className="section-title-row">
              <div>
                <h3>Scopes</h3>
                <p>
                  {showAllFields
                    ? "All workspace Scopes."
                    : "Named Scopes are intentional organising boundaries from the substrate."}
                </p>
              </div>
              <span>{homeFieldSummaries.length}</span>
            </div>
            {nestedFieldCount > 0 && (
              <button
                className="ghost-action full"
                onClick={() => setShowAllFields((current) => !current)}
              >
                {showAllFields ? "Show root Scopes" : `Show all Scopes (${fieldSummaries.length})`}
              </button>
            )}
            <button className="primary-action full" onClick={promptCreateField}>
              <FolderPlus size={15} />
              Add Scope
            </button>
            {homeFieldSummaries.length === 0 ? (
              <div className="quiet-empty">
                <SquareDashedMousePointer size={22} />
                <strong>No Scopes yet</strong>
                <span>Create a named Scope to start shaping this workspace.</span>
              </div>
            ) : (
              <div className="field-list">
                {homeFieldSummaries.map((summary) => {
                  const scopeCard = homeModel.scopeCards.find((card) => card.scopeId === summary.id);
                  const loadedContextCount = scopeCard?.loadedContextCount ?? 0;
                  const activityCount = scopeCard?.activityCount ?? 0;
                  return (
                    <button
                      key={summary.id}
                      className="field-block"
                      onClick={() => openField(summary.id)}
                      onDoubleClick={() => openField(summary.id)}
                    >
                      <span className="field-icon"><LayoutPanelLeft size={16} /></span>
                      <span>
                        <strong>{summary.title}</strong>
                        <small>Named Scope · {loadedContextCount} loaded Context{loadedContextCount === 1 ? "" : "s"} · {activityCount} Activity row{activityCount === 1 ? "" : "s"}</small>
                        {scopeCard?.latestActivityDetail && <small>Latest: {scopeCard.latestActivityDetail}</small>}
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <section className="home-overview-card recent-activity-card" data-testid="v6-home-recent-activity">
          <div className="section-title-row">
            <div>
              <h3>Recent activity</h3>
              <p>Workspace events and runtime traces using the Activity view model.</p>
            </div>
            <span>{homeModel.recentActivity.length}</span>
          </div>
          {homeModel.recentActivity.length === 0 ? (
            <div className="quiet-empty compact">
              <Activity size={22} />
              <strong>No recent activity</strong>
              <span>Events, deliveries, and runtime work will appear here.</span>
            </div>
          ) : (
            <div className="home-activity-list">
              {homeModel.recentActivity.map((item) => (
                <article key={item.id} className="home-activity-row">
                  <span className="field-icon"><Activity size={15} /></span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.detail}</small>
                    <small>{item.sourceLabel} · {item.contextLabel ?? "No Context"} · {item.scopeLabel}</small>
                  </span>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="field-list-pane workspace-context-pane" data-testid="v6-home-contexts">
            <div className="section-title-row">
              <div>
                <h3>Workspace-level Contexts</h3>
                <p>Actor-anchored streams that are not assigned to a Scope.</p>
              </div>
              <span>{recentWorkspaceContexts.length}</span>
            </div>
            {recentWorkspaceContexts.length === 0 ? (
              <div className="quiet-empty">
                <MessageSquare size={22} />
                <strong>No Workspace-level Contexts yet</strong>
                <span>Direct actor conversations will appear here without assigning them to a Scope.</span>
              </div>
            ) : (
              <div className="workspace-context-list">
                {recentWorkspaceContexts.map((context) => {
                  const label = workspaceContextLabel(context);
                  const activityTime = context.last_event_at ?? context.created_at;
                  const canAssign = canAssignContextToScope(context);
                  const selectedTargetScope = contextAssignmentTargets[context.context_id] ?? "";
                  return (
                    <article
                      key={context.context_id}
                      className="workspace-context-block"
                    >
                      <span className="field-icon"><MessageSquare size={16} /></span>
                      <span>
                        <strong>{label}</strong>
                        <small>
                          {contextParticipationLabel(context, scopeTitlesById)} · {formatContextTimestamp(activityTime)} · {contextScopeAssignmentStatus(context)}
                        </small>
                      </span>
                      <span className="workspace-context-actions">
                        <button
                          type="button"
                          className="ghost-action compact"
                          onClick={() => openWorkspaceContext(context)}
                        >
                          Open
                        </button>
                        {canAssign && (
                          <>
                            <select
                              aria-label={`Scope for ${label}`}
                              value={selectedTargetScope}
                              onChange={(event) => setContextAssignmentTargets((current) => ({
                                ...current,
                                [context.context_id]: event.target.value
                              }))}
                              disabled={scopeRecords.length === 0}
                            >
                              <option value="">{scopeRecords.length === 0 ? "No named Scopes" : "Choose Scope"}</option>
                              {scopeRecords.map((scope) => (
                                <option key={scope.scope_id} value={scope.scope_id}>{scope.title}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="primary-action compact"
                              onClick={() => void assignWorkspaceContextToScope(context, selectedTargetScope)}
                              disabled={!selectedTargetScope}
                            >
                              Assign to Scope
                            </button>
                            <button
                              type="button"
                              className="ghost-action compact"
                              onClick={() => promptCreateScopeAndAssign(context)}
                            >
                              Create Scope and assign
                            </button>
                          </>
                        )}
                      </span>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
      </section>
    );
  }

  function renderActivity() {
    const eventCount = filteredActivityRows.filter((row) => row.category === "event").length;
    const runtimeCount = filteredActivityRows.filter((row) => row.category === "runtime").length;
    const activeCount = filteredActivityRows.length;
    const activeContextCount = new Set(filteredActivityRows.map((row) => row.contextId).filter(Boolean)).size;
    const activeScopeCount = new Set(filteredActivityRows.map((row) => row.scopeId).filter(Boolean)).size;
    const allKinds = Array.from(new Set(activityRows.map((row) => row.kind))).sort();
    const setFilter = (patch: Partial<ActivityFilters>) => {
      setActivityFilters((current) => ({
        ...current,
        ...patch,
        contextId: patch.scopeId !== undefined || patch.kind !== undefined || patch.actorId !== undefined
          ? "all"
          : patch.contextId ?? current.contextId
      }));
    };
    const clearFilters = () => setActivityFilters({ actorId: "all", kind: "all", scopeId: "all", contextId: "all" });

    return (
      <section className="workspace-activity" data-testid="v6-activity">
        <div className="home-band activity-band">
          <div>
            <p className="eyebrow">Activity</p>
            <h1>Workspace Activity</h1>
            <p className="home-summary">Events, runtime work, Contexts, actors, and Scope associations from the substrate.</p>
          </div>
          <button className="ghost-action" onClick={() => void refresh()}>
            <RefreshCw size={16} />
            Refresh
          </button>
        </div>

        <div className="activity-summary-grid" data-testid="activity-summary">
          <div><strong>{activeCount}</strong> <span>items total</span></div>
          <div><strong>{eventCount}</strong> <span>Events</span></div>
          <div><strong>{runtimeCount}</strong> <span>runtime activity</span></div>
          <div><strong>{activeContextCount}</strong> <span>Contexts</span></div>
          <div><strong>{activeScopeCount}</strong> <span>Scopes</span></div>
        </div>

        <section className="activity-filter-panel" aria-label="Activity filters">
          <div className="activity-filter-row">
            <span>Actor/source</span>
            <button
              type="button"
              className={`filter-chip${activityFilters.actorId === "all" ? " active" : ""}`}
              onClick={() => setFilter({ actorId: "all" })}
            >
              All
            </button>
            {endpoints.map((endpoint) => {
              const label = endpointDisplayName(endpoint) ?? endpoint.agent_id ?? endpoint.endpoint_id;
              return (
                <button
                  key={endpoint.endpoint_id}
                  type="button"
                  className={`filter-chip${activityFilters.actorId === endpoint.endpoint_id ? " active" : ""}`}
                  onClick={() => setFilter({ actorId: endpoint.endpoint_id })}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="activity-filter-row">
            <span>Kind</span>
            <button
              type="button"
              className={`filter-chip${activityFilters.kind === "all" ? " active" : ""}`}
              onClick={() => setFilter({ kind: "all" })}
            >
              All
            </button>
            <button
              type="button"
              className={`filter-chip${activityFilters.kind === "events" ? " active" : ""}`}
              onClick={() => setFilter({ kind: "events" })}
            >
              Events
            </button>
            <button
              type="button"
              className={`filter-chip${activityFilters.kind === "runtime" ? " active" : ""}`}
              onClick={() => setFilter({ kind: "runtime" })}
            >
              Runtime
            </button>
            {allKinds.map((kind) => (
              <button
                key={kind}
                type="button"
                className={`filter-chip${activityFilters.kind === kind ? " active" : ""}`}
                onClick={() => setFilter({ kind })}
              >
                {kind}
              </button>
            ))}
          </div>
          <div className="activity-filter-row">
            <span>Scope</span>
            <button
              type="button"
              className={`filter-chip${activityFilters.scopeId === "all" ? " active" : ""}`}
              onClick={() => setFilter({ scopeId: "all" })}
            >
              All
            </button>
            <button
              type="button"
              className={`filter-chip${activityFilters.scopeId === "workspace" ? " active" : ""}`}
              onClick={() => setFilter({ scopeId: "workspace" })}
            >
              Workspace only
            </button>
            {scopeRecords.map((scope) => (
              <button
                key={scope.scope_id}
                type="button"
                className={`filter-chip${activityFilters.scopeId === scope.scope_id ? " active" : ""}`}
                onClick={() => setFilter({ scopeId: scope.scope_id })}
              >
                {scope.title}
              </button>
            ))}
          </div>
          <div className="activity-filter-row">
            <span>Context</span>
            <button
              type="button"
              className={`filter-chip${activityFilters.contextId === "all" ? " active" : ""}`}
              onClick={() => setFilter({ contextId: "all" })}
            >
              All
            </button>
            {activityContextOptions.map((context) => (
              <button
                key={context.context_id}
                type="button"
                className={`filter-chip${activityFilters.contextId === context.context_id ? " active" : ""}`}
                onClick={() => setFilter({ contextId: context.context_id })}
              >
                {contextActivityLabel(context)}
              </button>
            ))}
          </div>
          <div className="activity-filter-footer">
            <span>{activeCount} matching items</span>
            <button type="button" className="ghost-action compact" onClick={clearFilters}>Clear filters</button>
          </div>
        </section>

        {filteredActivityRows.length === 0 ? (
          <div className="quiet-empty activity-empty">
            <Activity size={22} />
            <strong>{activityRows.length === 0 ? "No activity yet" : "No activity matches these filters"}</strong>
            <span>Events and runtime records remain backed by the Workspace bus.</span>
          </div>
        ) : (
          <div className="activity-feed">
            {filteredActivityRows.map((row) => {
              const context = row.contextId
                ? activityContexts.find((candidate) => candidate.context_id === row.contextId) ?? null
                : null;
              return (
                <article
                  key={row.id}
                  className={`activity-row ${row.category}${selectedActivityRowId === row.id ? " selected" : ""}`}
                  data-testid="activity-row"
                  aria-selected={selectedActivityRowId === row.id}
                >
                  <button
                    type="button"
                    className="activity-row-select"
                    aria-label={`Inspect activity ${row.detail}`}
                    aria-pressed={selectedActivityRowId === row.id}
                    onClick={() => setSelectedActivityRowId(row.id)}
                  >
                    <span className="field-icon"><Activity size={15} /></span>
                    <div className="activity-row-body">
                      <div className="activity-row-title">
                        <strong>{row.title}</strong>
                        <span>{new Date(row.createdAt).toLocaleTimeString()}</span>
                      </div>
                      <p>{row.detail}</p>
                      <div className="activity-row-meta">
                        <span>{row.sourceLabel}</span>
                        <span>{row.scopeLabel}</span>
                        {row.contextLabel && <span>{row.contextLabel}</span>}
                      </div>
                    </div>
                  </button>
                  {context && (
                    <button
                      type="button"
                      className="ghost-action compact"
                      onClick={() => openWorkspaceContext(context)}
                    >
                      Open Context
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    );
  }

  function renderField() {
    if (view.kind !== "field") return null;
    const title = loadedProjection?.scope.title ?? selectedFieldSummary?.title ?? view.fieldId;
    const parentFieldId = view.backStack?.at(-1);
    const parentTitle = parentFieldId
      ? fieldSummaries.find((field) => field.id === parentFieldId)?.title ?? parentFieldId
      : null;
    const backLabel = parentTitle ? `Back to ${parentTitle}` : "Workspace Home";
    return (
      <section className="field-surface v6-scope-field" data-testid="v6-scope-field-map">
        <div className="field-toolbar">
          <button className="icon-button" onClick={backFromField} title={backLabel} aria-label={backLabel}>
            <ArrowLeft size={16} />
          </button>
          <div className="field-title-area">
            <p className="eyebrow">Scope Map</p>
            {renameDraft === null ? (
              <h2>{title}</h2>
            ) : (
              <div className="field-rename-row">
                <label>
                  <span className="sr-only">Scope title</span>
                  <input
                    aria-label="Scope title"
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitRenameField();
                      if (event.key === "Escape") cancelRenameField();
                    }}
                    autoFocus
                  />
                </label>
                <button className="primary-action" onClick={submitRenameField}>
                  <Check size={15} />
                  Save Scope
                </button>
                <button className="ghost-action" onClick={cancelRenameField}>
                  Cancel
                </button>
              </div>
            )}
          </div>
          {renameDraft === null && (
            <div className="field-toolbar-actions">
              <button className="ghost-action" onClick={beginRenameField} disabled={!loadedProjection}>
                <Edit3 size={16} />
                Rename Scope
              </button>
            </div>
          )}
        </div>
        <div className="canvas-wrap v6-scope-map-canvas">
          <div className="map-toolbar" aria-label="Map viewport controls">
            <button type="button" onClick={() => reactFlow.fitView({ padding: 0.22, duration: 220 })}>Fit</button>
            <button type="button" onClick={() => reactFlow.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 220 })}>Center</button>
          </div>
          <div className="map-legend" data-testid="v6-scope-map-legend">
            <span><span className="lg-dot cron" />cron</span>
            <span><span className="lg-dot webhook" />webhook</span>
            <span><span className="lg-dot file-watch" />file-watch</span>
            <span><span className="lg-dot manual" />manual</span>
          </div>
          <ReactFlow
            key={view.fieldId}
            nodes={fieldNodes}
            edges={fieldEdges}
            nodeTypes={fieldNodeTypes}
            edgeTypes={fieldEdgeTypes}
            onNodesChange={handleFieldNodesChange}
            onEdgesChange={handleFieldEdgesChange}
            onBeforeDelete={handleFieldBeforeDelete}
            onEdgesDelete={handleFieldEdgesDelete}
            onMoveEnd={handleFieldMoveEnd}
            onNodeDragStop={handleFieldNodeDragStop}
            onNodeDoubleClick={handleFieldNodeDoubleClick}
            onEdgeDoubleClick={handleFieldEdgeDoubleClick}
            onConnect={handleFieldConnect}
            onReconnect={handleFieldReconnect}
            onDrop={handleLibraryDropSurface}
            onDragOver={handleLibraryDragOver}
            deleteKeyCode={["Delete", "Backspace"]}
            defaultViewport={fieldViewport}
            edgesReconnectable
            panOnDrag
            zoomOnScroll
            minZoom={0.2}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <Controls position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" />
          </ReactFlow>
          {loadedProjection && fieldNodes.length === 0 && (
            <div className="canvas-empty">
              <SquareDashedMousePointer size={22} />
              <strong>Empty Scope</strong>
              <span>This Scope has no projected substrate primitives yet.</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderInspector() {
    return (
      <aside className="inspector" data-testid="v6-inspector" aria-label="Inspector">
        <div className="inspector-header">
          <span>Inspector</span>
          <button className="icon-button" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
        {!selectedWorkspace ? (
          <div className="inspector-section muted">No workspace selected.</div>
        ) : inspectorActor ? (
          <>
            <InspectorSection title="Actor">
              <Detail label="Type" value="Workspace Endpoint" />
              <Detail label="Name" value={endpointDisplayName(inspectorActor) ?? inspectorActor.agent_id ?? "Actor"} />
              <Detail label="Endpoint" value={inspectorActor.endpoint_id} />
              <Detail label="Status" value={inspectorActor.status || "unknown"} />
              {inspectorActor.agent_id && <Detail label="Agent id" value={inspectorActor.agent_id} />}
              <Detail label="Runtime binding" value={actorInspectorSummary?.runtimeBindingLabel ?? "Unconfigured"} />
              <Detail label="Adapter" value={actorInspectorSummary?.adapterLabel ?? "unknown"} />
              <Detail label="Workspace-level participation" value={String(actorInspectorSummary?.workspaceLevelContextCount ?? 0)} />
              <Detail label="Scoped participation" value={String(actorInspectorSummary?.scopedContextCount ?? 0)} />
              <Detail label="Actor Activity" value={String(actorInspectorSummary?.activityCount ?? 0)} />
            </InspectorSection>
            <InspectorSection title="Context participation">
              {inspectorActorContexts.length === 0 ? (
                <div className="inspector-note">No Contexts found for this actor.</div>
              ) : (
                <div className="inspector-context-list">
                  {inspectorActorContexts.map((context) => {
                    const label = contextLabel(context, null);
                    const participationLabel = contextParticipationLabel(context, scopeTitlesById);
                    const activityTime = context.last_event_at ?? context.created_at;
                    return (
                      <article key={context.context_id} className="inspector-context-card">
                        <strong>{label}</strong>
                        <span>{participationLabel}</span>
                        <small>{formatContextTimestamp(activityTime)}</small>
                        <button
                          type="button"
                          className="ghost-action compact"
                          onClick={() => openWorkspaceContext(context)}
                        >
                          Open in Channel
                        </button>
                      </article>
                    );
                  })}
                </div>
              )}
            </InspectorSection>
            <ActorAccessSection />
          </>
        ) : view.kind === "activity" ? (
          <>
            {selectedActivityRow && (
              <InspectorSection title="Selected Activity">
                <Detail label="Category" value={selectedActivityRow.category === "runtime" ? "Runtime" : "Event"} />
                <Detail label="Kind" value={selectedActivityRow.kind} />
                <Detail label="Detail" value={selectedActivityRow.detail} />
                <Detail label="Source" value={selectedActivityRow.sourceLabel} />
                <Detail label="Context" value={selectedActivityRow.contextLabel ?? selectedActivityRow.scopeLabel} />
                {selectedActivityRow.contextId && <Detail label="Context id" value={selectedActivityRow.contextId} />}
                <Detail label="Scope" value={selectedActivityRow.scopeLabel} />
                <Detail label="When" value={new Date(selectedActivityRow.createdAt).toLocaleString()} />
                {selectedActivityContext && (
                  <button
                    type="button"
                    className="ghost-action compact inspector-action"
                    onClick={() => openWorkspaceContext(selectedActivityContext)}
                  >
                    Open Context
                  </button>
                )}
              </InspectorSection>
            )}
            <InspectorSection title="Activity">
              <Detail label="Total records" value={String(activityRows.length)} />
              <Detail label="Filtered records" value={String(filteredActivityRows.length)} />
              <Detail label="Contexts loaded" value={String(activityContexts.length)} />
              <Detail label="Workspace-only rows" value={String(activityRows.filter((row) => row.scopeState === "workspace").length)} />
              <Detail label="Scoped rows" value={String(activityRows.filter((row) => row.scopeState === "scoped").length)} />
            </InspectorSection>
            <ActorAccessSection />
          </>
        ) : view.kind === "home" ? (
          <>
            <InspectorSection title="Workspace">
              <Detail label="Surface" value={workspaceInspectorSummary.surface} />
              <Detail label="Name" value={selectedWorkspace.name} />
              <Detail label="Location" value={selectedWorkspace.locator} />
              <Detail label=".floe" value={workspaceStatusLabel(selectedWorkspace)} />
              <Detail label="Named Scopes" value={String(workspaceInspectorSummary.namedScopeCount)} />
              <Detail label="Scope-backed Fields" value={String(workspaceInspectorSummary.scopeBackedFieldCount)} />
              <Detail label="Workspace-level Contexts" value={String(workspaceInspectorSummary.workspaceLevelContextCount)} />
              <Detail label="All loaded Contexts" value={String(workspaceInspectorSummary.loadedContextCount)} />
              <Detail label="Workspace Events" value={String(workspaceInspectorSummary.eventCount)} />
              <Detail label="Runtime records" value={String(workspaceInspectorSummary.telemetryCount)} />
              <Detail label="Actors" value={String(workspaceInspectorSummary.endpointCount)} />
            </InspectorSection>
            <RuntimeSection />
            <ActorAccessSection />
          </>
        ) : (
          <>
            <InspectorSection title="Scope">
              <Detail label="Title" value={loadedProjection?.scope.title ?? selectedFieldSummary?.title ?? "—"} />
              <Detail label="Scope id" value={loadedProjection?.scope.scope_id ?? view.fieldId} />
              <Detail label="Workspace" value={selectedWorkspace.name} />
              <Detail label="Projected Contexts" value={String(scopeInspectorSummary?.projectedContextCount ?? 0)} />
              <Detail label="Projected Events" value={String(scopeInspectorSummary?.projectedEventCount ?? 0)} />
              <Detail label="Actors" value={String(scopeInspectorSummary?.actorCount ?? 0)} />
              <Detail label="Activity rows" value={String(scopeInspectorSummary?.activityRowCount ?? 0)} />
              <Detail label="Total emits" value={String(scopeInspectorSummary?.totalEmitCount ?? 0)} />
              <Detail label="Pulses" value={String(scopeInspectorSummary?.pulseCount ?? 0)} />
              <Detail label="Unsupported" value={String(scopeInspectorSummary?.unsupportedCount ?? 0)} />
            </InspectorSection>
            {loadedProjection && loadedProjection.projection.refs.contexts.length > 0 && (
              <InspectorSection title="Projected Contexts">
                <div className="inspector-context-list">
                  {loadedProjection.projection.refs.contexts.slice(0, 4).map((context) => (
                    <article key={context.context_id} className="inspector-context-card">
                      <strong>{context.first_message_preview || context.context_id}</strong>
                      <span>{context.context_id}</span>
                      <small>{formatContextTimestamp(context.last_event_at ?? context.created_at)}</small>
                    </article>
                  ))}
                </div>
              </InspectorSection>
            )}
            {loadedProjection && loadedProjection.projection.refs.pulses.length > 0 && (
              <InspectorSection title="Pulses">
                <div className="inspector-context-list">
                  {loadedProjection.projection.refs.pulses.slice(0, 4).map((pulse) => (
                    <article key={pulse.pulse_id} className="inspector-context-card">
                      <strong>{pulse.pulse_id}</strong>
                      <span>{pulse.status} · fired {pulse.fire_count} times</span>
                      <small>{pulse.next_fire_at ? `Next ${formatContextTimestamp(pulse.next_fire_at)}` : "No next fire scheduled"}</small>
                    </article>
                  ))}
                </div>
              </InspectorSection>
            )}
            {scopeInspectorSummary && scopeInspectorSummary.activityRows.length > 0 && (
              <InspectorSection title="Scope Activity">
                <div className="inspector-context-list">
                  {scopeInspectorSummary.activityRows.slice(0, 4).map((row) => (
                    <article key={row.id} className="inspector-context-card">
                      <strong>{row.detail}</strong>
                      <span>{row.category === "runtime" ? "Runtime" : "Event"} · {row.kind}</span>
                      <small>{row.sourceLabel} · {formatContextTimestamp(row.createdAt)}</small>
                    </article>
                  ))}
                </div>
              </InspectorSection>
            )}
            {loadedProjection && loadedProjection.projection.unsupported.length > 0 && (
              <InspectorSection title="Projection gaps">
                <div className="inspector-context-list">
                  {loadedProjection.projection.unsupported.map((item, index) => (
                    <article key={`${item.kind}-${index}`} className="inspector-context-card">
                      <strong>{item.kind}</strong>
                      <span>{item.kind} refs are pending substrate projection.</span>
                    </article>
                  ))}
                </div>
              </InspectorSection>
            )}
            {scopeInspectorSummary?.hasProjectionActivityGap && (
              <InspectorSection title="Projection note">
                <div className="inspector-note">Projection Event and runtime refs are not treated as authoritative absence; Scope activity is correlated from loaded Workspace Activity rows.</div>
              </InspectorSection>
            )}
            <ActorAccessSection />
          </>
        )}
      </aside>
    );
  }

  function RuntimeSection() {
    return (
      <InspectorSection title="Runtime">
        {authProfiles.length === 0 ? (
          <div className="callout warning">
            <AlertTriangle size={14} />
            <span>No auth profiles found. Run <code>npm run floe -- login</code>.</span>
          </div>
        ) : (
          <>
            <label className="stacked-label">
              Workspace profile
              <select
                value={workspaceBinding?.auth_profile ?? ""}
                onChange={(event) => void setWorkspaceProfile(event.target.value)}
              >
                <option value="">Unconfigured</option>
                {authProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>{profile.id} ({profile.provider})</option>
                ))}
              </select>
            </label>
            <label className="stacked-label">
              Model
              <select
                value={workspaceBinding?.model ?? ""}
                onChange={(event) => void setWorkspaceModel(event.target.value)}
                disabled={!workspaceBinding?.auth_profile || workspaceModelOptions.length === 0}
              >
                <option value="">Select model</option>
                {workspaceModelOptions.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}{model.reasoning ? " reasoning" : ""}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <Detail label="Floe actor" value={floeAgent?.status ?? "not registered"} />
        {latestRuntimeError && <Detail label="Latest runtime issue" value={latestRuntimeError.kind} />}
      </InspectorSection>
    );
  }

  function renderBlockLibrary() {
    return (
      <aside className="library-panel">
        <div className="library-header">
          <h3>Block Library</h3>
          <p>{view.kind === "field" ? "Click to create another Scope-backed Field." : "Click or drag to create a Scope-backed Field."}</p>
        </div>
        {!selectedWorkspace ? (
          <div className="quiet-empty small">
            <LayoutPanelLeft size={20} />
            <strong>No Workspace</strong>
            <span>Open or create a workspace to add blocks.</span>
          </div>
        ) : (
          <div className="library-items">
            <button
              className="library-primitive"
              onClick={handleFieldPrimitiveClick}
              draggable
              onDragStart={handleFieldPrimitiveDragStart}
              title="Create a new Field"
            >
              <span className="library-card-icon"><LayoutPanelLeft size={18} /></span>
              <span>
                <strong>Field</strong>
                <small>Canvas surface block</small>
              </span>
            </button>
          </div>
        )}
      </aside>
    );
  }

  function ActorAccessSection() {
    return (
      <InspectorSection title="Workspace actors">
        <label className="stacked-label">
          Your display name
          <input
            key={`${selfActorId}:${operatorDisplayName}`}
            defaultValue={operatorDisplayName}
            onBlur={(event) => void updateOperatorDisplayName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <Detail label="Registered actors" value={String(endpoints.length)} />
        <Detail label="Selectable actors" value={String(agents.length)} />
      </InspectorSection>
    );
  }

  function toggleActivity(groupId: string) {
    setExpandedActivities((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function renderActivityGroup(group: ActivityGroup) {
    const isExpanded = expandedActivities.has(group.id);
    const isWorking = group.status === "working";
    return (
      <div key={group.id} className={`activity-group ${isWorking ? "working" : "done"}`}>
        <button
          className="activity-group-toggle"
          onClick={() => toggleActivity(group.id)}
          aria-expanded={isExpanded}
        >
          <span className="activity-group-icon">
            {isWorking ? <Loader size={13} className="spin" /> : <Activity size={13} />}
          </span>
          <span className="activity-group-label">{group.label}</span>
          {group.items.length > 1 && (
            <span className="activity-group-count">{group.items.length}</span>
          )}
          <ChevronDown size={13} className={`activity-chevron ${isExpanded ? "expanded" : ""}`} />
        </button>
        {isExpanded && (
          <div className="activity-group-details">
            {group.items.map((item) => (
              <div key={item.id} className={`activity-detail-item ${item.kind === "Failed" ? "failed" : ""}`}>
                <span className="activity-detail-icon">
                  {item.kind === "Completed" ? "✓" : item.kind === "Failed" ? "✗" : item.kind === "Running" ? "⋯" : "·"}
                </span>
                <span className="activity-detail-summary">{item.summary}</span>
                {item.duration_ms != null && (
                  <span className="activity-detail-duration">{item.duration_ms}ms</span>
                )}
                <time className="activity-detail-time">{item.time}</time>
                {item.files_touched && item.files_touched.length > 0 && (
                  <div className="activity-detail-files">
                    {item.files_touched.map((file, idx) => (
                      <span key={idx} className="activity-detail-file">📄 {file}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderChannel() {
    if (!channelOpen) return null;
    const actorName = selectedAgent ? selectedAgent.name?.trim() || selectedAgent.agent_id || "Actor" : "";
    const messageSourceLabel = (sourceEndpointId: string | null): string => {
      if (!sourceEndpointId) return "System";
      if (sourceEndpointId === humanEndpoint) return operatorDisplayName;
      const endpoint = endpoints.find((item) => item.endpoint_id === sourceEndpointId);
      return endpointDisplayName(endpoint) ?? "Actor";
    };
    const activeContextLabel = selectedContext
      ? selectedContext.first_message_preview?.trim() || pulseLabels[selectedContext.context_id] || "Conversation"
      : null;
    const activeConversationTitle = draftMode
      ? `New conversation with ${actorName}`
      : activeContextLabel ?? (
        sortedContexts.sorted.length === 0
          ? `No conversations with ${actorName} yet`
          : "Select a conversation"
      );
    const activeConversationState = draftMode
      ? "Draft"
      : selectedContext
        ? selectedContextCanMessage ? "Existing conversation" : "Read-only Context"
        : sortedContexts.sorted.length === 0
          ? "No conversations yet"
          : "No conversation selected";
    return (
      <aside className="channel" data-testid="v6-channel" aria-label="Actor conversations">
        <div className="channel-header">
          <div className="channel-title">
            <div className="channel-avatar"><CircleDot size={16} /></div>
            <div>
              <strong>Actor conversations</strong>
              <span>{selectedAgent ? `${actorName} selected` : "No actors available"}</span>
            </div>
          </div>
          <button
            className="icon-button"
            onClick={() => setChannelOpen(false)}
            title="Close actor conversation panel"
            aria-label="Close actor conversation panel"
          >
            <X size={16} />
          </button>
        </div>
        {agents.length > 0 && (
          <section className="actor-selector" role="group" aria-label="Actors" data-testid="actor-selector">
            <div className="actor-selector-heading">
              <span>Actors</span>
              <span>{agents.length}</span>
            </div>
            <div className="actor-selector-list">
              {agents.map((agent) => {
                const name = agent.name?.trim() || agent.agent_id || "Actor";
                const status = agent.status || "unknown";
                const selected = selectedAgent?.endpoint_id === agent.endpoint_id;
                return (
                  <button
                    key={agent.endpoint_id}
                    type="button"
                    className={`actor-selector-item${selected ? " active" : ""}`}
                    aria-pressed={selected}
                    aria-label={`${name} ${status}${selected ? " selected" : ""}`}
                    onClick={() => {
                      contextsRequestRef.current += 1;
                      setSelectedAgentId(agent.endpoint_id);
                      setSelectedContextId(null);
                      setDraftMode(false);
                      clearContextEvents();
                    }}
                  >
                    <span className="actor-selector-avatar" aria-hidden="true">{actorInitial(name)}</span>
                    <span className="actor-selector-copy">
                      <strong>{name}</strong>
                      <span>{status}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
        {selectedAgent && (
          <div className="channel-context-list" data-testid="context-list">
            <div className="channel-context-list-header">
              <span>Contexts involving {actorName}</span>
              <button
                className="ghost-action small"
                data-testid="new-conversation-button"
                onClick={startNewConversation}
                title={`New conversation with ${actorName}`}
                aria-label={`Start new conversation with ${actorName}`}
              >
                + New conversation
              </button>
            </div>
            {sortedContexts.sorted.length === 0 ? (
              <div className="channel-context-empty" data-testid="context-list-empty">
                No conversations with {actorName} yet. Send a message to start one.
              </div>
            ) : (
              <ul className="channel-context-items">
                {sortedContexts.sorted.map((ctx) => {
                  const label =
                    ctx.first_message_preview?.trim()
                      ? ctx.first_message_preview
                      : pulseLabels[ctx.context_id] ?? "Conversation";
                  const isActive = ctx.context_id === selectedContextId;
                  const activityTime = ctx.last_event_at ?? ctx.created_at;
                  const participationLabel = contextParticipationLabel(ctx, scopeTitlesById);
                  const operatorParticipates = ctx.participants.includes(humanEndpoint);
                  return (
                    <li key={ctx.context_id} className="channel-context-row">
                      <button
                        type="button"
                        data-testid="context-list-item"
                        data-context-id={ctx.context_id}
                        className={`channel-context-item${isActive ? " active" : ""}`}
                        aria-current={isActive ? "true" : undefined}
                        aria-label={`${label}, ${formatContextTimestamp(activityTime)}${isActive ? ", selected" : ""}`}
                        onClick={() => {
                          setSelectedContextId(ctx.context_id);
                          setDraftMode(false);
                        }}
                      >
                        <span className="channel-context-label">{label}</span>
                        <span className="channel-context-scope">{participationLabel}</span>
                        <time
                          className="channel-context-time"
                          data-testid="context-list-item-time"
                          dateTime={activityTime}
                        >
                          {formatContextTimestamp(activityTime)}
                        </time>
                      </button>
                      {operatorParticipates && (
                        <button
                          type="button"
                          className="channel-context-delete-button"
                          aria-label={`Delete conversation ${label}`}
                          title={`Delete conversation ${label}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void deleteConversation(ctx.context_id, label);
                          }}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
        {selectedAgent && (
          <section
            className="active-conversation-header"
            data-testid="active-conversation-header"
            aria-label="Active conversation"
          >
            <div className="active-conversation-title">
              <span>Conversation with {actorName}</span>
              <strong>{activeConversationTitle}</strong>
            </div>
            <div className="active-conversation-meta">
              <span>{activeConversationState}</span>
              <span>{selectedAgent.status}</span>
            </div>
          </section>
        )}
        <div className="channel-body">
          {!selectedAgent && (
            <div className="callout warning">
              <AlertTriangle size={15} />
              <span>No actors available yet.</span>
            </div>
          )}
          {!runtimeReady && selectedAgent && (
            <div className="callout warning">
              <AlertTriangle size={15} />
              <span>Select a runtime profile and model before messaging {actorName}.</span>
            </div>
          )}
          {runtimeBlockedByFakeAdapter && selectedAgent && (
            <div className="callout warning">
              <AlertTriangle size={15} />
              <span>The bridge is running with the fake runtime adapter, so {effectiveProfile?.id} will not be used. Set <code>bridge.runtime_adapter</code> to <code>pi-agent-core</code> and restart Floe.</span>
            </div>
          )}
          {selectedAgent && selectedContext && !selectedContextCanMessage && (
            <div className="callout warning">
              <AlertTriangle size={15} />
              <span>Read-only Context: {actorName} participates in this Workspace Context, but {operatorDisplayName} is not a participant.</span>
            </div>
          )}
          {!selectedAgent ? (
            <div className="channel-empty" data-testid="channel-empty-no-actors">
              <MessageSquare size={22} />
              <strong>No actors available yet.</strong>
              <span>Add or register an actor for this workspace to start a conversation.</span>
            </div>
          ) : chatSegments.length === 0 ? (
            sortedContexts.sorted.length === 0 ? (
              <div className="channel-empty" data-testid="channel-empty-no-contexts">
                <MessageSquare size={22} />
                <strong>No conversations with {actorName} yet.</strong>
                <span>Send a message to start one.</span>
              </div>
            ) : draftMode ? (
              <div className="channel-empty" data-testid="channel-empty-draft">
                <MessageSquare size={22} />
                <strong>New conversation with {actorName}</strong>
                <span>Type a message below to start. The conversation appears in the list once you send.</span>
              </div>
            ) : !selectedContextId ? (
              <div className="channel-empty">
                <MessageSquare size={22} />
                <strong>Select a conversation</strong>
                <span>Pick a conversation from the list above, or start a new one.</span>
              </div>
            ) : (
              <div className="channel-empty">
                <MessageSquare size={22} />
                <strong>No messages yet in this conversation.</strong>
                <span>Send a message to {actorName} below.</span>
              </div>
            )
          ) : (
            <>
              {chatSegments.map((segment) => {
                if (segment.kind === "activity") {
                  return renderActivityGroup(segment.group);
                }
                if (segment.kind === "streaming") {
                  return (
                    <div key={segment.turnId} className="channel-message other streaming">
                      <div className="message-meta">{actorName}</div>
                      <div className="message-text">{renderMarkdown(segment.text)}</div>
                    </div>
                  );
                }
                if (segment.kind === "pulse") {
                  return (
                    <div key={segment.event.event_id} className="pulse-event-card" data-testid="pulse-event-card">
                      <div className="pulse-event-meta">
                        Scheduled reminder · {new Date(segment.event.created_at).toLocaleTimeString()}
                      </div>
                      <div className="pulse-event-text">{renderMarkdown(pulseEventText(segment.event))}</div>
                    </div>
                  );
                }
                const isSelf = segment.message.source_endpoint_id === humanEndpoint;
                return (
                  <div key={segment.message.event_id} className={`channel-message ${isSelf ? "self" : "other"}`}>
                    <div className="message-meta">{messageSourceLabel(segment.message.source_endpoint_id)} · {new Date(segment.message.created_at).toLocaleTimeString()}</div>
                    <div className="message-text">{isSelf ? segment.message.content.text : renderMarkdown(segment.message.content.text ?? "")}</div>
                    {segment.activity && renderActivityGroup(segment.activity)}
                  </div>
                );
              })}
            </>
          )}
          {floeIsActive && !chatSegments.some((s) => s.kind === "activity" && s.group.status === "working") && (
            <div className="thinking-strip">
              <Loader size={13} className="spin" />
              <span>{actorName} is working…</span>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <div className="channel-composer">
          <input
            value={channelMessage}
            onChange={(event) => setChannelMessage(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendFloeMessage();
              }
            }}
            disabled={!selectedAgent || !canUseChannelComposer}
            aria-label={selectedAgent ? `Message ${actorName}` : "Message actor"}
            placeholder={!selectedAgent ? "No actors available" : !selectedContextCanMessage ? "Read-only Context" : !runtimeReady ? "Configure runtime first" : runtimeBlockedByFakeAdapter ? "Configure bridge runtime first" : `Message ${actorName}`}
          />
          <button
            className="icon-button primary-icon"
            onClick={() => void sendFloeMessage()}
            disabled={!selectedAgent || !canUseChannelComposer || !channelMessage.trim()}
            title="Send"
            aria-label="Send message"
          >
            <Send size={15} />
          </button>
        </div>
      </aside>
    );
  }

  return (
    <main className={`floe-shell v6-shell${channelOpen ? " with-channel" : ""}`} data-testid="v6-shell">
      <header className="topbar v6-topbar" data-testid="v6-topbar">
        {renderWorkspaceSwitcher()}
        <nav className="breadcrumb">
          <button onClick={goToWorkspaceHome}><Home size={14} /> Workspace</button>
          {view.kind === "field" && (
            <>
              <ChevronRight size={14} />
              <button className="breadcrumb-current">
                {loadedProjection?.scope.title ?? selectedFieldSummary?.title ?? view.fieldId}
              </button>
            </>
          )}
        </nav>
        <div className="topbar-actions">
          {view.kind === "field" && (
            <div className="pill-grp scope-mode-pill" role="group" aria-label="Scope mode">
              <button type="button" className="is-on">Map</button>
              <button type="button" disabled title="Ops surface follows in a later v6 slice">Ops</button>
            </div>
          )}
          <button className="icon-button" onClick={() => void refresh()} title="Refresh" aria-label="Refresh workspace">
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="workspace-rail v6-left-nav" data-testid="v6-left-nav" aria-label="Workspace navigation">
          <div className="rail-brand">
            <div className="brand-mark"><Workflow size={18} /></div>
            <div>
              <strong>Floe</strong>
              <span className={`connection ${connectionClass(status)}`}><CircleDot size={10} />{status}</span>
            </div>
          </div>
          <div className="rail-section">
            <button
              type="button"
              className={`nav-row ${view.kind === "home" ? "active" : ""}`}
              onClick={goToWorkspaceHome}
            >
              <Home size={15} />
              <span>Home</span>
            </button>
            <button
              type="button"
              className={`nav-row ${view.kind === "activity" ? "active" : ""}`}
              onClick={() => setView({ kind: "activity" })}
            >
              <Activity size={15} />
              <span>Activity</span>
            </button>
            <span className="rail-label nav-group-label">
              <span>Scopes</span>
              <span>{fieldSummaries.length}</span>
            </span>
            {fieldSummaries.length === 0 ? (
              <div className="nav-empty">No named Scopes yet</div>
            ) : (
              fieldSummaries.map((summary) => (
                <button
                  key={summary.id}
                  type="button"
                  className={`nav-row scope-nav-row${view.kind === "field" && view.fieldId === summary.id ? " active" : ""}`}
                  onClick={() => openField(summary.id)}
                >
                  <LayoutPanelLeft size={15} />
                  <span>{summary.title}</span>
                </button>
              ))
            )}
            <button
              type="button"
              className="nav-row nav-add"
              onClick={promptCreateField}
              draggable
              onDragStart={handleFieldPrimitiveDragStart}
              title="Create a new Scope"
            >
              <FolderPlus size={15} />
              <span>New Scope</span>
            </button>
            {view.kind === "field" && loadedProjection && (
              <div className="scope-nav-section" data-testid="v6-scope-contexts">
                <span className="rail-label nav-group-label">
                  <span>Contexts</span>
                  <span>{openedScopeContexts.length}</span>
                </span>
                {openedScopeContexts.length === 0 ? (
                  <div className="nav-empty">No mapped Contexts</div>
                ) : (
                  openedScopeContexts.map((context) => (
                    <button
                      key={context.context_id}
                      type="button"
                      className={`nav-row context-nav-row${selectedContextId === context.context_id ? " active" : ""}`}
                      onClick={() => openProjectedContext(context.context_id)}
                    >
                      <MessageSquare size={15} />
                      <span>{context.first_message_preview || context.context_id}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button className="rail-settings" onClick={() => setShowBusSettings((current) => !current)}>
            <Settings size={14} />
            Bus
          </button>
          {showBusSettings && (
            <div className="bus-settings">
              <input value={busUrl} onChange={(event) => setBusUrl(event.target.value)} />
              <button onClick={() => void refresh()}>Reconnect</button>
            </div>
          )}
        </aside>

        <div
          className="surface-area"
          data-testid="v6-main-surface"
          onDrop={handleLibraryDropSurface}
          onDragOver={handleLibraryDragOver}
        >
          {error && <div className="error-bar">{error}</div>}
          {!selectedWorkspace ? renderNoWorkspace() : view.kind === "field" ? renderField() : view.kind === "activity" ? renderActivity() : renderHome()}
        </div>
        {renderInspector()}
        {renderChannel()}
      </div>
      <DialogHost />
    </main>
  );
}

function InspectorSection(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="inspector-section">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

function Detail(props: { label: string; value: React.ReactNode }) {
  return (
    <div className="detail">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function actorInitial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "A";
}

function formatContextTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, text: string) {
    super(text);
    this.status = status;
    this.body = body;
  }
}

async function api<T>(baseUrl: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const text = await response.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    throw new ApiError(response.status, body, `${options.method ?? "GET"} ${path}: ${response.status} ${text}`);
  }
  return response.json() as Promise<T>;
}

function operatorActorId(workspaceId: string): string {
  return `actor:${workspaceId}:operator`;
}

function endpointDisplayName(endpoint: Endpoint | null | undefined): string | null {
  const name = endpoint?.name?.trim();
  return name ? name : null;
}

function scopeToFieldSummary(scope: ScopeRecord): FieldSummary {
  return {
    id: scope.scope_id,
    title: scope.title || scope.scope_id,
    item_count: 0,
    connection_count: 0,
    parent_count: 0,
    updated_at: scope.updated_at
  };
}

function projectionScopeFallback(projection: ScopeProjection): ScopeRecord {
  return {
    workspace_id: projection.workspace_id,
    scope_id: projection.scope_id,
    title: projection.scope_id,
    description: null,
    is_default: false,
    created_at: projection.generated_at,
    updated_at: projection.generated_at
  };
}

function cachedOperatorDisplayName(): string | null {
  const name = localStorage.getItem("floe-operator-name")?.trim();
  return name ? name : null;
}

function workspaceStatusLabel(workspace: Workspace): string {
  if (!workspace.init_authorized) return "consent required";
  if (workspace.status === "attached") return "attached";
  if (workspace.status === "config_drift") return "config drift";
  return workspace.status;
}

function connectionClass(status: string): string {
  if (status === "Connected") return "connected";
  if (status === "Offline") return "offline";
  return "pending";
}

function currentContextLabel(view: View, workspace: Workspace | null, fieldTitle: string | null): string {
  if (!workspace) return "No workspace";
  if (view.kind === "field" && fieldTitle) return `Workspace: ${workspace.name}; Field: ${fieldTitle}`;
  if (view.kind === "activity") return `Workspace: ${workspace.name}; Activity`;
  return `Workspace: ${workspace.name}; Home`;
}

function endpointRuntimeAdapter(endpoint: Endpoint | null): string | null {
  if (!endpoint?.metadata_json) return null;
  try {
    const metadata = JSON.parse(endpoint.metadata_json) as Record<string, unknown>;
    return typeof metadata.runtime_adapter === "string"
      ? metadata.runtime_adapter.trim().toLowerCase()
      : null;
  } catch {
    return null;
  }
}

/** Human-friendly label for a completed activity group */
function activityGroupLabel(items: RuntimeActivity[]): string {
  // After merging, items are resolved (Completed/Failed). Extract tool names from all items.
  const toolItems = items.filter((item) => item.kind === "Completed" || item.kind === "Running" || item.kind === "Failed");
  if (toolItems.length === 0) return `Activity · ${items.length} step${items.length === 1 ? "" : "s"}`;
  const toolNames = toolItems.map((item) => {
    const name = item.summary || "tool";
    if (name === "emit" || name.startsWith("emit ") || name === "sent message" || name.startsWith("sent message")) return "sent message";
    return name;
  });
  const uniqueTools = [...new Set(toolNames)];
  // Append "completed" when all items are resolved (no Running)
  const allResolved = items.every((item) => item.kind !== "Running");
  const suffix = allResolved ? " · completed" : "";
  if (uniqueTools.length === 1) return `Activity · ${uniqueTools[0]}${suffix}`;
  if (uniqueTools.length <= 3) return `Activity · ${uniqueTools.join(" · ")}${suffix}`;
  return `Activity · ${uniqueTools.length} tools${suffix}`;
}

/** Live working label showing the latest action */
function activityWorkingLabel(items: RuntimeActivity[]): string {
  const latest = items.at(-1);
  if (!latest) return "Working…";
  if (latest.kind === "Running") {
    const name = latest.summary || "tool";
    return `Running ${name}…`;
  }
  if (latest.kind === "Completed") {
    const name = latest.summary || "tool";
    return `Ran ${name}`;
  }
  if (latest.kind === "Failed") {
    const name = latest.summary || "tool";
    return `${name} failed`;
  }
  return "Working…";
}

function chatSegmentCreatedAt(segment: ChatSegment): string {
  if (segment.kind === "message") return segment.message.created_at;
  if (segment.kind === "pulse") return segment.event.created_at;
  return "9999-12-31T23:59:59.999Z";
}

function pulseEventText(event: ContextEvent): string {
  if (typeof event.content?.text === "string" && event.content.text.trim()) {
    return event.content.text;
  }
  const data = event.content?.data;
  if (data && typeof data.text === "string" && data.text.trim()) {
    return data.text;
  }
  return "Pulse fired.";
}

function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  return lines.map((line, index) => {
    if (!line.trim()) return <br key={index} />;
    return <p key={index}>{inlineMarkdown(line)}</p>;
  });
}

function inlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2]) parts.push(<strong key={key++}>{match[2]}</strong>);
    if (match[4]) parts.push(<code key={key++}>{match[4]}</code>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

createRoot(document.getElementById("root")!).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>
);
