import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FolderOpen,
  FolderPlus,
  Home,
  LayoutPanelLeft,
  Loader,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
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
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useOnViewportChange,
  type Node as ReactFlowNode,
  type NodeChange,
  type NodeProps,
  type Viewport
} from "@xyflow/react";
import "./styles.css";
import {
  buildEmitBody,
  contextLabel,
  sortContextsForAgent,
  type ContextEvent,
  type ContextSummary
} from "./contexts";
import {
  applyNodeChangesToLayout,
  fieldToReactFlow,
  reactFlowToLayout,
  type FieldLayoutFloeweb,
  type FieldItemNodeData,
  type FieldSummary,
  type FieldSemantic
} from "./fields";
import {
  listFields,
  getField,
  putFieldSemantic,
  putFieldLayout,
  deleteField as deleteFieldApi,
  parseFieldStreamMessage,
  subscribeToFieldEvents,
  type LoadedField
} from "./fields-api";

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
  | { kind: "field"; fieldId: string };

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

function FieldItemNode({ data }: NodeProps) {
  const item = data as FieldItemNodeData;
  return (
    <>
      <Handle type="target" position={Position.Top} />
      <div className="canvas-field-node" title={item.ref.raw} data-kind={item.kind}>
        <span>{item.label}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </>
  );
}

