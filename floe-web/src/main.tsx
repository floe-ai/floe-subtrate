import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
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
  Sparkles,
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
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type XYPosition,
  type NodeChange,
  type Node
} from "@xyflow/react";
import "./styles.css";

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
  actor_type: "human" | "agent";
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
  source_endpoint_id: string;
  destination_json: { kind: "endpoint" | "broadcast"; endpoint_id?: string };
  thread_id: string;
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

type FieldBlock = {
  id: string;
  name: string;
  parent_id?: string | null;
  created_at: string;
  updated_at: string;
  nodes: Node[];
  edges: Edge[];
};

type RuntimeActivity = {
  id: string;
  kind: string;
  summary: string;
  time: string;
};

type ActivityGroup = {
  id: string;
  items: RuntimeActivity[];
  status: "working" | "done";
  label: string;
};

type ChatSegment =
  | { kind: "message"; message: EventEnvelope }
  | { kind: "activity"; group: ActivityGroup }
  | { kind: "streaming"; turnId: string; text: string };

type View =
  | { kind: "home" }
  | { kind: "field"; fieldId: string };

const defaultBusUrl = localStorage.getItem("floe.busUrl") ?? "http://127.0.0.1:5377";
const localFieldStoragePrefix = "floe.web.local-fields.";
const fieldPrimitiveMime = "application/x-floe-primitive";

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

