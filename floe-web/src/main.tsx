import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  Check,
  FolderPlus,
  FileJson,
  MessageCircle,
  PlugZap,
  RefreshCw,
  Save,
  Send,
  Terminal,
  Trash2,
  UserRound
} from "lucide-react";
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

type AuthProfile = {
  id: string;
  provider: string;
  model?: string;
  label?: string;
};

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

type SavedConfig = {
  config_id: string;
  name: string;
  config_json: string;
};

type WorkspaceDeleteResult = {
  ok: boolean;
  workspace_id: string;
  locator: string;
  locator_deleted: boolean;
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

type TimelineEntry =
  | { kind: "event"; data: EventEnvelope }
  | { kind: "telemetry"; data: TelemetryRecord };

const TELEMETRY_ERROR_KINDS = new Set([
  "runtime_error",
  "runtime_no_visible_output",
  "provider_auth_missing",
  "runtime_profile_provider_mismatch",
  "runtime_model_required",
  "runtime_model_unknown",
  "runtime_provider_required",
  "runtime_profile_required"
]);

const defaultBusUrl = localStorage.getItem("floe.busUrl") ?? "http://127.0.0.1:5377";

function App() {
  const params = new URLSearchParams(window.location.search);
  const [busUrl, setBusUrl] = useState(defaultBusUrl);
  const [candidate, setCandidate] = useState(params.get("candidate") ?? params.get("workspace") ?? "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryRecord[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [runtimeBindings, setRuntimeBindings] = useState<RuntimeBinding[]>([]); 
  const [configs, setConfigs] = useState<SavedConfig[]>([]);
  const [selectedConfigId, setSelectedConfigId] = useState("");
  const [configName, setConfigName] = useState("Local agent config");
  const [configBody, setConfigBody] = useState(`{
  "agents": [
    {
      "id": "reviewer",
      "name": "Reviewer",
      "instructions": "Review changes and report concrete risks before yielding.",
      "skills": []
    }
  ]
}`);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [error, setError] = useState<string | null>(null);
  const selectedWorkspaceIdRef = useRef<string>("");

  const selectedWorkspace = workspaces.find((workspace) => workspace.workspace_id === selectedWorkspaceId) ?? null;
  const agents = endpoints.filter((endpoint) => endpoint.actor_type === "agent");
  const humanEndpoint = selectedWorkspace ? humanEndpointId(selectedWorkspace.workspace_id) : "";
  const selectedAgent = agents[0];
  const threadId = selectedWorkspace ? `thread:${selectedWorkspace.workspace_id}:operator` : "";
  const workspaceBinding = selectedWorkspace
    ? runtimeBindings.find((binding) => binding.scope === "workspace_default" && binding.workspace_id === selectedWorkspace.workspace_id)
    : undefined;
  const agentBinding = selectedAgent
    ? runtimeBindings.find((binding) => binding.scope === "agent" && binding.endpoint_id === selectedAgent.endpoint_id)
    : undefined;

  // The effective profile is the agent binding's profile (if set), otherwise the workspace binding's
  const effectiveProfileId = agentBinding?.auth_profile || workspaceBinding?.auth_profile || null;
  const effectiveProfile = authProfiles.find((p) => p.id === effectiveProfileId) ?? null;
  // Is the runtime ready to send? Both profile and model must be resolved.
  const effectiveModel = agentBinding?.model ?? workspaceBinding?.model ?? null;
  const runtimeReady = !!effectiveProfileId && !!effectiveModel;

  const refresh = useCallback(async (preferredWorkspaceId?: string) => {
    try {
      setError(null);
      const workspaceResult = await api<{ workspaces: Workspace[] }>(busUrl, "/v1/workspaces");
      setWorkspaces(workspaceResult.workspaces);
      const authResult = await api<{ profiles: AuthProfile[] }>(busUrl, "/v1/auth/profiles");
      setAuthProfiles(authResult.profiles);
      const configResult = await api<{ configs: SavedConfig[] }>(busUrl, "/v1/configs");
      setConfigs(configResult.configs);
      setSelectedConfigId((current) => current || configResult.configs[0]?.config_id || "");
      const ids = new Set(workspaceResult.workspaces.map((workspace) => workspace.workspace_id));
      let nextWorkspaceId = preferredWorkspaceId ?? selectedWorkspaceIdRef.current;
      if (!nextWorkspaceId || !ids.has(nextWorkspaceId)) {
        nextWorkspaceId = workspaceResult.workspaces[0]?.workspace_id || "";
      }
      if (nextWorkspaceId !== selectedWorkspaceIdRef.current) {
        selectedWorkspaceIdRef.current = nextWorkspaceId;
        setSelectedWorkspaceId(nextWorkspaceId);
      }
      if (nextWorkspaceId) {
        const endpointResult = await api<{ endpoints: Endpoint[] }>(busUrl, `/v1/workspaces/${encodeURIComponent(nextWorkspaceId)}/endpoints`);
        setEndpoints(endpointResult.endpoints);
        const bindingResult = await api<{ bindings: RuntimeBinding[] }>(
          busUrl,
          `/v1/runtime/bindings?workspace_id=${encodeURIComponent(nextWorkspaceId)}`
        );
        setRuntimeBindings(bindingResult.bindings);
        const eventResult = await api<{ events: EventEnvelope[] }>(busUrl, `/v1/events?workspace_id=${encodeURIComponent(nextWorkspaceId)}&limit=200`);
        setEvents(eventResult.events);
        const telemetryResult = await api<{ records: TelemetryRecord[] }>(busUrl, `/v1/runtime/telemetry?workspace_id=${encodeURIComponent(nextWorkspaceId)}&limit=200`);
        setTelemetry(telemetryResult.records);
      } else {
        setEndpoints([]);
        setRuntimeBindings([]);
        setEvents([]);
        setTelemetry([]);
      }
      setStatus("Connected");
    } catch (err) {
      setStatus("Offline");
      setError((err as Error).message);
    }
  }, [busUrl]);

  useEffect(() => {
    selectedWorkspaceIdRef.current = selectedWorkspaceId;
  }, [selectedWorkspaceId]);

  // Fetch available models whenever the effective provider changes
  useEffect(() => {
    if (!effectiveProfile?.provider) { setAvailableModels([]); return; }
    void api<{ models: ModelInfo[] }>(busUrl, `/v1/auth/models?provider=${encodeURIComponent(effectiveProfile.provider)}`)
      .then((result) => setAvailableModels(result.models))
      .catch(() => setAvailableModels([]));
  }, [busUrl, effectiveProfile?.provider]);

  useEffect(() => {
    localStorage.setItem("floe.busUrl", busUrl);
    void refresh();
    const socketUrl = busUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "") + "/v1/events/stream";
    const socket = new WebSocket(socketUrl);
    let refreshRunning = false;
    let refreshPending = false;
    const queueRefresh = () => {
      if (refreshRunning) {
        refreshPending = true;
        return;
      }
      refreshRunning = true;
      refreshPending = false;
      void refresh().finally(() => {
        refreshRunning = false;
        if (refreshPending) {
          queueRefresh();
        }
      });
    };
    socket.onopen = () => setStatus("Connected");
    socket.onmessage = () => queueRefresh();
    socket.onerror = () => setStatus((current) => (current === "Offline" ? current : "Socket reconnecting"));
    socket.onclose = () => setStatus((current) => (current === "Offline" ? current : "Socket disconnected"));
    const recoveryInterval = setInterval(() => void refresh(), 30_000);
    return () => {
      socket.close();
      clearInterval(recoveryInterval);
    };
  }, [busUrl, refresh]);

  async function registerWorkspace() {
    if (!candidate.trim()) return;
    const result = await api<{ workspace: Workspace }>(busUrl, "/v1/workspaces/register", {
      method: "POST",
      body: {
        locator: candidate.trim(),
        init_authorized: true
      }
    });
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(result.workspace.workspace_id)}/select`, { method: "POST" });
    selectedWorkspaceIdRef.current = result.workspace.workspace_id;
    setSelectedWorkspaceId(result.workspace.workspace_id);
    await ensureHuman(result.workspace.workspace_id);
    await refresh(result.workspace.workspace_id);
  }

  async function selectWorkspace(workspaceId: string) {
    selectedWorkspaceIdRef.current = workspaceId;
    setSelectedWorkspaceId(workspaceId);
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, { method: "POST" });
    await ensureHuman(workspaceId);
    await refresh(workspaceId);
  }

  async function deleteWorkspace(workspace: Workspace) {
    if (!window.confirm(`Remove workspace '${workspace.name}' from Floe?`)) return;
    const deleteLocator = window.confirm(
      `Also delete the workspace folder and files on disk?\n\n${workspace.locator}\n\nPress OK to delete files, Cancel to keep files.`
    );
    await api<WorkspaceDeleteResult>(busUrl, `/v1/workspaces/${encodeURIComponent(workspace.workspace_id)}/delete`, {
      method: "POST",
      body: {
        delete_locator: deleteLocator
      }
    });
    if (selectedWorkspaceIdRef.current === workspace.workspace_id) {
      selectedWorkspaceIdRef.current = "";
      setSelectedWorkspaceId("");
    }
    await refresh();
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
        metadata: {
          registered_by: "floe-web"
        }
      }
    });
  }

  async function setWorkspaceProfile(profileId: string) {
    if (!selectedWorkspace) return;
    if (!profileId) {
      await api(busUrl, "/v1/runtime/bindings/clear", {
        method: "POST",
        body: {
          scope: "workspace_default",
          workspace_id: selectedWorkspace.workspace_id
        }
      });
    } else {
      await api(busUrl, "/v1/runtime/bindings", {
        method: "POST",
        body: {
          scope: "workspace_default",
          workspace_id: selectedWorkspace.workspace_id,
          auth_profile: profileId,
          model: null  // clear model when profile changes — user must re-select
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

  async function setAgentProfile(profileId: string) {
    if (!selectedWorkspace || !selectedAgent) return;
    if (!profileId) {
      await api(busUrl, "/v1/runtime/bindings/clear", {
        method: "POST",
        body: {
          scope: "agent",
          workspace_id: selectedWorkspace.workspace_id,
          endpoint_id: selectedAgent.endpoint_id
        }
      });
    } else {
      await api(busUrl, "/v1/runtime/bindings", {
        method: "POST",
        body: {
          scope: "agent",
          workspace_id: selectedWorkspace.workspace_id,
          endpoint_id: selectedAgent.endpoint_id,
          auth_profile: profileId,
          model: null  // clear model when profile changes
        }
      });
    }
    await refresh(selectedWorkspace.workspace_id);
  }

  async function setAgentModel(modelId: string) {
    if (!selectedWorkspace || !selectedAgent) return;
    // Agent model override: use agent binding's profile if set, else workspace binding's profile
    const profileId = agentBinding?.auth_profile || workspaceBinding?.auth_profile;
    if (!profileId) return;
    if (!agentBinding) {
      // No agent binding yet — create one with the inherited profile + selected model
      await api(busUrl, "/v1/runtime/bindings", {
        method: "POST",
        body: {
          scope: "agent",
          workspace_id: selectedWorkspace.workspace_id,
          endpoint_id: selectedAgent.endpoint_id,
          auth_profile: profileId,
          model: modelId || null
        }
      });
    } else {
      await api(busUrl, "/v1/runtime/bindings", {
        method: "POST",
        body: {
          scope: "agent",
          workspace_id: selectedWorkspace.workspace_id,
          endpoint_id: selectedAgent.endpoint_id,
          auth_profile: agentBinding.auth_profile,
          model: modelId || null
        }
      });
    }
    await refresh(selectedWorkspace.workspace_id);
  }

  async function sendMessage() {
    if (!selectedWorkspace || !selectedAgent || !message.trim()) return;
    await ensureHuman(selectedWorkspace.workspace_id);
    await api(busUrl, "/v1/events/emit", {
      method: "POST",
      body: {
        type: "message",
        workspace_id: selectedWorkspace.workspace_id,
        source_endpoint_id: humanEndpoint,
        destination: {
          kind: "endpoint",
          endpoint_id: selectedAgent.endpoint_id
        },
        thread_id: threadId,
        correlation_id: null,
        content: {
          text: message.trim(),
          data: {}
        },
        response: {
          expected: false
        },
        metadata: {
          submitted_by: "floe-web"
        }
      }
    });
    setMessage("");
    await refresh();
  }

  async function saveConfig() {
    const parsed = JSON.parse(configBody);
    const result = await api<{ config: SavedConfig }>(busUrl, "/v1/configs", {
      method: "POST",
      body: {
        name: configName.trim() || "Untitled config",
        config: parsed
      }
    });
    setSelectedConfigId(result.config.config_id);
    await refresh();
  }

  async function applyConfig() {
    if (!selectedWorkspace || !selectedConfigId) return;
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(selectedWorkspace.workspace_id)}/apply-config`, {
      method: "POST",
      body: {
        config_id: selectedConfigId
      }
    });
    await refresh();
  }

  async function importSnapshot() {
    if (!selectedWorkspace) return;
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(selectedWorkspace.workspace_id)}/config-snapshot`, {
      method: "POST",
      body: {}
    });
    await refresh();
  }

  const sortedTimeline = useMemo((): TimelineEntry[] => {
    const entries: TimelineEntry[] = [
      ...events.map((e): TimelineEntry => ({ kind: "event", data: e })),
      ...telemetry.map((t): TimelineEntry => ({ kind: "telemetry", data: t }))
    ];
    return entries.sort((a, b) => a.data.created_at.localeCompare(b.data.created_at));
  }, [events, telemetry]);

  // Chat pane: human messages sent + agent runtime_turn_output events only
  const chatMessages = useMemo((): TimelineEntry[] => {
    if (!selectedAgent || !threadId) return [];
    const agentEndpointId = selectedAgent.endpoint_id;
    const result: TimelineEntry[] = [];
    for (const event of events) {
      if (event.thread_id !== threadId) continue;
      const isHumanMessage = event.source_endpoint_id === humanEndpoint && event.type === "message";
      const isAgentOutput = event.metadata?.origin === "runtime_turn_output"
        && event.source_endpoint_id === agentEndpointId;
      if (isHumanMessage || isAgentOutput) {
        result.push({ kind: "event", data: event });
      }
    }
    return result.sort((a, b) => a.data.created_at.localeCompare(b.data.created_at));
  }, [events, selectedAgent, threadId, humanEndpoint]);

  // Streaming bubble: latest visible_output per turn that doesn't yet have a runtime_turn_output event
  const streamingTurns = useMemo((): Record<string, { text: string; created_at: string }> => {
    if (!selectedAgent || !threadId) return {};
    const agentEndpointId = selectedAgent.endpoint_id;
    // Collect runtime_turn_ids that already have a final output event
    const finishedTurnIds = new Set<string>();
    for (const event of events) {
      if (event.metadata?.origin === "runtime_turn_output" && event.source_endpoint_id === agentEndpointId) {
        const turnId = event.content?.data?.runtime_turn_id;
        if (typeof turnId === "string") finishedTurnIds.add(turnId);
      }
    }
    // Latest visible_output snapshot per turn (only for unfinished turns)
    const latest: Record<string, { text: string; created_at: string }> = {};
    for (const t of telemetry) {
      if (t.endpoint_id !== agentEndpointId) continue;
      if (t.kind !== "visible_output") continue;
      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(t.payload_json); } catch { continue; }
      const turnId = payload.runtime_turn_id;
      if (typeof turnId !== "string" || finishedTurnIds.has(turnId)) continue;
      if (!latest[turnId] || t.created_at > latest[turnId].created_at) {
        latest[turnId] = { text: String(payload.text ?? ""), created_at: t.created_at };
      }
    }
    return latest;
  }, [events, telemetry, selectedAgent, threadId]);

  const agentErrorTelemetry = useMemo(() => {
    if (!selectedAgent) return null;
    const agentTel = telemetry.filter((t) => t.endpoint_id === selectedAgent.endpoint_id);
    const latest = agentTel[agentTel.length - 1];
    return latest && TELEMETRY_ERROR_KINDS.has(latest.kind) ? latest : null;
  }, [telemetry, selectedAgent]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark"><PlugZap size={20} /></div>
          <div>
            <h1>Floe</h1>
            <span>{status}</span>
          </div>
        </div>
        <div className="bus-control">
          <input value={busUrl} onChange={(event) => setBusUrl(event.target.value)} aria-label="Bus URL" />
          <button onClick={() => void refresh()} title="Refresh"><RefreshCw size={18} /></button>
        </div>
      </header>

      {error && <div className="error-bar">{error}</div>}

      <section className="workspace-band">
        <div className="workspace-form">
          <FolderPlus size={18} />
          <input
            value={candidate}
            onChange={(event) => setCandidate(event.target.value)}
            placeholder="Project folder path"
            aria-label="Project folder path"
          />
          <button onClick={() => void registerWorkspace()}>
            <Check size={17} />
            Add Workspace
          </button>
        </div>
      </section>

      <section className="console-grid">
        <aside className="sidebar">
          <div className="panel-heading">
            <Terminal size={17} />
            <h2>Workspaces</h2>
          </div>
          <div className="workspace-list">
            {workspaces.map((workspace) => (
              <div
                key={workspace.workspace_id}
                className={workspace.workspace_id === selectedWorkspaceId ? "workspace-row active" : "workspace-row"}
              >
                <button
                  className={workspace.workspace_id === selectedWorkspaceId ? "workspace-item active" : "workspace-item"}
                  onClick={() => void selectWorkspace(workspace.workspace_id)}
                >
                  <strong>{workspace.name}</strong>
                  <span>{workspace.status}</span>
                </button>
                <button
                  className="workspace-delete"
                  onClick={() => void deleteWorkspace(workspace)}
                  title={`Remove workspace ${workspace.name}`}
                  aria-label={`Remove workspace ${workspace.name}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="thread-panel">
          <div className="panel-heading split">
            <div>
              <MessageCircle size={17} />
              <h2>Chat</h2>
            </div>
            <span>{selectedAgent?.name ?? "No agent selected"}</span>
          </div>
          <div className="event-list chat-list">
            {chatMessages.map((entry) => {
              const event = entry.data as EventEnvelope;
              const isHuman = event.source_endpoint_id === humanEndpoint;
              return (
                <article key={event.event_id} className={isHuman ? "event human" : "event agent"}>
                  <div className="event-meta">
                    <span>{isHuman ? "You" : (selectedAgent?.name ?? "Agent")}</span>
                    <time>{new Date(event.created_at).toLocaleTimeString()}</time>
                  </div>
                  <p>{event.content?.text ?? JSON.stringify(event.content)}</p>
                </article>
              );
            })}
            {Object.entries(streamingTurns).map(([turnId, { text, created_at }]) => (
              <article key={turnId} className="event agent streaming">
                <div className="event-meta">
                  <span>{selectedAgent?.name ?? "Agent"} <em>(streaming…)</em></span>
                  <time>{new Date(created_at).toLocaleTimeString()}</time>
                </div>
                <p>{text}</p>
              </article>
            ))}
            {chatMessages.length === 0 && Object.keys(streamingTurns).length === 0 && (
              <div className="empty">{selectedAgent ? "No messages yet. Say hello!" : "Select a workspace and agent."}</div>
            )}
          </div>
          {agentErrorTelemetry && (
            <div className="warning">
              Runtime outcome: <strong>{agentErrorTelemetry.kind}</strong>
              {(() => {
                try {
                  const p = JSON.parse(agentErrorTelemetry.payload_json) as Record<string, unknown>;
                  return p.message ? <span>{String(p.message)}</span> : null;
                } catch { return null; }
              })()}
            </div>
          )}
          {selectedAgent?.status === "runtime_unconfigured" && (
            <div className="warning">
              Agent runtime is unconfigured.
              <span>Select a runtime auth profile in the Runtime Auth panel.</span>
            </div>
          )}
          <div className="composer">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendMessage();
              }}
              placeholder={
                !selectedAgent ? "Waiting for an agent endpoint"
                : !effectiveProfileId ? "Select a runtime profile first"
                : !effectiveModel ? "Select a model to enable messaging"
                : `Message ${selectedAgent.name}`
              }
              disabled={!selectedAgent || !runtimeReady}
            />
            <button onClick={() => void sendMessage()} disabled={!selectedAgent || !runtimeReady || !message.trim()} title="Send">
              <Send size={18} />
            </button>
          </div>
        </section>

        <section className="thread-panel debug-panel">
          <div className="panel-heading split">
            <div>
              <Activity size={17} />
              <h2>Event History</h2>
            </div>
            <span>{selectedWorkspace?.active_config_hash ?? "No config hash"}</span>
          </div>
          <div className="event-list">
            {sortedTimeline.map((entry) => {
              if (entry.kind === "telemetry") {
                const t = entry.data;
                let payload: Record<string, unknown> = {};
                try { payload = JSON.parse(t.payload_json); } catch { /* ignore */ }
                const isError = TELEMETRY_ERROR_KINDS.has(t.kind);
                const summary = payload.error_message
                  ? String(payload.error_message).slice(0, 200)
                  : payload.text
                    ? String(payload.text).slice(0, 120)
                    : payload.message
                      ? String(payload.message).slice(0, 120)
                      : payload.note
                        ? String(payload.note).slice(0, 120)
                        : "";
                return (
                  <article key={t.telemetry_id} className={`event telemetry${isError ? " telemetry-error" : ""}`}>
                    <div className="event-meta">
                      <span>⚙ {t.kind}</span>
                      <time>{new Date(t.created_at).toLocaleTimeString()}</time>
                    </div>
                    {summary && <p>{summary}</p>}
                  </article>
                );
              }
              const event = entry.data;
              return (
                <article key={event.event_id} className={event.source_endpoint_id === humanEndpoint ? "event human" : "event agent"}>
                  <div className="event-meta">
                    <span>{event.type}</span>
                    <time>{new Date(event.created_at).toLocaleTimeString()}</time>
                  </div>
                  <p>{event.content?.text ?? JSON.stringify(event.content)}</p>
                </article>
              );
            })}
            {sortedTimeline.length === 0 && <div className="empty">No events yet.</div>}
          </div>
        </section>

        <aside className="sidebar">
          <div className="panel-heading">
            <Bot size={17} />
            <h2>Endpoints</h2>
          </div>
          <div className="endpoint-list">
            {endpoints.map((endpoint) => (
              <div className="endpoint-item" key={endpoint.endpoint_id}>
                {endpoint.actor_type === "human" ? <UserRound size={16} /> : <Bot size={16} />}
                <div>
                  <strong>{endpoint.name}</strong>
                  <span>{endpoint.status}</span>
                </div>
              </div>
            ))}
            {endpoints.length === 0 && <div className="empty">No endpoints registered.</div>}
          </div>

          <div className="panel-heading lower">
            <PlugZap size={17} />
            <h2>Runtime Auth</h2>
          </div>
          {authProfiles.length === 0 ? (
            <div className="warning">
              No local auth profiles found.
              <span>Run <code>npm run floe -- login</code> to create one.</span>
            </div>
          ) : (
            <div className="config-tools">
              <label htmlFor="workspace-profile">Workspace profile</label>
              <select
                id="workspace-profile"
                value={workspaceBinding?.auth_profile ?? ""}
                onChange={(event) => void setWorkspaceProfile(event.target.value)}
                disabled={!selectedWorkspace}
              >
                <option value="">Unconfigured</option>
                {authProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.id} ({profile.provider})
                  </option>
                ))}
              </select>
              <label htmlFor="workspace-model">
                Workspace model
                {availableModels.length > 0 && <span style={{ color: "var(--text-muted)", marginLeft: "4px" }}>({availableModels.length} available)</span>}
              </label>
              <select
                id="workspace-model"
                value={workspaceBinding?.model ?? ""}
                onChange={(event) => void setWorkspaceModel(event.target.value)}
                disabled={!workspaceBinding?.auth_profile || availableModels.length === 0}
              >
                <option value="">Select a model…</option>
                {availableModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}{model.reasoning ? " ✦" : ""}
                  </option>
                ))}
              </select>
              <label htmlFor="agent-profile">Agent override ({selectedAgent?.name ?? "no agent"})</label>
              <select
                id="agent-profile"
                value={agentBinding?.auth_profile ?? ""}
                onChange={(event) => void setAgentProfile(event.target.value)}
                disabled={!selectedWorkspace || !selectedAgent}
              >
                <option value="">Use workspace default</option>
                {authProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.id} ({profile.provider})
                  </option>
                ))}
              </select>
              {agentBinding?.auth_profile && (
                <>
                  <label htmlFor="agent-model">Agent model override</label>
                  <select
                    id="agent-model"
                    value={agentBinding?.model ?? ""}
                    onChange={(event) => void setAgentModel(event.target.value)}
                    disabled={availableModels.length === 0}
                  >
                    <option value="">Inherit workspace model</option>
                    {availableModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}{model.reasoning ? " ✦" : ""}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {!runtimeReady && effectiveProfileId && (
                <div className="warning" style={{ marginTop: "6px" }}>
                  Select a model to enable messaging.
                </div>
              )}
            </div>
          )}

          <div className="panel-heading lower">
            <FileJson size={17} />
            <h2>Configuration</h2>
          </div>
          {selectedWorkspace && selectedWorkspace.status === "config_drift" && (
            <div className="warning">
              Project config drift detected.
              <button onClick={() => void importSnapshot()}>Import Snapshot</button>
            </div>
          )}
          <div className="config-tools">
            <select value={selectedConfigId} onChange={(event) => setSelectedConfigId(event.target.value)}>
              <option value="">No saved config</option>
              {configs.map((config) => (
                <option key={config.config_id} value={config.config_id}>{config.name}</option>
              ))}
            </select>
            <button onClick={() => void applyConfig()} disabled={!selectedWorkspace || !selectedConfigId}>
              <Check size={16} />
              Apply
            </button>
            <input value={configName} onChange={(event) => setConfigName(event.target.value)} aria-label="Config name" />
            <textarea value={configBody} onChange={(event) => setConfigBody(event.target.value)} aria-label="Config JSON" />
            <button onClick={() => void saveConfig()}>
              <Save size={16} />
              Save Config
            </button>
          </div>

          {selectedWorkspace && (
            <>
              <div className="panel-heading lower">
                <PlugZap size={17} />
                <h2>Webhook</h2>
              </div>
              <input
                readOnly
                value={`${busUrl.replace(/\/$/, "")}/v1/webhooks/${selectedWorkspace.workspace_id}/default`}
                aria-label="Webhook route"
              />
            </>
          )}
        </aside>
      </section>
    </main>
  );
}

async function api<T>(baseUrl: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function humanEndpointId(workspaceId: string): string {
  return `endpoint:${workspaceId}:user:operator`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
