/*
 * @invariant shell-surfaces composes the only supported floe-web shell chrome, including Tailwind/shadcn primitives, V6-aligned panels, and React Flow-backed scope surfaces.
 * @invariant Workspace, Context, Scope, Inspector, and Channel semantics stay substrate-backed here; UI foundation changes must not replace or bypass those contracts.
 */
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
  SquareDashedMousePointer,
  Workflow,
  X
} from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge as ReactFlowEdge,
  type EdgeChange,
  type Node as ReactFlowNode,
  type NodeChange,
  type Viewport
} from "@xyflow/react";
import "./styles.css";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
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
  buildContextInspectorSummary,
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
const shellLeftPanelMinWidthPx = 248;
const shellLeftPanelDefaultWidthPx = 272;
const shellLeftPanelMaxWidthPx = 340;
const shellMainPanelMinWidthPx = 520;
const shellInspectorPanelMinWidthPx = 304;
const shellInspectorPanelDefaultWidthPx = 344;
const shellInspectorPanelMaxWidthPx = 420;

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
      return false;
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
  const channelActorSummary = selectedAgent
    ? buildActorInspectorSummary({
      actorId: selectedAgent.endpoint_id,
      contexts: sortedContexts.sorted,
      activityRows,
      runtimeBinding: agentBinding,
      adapter: selectedAgentRuntimeAdapter ?? bridgeRuntimeAdapterName
    })
    : null;
  const selectedContextInspectorSummary = selectedContext
    ? buildContextInspectorSummary({
      context: selectedContext,
      events: contextEvents,
      scopeTitlesById
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
      const edges: ReactFlowEdge[] = flow.edges.map((edge) => {
        const label = typeof edge.label === "string" ? edge.label : "";
        return {
          ...edge,
          type: undefined,
          selected: selectedFieldConnectionId === edge.id,
          reconnectable: false,
          label,
          labelShowBg: true,
          labelBgPadding: [6, 2],
          labelBgBorderRadius: 999,
          style: scopeMapEdgeStyle(selectedFieldConnectionId === edge.id)
        };
      });
      const nodes = flow.nodes.map((node) => {
        const kind = typeof node.data?.kind === "string" ? node.data.kind : "context";
        return {
          ...node,
          type: undefined,
          selected: selectedFieldItemIds.has(node.id),
          style: scopeMapNodeStyle(kind, selectedFieldItemIds.has(node.id))
        };
      });
      return { nodes, edges };
    }
    return { nodes: [], edges: [] };
  }, [
    loadedProjection,
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

  const handleFieldEdgesChange = useCallback((changes: EdgeChange<ReactFlowEdge>[]) => {
    const selection = [...changes].reverse().find((change) => change.type === "select");
    if (!selection || selection.type !== "select") return;
    if (selection.selected) {
      setSelectedFieldConnectionId(selection.id);
      return;
    }
    setSelectedFieldConnectionId((current) => current === selection.id ? null : current);
  }, []);

  const handleFieldEdgesDelete = useCallback((edges: ReactFlowEdge[]) => {
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
    edges: ReactFlowEdge[];
  }) => {
    return nodes.length === 0;
  }, []);

  const handleFieldReconnect = useCallback((oldEdge: ReactFlowEdge, connection: Connection) => {
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
        <div className="empty-start-panel overflow-hidden border border-border/70 bg-card/95 shadow-2xl shadow-black/35">
          <div className="brand-lockup bg-[linear-gradient(180deg,hsl(var(--accent))/0.12,transparent)]">
            <div className="brand-mark"><Workflow size={22} /></div>
            <div>
              <h1>Floe</h1>
              <p>Open a portable workspace to begin.</p>
            </div>
          </div>
          <div className="workspace-form">
            <label>
              Workspace folder
              <Input
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void registerWorkspace(); }}
                placeholder="C:\\Development\\example-workspace"
              />
            </label>
            <label>
              Name
              <Input
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
            <Button className="primary-action" onClick={() => void registerWorkspace()} disabled={!workspacePath.trim()}>
              <FolderPlus size={16} />
              Create Workspace
            </Button>
          </div>
        </div>
      </section>
    );
  }

  function renderWorkspaceSwitcher() {
    const label = selectedWorkspace?.name ?? "Open Workspace";
    return (
      <DropdownMenu
        open={workspaceMenuOpen}
        onOpenChange={(open) => {
          setWorkspaceMenuOpen(open);
          if (!open) setWorkspaceCreateOpen(false);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className="h-10 min-w-[13rem] justify-between rounded-xl border-border/70 bg-background/55 px-3 text-sm text-foreground shadow-sm hover:bg-accent/30"
          >
            <span className="flex min-w-0 items-center gap-2">
              <FolderOpen size={15} />
              <span className="truncate">{label}</span>
            </span>
            <ChevronDown size={14} className={cn("transition-transform", workspaceMenuOpen && "rotate-180")} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={10}
          className="w-[26rem] border-border/70 bg-popover/95 p-2 shadow-2xl shadow-black/35 backdrop-blur-xl"
        >
          <div className="px-2 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Workspaces
          </div>
          <ScrollArea className="max-h-72">
            <div className="space-y-2 pr-2">
              {workspaces.length === 0 ? (
                <p className="workspace-menu-empty rounded-xl border border-dashed border-border/70 bg-background/45 px-3 py-4">
                  No Workspaces registered
                </p>
              ) : (
                workspaces.map((workspace) => (
                  <div key={workspace.workspace_id} className="workspace-menu-row flex items-stretch gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      className={cn(
                        "workspace-menu-item h-auto flex-1 items-start justify-between rounded-xl border border-transparent px-3 py-3 text-left hover:bg-accent/25",
                        workspace.workspace_id === selectedWorkspaceId && "border-border/70 bg-accent/30 text-accent-foreground"
                      )}
                      onClick={() => void selectWorkspace(workspace.workspace_id)}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate">{workspace.name}</strong>
                        <small className="mt-1 block truncate text-muted-foreground">
                          {workspace.locator ?? workspace.workspace_id}
                        </small>
                      </span>
                      {workspace.workspace_id === selectedWorkspaceId && <Check size={14} className="mt-0.5 shrink-0" />}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="workspace-menu-delete h-auto rounded-xl border border-transparent text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                      onClick={() => void deleteWorkspace(workspace.workspace_id)}
                      title="Remove workspace"
                      aria-label={`Remove workspace ${workspace.name}`}
                    >
                      <X size={12} />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>
          <DropdownMenuSeparator />
          <Button
            type="button"
            variant="ghost"
            className="workspace-menu-create w-full justify-start rounded-xl px-3 text-left hover:bg-accent/25"
            onClick={() => setWorkspaceCreateOpen((current) => !current)}
          >
            <FolderPlus size={14} />
            {workspaceCreateOpen ? "Hide workspace form" : "New Workspace"}
          </Button>
          {workspaceCreateOpen && (
            <div className="workspace-menu-form mt-2 space-y-3 rounded-2xl border border-border/70 bg-background/55 p-3">
              <label>
                Location
                <Input
                  value={workspacePath}
                  onChange={(event) => setWorkspacePath(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void registerWorkspace(); }}
                  placeholder="C:\\Development\\example-workspace"
                />
              </label>
              <label>
                Name
                <Input
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
              <Button
                type="button"
                className="primary-action full"
                onClick={() => void registerWorkspace()}
                disabled={!workspacePath.trim()}
              >
                Create Workspace
              </Button>
            </div>
          )}
          <DropdownMenuSeparator />
          <div className="space-y-3 rounded-2xl border border-border/70 bg-background/55 p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Connection</div>
                <div className="mt-1 text-sm text-foreground/90">Workspace bus</div>
              </div>
              <span className={cn("inline-flex items-center gap-1 rounded-full border border-border/70 px-2 py-1 text-[11px] font-medium", connectionClass(status))}>
                <CircleDot size={10} />
                {status}
              </span>
            </div>
            <label className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              URL
              <Input
                value={busUrl}
                onChange={(event) => setBusUrl(event.target.value)}
                className="mt-2"
                aria-label="Workspace bus URL"
              />
            </label>
            <Button type="button" variant="outline" className="w-full" onClick={() => void refresh()}>
              Reconnect
            </Button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  function renderHome() {
    const homeActorCards = homeModel.actorCards.filter((actor) => actor.endpointId !== selfActorId);
    const runtimeStateLabel = canMessageRuntime ? "Ready" : runtimeBlockedByFakeAdapter ? "Blocked by adapter" : "Needs setup";
    return (
      <section className="workspace-home home2" data-testid="v6-workspace-home">
        <section className="hero">
          <p className="eyebrow">Workspace</p>
          <h1>{selectedWorkspace?.name ?? "Workspace"}</h1>
          <p className="home-summary">
            Actors, Scopes, and live Activity. Home indexes Workspace state without becoming a Scope.
            Open Activity for the full substrate stream.
          </p>
          <div className="home-hero-actions">
            <Button type="button" variant="ghost" size="sm" className="home-inline-button" onClick={() => setView({ kind: "activity" })}>
              <Activity size={14} />
              <span>Open Activity</span>
            </Button>
          </div>
        </section>

        <section className="ws-settings" data-testid="v6-home-workspace-settings">
          <div className="wss-row">
            <div className="wss-key">Path</div>
            <div className="wss-val">
              <code className="wss-path">{selectedWorkspace?.locator ?? "—"}</code>
              {selectedWorkspace?.locator && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="wss-copy"
                  title="Copy path"
                  onClick={() => {
                    void navigator.clipboard.writeText(selectedWorkspace.locator).catch(() => {
                      setError("Could not copy the Workspace path.");
                    });
                  }}
                >
                  Copy
                </Button>
              )}
            </div>
          </div>
          <div className="wss-row">
            <div className="wss-key">Status</div>
            <div className="wss-val">{selectedWorkspace ? workspaceStatusLabel(selectedWorkspace) : "No workspace"}</div>
          </div>
          <div className="wss-row">
            <div className="wss-key">New actors inherit</div>
            <div className="wss-val wss-inline">
              {authProfiles.length === 0 ? (
                <span className="wss-unconfigured">No profiles — run <code>floe login</code></span>
              ) : (
                <>
                  <select
                    className="wss-select"
                    value={workspaceBinding?.auth_profile ?? ""}
                    onChange={(event) => void setWorkspaceProfile(event.target.value)}
                    title="Default profile for new actors"
                  >
                    <option value="">Profile…</option>
                    {authProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>{profile.id}</option>
                    ))}
                  </select>
                  <span className="wss-sep">·</span>
                  <select
                    className="wss-select"
                    value={workspaceBinding?.model ?? ""}
                    onChange={(event) => void setWorkspaceModel(event.target.value)}
                    disabled={!workspaceBinding?.auth_profile || workspaceModelOptions.length === 0}
                    title="Default model for new actors"
                  >
                    <option value="">Model…</option>
                    {workspaceModelOptions.map((model) => (
                      <option key={model.id} value={model.id}>{model.name}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>
          <div className="wss-row">
            <div className="wss-key">Runtime</div>
            <div className="wss-val">
              {runtimeStateLabel}
              {bridgeRuntimeAdapterName ? ` · ${bridgeRuntimeAdapterName}` : ""}
            </div>
          </div>
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

        <section data-testid="v6-home-actors">
          <h2 className="sect">
            <span>Actors</span>
            <span className="ct">{homeActorCards.length}</span>
          </h2>
          {homeActorCards.length === 0 ? (
            <div className="quiet-empty compact">
              <CircleDot size={22} />
              <strong>No actors available</strong>
              <span>Registered Workspace actors will appear here.</span>
            </div>
          ) : (
            <div className="actor-strip home-actor-strip">
              {homeActorCards.map((actor) => {
                const name = actor.name;
                const selected = inspectorActor?.endpoint_id === actor.endpointId;
                return (
                  <article key={actor.endpointId} className={`actor-card home-actor-card${selected ? " is-on selected" : ""}`}>
                    <button
                      type="button"
                      className="home-actor-summary"
                      aria-pressed={selected}
                      onClick={() => selectActorForInspector(actor.endpointId)}
                    >
                      <span className="av home-actor-avatar">{actorInitial(name)}</span>
                      <span className="actor-meta">
                        <strong className="nm">{name}</strong>
                        <small>{actor.status} · Workspace-level {actor.workspaceLevelContextCount} · Scoped {actor.scopedContextCount}</small>
                        <small>Activity {actor.activityCount} · {actor.runtimeBindingLabel} · {actor.adapterLabel}</small>
                        {actor.latestActivityDetail && <small>Latest: {actor.latestActivityDetail}</small>}
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="home-inline-button home-actor-action"
                      aria-label={`Open Contexts for ${name}`}
                      onClick={() => openActorContexts(actor.endpointId)}
                    >
                      Open Contexts
                    </Button>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section data-testid="v6-home-scopes">
          <h2 className="sect">
            <span>Scopes</span>
            <span className="ct">{homeFieldSummaries.length}</span>
            <span className="actions">
              {nestedFieldCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="home-inline-button"
                  onClick={() => setShowAllFields((current) => !current)}
                >
                  {showAllFields ? "Show root Scopes" : `Show all Scopes (${fieldSummaries.length})`}
                </Button>
              )}
            </span>
          </h2>
          {homeFieldSummaries.length === 0 ? (
            <div className="quiet-empty">
              <SquareDashedMousePointer size={22} />
              <strong>No Scopes yet</strong>
              <span>Create a named Scope to start shaping this workspace.</span>
            </div>
          ) : (
            <div className="scope-grid">
              {homeFieldSummaries.map((summary) => {
                const scopeCard = homeModel.scopeCards.find((card) => card.scopeId === summary.id);
                const scopeRecord = scopeRecords.find((record) => record.scope_id === summary.id);
                const loadedContextCount = scopeCard?.loadedContextCount ?? 0;
                const activityCount = scopeCard?.activityCount ?? 0;
                return (
                  <button key={summary.id} className="scope-card" onClick={() => openField(summary.id)}>
                    <div className="sc-head">
                      <span className="sc-glyph">{summary.title.charAt(0).toUpperCase()}</span>
                      <span className="sc-name">{summary.title}</span>
                    </div>
                    <div className="sc-desc">
                      {scopeRecord?.description?.trim() || `Field map with ${summary.item_count} item${summary.item_count === 1 ? "" : "s"} and ${summary.connection_count} connection${summary.connection_count === 1 ? "" : "s"}.`}
                    </div>
                    <div className="sc-stats">
                      <span><b>{loadedContextCount}</b> contexts</span>
                      <span><b>{activityCount}</b> activity</span>
                    </div>
                  </button>
                );
              })}
              <button type="button" className="scope-add" onClick={promptCreateField}>
                <FolderPlus size={15} />
                <span>Add Scope</span>
              </button>
            </div>
          )}
        </section>

        <section data-testid="v6-home-recent-activity">
          <h2 className="sect">
            <span>Recent activity</span>
            <span className="ct">{homeModel.recentActivity.length}</span>
            <span className="actions">
              <Button type="button" variant="ghost" size="sm" className="home-inline-button" onClick={() => setView({ kind: "activity" })}>
                View all
              </Button>
            </span>
          </h2>
          {homeModel.recentActivity.length === 0 ? (
            <div className="quiet-empty compact">
              <Activity size={22} />
              <strong>No recent activity</strong>
              <span>Events, deliveries, and runtime work will appear here.</span>
            </div>
          ) : (
            <ScrollArea className="ws-stream">
              <div className="home-activity-list">
                {homeModel.recentActivity.map((item) => (
                  <article key={item.id} className="home-activity-row">
                    <span className="field-icon"><Activity size={15} /></span>
                    <span className="home-activity-body">
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                      <small>{item.sourceLabel} · {item.contextLabel ?? "No Context"} · {item.scopeLabel}</small>
                    </span>
                    <time className="home-activity-time" dateTime={item.createdAt}>{formatContextTimestamp(item.createdAt)}</time>
                  </article>
                ))}
              </div>
            </ScrollArea>
          )}
        </section>

        <section data-testid="v6-home-contexts">
          <h2 className="sect">
            <span>Workspace contexts</span>
            <span className="ct">{recentWorkspaceContexts.length}</span>
          </h2>
          {recentWorkspaceContexts.length === 0 ? (
            <div className="quiet-empty">
              <MessageSquare size={22} />
              <strong>No Workspace-level Contexts yet</strong>
              <span>Direct actor conversations will appear here without assigning them to a Scope.</span>
            </div>
          ) : (
            <div className="ctx-list workspace-context-list">
              {recentWorkspaceContexts.map((context) => {
                const label = workspaceContextLabel(context);
                const activityTime = context.last_event_at ?? context.created_at;
                const canAssign = canAssignContextToScope(context);
                const selectedTargetScope = contextAssignmentTargets[context.context_id] ?? "";
                return (
                  <article key={context.context_id} className="workspace-context-block ctx-row">
                    <span className="glyph field-icon"><MessageSquare size={14} /></span>
                    <span className="workspace-context-body ctx-body">
                      <strong className="label">{label}</strong>
                      <small className="preview workspace-context-preview">{context.first_message_preview ?? "Workspace-level Context"}</small>
                      <span className="meta workspace-context-meta">
                        <span>{contextParticipationLabel(context, scopeTitlesById)}</span>
                        <span>{formatContextTimestamp(activityTime)}</span>
                        <span>{contextScopeAssignmentStatus(context)}</span>
                      </span>
                    </span>
                    <span className="workspace-context-actions">
                      <Button type="button" variant="ghost" size="sm" className="home-inline-button" onClick={() => openWorkspaceContext(context)}>
                        Open
                      </Button>
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
                          <Button
                            type="button"
                            size="sm"
                            className="home-primary-button"
                            onClick={() => void assignWorkspaceContextToScope(context, selectedTargetScope)}
                            disabled={!selectedTargetScope}
                          >
                            Assign to Scope
                          </Button>
                          <Button type="button" variant="ghost" size="sm" className="home-inline-button" onClick={() => promptCreateScopeAndAssign(context)}>
                            Create Scope and assign
                          </Button>
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
    const hasActiveFilters = Object.values(activityFilters).some((value) => value !== "all");
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
        <div className="activity-summary-bar" data-testid="activity-summary">
          <div className="activity-summary-title">
            <p className="eyebrow">Activity</p>
            <h1>Workspace Activity</h1>
          </div>
          <div className="activity-summary-metrics">
            <span><strong>{activeCount}</strong> {hasActiveFilters ? "matching records" : "records total"}</span>
            <span><strong>{eventCount}</strong> Events</span>
            <span><strong>{runtimeCount}</strong> runtime activity</span>
            <span><strong>{activeContextCount}</strong> Contexts</span>
            <span><strong>{activeScopeCount}</strong> Scopes</span>
          </div>
          {hasActiveFilters && (
            <Button type="button" variant="outline" size="sm" className="activity-summary-clear" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>

        <section className="activity-filter-bar" aria-label="Activity filters">
          <div className="activity-filter-group">
            <span className="activity-filter-label">Actor</span>
            {endpoints.map((endpoint) => {
              const label = endpointDisplayName(endpoint) ?? endpoint.agent_id ?? endpoint.endpoint_id;
              return (
                <Button
                  key={endpoint.endpoint_id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn("activity-filter-chip", activityFilters.actorId === endpoint.endpoint_id && "active")}
                  onClick={() => setFilter({ actorId: activityFilters.actorId === endpoint.endpoint_id ? "all" : endpoint.endpoint_id })}
                >
                  {label}
                </Button>
              );
            })}
          </div>

          <div className="activity-filter-group">
            <span className="activity-filter-label">Kind</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("activity-filter-chip", activityFilters.kind === "events" && "active")}
              onClick={() => setFilter({ kind: activityFilters.kind === "events" ? "all" : "events" })}
            >
              Events
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("activity-filter-chip", activityFilters.kind === "runtime" && "active")}
              onClick={() => setFilter({ kind: activityFilters.kind === "runtime" ? "all" : "runtime" })}
            >
              Runtime
            </Button>
            {allKinds.map((kind) => (
              <Button
                key={kind}
                type="button"
                variant="ghost"
                size="sm"
                className={cn("activity-filter-chip", activityFilters.kind === kind && "active")}
                onClick={() => setFilter({ kind: activityFilters.kind === kind ? "all" : kind })}
              >
                {kind}
              </Button>
            ))}
          </div>

          <div className="activity-filter-group">
            <span className="activity-filter-label">Scope</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("activity-filter-chip", activityFilters.scopeId === "all" && "active")}
              onClick={() => setFilter({ scopeId: "all" })}
            >
              All
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={cn("activity-filter-chip", activityFilters.scopeId === "workspace" && "active")}
              onClick={() => setFilter({ scopeId: activityFilters.scopeId === "workspace" ? "all" : "workspace" })}
            >
              Workspace only
            </Button>
            {scopeRecords.map((scope) => (
              <Button
                key={scope.scope_id}
                type="button"
                variant="ghost"
                size="sm"
                className={cn("activity-filter-chip", activityFilters.scopeId === scope.scope_id && "active")}
                onClick={() => setFilter({ scopeId: activityFilters.scopeId === scope.scope_id ? "all" : scope.scope_id })}
              >
                {scope.title}
              </Button>
            ))}
          </div>

          <div className="activity-filter-group">
            <span className="activity-filter-label">Context</span>
            {activityContextOptions.length === 0 ? (
              <span className="activity-filter-empty">
                {activityFilters.scopeId === "all" ? "Pick a Scope first" : "No Contexts in this selection"}
              </span>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={cn("activity-filter-chip", activityFilters.contextId === "all" && "active")}
                  onClick={() => setFilter({ contextId: "all" })}
                >
                  All
                </Button>
                {activityContextOptions.map((context) => (
                  <Button
                    key={context.context_id}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn("activity-filter-chip", activityFilters.contextId === context.context_id && "active")}
                    onClick={() => setFilter({ contextId: activityFilters.contextId === context.context_id ? "all" : context.context_id })}
                  >
                    {contextActivityLabel(context)}
                  </Button>
                ))}
              </>
            )}
          </div>
        </section>

        <div className="activity-stream-body">
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
                      <span className={cn("activity-row-glyph", row.category === "runtime" && "runtime")}>
                        {row.category === "runtime" ? <Workflow size={15} /> : <MessageSquare size={15} />}
                      </span>
                      <div className="activity-row-body">
                        <div className="activity-row-heading">
                          <span className="activity-row-source">{row.sourceLabel}</span>
                          <span className="activity-row-separator">·</span>
                          <strong>{row.title}</strong>
                          {row.contextLabel && (
                            <>
                              <span className="activity-row-separator">·</span>
                              <span>{row.contextLabel}</span>
                            </>
                          )}
                          <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleTimeString()}</time>
                        </div>
                        <p>{row.detail}</p>
                        <div className="activity-row-meta">
                          <span className={cn("activity-row-pill", row.category === "runtime" && "runtime")}>
                            {row.category === "runtime" ? "Runtime" : "Event"}
                          </span>
                          <span className="activity-row-pill">{row.scopeLabel}</span>
                          {row.kind !== row.title && <span className="activity-row-pill subtle">{row.kind}</span>}
                        </div>
                      </div>
                    </button>
                    {context && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="activity-row-action"
                        onClick={() => openWorkspaceContext(context)}
                      >
                        Open Context
                      </Button>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderField() {
    if (view.kind !== "field") return null;
    const title = loadedProjection?.scope.title ?? selectedFieldSummary?.title ?? view.fieldId;
    const scopeDescription = selectedScopeRecord?.description?.trim() || "React Flow projection of substrate-backed Contexts, Pulses, and route relationships.";
    const projectedContextCount = scopeInspectorSummary?.projectedContextCount ?? 0;
    const pulseCount = scopeInspectorSummary?.pulseCount ?? 0;
    const projectedRouteCount = (scopeInspectorSummary?.projectedEventCount ?? 0) + (scopeInspectorSummary?.projectedActivityRefCount ?? 0);
    const actorCount = scopeInspectorSummary?.actorCount ?? 0;
    return (
      <section className="field-surface v6-scope-field" data-testid="v6-scope-field-map">
        <div className="scope-stage-shell">
          <div className="scope-stage-header" data-testid="v6-scope-stage-header">
            <div className="scope-stage-heading">
              <p className="eyebrow">Scope</p>
              <p className="scope-stage-description">{scopeDescription}</p>
              <div className="scope-stage-stats" aria-label="Scope summary">
                <span className="scope-stage-stat">
                  <strong>{projectedContextCount}</strong>
                  Contexts
                </span>
                <span className="scope-stage-stat">
                  <strong>{pulseCount}</strong>
                  Pulses
                </span>
                <span className="scope-stage-stat">
                  <strong>{projectedRouteCount}</strong>
                  Route refs
                </span>
                <span className="scope-stage-stat">
                  <strong>{actorCount}</strong>
                  Actors
                </span>
              </div>
            </div>
            <div className="field-toolbar">
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
              <div className="field-toolbar-actions">
                <button className="ghost-action" onClick={backFromField} title="Back to Home">
                  <ArrowLeft size={16} />
                  Back
                </button>
                {renameDraft === null && (
                  <button className="ghost-action" onClick={beginRenameField} disabled={!loadedProjection}>
                    <Edit3 size={16} />
                    Rename Scope
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="canvas-wrap v6-scope-map-canvas">
            <div className="map-toolbar" aria-label="Map viewport controls" data-testid="v6-scope-map-toolbar">
              <span className="map-toolbar-label">Viewport</span>
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
              onNodesChange={handleFieldNodesChange}
              onEdgesChange={handleFieldEdgesChange}
              onBeforeDelete={handleFieldBeforeDelete}
              onEdgesDelete={handleFieldEdgesDelete}
              onMoveEnd={handleFieldMoveEnd}
              onNodeDragStop={handleFieldNodeDragStop}
              onNodeDoubleClick={handleFieldNodeDoubleClick}
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
        </div>
      </section>
    );
  }

  function renderInspector() {
    return (
      <aside
        className="inspector flex h-full min-h-0 flex-col border-l border-border/70 bg-card/90 backdrop-blur-xl"
        data-testid="v6-inspector"
        aria-label="Inspector"
      >
        {channelOpen ? (
          renderChannel()
        ) : (
          <>
            <div className="inspector-header flex items-center justify-between border-b border-border/70 px-4">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Inspector</span>
              <Button variant="ghost" size="icon" className="icon-button h-8 w-8 rounded-lg" onClick={() => void refresh()} title="Refresh">
                <RefreshCw size={14} />
              </Button>
            </div>
            <ScrollArea className="flex-1">
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
                  {inspectorActorContexts.map((context) => renderInspectorContextPill(context))}
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
            </ScrollArea>
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

  function renderInspectorContextPill(context: ContextSummary) {
    const label = neutralContextLabel(context, scopeTitlesById, pulseLabels[context.context_id]);
    const participationLabel = contextParticipationLabel(context, scopeTitlesById);
    const activityTime = context.last_event_at ?? context.created_at;
    return (
      <article
        key={context.context_id}
        className={cn("inspector-context-pill", selectedContextId === context.context_id && "active")}
      >
        <div className="inspector-context-pill-copy">
          <strong>{label}</strong>
          <span>{participationLabel}</span>
        </div>
        <div className="inspector-context-pill-meta">
          <small>{formatContextTimestamp(activityTime)}</small>
          <button
            type="button"
            className="ghost-action compact"
            onClick={() => openWorkspaceContext(context)}
          >
            Open
          </button>
        </div>
      </article>
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
    const activeConversationTitle = draftMode
      ? `New conversation with ${actorName}`
      : selectedContext ? neutralContextLabel(selectedContext, scopeTitlesById, pulseLabels[selectedContext.context_id]) : (
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
      <section className="channel channel-context-shell flex-1 min-h-0" data-testid="v6-channel" aria-label="Actor conversations">
        <div className="channel-header channel-context-header">
          <div className="channel-title channel-context-title">
            <div className="channel-avatar"><MessageSquare size={16} /></div>
            <div className="min-w-0">
              <strong>Actor Conversations</strong>
              <span>
                {selectedAgent
                  ? `${draftMode ? "Draft context" : selectedContextInspectorSummary?.scopeLabel ?? "Context"} · ${actorName}`
                  : "Select an actor from the workspace shell"}
              </span>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="icon-button h-9 w-9 rounded-xl"
            onClick={() => setChannelOpen(false)}
            title="Close actor conversation panel"
            aria-label="Close actor conversation panel"
          >
            <X size={16} />
          </Button>
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
                    onClick={() => openActorContexts(agent.endpoint_id)}
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
                  const label = neutralContextLabel(ctx, scopeTitlesById, pulseLabels[ctx.context_id]);
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
          <div className="channel-composer-head">
            <span className="channel-composer-label">
              {!selectedAgent
                ? "Channel closed to actor messaging"
                : draftMode
                  ? `Starting as ${operatorDisplayName}`
                  : selectedContext ? neutralContextLabel(selectedContext, scopeTitlesById, pulseLabels[selectedContext.context_id]) : `Messaging ${actorName}`}
            </span>
            <span className="channel-composer-hint">Enter to send</span>
          </div>
          <div className="channel-composer-row">
            <Input
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
              className="h-11 border-border/70 bg-background/70"
            />
            <Button
              className="icon-button primary-icon h-11 w-11 rounded-xl"
              size="icon"
              onClick={() => void sendFloeMessage()}
              disabled={!selectedAgent || !canUseChannelComposer || !channelMessage.trim()}
              title="Send"
              aria-label="Send message"
            >
              <Send size={15} />
            </Button>
          </div>
        </div>
      </section>
    );
  }

  const shellNavButtonClass =
    "h-10 w-full justify-start gap-2 rounded-xl border border-transparent px-3 text-sm font-medium text-muted-foreground shadow-none hover:bg-accent/25 hover:text-foreground";
  const shellNavButtonActiveClass = "border-border/70 bg-accent/30 text-accent-foreground";
  const shellSectionLabelClass = "mb-2 flex items-center justify-between px-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground";

  return (
    <main className="shell-root v6-shell flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="v6-shell">
      <header className="v6-topbar flex h-14 items-center justify-between gap-4 border-b border-border/70 bg-[color:var(--chrome)] px-4 backdrop-blur-xl" data-testid="v6-topbar">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={goToWorkspaceHome}
            className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent/20"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-foreground text-background">
              <Workflow size={16} />
            </span>
            <span className="hidden sm:inline">Floe</span>
          </button>
          <Separator orientation="vertical" className="hidden h-6 bg-border/70 sm:block" />
          {renderWorkspaceSwitcher()}
          {view.kind !== "home" && (
            <nav className="breadcrumb hidden min-w-0 items-center gap-2 md:flex">
              <ChevronRight size={14} className="text-muted-foreground" />
              <span className="breadcrumb-current truncate rounded-lg px-2 py-1 text-sm font-medium text-foreground">
                {view.kind === "activity"
                  ? "Activity"
                  : loadedProjection?.scope.title ?? selectedFieldSummary?.title ?? view.fieldId}
              </span>
            </nav>
          )}
        </div>
        <div className="topbar-actions flex items-center gap-2">
          {view.kind === "field" && (
            <div className="flex items-center rounded-xl border border-border/70 bg-background/55 p-1" role="group" aria-label="Scope mode">
              <Button type="button" size="sm" className="h-8 rounded-lg px-3">Map</Button>
              <Button type="button" variant="ghost" size="sm" className="h-8 rounded-lg px-3 text-muted-foreground" disabled title="Ops surface follows in a later v6 slice">
                Ops
              </Button>
            </div>
          )}
          <Button variant="ghost" size="icon" className="icon-button h-9 w-9 rounded-xl" onClick={() => void refresh()} title="Refresh" aria-label="Refresh workspace">
            <RefreshCw size={15} />
          </Button>
        </div>
      </header>

      <ResizablePanelGroup
        key={channelOpen ? "with-channel" : "without-channel"}
        orientation="horizontal"
        className="body shell-body !flex flex-1 min-h-0"
      >
        <ResizablePanel
          defaultSize={shellLeftPanelDefaultWidthPx}
          minSize={shellLeftPanelMinWidthPx}
          maxSize={shellLeftPanelMaxWidthPx}
          className="shell-left-nav v6-left-nav"
          aria-label="Workspace navigation"
        >
          <aside
            className="flex h-full min-h-0 flex-col border-r border-border/70 bg-card/85 backdrop-blur-xl"
            data-testid="v6-left-nav"
            aria-label="Workspace navigation"
          >
            <ScrollArea className="flex-1">
              <div className="space-y-4 p-3 pt-4">
                <div className="space-y-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(shellNavButtonClass, view.kind === "home" && shellNavButtonActiveClass)}
                    onClick={goToWorkspaceHome}
                  >
                    <Home size={15} />
                    <span>Home</span>
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(shellNavButtonClass, view.kind === "activity" && shellNavButtonActiveClass)}
                    onClick={() => setView({ kind: "activity" })}
                  >
                    <Activity size={15} />
                    <span>Activity</span>
                  </Button>
                </div>

                <div className="space-y-1">
                  <span className={shellSectionLabelClass}>
                    <span>Scopes</span>
                    <span>{fieldSummaries.length}</span>
                  </span>
                  {fieldSummaries.length === 0 ? (
                    <div className="nav-empty px-3 py-2 text-sm text-muted-foreground">No named Scopes yet</div>
                  ) : (
                    fieldSummaries.map((summary) => (
                      <Button
                        key={summary.id}
                        type="button"
                        variant="ghost"
                        className={cn(shellNavButtonClass, "ml-3 w-[calc(100%-0.75rem)]", view.kind === "field" && view.fieldId === summary.id && shellNavButtonActiveClass)}
                        onClick={() => openField(summary.id)}
                      >
                        <LayoutPanelLeft size={15} />
                        <span className="truncate">{summary.title}</span>
                      </Button>
                    ))
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    className={cn(shellNavButtonClass, "border-dashed border-border/70 text-accent-foreground")}
                    onClick={promptCreateField}
                    draggable
                    onDragStart={handleFieldPrimitiveDragStart}
                    title="Create a new Scope"
                  >
                    <FolderPlus size={15} />
                    <span>New Scope</span>
                  </Button>
                </div>

                {view.kind === "field" && loadedProjection && (
                  <div className="space-y-1" data-testid="v6-scope-contexts">
                    <span className={shellSectionLabelClass}>
                      <span>Contexts</span>
                      <span>{openedScopeContexts.length}</span>
                    </span>
                    {openedScopeContexts.length === 0 ? (
                      <div className="nav-empty px-3 py-2 text-sm text-muted-foreground">No mapped Contexts</div>
                    ) : (
                      openedScopeContexts.map((context) => (
                        <Button
                          key={context.context_id}
                          type="button"
                          variant="ghost"
                          className={cn(shellNavButtonClass, "ml-3 w-[calc(100%-0.75rem)]", selectedContextId === context.context_id && shellNavButtonActiveClass)}
                          onClick={() => openProjectedContext(context.context_id)}
                        >
                          <MessageSquare size={15} />
                          <span className="truncate">{neutralContextLabel(context, scopeTitlesById, pulseLabels[context.context_id])}</span>
                        </Button>
                      ))
                    )}
                  </div>
                )}

                {agents.length > 0 && (
                  <div className="space-y-1" data-testid="v6-nav-actors">
                    <span className={shellSectionLabelClass}>
                      <span>Actors</span>
                      <span>{agents.length}</span>
                    </span>
                    {agents.map((endpoint) => (
                      <Button
                        key={endpoint.endpoint_id}
                        type="button"
                        variant="ghost"
                        className={cn(
                          shellNavButtonClass,
                          "ml-3 w-[calc(100%-0.75rem)] justify-start",
                          inspectorActor?.endpoint_id === endpoint.endpoint_id && shellNavButtonActiveClass
                        )}
                        onClick={() => selectActorForInspector(endpoint.endpoint_id)}
                        title={endpoint.name}
                      >
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-background/80 text-xs font-semibold text-accent-foreground">
                          {endpoint.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="truncate">{endpoint.name}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </ScrollArea>
          </aside>
        </ResizablePanel>

        <ShellResizeHandle />

        <ResizablePanel minSize={shellMainPanelMinWidthPx} className="shell-main-panel">
          <div
            className="surface-area flex h-full min-h-0 flex-col bg-background/35"
            data-testid="v6-main-surface"
            onDrop={handleLibraryDropSurface}
            onDragOver={handleLibraryDragOver}
          >
            {error && <div className="error-bar">{error}</div>}
            {!selectedWorkspace ? renderNoWorkspace() : view.kind === "field" ? renderField() : view.kind === "activity" ? renderActivity() : renderHome()}
          </div>
        </ResizablePanel>

        <ShellResizeHandle />

        <ResizablePanel
          defaultSize={shellInspectorPanelDefaultWidthPx}
          minSize={shellInspectorPanelMinWidthPx}
          maxSize={shellInspectorPanelMaxWidthPx}
          className="shell-inspector-panel"
        >
          {renderInspector()}
        </ResizablePanel>
      </ResizablePanelGroup>
      <DialogHost />
    </main>
  );
}

function ShellResizeHandle() {
  return (
    <ResizableHandle className="group relative w-2 bg-transparent">
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/6 transition-colors group-hover:bg-[color:var(--accent)] group-data-[resize-handle-state=drag]:bg-[color:var(--accent)]" />
      <span className="sr-only">Resize panel</span>
    </ResizableHandle>
  );
}

function InspectorSection(props: { title: React.ReactNode; children: React.ReactNode }) {
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

function neutralContextLabel(
  context: { scope_id: string | null },
  scopeTitlesById: Record<string, string>,
  pulseLabel?: string | null
): string {
  const pulse = pulseLabel?.trim();
  if (pulse) return pulse;
  if (!context.scope_id) return "Workspace Context";
  return scopeTitlesById[context.scope_id]?.trim() || "Scoped Context";
}

function scopeMapNodeStyle(kind: unknown, selected: boolean): React.CSSProperties {
  const palette =
    kind === "pulse"
      ? {
          background: "hsl(var(--warn-soft))",
          border: "1px solid hsl(var(--warn) / 0.35)",
          color: "hsl(var(--warn))"
        }
      : {
          background: "hsl(var(--card))",
          border: "1px solid hsl(var(--border))",
          color: "hsl(var(--foreground))"
        };

  return {
    ...palette,
    borderRadius: 8,
    boxShadow: selected ? "0 0 0 2px hsl(var(--ring) / 0.2)" : "none",
    fontSize: 12,
    fontWeight: 600,
    minWidth: 148,
    padding: "10px 14px"
  };
}

function scopeMapEdgeStyle(selected: boolean): React.CSSProperties {
  return {
    stroke: selected ? "hsl(var(--primary))" : "hsl(var(--border))",
    strokeWidth: selected ? 2.5 : 1.75
  };
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