const fieldNodeTypes = {
  fieldItem: FieldItemNode
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

function FieldViewportObserver({ onChange }: { onChange: (viewport: Viewport) => void }) {
  useOnViewportChange({ onEnd: onChange });
  return null;
}

function App() {
  const [busUrl, setBusUrl] = useState(defaultBusUrl);
  const [showBusSettings, setShowBusSettings] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [authorizeInit, setAuthorizeInit] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
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
  const [loadedField, setLoadedField] = useState<LoadedField | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [channelMessage, setChannelMessage] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [contexts, setContexts] = useState<ContextSummary[]>([]);
  const [selectedContextId, setSelectedContextId] = useState<string | null>(null);
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
  const loadedFieldRef = useRef<LoadedField | null>(null);
  const layoutSaveTimersRef = useRef<Map<string, number>>(new Map());
  const pendingLayoutSavesRef = useRef<Map<string, PendingLayoutSave>>(new Map());
  const localLayoutWriteUntilRef = useRef<Map<string, number>>(new Map());
  const autoInitializedLayoutRef = useRef<Set<string>>(new Set());
  const chatEndRef = useRef<HTMLDivElement>(null);
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

  const selectedContext = selectedContextId
    ? contexts.find((c) => c.context_id === selectedContextId) ?? null
    : null;
  const contextEvents = contextEventsState.contextId === selectedContextId ? contextEventsState.events : [];
  const selectedFieldSummary = view.kind === "field"
    ? fieldSummaries.find((field) => field.id === view.fieldId) ?? null
    : null;

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

  const { nodes: fieldNodes, edges: fieldEdges } = useMemo(() => {
    if (!loadedField) return { nodes: [], edges: [] };
    return fieldToReactFlow(loadedField.semantic, loadedField.layout ?? undefined);
  }, [loadedField]);
  const fieldViewport = useMemo<Viewport>(
    () => loadedField?.layout?.viewport ?? { x: 0, y: 0, zoom: 1 },
    [loadedField?.layout?.viewport]
  );

  const refreshContexts = useCallback(async (workspaceId: string) => {
    try {
      const selfId = operatorActorId(workspaceId);
      const result = await api<{ contexts: ContextSummary[] }>(
        busUrl,
        `/v1/contexts?participant=${encodeURIComponent(selfId)}&workspace_id=${encodeURIComponent(workspaceId)}`
      );
      setContexts(result.contexts);
    } catch {
      // Non-fatal — keep showing whatever we already have.
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
      } else {
        setEndpoints([]);
        setRuntimeBindings([]);
        setEvents([]);
        setTelemetry([]);
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
    loadedFieldRef.current = loadedField;
  }, [loadedField]);

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
      if (parseFieldStreamMessage(String(event.data))) return;
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
      setContexts([]);
      setSelectedContextId(null);
      clearContextEvents();
      setDraftMode(false);
      return;
    }
    void refreshContexts(selectedWorkspace.workspace_id);
  }, [selectedWorkspace?.workspace_id, floeAgent?.endpoint_id, refreshContexts]);

  // Auto-select default-or-most-recent context once contexts load (unless drafting).
  useEffect(() => {
    if (draftMode) return;
    if (selectedContextId) return;
    if (sortedContexts.sorted.length === 0) return;
    setSelectedContextId(sortedContexts.sorted[0].context_id);
  }, [sortedContexts, selectedContextId, draftMode]);

  // Drop selection if it disappears (workspace switch, etc.)
  useEffect(() => {
    if (!selectedContextId) return;
    if (!contexts.some((c) => c.context_id === selectedContextId)) {
      setSelectedContextId(null);
      clearContextEvents();
    }
  }, [contexts, selectedContextId]);

  useEffect(() => {
    if (!selectedContextId) {
      clearContextEvents();
      return;
    }
    void refreshContextEvents(selectedContextId);
  }, [selectedContextId, refreshContextEvents]);

  // When workspace-level events change (via WS refresh), re-pull context list
  // and the selected context's events so live updates flow through. Cheap.
  useEffect(() => {
    if (!selectedWorkspace || !floeAgent) return;
    void refreshContexts(selectedWorkspace.workspace_id);
    if (selectedContextId) void refreshContextEvents(selectedContextId);
  }, [events.length, selectedWorkspace?.workspace_id, floeAgent?.endpoint_id, selectedContextId, refreshContexts, refreshContextEvents]);

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
      const summaries = await listFields(busUrl, workspaceId);
      setFieldSummaries(summaries);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, [busUrl]);

  const refreshOpenField = useCallback(async (workspaceId: string, fieldId: string) => {
    try {
      const result = await getField(busUrl, workspaceId, fieldId);
      setLoadedField(result);
    } catch (caught) {
      setLoadedField(null);
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

  const sendFieldLayoutSave = useCallback((pending: PendingLayoutSave) => {
    markLocalLayoutWrite(pending.workspaceId, pending.fieldId);
    void putFieldLayout(busUrl, pending.workspaceId, pending.fieldId, pending.layout)
      .then(() => markLocalLayoutWrite(pending.workspaceId, pending.fieldId))
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

  const updateLoadedFieldLayout = useCallback((layout: FieldLayoutFloeweb) => {
    const current = loadedFieldRef.current;
    if (!current || current.semantic.id !== layout.field_id) return;
    const next = { ...current, layout };
    loadedFieldRef.current = next;
    setLoadedField(next);
  }, []);

  const handleFieldNodesChange = useCallback((changes: NodeChange[]) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const current = loadedFieldRef.current;
    const currentView = viewRef.current;
    if (!workspaceId || !current || currentView.kind !== "field") return;
    if (currentView.fieldId !== current.semantic.id) return;
    const baseLayout = current.layout ?? reactFlowToLayout(
      current.semantic.id,
      fieldToReactFlow(current.semantic).nodes,
      { x: 0, y: 0, zoom: 1 }
    );
    const nextLayout = applyNodeChangesToLayout(baseLayout, changes);
    if (nextLayout === baseLayout) return;
    if (current.layout && layoutsEqual(current.layout, nextLayout)) return;
    updateLoadedFieldLayout(nextLayout);
    scheduleFieldLayoutSave(workspaceId, current.semantic.id, nextLayout);
  }, [scheduleFieldLayoutSave, updateLoadedFieldLayout]);

  const handleFieldMoveEnd = useCallback((_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const current = loadedFieldRef.current;
    const currentView = viewRef.current;
    if (!workspaceId || !current || currentView.kind !== "field") return;
    if (currentView.fieldId !== current.semantic.id) return;
    const { nodes } = fieldToReactFlow(current.semantic, current.layout ?? undefined);
    const nextLayout = reactFlowToLayout(current.semantic.id, nodes, viewport);
    if (current.layout && layoutsEqual(current.layout, nextLayout)) return;
    updateLoadedFieldLayout(nextLayout);
    scheduleFieldLayoutSave(workspaceId, current.semantic.id, nextLayout);
  }, [scheduleFieldLayoutSave, updateLoadedFieldLayout]);

  const handleFieldViewportChange = useCallback((viewport: Viewport) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const current = loadedFieldRef.current;
    const currentView = viewRef.current;
    if (!workspaceId || !current || currentView.kind !== "field") return;
    if (currentView.fieldId !== current.semantic.id) return;
    const { nodes } = fieldToReactFlow(current.semantic, current.layout ?? undefined);
    const nextLayout = reactFlowToLayout(current.semantic.id, nodes, viewport);
    if (current.layout && layoutsEqual(current.layout, nextLayout)) return;
    updateLoadedFieldLayout(nextLayout);
    scheduleFieldLayoutSave(workspaceId, current.semantic.id, nextLayout);
  }, [scheduleFieldLayoutSave, updateLoadedFieldLayout]);

  const handleFieldNodeDragStop = useCallback((_event: React.MouseEvent, node: ReactFlowNode) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    const current = loadedFieldRef.current;
    const currentView = viewRef.current;
    if (!workspaceId || !current || currentView.kind !== "field") return;
    if (currentView.fieldId !== current.semantic.id) return;
    const baseLayout = current.layout ?? reactFlowToLayout(
      current.semantic.id,
      fieldToReactFlow(current.semantic).nodes,
      { x: 0, y: 0, zoom: 1 }
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
    if (current.layout && layoutsEqual(current.layout, nextLayout)) return;
    updateLoadedFieldLayout(nextLayout);
    scheduleFieldLayoutSave(workspaceId, current.semantic.id, nextLayout);
  }, [scheduleFieldLayoutSave, updateLoadedFieldLayout]);

  useEffect(() => subscribeToFieldEvents(busUrl, (event) => {
    const workspaceId = selectedWorkspaceIdRef.current;
    if (!workspaceId || event.payload.workspace_id !== workspaceId) return;
    void refreshFields(workspaceId);
    const currentView = viewRef.current;
    if (currentView.kind !== "field" || currentView.fieldId !== event.payload.field_id) return;
    if (event.type === "field.deleted") {
      autoInitializedLayoutRef.current.delete(fieldLayoutKey(workspaceId, event.payload.field_id));
      setLoadedField(null);
      setView({ kind: "home" });
      return;
    }
    if (
      event.payload.changed === "layout" &&
      hasRecentLocalLayoutWrite(workspaceId, event.payload.field_id)
    ) {
      return;
    }
    void refreshOpenField(workspaceId, event.payload.field_id);
  }), [busUrl, hasRecentLocalLayoutWrite, refreshFields, refreshOpenField]);

  useEffect(() => {
    const workspaceId = selectedWorkspaceIdRef.current;
    if (!workspaceId || view.kind !== "field" || !loadedField || loadedField.layout) return;
    if (fieldNodes.length === 0) return;
    const key = fieldLayoutKey(workspaceId, loadedField.semantic.id);
    if (autoInitializedLayoutRef.current.has(key)) return;
    autoInitializedLayoutRef.current.add(key);
    const layout = reactFlowToLayout(loadedField.semantic.id, fieldNodes, fieldViewport);
    updateLoadedFieldLayout(layout);
    scheduleFieldLayoutSave(workspaceId, loadedField.semantic.id, layout);
  }, [
    fieldNodes,
    fieldViewport,
    loadedField,
    scheduleFieldLayoutSave,
    updateLoadedFieldLayout,
    view
  ]);

  useEffect(() => {
    setLoadedField(null);
    if (!selectedWorkspaceId) {
      setFieldSummaries([]);
      return;
    }
    void refreshFields(selectedWorkspaceId);
  }, [selectedWorkspaceId, refreshFields]);

  useEffect(() => {
    if (view.kind !== "field" || !selectedWorkspaceId) {
      setLoadedField(null);
      return;
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
      setView({ kind: "home" });
    } catch (err) {
      if (err instanceof ApiError && (err.body as any)?.error === "directory_not_found") {
        const locator = (err.body as any)?.locator ?? workspacePath.trim();
        if (window.confirm(`Directory does not exist:\n${locator}\n\nCreate it?`)) {
          return registerWorkspace(true);
        }
        return;
      }
      throw err;
    }
  }

  async function selectWorkspace(workspaceId: string) {
    selectedWorkspaceIdRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
    setView({ kind: "home" });
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, { method: "POST" });
    await ensureOperator(workspaceId);
    await refresh(workspaceId);
  }

  async function deleteWorkspace(workspaceId: string) {
    const workspace = workspaces.find((w) => w.workspace_id === workspaceId);
    const label = workspace?.name ?? workspaceId;
    if (!window.confirm(`Delete workspace "${label}"?\n\nThis removes the workspace from Floe. You can choose whether to keep or delete the folder next.`)) return;
    const locatorLabel = workspace?.locator ? `\n\n${workspace.locator}` : "";
    const deleteLocator = window.confirm(
      `Remove the workspace folder from disk too?${locatorLabel}\n\nChoose OK to delete the folder and its files. Choose Cancel to keep files and only remove it from Floe.`
    );
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`, {
      method: "POST",
      body: { delete_locator: deleteLocator }
    });
    if (selectedWorkspaceId === workspaceId) {
      setSelectedWorkspaceId("");
      selectedWorkspaceIdRef.current = "";
      setEndpoints([]);
      setEvents([]);
      setTelemetry([]);
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
    if (!selectedWorkspace || !floeAgent || !canMessageRuntime || !channelMessage.trim()) return;
    await ensureOperator(selectedWorkspace.workspace_id);
    const text = channelMessage.trim();
    const body = buildEmitBody({
      workspaceId: selectedWorkspace.workspace_id,
      source: humanEndpoint,
      agentEndpointId: floeAgent.endpoint_id,
      selectedContextId: selectedContextId,
      text,
      contextLabelText: currentContextLabel(view, selectedWorkspace, loadedField?.semantic.title ?? selectedFieldSummary?.title ?? null)
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
    await refreshContexts(selectedWorkspace.workspace_id);
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
    if (!window.confirm(`Delete conversation "${label}"?\n\nThis permanently deletes the conversation and its events from Floe.`)) return;
    await api(busUrl, `/v1/contexts/${encodeURIComponent(contextId)}`, { method: "DELETE" });
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

  function createField(name?: string): void {
    if (!selectedWorkspace) return;
    const workspaceId = selectedWorkspace.workspace_id;
    const nextName = name?.trim() || `Field ${fieldSummaries.length + 1}`;
    const id = slugifyFieldId(nextName);
    const semantic = emptyFieldSemantic(id, nextName);
    void (async () => {
      try {
        await putFieldSemantic(busUrl, workspaceId, id, semantic, { ifAbsent: true });
        await refreshFields(workspaceId);
        setView({ kind: "field", fieldId: id });
      } catch (caught) {
        setError((caught as Error).message);
      }
    })();
  }

  function openField(fieldId: string): void {
    setView({ kind: "field", fieldId });
    if (selectedWorkspaceId) void refreshOpenField(selectedWorkspaceId, fieldId);
  }

  function deleteOpenField(fieldId: string): void {
    if (!selectedWorkspace) return;
    const workspaceId = selectedWorkspace.workspace_id;
    if (!window.confirm(`Delete field "${fieldId}"?`)) return;
    void (async () => {
      try {
        await deleteFieldApi(busUrl, workspaceId, fieldId);
        setLoadedField(null);
        setView({ kind: "home" });
        await refreshFields(workspaceId);
      } catch (caught) {
        setError((caught as Error).message);
      }
    })();
  }

  function promptCreateField(): void {
    const name = window.prompt("New field name?");
    if (name === null) return;
    createField(name);
  }

  function backToHome() {
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

  function renderHome() {
    return (
      <section className="workspace-home">
        <div className="home-band">
          <div>
            <p className="eyebrow">Workspace Home</p>
            <h2>{selectedWorkspace?.name ?? "Workspace"}</h2>
          </div>
          <button className="ghost-action" onClick={() => setChannelOpen(true)}>
            <MessageSquare size={16} />
            Floe
          </button>
        </div>

        <div className="home-grid">
          <section className="field-list-pane">
            <div className="section-title-row">
              <div>
                <h3>Fields</h3>
                <p>Substrate-backed Fields stored under <code>.floe/fields/</code>.</p>
              </div>
              <span>{fieldSummaries.length}</span>
            </div>
            <button className="primary-action full" onClick={promptCreateField}>
              <FolderPlus size={15} />
              Add field
            </button>
            {fieldSummaries.length === 0 ? (
              <div className="quiet-empty">
                <SquareDashedMousePointer size={22} />
                <strong>No Fields yet</strong>
                <span>Create a Field to start shaping this workspace.</span>
              </div>
            ) : (
              <div className="field-list">
                {fieldSummaries.map((summary) => (
                  <button
                    key={summary.id}
                    className="field-block"
                    onClick={() => openField(summary.id)}
                    onDoubleClick={() => openField(summary.id)}
                  >
                    <span className="field-icon"><LayoutPanelLeft size={16} /></span>
                    <span>
                      <strong>{summary.title}</strong>
                      <small>{summary.item_count} items</small>
                    </span>
                    <ChevronRight size={16} />
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </section>
    );
  }

  function renderField() {
    if (view.kind !== "field") return null;
    const title = loadedField?.semantic.title ?? selectedFieldSummary?.title ?? view.fieldId;
    return (
      <section className="field-surface">
        <div className="field-toolbar">
          <button className="icon-button" onClick={backToHome} title="Workspace Home">
            <ArrowLeft size={16} />
          </button>
          <div>
            <p className="eyebrow">Field Surface</p>
            <h2>{title}</h2>
          </div>
          <button className="ghost-action" onClick={() => setChannelOpen(true)}>
            <MessageSquare size={16} />
            Floe
          </button>
        </div>
        <div className="canvas-wrap">
          <ReactFlow
            nodes={fieldNodes}
            edges={fieldEdges}
            nodeTypes={fieldNodeTypes}
            onNodesChange={handleFieldNodesChange}
            onMoveEnd={handleFieldMoveEnd}
            onNodeDragStop={handleFieldNodeDragStop}
            viewport={fieldViewport}
            panOnDrag
            zoomOnScroll
            minZoom={0.2}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
          >
            <FieldViewportObserver onChange={handleFieldViewportChange} />
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <Controls position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" />
          </ReactFlow>
          {loadedField && fieldNodes.length === 0 && (
            <div className="canvas-empty">
              <SquareDashedMousePointer size={22} />
              <strong>Empty Field</strong>
              <span>This field has no items yet. Item editing arrives in a later slice.</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  function renderInspector() {
    return (
      <aside className="inspector">
        <div className="inspector-header">
          <span>Inspector</span>
          <button className="icon-button" onClick={() => void refresh()} title="Refresh">
            <RefreshCw size={14} />
          </button>
        </div>
        {!selectedWorkspace ? (
          <div className="inspector-section muted">No workspace selected.</div>
        ) : view.kind === "home" ? (
          <>
            <InspectorSection title="Workspace">
              <Detail label="Name" value={selectedWorkspace.name} />
              <Detail label="Location" value={selectedWorkspace.locator} />
              <Detail label=".floe" value={workspaceStatusLabel(selectedWorkspace)} />
              <Detail label="Fields" value={String(fieldSummaries.length)} />
            </InspectorSection>
            <RuntimeSection />
            <ActorAccessSection />
          </>
        ) : (
          <>
            <InspectorSection title="Opened Field">
              <Detail label="Id" value={view.fieldId} />
              <Detail label="Title" value={loadedField?.semantic.title ?? selectedFieldSummary?.title ?? "—"} />
              <Detail label="Items" value={String(loadedField?.semantic.items.length ?? selectedFieldSummary?.item_count ?? 0)} />
              <Detail label="Connections" value={String(loadedField?.semantic.connections.length ?? selectedFieldSummary?.connection_count ?? 0)} />
              <button className="primary-action full" onClick={() => deleteOpenField(view.fieldId)}>
                <X size={15} />
                Delete field
              </button>
            </InspectorSection>
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
          <p>Use “Add field” on the workspace home to create a Field.</p>
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
              onClick={promptCreateField}
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
        ? "Existing conversation"
        : sortedContexts.sorted.length === 0
          ? "No conversations yet"
          : "No conversation selected";
    return (
      <aside className="channel">
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
              <span>Conversations</span>
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
                        <time
                          className="channel-context-time"
                          data-testid="context-list-item-time"
                          dateTime={activityTime}
                        >
                          {formatContextTimestamp(activityTime)}
                        </time>
                      </button>
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
                    <div className="message-meta">{isSelf ? operatorDisplayName : actorName} · {new Date(segment.message.created_at).toLocaleTimeString()}</div>
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
            disabled={!selectedAgent || !canMessageRuntime}
            aria-label={selectedAgent ? `Message ${actorName}` : "Message actor"}
            placeholder={!selectedAgent ? "No actors available" : !runtimeReady ? "Configure runtime first" : runtimeBlockedByFakeAdapter ? "Configure bridge runtime first" : `Message ${actorName}`}
          />
          <button
            className="icon-button primary-icon"
            onClick={() => void sendFloeMessage()}
            disabled={!selectedAgent || !canMessageRuntime || !channelMessage.trim()}
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
    <main className={`floe-shell ${channelOpen ? "with-channel" : ""}`}>
      <aside className="workspace-rail">
        <div className="rail-brand">
          <div className="brand-mark"><Workflow size={18} /></div>
          <div>
            <strong>Floe</strong>
            <span className={`connection ${connectionClass(status)}`}><CircleDot size={10} />{status}</span>
          </div>
        </div>
        <div className="rail-section">
          <span className="rail-label">Workspaces</span>
          {workspaces.map((workspace) => (
            <div key={workspace.workspace_id} className="workspace-row">
              <button
                className={`workspace-button${workspace.workspace_id === selectedWorkspaceId ? " active" : ""}`}
                onClick={() => void selectWorkspace(workspace.workspace_id)}
              >
                <FolderOpen size={15} />
                <span>{workspace.name}</span>
              </button>
              <button
                className="workspace-delete-button"
                onClick={(e) => { e.stopPropagation(); void deleteWorkspace(workspace.workspace_id); }}
                title="Remove workspace"
                aria-label={`Remove workspace ${workspace.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="rail-new">
          <input
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void registerWorkspace(); }}
            placeholder="Workspace path"
          />
          <button
            className="icon-button"
            onClick={() => void registerWorkspace()}
            disabled={!workspacePath.trim()}
            title="Create Workspace"
            aria-label="Create workspace"
          >
            <FolderPlus size={15} />
          </button>
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

      <section className="main-stage">
        {error && <div className="error-bar">{error}</div>}
        <header className="topbar">
          <nav className="breadcrumb">
            <button onClick={backToHome}><Home size={14} /> Workspace</button>
            {view.kind === "field" && (
              <>
                <ChevronRight size={14} />
                <button className="breadcrumb-current">
                  {loadedField?.semantic.title ?? selectedFieldSummary?.title ?? view.fieldId}
                </button>
              </>
            )}
          </nav>
          <div className="topbar-actions">
            <button className="icon-button" onClick={() => void refresh()} title="Refresh" aria-label="Refresh workspace">
              <RefreshCw size={15} />
            </button>
            <button
              className="icon-button"
              onClick={() => setChannelOpen((current) => !current)}
              title="Toggle actor conversations"
              aria-label={channelOpen ? "Hide actor conversation panel" : "Open actor conversation panel"}
            >
              {channelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>
          </div>
        </header>
        <div className="content-row">
          {renderBlockLibrary()}
          <div className="surface-area">
            {!selectedWorkspace ? renderNoWorkspace() : view.kind === "field" ? renderField() : renderHome()}
          </div>
          {renderInspector()}
        </div>
      </section>

      {renderChannel()}
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

function slugifyFieldId(input: string): string {
  const s = input.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || `field-${Date.now().toString(36)}`;
}

function emptyFieldSemantic(id: string, title: string): FieldSemantic {
  const now = new Date().toISOString();
  return {
    id,
    schema: "floe.field.v1",
    title,
    items: [],
    connections: [],
    created_at: now,
    updated_at: now
  };
}

function runtimeActivityLabel(kind: string): string {
  const labels: Record<string, string> = {
    "BeforeToolUse": "Running",
    "AfterToolUse": "Completed",
    "ToolUseFailed": "Failed",
    "runtime_error": "Error",
    "runtime_no_visible_output": "No output",
    "visible_output_worklog": "Runtime notes"
  };
  if (labels[kind]) return labels[kind];
  return kind
    .replace(/^runtime_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
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

function parseTelemetryPayload(record: TelemetryRecord): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(record.payload_json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function telemetryContextId(record: TelemetryRecord): string | null {
  const payload = parseTelemetryPayload(record);
  return typeof payload?.context_id === "string" ? payload.context_id : null;
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

function summarizeTelemetry(record: TelemetryRecord): string {
  try {
    const payload = parseTelemetryPayload(record);
    if (!payload) return record.kind;
    // For tool calls, show summary if available, then fall back to tool name
    if (typeof payload.summary === "string" && payload.summary.trim()) {
      const summary = payload.summary.trim().slice(0, 140);
      // Rename "emit" references for user-facing display
      return summary.replace(/^emit\b/i, "sent message");
    }
    if (typeof payload.toolName === "string") {
      const name = payload.toolName;
      if (name === "emit") return "sent message";
      return name;
    }
    const candidate = payload.error_message ?? payload.message ?? payload.note ?? payload.text ?? payload.code;
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 140);
  } catch {
    return record.kind;
  }
  return record.kind;
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