function App() {
  const { screenToFlowPosition } = useReactFlow();
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
  const [view, setView] = useState<View>({ kind: "home" });
  const [fields, setFields] = useState<FieldBlock[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [channelOpen, setChannelOpen] = useState(false);
  const [channelMessage, setChannelMessage] = useState("");
  const [expandedActivities, setExpandedActivities] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState("Connecting");
  const [error, setError] = useState<string | null>(null);
  const selectedWorkspaceIdRef = useRef("");
  const skipNextSaveRef = useRef(true);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const selectedWorkspace = workspaces.find((item) => item.workspace_id === selectedWorkspaceId) ?? null;
  const agents = endpoints.filter((endpoint) => endpoint.actor_type === "agent");
  const floeAgent = agents.find((endpoint) => endpoint.agent_id === "floe") ?? agents[0] ?? null;
  const humans = endpoints.filter((endpoint) => endpoint.actor_type === "human");
  const humanEndpoint = selectedWorkspace ? humanEndpointId(selectedWorkspace.workspace_id) : "";
  const threadId = selectedWorkspace ? `thread:${selectedWorkspace.workspace_id}:floe` : "";
  const selectedField = view.kind === "field" ? fields.find((field) => field.id === view.fieldId) ?? null : null;
  const selectedCanvasFieldId = selectedField?.nodes.find((node) => node.selected) ? fieldIdFromNode(selectedField.nodes.find((node) => node.selected)!) : null;
  const effectiveSelectedBlockId = selectedCanvasFieldId ?? selectedBlockId;
  const selectedFieldBlock = effectiveSelectedBlockId && effectiveSelectedBlockId !== selectedField?.id
    ? fields.find((field) => field.id === effectiveSelectedBlockId) ?? null
    : null;
  const currentSelection = selectedFieldBlock ?? selectedField;
  const workspaceFields = useMemo(() => fields.filter((field) => !field.parent_id), [fields]);

  const workspaceBinding = selectedWorkspace
    ? runtimeBindings.find((binding) => binding.scope === "workspace_default" && binding.workspace_id === selectedWorkspace.workspace_id)
    : undefined;
  const agentBinding = floeAgent
    ? runtimeBindings.find((binding) => binding.scope === "agent" && binding.endpoint_id === floeAgent.endpoint_id)
    : undefined;
  const effectiveProfileId = agentBinding?.auth_profile || workspaceBinding?.auth_profile || null;
  const effectiveProfile = authProfiles.find((profile) => profile.id === effectiveProfileId) ?? null;
  const effectiveModel = agentBinding?.model ?? workspaceBinding?.model ?? null;
  const runtimeReady = !!effectiveProfileId && !!effectiveModel;

  const floeMessages = useMemo(() => {
    if (!floeAgent || !threadId) return [];
    return events
      .filter((event) => {
        if (event.thread_id !== threadId) return false;
        if (event.source_endpoint_id === humanEndpoint && event.type === "message") return true;
        return event.metadata?.origin === "runtime_turn_output" && event.source_endpoint_id === floeAgent.endpoint_id;
      })
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
  }, [events, floeAgent, humanEndpoint, threadId]);

  const streamingTurns = useMemo(() => {
    if (!floeAgent || !threadId) return {};
    const finished = new Set<string>();
    for (const event of events) {
      if (event.metadata?.origin === "runtime_turn_output" && event.source_endpoint_id === floeAgent.endpoint_id) {
        const turnId = event.content?.data?.runtime_turn_id;
        if (typeof turnId === "string") finished.add(turnId);
      }
    }
    const latest: Record<string, { text: string; created_at: string }> = {};
    for (const record of telemetry) {
      if (record.endpoint_id !== floeAgent.endpoint_id || record.kind !== "visible_output") continue;
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(record.payload_json) as Record<string, unknown>;
      } catch {
        continue;
      }
      const turnId = payload.runtime_turn_id;
      if (typeof turnId !== "string" || finished.has(turnId)) continue;
      if (typeof payload.thread_id === "string" && payload.thread_id !== threadId) continue;
      if (!latest[turnId] || record.created_at > latest[turnId].created_at) {
        latest[turnId] = { text: String(payload.text ?? ""), created_at: record.created_at };
      }
    }
    return latest;
  }, [events, floeAgent, telemetry, threadId]);

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

  const floeIsActive = floeAgent?.status === "active" || Object.keys(streamingTurns).length > 0;

  const chatSegments = useMemo<ChatSegment[]>(() => {
    if (!floeAgent || !threadId) return [];
    const excludedKinds = new Set(["usage", "runtime_config", "visible_output", "runtime_no_visible_output"]);
    const agentTelemetry = telemetry
      .filter((record) => record.endpoint_id === floeAgent.endpoint_id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    // Build sorted list of messages
    const messages = [...floeMessages].sort((a, b) => a.created_at.localeCompare(b.created_at));

    // Build timeline: interleave messages with activity groups
    const segments: ChatSegment[] = [];
    let telemetryIndex = 0;
    let pendingActivity: RuntimeActivity[] = [];

    for (const message of messages) {
      // Collect telemetry before this message
      while (telemetryIndex < agentTelemetry.length && agentTelemetry[telemetryIndex].created_at < message.created_at) {
        const record = agentTelemetry[telemetryIndex];
        if (!excludedKinds.has(record.kind)) {
          pendingActivity.push({
            id: record.telemetry_id,
            kind: runtimeActivityLabel(record.kind),
            summary: summarizeTelemetry(record),
            time: new Date(record.created_at).toLocaleTimeString()
          });
        }
        telemetryIndex++;
      }
      // Emit accumulated activity before agent messages
      const isHuman = message.source_endpoint_id === humanEndpoint;
      if (!isHuman && pendingActivity.length > 0) {
        segments.push({
          kind: "activity",
          group: {
            id: `activity_${pendingActivity[0].id}`,
            items: pendingActivity,
            status: "done",
            label: activityGroupLabel(pendingActivity)
          }
        });
        pendingActivity = [];
      }
      segments.push({ kind: "message", message });
    }

    // Trailing telemetry (agent is still working) — include any carried-forward pending activity
    while (telemetryIndex < agentTelemetry.length) {
      const record = agentTelemetry[telemetryIndex];
      if (!excludedKinds.has(record.kind)) {
        pendingActivity.push({
          id: record.telemetry_id,
          kind: runtimeActivityLabel(record.kind),
          summary: summarizeTelemetry(record),
          time: new Date(record.created_at).toLocaleTimeString()
        });
      }
      telemetryIndex++;
    }
    if (pendingActivity.length > 0) {
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

    // Append streaming turns
    for (const [turnId, turn] of Object.entries(streamingTurns)) {
      segments.push({ kind: "streaming", turnId, text: turn.text });
    }

    return segments;
  }, [floeAgent, floeMessages, floeIsActive, humanEndpoint, streamingTurns, telemetry, threadId]);

  const latestRuntimeError = useMemo(() => {
    if (!floeAgent) return null;
    const items = telemetry.filter((record) => record.endpoint_id === floeAgent.endpoint_id);
    const latest = items.at(-1);
    return latest && runtimeErrorKinds.has(latest.kind) ? latest : null;
  }, [floeAgent, telemetry]);

  const fieldNodes = useMemo<Node[]>(() => (selectedField?.nodes ?? []).map((node) => ({
    ...node,
    type: fieldIdFromNode(node) ? "field" : node.type,
    selected: fieldIdFromNode(node) === effectiveSelectedBlockId
  })), [effectiveSelectedBlockId, selectedField?.nodes]);
  const fieldEdges = useMemo<Edge[]>(() => selectedField?.edges ?? [], [selectedField?.edges]);
  const nodeTypes = useMemo(() => ({
    field: (props: { data: Record<string, unknown> }) => {
      const fieldId = typeof props.data.field_id === "string" ? props.data.field_id : null;
      return (
        <div
          className="canvas-field-node"
          role="button"
          tabIndex={0}
          onClick={() => { if (fieldId) setSelectedBlockId(fieldId); }}
          onDoubleClick={() => { if (fieldId) openField(fieldId); }}
          onKeyDown={(event) => {
            if (!fieldId) return;
            if (event.key === "Enter") openField(fieldId);
            if (event.key === " ") setSelectedBlockId(fieldId);
          }}
        >
          <LayoutPanelLeft size={15} />
          <span>{typeof props.data.label === "string" ? props.data.label : "Field"}</span>
        </div>
      );
    }
  }), []);

  const refresh = useCallback(async (preferredWorkspaceId?: string) => {
    try {
      setError(null);
      const [workspaceResult, authResult] = await Promise.all([
        api<{ workspaces: Workspace[] }>(busUrl, "/v1/workspaces"),
        api<{ profiles: AuthProfile[] }>(busUrl, "/v1/auth/profiles")
      ]);
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
        setSelectedBlockId(null);
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
    skipNextSaveRef.current = true;
    if (!selectedWorkspaceId) {
      setFields([]);
      return;
    }
    setFields(loadLocalFields(selectedWorkspaceId));
  }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!selectedWorkspaceId) return;
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    saveLocalFields(selectedWorkspaceId, fields);
  }, [fields, selectedWorkspaceId]);

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
    socket.onmessage = () => queueRefresh();
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

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as HTMLElement | null;
      const flowNode = target?.closest(".react-flow__node") as HTMLElement | null;
      if (flowNode && selectedField) {
        const nodeId = flowNode.dataset.id;
        const node = selectedField.nodes.find((item) => item.id === nodeId);
        if (node) {
          const fieldId = fieldIdFromNode(node);
          if (fieldId) setSelectedBlockId(fieldId);
        }
        return;
      }
      if (!selectedBlockId) return;
      if (target?.closest(".field-block")) return;
      if (target?.closest(".inspector")) return;
      setSelectedBlockId(null);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [selectedBlockId, selectedField]);

  useEffect(() => {
    function handleDoubleClick(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      const flowNode = target?.closest(".react-flow__node") as HTMLElement | null;
      if (!flowNode || !selectedField) return;
      const nodeId = flowNode.dataset.id;
      const node = selectedField.nodes.find((item) => item.id === nodeId);
      if (node) openFieldNode(node);
    }
    window.addEventListener("dblclick", handleDoubleClick);
    return () => window.removeEventListener("dblclick", handleDoubleClick);
  }, [selectedField]);

  async function registerWorkspace() {
    if (!workspacePath.trim()) return;
    const result = await api<{ workspace: Workspace }>(busUrl, "/v1/workspaces/register", {
      method: "POST",
      body: {
        locator: workspacePath.trim(),
        name: workspaceName.trim() || undefined,
        init_authorized: authorizeInit
      }
    });
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(result.workspace.workspace_id)}/select`, { method: "POST" });
    selectedWorkspaceIdRef.current = result.workspace.workspace_id;
    setSelectedWorkspaceId(result.workspace.workspace_id);
    await ensureHuman(result.workspace.workspace_id);
    await refresh(result.workspace.workspace_id);
    setWorkspacePath("");
    setWorkspaceName("");
    setView({ kind: "home" });
  }

  async function selectWorkspace(workspaceId: string) {
    selectedWorkspaceIdRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
    setSelectedBlockId(null);
    setView({ kind: "home" });
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, { method: "POST" });
    await ensureHuman(workspaceId);
    await refresh(workspaceId);
  }

  async function ensureHuman(workspaceId: string) {
    await api(busUrl, "/v1/endpoints/register", {
      method: "POST",
      body: {
        endpoint_id: humanEndpointId(workspaceId),
        workspace_id: workspaceId,
        actor_type: "human",
        name: "Operator",
        status: "online",
        metadata: { registered_by: "floe-web" }
      }
    });
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
    if (!selectedWorkspace || !floeAgent || !channelMessage.trim()) return;
    await ensureHuman(selectedWorkspace.workspace_id);
    await api(busUrl, "/v1/events/emit", {
      method: "POST",
      body: {
        type: "message",
        workspace_id: selectedWorkspace.workspace_id,
        source_endpoint_id: humanEndpoint,
        destination: { kind: "endpoint", endpoint_id: floeAgent.endpoint_id },
        thread_id: threadId,
        correlation_id: null,
        content: {
          text: channelMessage.trim(),
          data: {
            context: currentContextLabel(view, selectedWorkspace, selectedField)
          }
        },
        response: { expected: false },
        metadata: { submitted_by: "floe-web", channel: "floe" }
      }
    });
    setChannelMessage("");
    await refresh(selectedWorkspace.workspace_id);
  }

  function createField(name?: string) {
    if (!selectedWorkspace) return;
    const nextName = name?.trim() || `Field ${workspaceFields.length + 1}`;
    const timestamp = new Date().toISOString();
    const field: FieldBlock = {
      id: `field_${crypto.randomUUID()}`,
      name: nextName,
      parent_id: null,
      created_at: timestamp,
      updated_at: timestamp,
      nodes: [],
      edges: []
    };
    setFields((current) => [field, ...current]);
    setSelectedBlockId(field.id);
  }

  function addFieldNodeToOpenField(position?: XYPosition) {
    if (!selectedField) return;
    const timestamp = new Date().toISOString();
    const childId = `field_${crypto.randomUUID()}`;
    setFields((current) => {
      const parent = current.find((field) => field.id === selectedField.id) ?? selectedField;
      const nextIndex = parent.nodes.length + 1;
      const childName = `Field ${nextIndex}`;
      const nextNode: Node = {
        id: `node_${crypto.randomUUID()}`,
        type: "default",
        data: { label: childName, field_id: childId, block_type: "field" },
        position: position ?? { x: 120 + (nextIndex * 20), y: 120 + (nextIndex * 20) }
      };
      const childField: FieldBlock = {
        id: childId,
        name: childName,
        parent_id: selectedField.id,
        created_at: timestamp,
        updated_at: timestamp,
        nodes: [],
        edges: []
      };
      return [
        childField,
        ...current.map((field) => (
          field.id === selectedField.id
            ? { ...field, nodes: [...field.nodes, nextNode], updated_at: timestamp }
            : field
        ))
      ];
    });
    setSelectedBlockId(childId);
  }

  function addFieldFromLibrary() {
    if (!selectedWorkspace) return;
    if (view.kind === "field" && selectedField) {
      addFieldNodeToOpenField();
      return;
    }
    createField();
  }

  function onFieldPrimitiveDragStart(event: React.DragEvent<HTMLButtonElement>) {
    event.dataTransfer.setData(fieldPrimitiveMime, "field");
    event.dataTransfer.effectAllowed = "copy";
  }

  function onLibraryDropSurface(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    if (event.dataTransfer.getData(fieldPrimitiveMime) === "field") {
      if (view.kind === "field" && selectedField) {
        addFieldNodeToOpenField(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      } else {
        addFieldFromLibrary();
      }
    }
  }

  function onLibraryDragOver(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  const onFieldNodesChange = useCallback((changes: NodeChange[]) => {
    if (!selectedField) return;
    const selectedChange = changes.find(
      (change): change is Extract<NodeChange, { type: "select" }> => change.type === "select" && change.selected
    );
    if (selectedChange) {
      const selectedNode = selectedField.nodes.find((node) => node.id === selectedChange.id);
      const fieldId = selectedNode ? fieldIdFromNode(selectedNode) : null;
      if (fieldId) setSelectedBlockId(fieldId);
    }
    setFields((current) => current.map((field) => (
      field.id === selectedField.id
        ? { ...field, nodes: applyNodeChanges(changes, field.nodes), updated_at: new Date().toISOString() }
        : field
    )));
  }, [selectedField]);

  const onFieldEdgesChange = useCallback((changes: EdgeChange[]) => {
    if (!selectedField) return;
    setFields((current) => current.map((field) => (
      field.id === selectedField.id
        ? { ...field, edges: applyEdgeChanges(changes, field.edges), updated_at: new Date().toISOString() }
        : field
    )));
  }, [selectedField]);

  function selectFieldNode(node: Node) {
    const fieldId = fieldIdFromNode(node);
    if (fieldId) setSelectedBlockId(fieldId);
  }

  function openFieldNode(node: Node) {
    const fieldId = fieldIdFromNode(node);
    if (fieldId) openField(fieldId);
  }

  function nodeFromCanvasEvent(event: React.MouseEvent<HTMLElement>): Node | null {
    if (!selectedField) return null;
    const target = event.target as HTMLElement | null;
    const flowNode = target?.closest(".react-flow__node") as HTMLElement | null;
    const nodeId = flowNode?.dataset.id;
    return nodeId ? selectedField.nodes.find((node) => node.id === nodeId) ?? null : null;
  }

  function renameField(fieldId: string, name: string) {
    const nextName = name.trim();
    if (!nextName) return;
    setFields((current) => current.map((field) => {
      if (field.id === fieldId) {
        return { ...field, name: nextName, updated_at: new Date().toISOString() };
      }
      // Update canvas node labels that reference this field
      const hasRef = field.nodes.some((node) => node.data.field_id === fieldId);
      if (hasRef) {
        return {
          ...field,
          nodes: field.nodes.map((node) =>
            node.data.field_id === fieldId ? { ...node, data: { ...node.data, label: nextName } } : node
          )
        };
      }
      return field;
    }));
  }

  function openField(fieldId: string) {
    setView({ kind: "field", fieldId });
    setSelectedBlockId(null);
  }

  function navigateUp() {
    if (!selectedField) {
      setView({ kind: "home" });
      setSelectedBlockId(null);
      return;
    }
    const parentId = selectedField.parent_id;
    if (parentId && fields.some((field) => field.id === parentId)) {
      setView({ kind: "field", fieldId: parentId });
    } else {
      setView({ kind: "home" });
    }
    setSelectedBlockId(null);
  }

  function backToHome() {
    setView({ kind: "home" });
    setSelectedBlockId(null);
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
      <section
        className="workspace-home"
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelectedBlockId(null);
        }}
        onDrop={onLibraryDropSurface}
        onDragOver={onLibraryDragOver}
      >
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
          <section
            className="field-list-pane"
            onClick={(event) => {
              if (event.target === event.currentTarget) setSelectedBlockId(null);
            }}
          >
            <div className="section-title-row">
              <div>
                <h3>Fields</h3>
                <p>Field Blocks open into canvas surfaces.</p>
              </div>
              <span>{workspaceFields.length}</span>
            </div>
            {workspaceFields.length === 0 ? (
              <div className="quiet-empty">
                <SquareDashedMousePointer size={22} />
                <strong>No Fields yet</strong>
                <span>Create one Field Block to start shaping this workspace.</span>
              </div>
            ) : (
              <div className="field-list">
                {workspaceFields.map((field) => (
                  <button
                    key={field.id}
                    className={`field-block${selectedBlockId === field.id ? " selected" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setSelectedBlockId(field.id);
                    }}
                    onDoubleClick={() => openField(field.id)}
                  >
                    <span className="field-icon"><LayoutPanelLeft size={16} /></span>
                    <span>
                      <strong>{field.name}</strong>
                      <small>{field.nodes.length} child blocks</small>
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
    if (!selectedField) return null;
    return (
      <section className="field-surface">
        <div className="field-toolbar">
          <button className="icon-button" onClick={navigateUp} title={selectedField.parent_id ? "Back to parent" : "Workspace Home"}>
            <ArrowLeft size={16} />
          </button>
          <div>
            <p className="eyebrow">Field Surface</p>
            <h2>{selectedField.name}</h2>
          </div>
          <button className="ghost-action" onClick={() => setChannelOpen(true)}>
            <MessageSquare size={16} />
            Floe
          </button>
        </div>
        <div
          className="canvas-wrap"
          onClickCapture={(event) => {
            const node = nodeFromCanvasEvent(event);
            if (node) selectFieldNode(node);
          }}
          onDoubleClickCapture={(event) => {
            const node = nodeFromCanvasEvent(event);
            if (node) openFieldNode(node);
          }}
        >
          <ReactFlow
            nodes={fieldNodes}
            edges={fieldEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onFieldNodesChange}
            onEdgesChange={onFieldEdgesChange}
            onNodeClick={(_, node) => selectFieldNode(node)}
            onNodeDoubleClick={(_, node) => openFieldNode(node)}
            onSelectionChange={(selection) => {
              const node = selection.nodes[0];
              if (node) selectFieldNode(node);
            }}
            fitView
            minZoom={0.2}
            maxZoom={1.8}
            onPaneClick={() => setSelectedBlockId(null)}
            onDrop={(event) => onLibraryDropSurface(event as unknown as React.DragEvent<HTMLElement>)}
            onDragOver={(event) => onLibraryDragOver(event as unknown as React.DragEvent<HTMLElement>)}
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <Controls position="bottom-left" />
            <MiniMap pannable zoomable position="bottom-right" />
          </ReactFlow>
          {fieldNodes.length === 0 && (
            <div className="canvas-empty">
              <SquareDashedMousePointer size={22} />
              <strong>Empty Field</strong>
              <span>Canvas-backed Blocks will appear here when product-layer storage APIs are added.</span>
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
        ) : view.kind === "home" && !selectedFieldBlock ? (
          <>
            <InspectorSection title="Workspace">
              <Detail label="Name" value={selectedWorkspace.name} />
              <Detail label="Location" value={selectedWorkspace.locator} />
              <Detail label=".floe" value={workspaceStatusLabel(selectedWorkspace)} />
              <Detail label="Fields" value={String(workspaceFields.length)} />
            </InspectorSection>
            <RuntimeSection />
            <ActorAccessSection />
          </>
        ) : currentSelection ? (
          <>
            <InspectorSection title={selectedFieldBlock ? "Field Block" : "Opened Field"}>
              <label className="stacked-label">
                Name
                <input
                  key={currentSelection.id}
                  defaultValue={currentSelection.name}
                  onBlur={(event) => renameField(currentSelection.id, event.target.value)}
                />
              </label>
              <Detail label="Type" value="Field" />
              <Detail label="Children" value={String(currentSelection.nodes.length)} />
              <Detail label="Storage" value="Local draft" />
              {selectedFieldBlock && (
                <button className="primary-action full" onClick={() => openField(selectedFieldBlock.id)}>
                  <FolderOpen size={15} />
                  Open Field
                </button>
              )}
            </InspectorSection>
            <ActorAccessSection />
          </>
        ) : null}
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
                disabled={!workspaceBinding?.auth_profile || availableModels.length === 0}
              >
                <option value="">Select model</option>
                {availableModels.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}{model.reasoning ? " reasoning" : ""}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <Detail label="Floe endpoint" value={floeAgent?.status ?? "not registered"} />
        {latestRuntimeError && <Detail label="Latest runtime issue" value={latestRuntimeError.kind} />}
      </InspectorSection>
    );
  }

  function renderBlockLibrary() {
    return (
      <aside className="library-panel">
        <div className="library-header">
          <h3>Block Library</h3>
          <p>{view.kind === "field" ? "Drop in canvas or click to add to this Field." : "Click or drag to create in Workspace Home."}</p>
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
              onClick={addFieldFromLibrary}
              draggable
              onDragStart={onFieldPrimitiveDragStart}
              title="Field"
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
      <InspectorSection title="Actor Access">
        <Detail label="Humans" value={String(humans.length)} />
        <Detail label="Agents" value={String(agents.length)} />
        <Detail label="Default channel" value={floeAgent ? "Floe" : "Unavailable"} />
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
              <div key={item.id} className="activity-detail-item">
                <span className="activity-detail-kind">{item.kind}</span>
                <span className="activity-detail-summary">{item.summary}</span>
                <time className="activity-detail-time">{item.time}</time>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function renderChannel() {
    if (!channelOpen) return null;
    return (
      <aside className="channel">
        <div className="channel-header">
          <div className="channel-title">
            <div className="channel-avatar"><Sparkles size={16} /></div>
            <div>
              <strong>Floe</strong>
              <span>System</span>
            </div>
          </div>
          <button className="icon-button" onClick={() => setChannelOpen(false)} title="Close Channel">
            <X size={16} />
          </button>
        </div>
        <div className="channel-body">
          {!floeAgent && (
            <div className="callout warning">
              <AlertTriangle size={15} />
              <span>The default Floe endpoint has not registered yet.</span>
            </div>
          )}
          {!runtimeReady && floeAgent && (
            <div className="callout warning">
              <AlertTriangle size={15} />
              <span>Select a runtime profile and model before messaging Floe.</span>
            </div>
          )}
          {chatSegments.length === 0 ? (
            <div className="channel-empty">
              <MessageSquare size={22} />
              <strong>Floe is available from this screen.</strong>
              <span>Messages use the existing event substrate and the default Floe endpoint.</span>
            </div>
          ) : (
            <>
              {chatSegments.map((segment) => {
                if (segment.kind === "activity") {
                  return renderActivityGroup(segment.group);
                }
                if (segment.kind === "streaming") {
                  return (
                    <div key={segment.turnId} className="channel-message floe streaming">
                      <div className="message-meta">Floe</div>
                      <div className="message-text">{renderMarkdown(segment.text)}</div>
                    </div>
                  );
                }
                const isHuman = segment.message.source_endpoint_id === humanEndpoint;
                return (
                  <div key={segment.message.event_id} className={`channel-message ${isHuman ? "human" : "floe"}`}>
                    <div className="message-meta">{isHuman ? "You" : "Floe"} · {new Date(segment.message.created_at).toLocaleTimeString()}</div>
                    <div className="message-text">{isHuman ? segment.message.content.text : renderMarkdown(segment.message.content.text ?? "")}</div>
                  </div>
                );
              })}
            </>
          )}
          {floeIsActive && !chatSegments.some((s) => s.kind === "activity" && s.group.status === "working") && (
            <div className="thinking-strip">
              <Loader size={13} className="spin" />
              <span>Floe is working…</span>
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
            disabled={!floeAgent || !runtimeReady}
            placeholder={!floeAgent ? "Waiting for Floe endpoint" : !runtimeReady ? "Configure runtime first" : "Message Floe"}
          />
          <button
            className="icon-button primary-icon"
            onClick={() => void sendFloeMessage()}
            disabled={!floeAgent || !runtimeReady || !channelMessage.trim()}
            title="Send"
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
            <button
              key={workspace.workspace_id}
              className={`workspace-button${workspace.workspace_id === selectedWorkspaceId ? " active" : ""}`}
              onClick={() => void selectWorkspace(workspace.workspace_id)}
            >
              <FolderOpen size={15} />
              <span>{workspace.name}</span>
            </button>
          ))}
        </div>
        <div className="rail-new">
          <input
            value={workspacePath}
            onChange={(event) => setWorkspacePath(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void registerWorkspace(); }}
            placeholder="Workspace path"
          />
          <button className="icon-button" onClick={() => void registerWorkspace()} disabled={!workspacePath.trim()} title="Create Workspace">
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
            {selectedField && fieldAncestors(selectedField, fields).map((ancestor) => (
              <React.Fragment key={ancestor.id}>
                <ChevronRight size={14} />
                <button onClick={() => openField(ancestor.id)}>{ancestor.name}</button>
              </React.Fragment>
            ))}
            {selectedField && (
              <>
                <ChevronRight size={14} />
                <button className="breadcrumb-current">{selectedField.name}</button>
              </>
            )}
          </nav>
          <div className="topbar-actions">
            <button className="icon-button" onClick={() => void refresh()} title="Refresh">
              <RefreshCw size={15} />
            </button>
            <button className="icon-button" onClick={() => setChannelOpen((current) => !current)} title="Toggle Channel">
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

async function api<T>(baseUrl: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function humanEndpointId(workspaceId: string): string {
  return `endpoint:${workspaceId}:user:operator`;
}

function loadLocalFields(workspaceId: string): FieldBlock[] {
  try {
    const raw = localStorage.getItem(`${localFieldStoragePrefix}${workspaceId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as FieldBlock[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalFields(workspaceId: string, fields: FieldBlock[]) {
  localStorage.setItem(`${localFieldStoragePrefix}${workspaceId}`, JSON.stringify(fields));
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

function currentContextLabel(view: View, workspace: Workspace | null, field: FieldBlock | null): string {
  if (!workspace) return "No workspace";
  if (view.kind === "field" && field) return `Workspace: ${workspace.name}; Field: ${field.name}`;
  return `Workspace: ${workspace.name}; Home`;
}

function fieldIdFromNode(node: Node): string | null {
  const value = node.data?.field_id;
  return typeof value === "string" ? value : null;
}

/** Walk up the parent_id chain and return ancestors in root-first order (excludes the field itself). */
function fieldAncestors(field: FieldBlock, allFields: FieldBlock[]): FieldBlock[] {
  const ancestors: FieldBlock[] = [];
  let currentId = field.parent_id;
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = allFields.find((f) => f.id === currentId);
    if (!parent) break;
    ancestors.unshift(parent);
    currentId = parent.parent_id;
  }
  return ancestors;
}

function runtimeActivityLabel(kind: string): string {
  const labels: Record<string, string> = {
    "BeforeToolUse": "Running",
    "AfterToolUse": "Completed",
    "ToolUseFailed": "Failed",
    "runtime_error": "Error",
    "runtime_no_visible_output": "No output"
  };
  if (labels[kind]) return labels[kind];
  return kind
    .replace(/^runtime_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Human-friendly label for a completed activity group */
function activityGroupLabel(items: RuntimeActivity[]): string {
  const toolStarts = items.filter((item) => item.kind === "Running");
  if (toolStarts.length === 0) return `Activity · ${items.length} step${items.length === 1 ? "" : "s"}`;
  if (toolStarts.length === 1) return `Used ${toolStarts[0].summary || "a tool"}`;
  // Deduplicate tool names for a concise label
  const uniqueTools = [...new Set(toolStarts.map((item) => item.summary || "tool"))];
  if (uniqueTools.length <= 2) return `Used ${uniqueTools.join(" and ")}`;
  return `Used ${uniqueTools.length} tools`;
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

function summarizeTelemetry(record: TelemetryRecord): string {
  try {
    const payload = JSON.parse(record.payload_json) as Record<string, unknown>;
    // For tool calls, show the tool name
    if (typeof payload.toolName === "string") return payload.toolName;
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
