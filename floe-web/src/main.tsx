import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Send,
  Settings,
  Trash2,
  UserRound,
  Zap
} from "lucide-react";
import "./styles.css";

/* ── Types ── */
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
type ModelInfo = { id: string; name: string; provider: string; reasoning: boolean; contextWindow?: number; api?: string };
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

const TELEMETRY_ERROR_KINDS = new Set([
  "runtime_error", "runtime_no_visible_output", "provider_auth_missing",
  "runtime_profile_provider_mismatch", "runtime_model_required",
  "runtime_model_unknown", "runtime_provider_required", "runtime_profile_required"
]);

const defaultBusUrl = localStorage.getItem("floe.busUrl") ?? "http://127.0.0.1:5377";

/* ── Status pill mapping ── */
function statusPill(status: string): { label: string; cls: string } {
  switch (status) {
    case "idle": return { label: "Online", cls: "idle" };
    case "online": return { label: "Online", cls: "idle" };
    case "active": case "processing": return { label: "Active", cls: "active" };
    case "runtime_unconfigured": return { label: "Unconfigured", cls: "unconfigured" };
    case "runtime_error": return { label: "Error", cls: "error" };
    case "error": return { label: "Error", cls: "error" };
    default: return { label: status, cls: "unconfigured" };
  }
}

/* ── Simple markdown renderer ── */
function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(<pre key={elements.length}><code className={lang}>{codeLines.join("\n")}</code></pre>);
      continue;
    }
    // Unordered list
    if (/^[-*•] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•] /.test(lines[i])) {
        items.push(lines[i].replace(/^[-*•] /, ""));
        i++;
      }
      elements.push(<ul key={elements.length}>{items.map((item, j) => <li key={j}>{inlineMarkdown(item)}</li>)}</ul>);
      continue;
    }
    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      elements.push(<ol key={elements.length}>{items.map((item, j) => <li key={j}>{inlineMarkdown(item)}</li>)}</ol>);
      continue;
    }
    // Empty line
    if (!line.trim()) { i++; continue; }
    // Regular paragraph
    elements.push(<p key={elements.length}>{inlineMarkdown(line)}</p>);
    i++;
  }
  return <>{elements}</>;
}

function inlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Process inline patterns: **bold**, *italic*, `code`
  const regex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[2]) parts.push(<strong key={key++}>{match[2]}</strong>);
    else if (match[4]) parts.push(<em key={key++}>{match[4]}</em>);
    else if (match[6]) parts.push(<code key={key++}>{match[6]}</code>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

/* ── App ── */
function App() {
  const [busUrl, setBusUrl] = useState(defaultBusUrl);
  const [showBusUrl, setShowBusUrl] = useState(false);
  const [candidate, setCandidate] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryRecord[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [runtimeBindings, setRuntimeBindings] = useState<RuntimeBinding[]>([]);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("Connecting");
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const selectedWorkspaceIdRef = useRef<string>("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  const selectedWorkspace = workspaces.find((w) => w.workspace_id === selectedWorkspaceId) ?? null;
  const agents = endpoints.filter((e) => e.actor_type === "agent");
  const humanEndpoint = selectedWorkspace ? humanEndpointId(selectedWorkspace.workspace_id) : "";
  const selectedAgent = agents[0];
  const threadId = selectedWorkspace ? `thread:${selectedWorkspace.workspace_id}:operator` : "";
  const workspaceBinding = selectedWorkspace
    ? runtimeBindings.find((b) => b.scope === "workspace_default" && b.workspace_id === selectedWorkspace.workspace_id)
    : undefined;
  const agentBinding = selectedAgent
    ? runtimeBindings.find((b) => b.scope === "agent" && b.endpoint_id === selectedAgent.endpoint_id)
    : undefined;
  const effectiveProfileId = agentBinding?.auth_profile || workspaceBinding?.auth_profile || null;
  const effectiveProfile = authProfiles.find((p) => p.id === effectiveProfileId) ?? null;
  const effectiveModel = agentBinding?.model ?? workspaceBinding?.model ?? null;
  const runtimeReady = !!effectiveProfileId && !!effectiveModel;

  const agentMeta = useMemo(() => {
    if (!selectedAgent?.metadata_json) return null;
    try { return JSON.parse(selectedAgent.metadata_json); } catch { return null; }
  }, [selectedAgent?.metadata_json]);

  /* ── Refresh ── */
  const refresh = useCallback(async (preferredWorkspaceId?: string) => {
    try {
      setError(null);
      const [wsResult, authResult] = await Promise.all([
        api<{ workspaces: Workspace[] }>(busUrl, "/v1/workspaces"),
        api<{ profiles: AuthProfile[] }>(busUrl, "/v1/auth/profiles"),
      ]);
      setWorkspaces(wsResult.workspaces);
      setAuthProfiles(authResult.profiles);
      const ids = new Set(wsResult.workspaces.map((w) => w.workspace_id));
      let nextWsId = preferredWorkspaceId ?? selectedWorkspaceIdRef.current;
      if (!nextWsId || !ids.has(nextWsId)) nextWsId = wsResult.workspaces[0]?.workspace_id || "";
      if (nextWsId !== selectedWorkspaceIdRef.current) {
        selectedWorkspaceIdRef.current = nextWsId;
        setSelectedWorkspaceId(nextWsId);
      }
      if (nextWsId) {
        const [epResult, bindResult, evtResult, telResult] = await Promise.all([
          api<{ endpoints: Endpoint[] }>(busUrl, `/v1/workspaces/${encodeURIComponent(nextWsId)}/endpoints`),
          api<{ bindings: RuntimeBinding[] }>(busUrl, `/v1/runtime/bindings?workspace_id=${encodeURIComponent(nextWsId)}`),
          api<{ events: EventEnvelope[] }>(busUrl, `/v1/events?workspace_id=${encodeURIComponent(nextWsId)}&limit=200`),
          api<{ records: TelemetryRecord[] }>(busUrl, `/v1/runtime/telemetry?workspace_id=${encodeURIComponent(nextWsId)}&limit=200`),
        ]);
        setEndpoints(epResult.endpoints);
        setRuntimeBindings(bindResult.bindings);
        setEvents(evtResult.events);
        setTelemetry(telResult.records);
      } else {
        setEndpoints([]); setRuntimeBindings([]); setEvents([]); setTelemetry([]);
      }
      setStatus("Connected");
    } catch (err) {
      setStatus("Offline");
      setError((err as Error).message);
    }
  }, [busUrl]);

  useEffect(() => { selectedWorkspaceIdRef.current = selectedWorkspaceId; }, [selectedWorkspaceId]);

  useEffect(() => {
    if (!effectiveProfile?.provider) { setAvailableModels([]); return; }
    void api<{ models: ModelInfo[] }>(busUrl, `/v1/auth/models?provider=${encodeURIComponent(effectiveProfile.provider)}`)
      .then((r) => setAvailableModels(r.models)).catch(() => setAvailableModels([]));
  }, [busUrl, effectiveProfile?.provider]);

  useEffect(() => {
    localStorage.setItem("floe.busUrl", busUrl);
    void refresh();
    const socketUrl = busUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "") + "/v1/events/stream";
    const socket = new WebSocket(socketUrl);
    let running = false, pending = false;
    const queue = () => {
      if (running) { pending = true; return; }
      running = true; pending = false;
      void refresh().finally(() => { running = false; if (pending) queue(); });
    };
    socket.onopen = () => setStatus("Connected");
    socket.onmessage = () => queue();
    socket.onerror = () => setStatus((s) => s === "Offline" ? s : "Reconnecting");
    socket.onclose = () => setStatus((s) => s === "Offline" ? s : "Disconnected");
    const recovery = setInterval(() => void refresh(), 30_000);
    return () => { socket.close(); clearInterval(recovery); };
  }, [busUrl, refresh]);

  // Auto-scroll chat
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [events, telemetry]);

  /* ── Chat messages (human + final agent output only) ── */
  const chatMessages = useMemo(() => {
    if (!selectedAgent || !threadId) return [];
    const agentEpId = selectedAgent.endpoint_id;
    return events
      .filter((e) => {
        if (e.thread_id !== threadId) return false;
        if (e.source_endpoint_id === humanEndpoint && e.type === "message") return true;
        if (e.metadata?.origin === "runtime_turn_output" && e.source_endpoint_id === agentEpId) return true;
        return false;
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }, [events, selectedAgent, threadId, humanEndpoint]);

  /* ── Streaming turns (in-flight, not yet finalized) ── */
  const streamingTurns = useMemo(() => {
    if (!selectedAgent || !threadId) return {};
    const agentEpId = selectedAgent.endpoint_id;
    const finished = new Set<string>();
    for (const e of events) {
      if (e.metadata?.origin === "runtime_turn_output" && e.source_endpoint_id === agentEpId) {
        const tid = e.content?.data?.runtime_turn_id;
        if (typeof tid === "string") finished.add(tid);
      }
    }
    const latest: Record<string, { text: string; created_at: string }> = {};
    for (const t of telemetry) {
      if (t.endpoint_id !== agentEpId || t.kind !== "visible_output") continue;
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(t.payload_json); } catch { continue; }
      const tid = p.runtime_turn_id;
      const pThread = p.thread_id;
      if (typeof tid !== "string" || finished.has(tid)) continue;
      if (typeof pThread === "string" && pThread !== threadId) continue;
      if (!latest[tid] || t.created_at > latest[tid].created_at) {
        latest[tid] = { text: String(p.text ?? ""), created_at: t.created_at };
      }
    }
    return latest;
  }, [events, telemetry, selectedAgent, threadId]);

  /* ── Latest error telemetry ── */
  const agentError = useMemo(() => {
    if (!selectedAgent) return null;
    const agentTel = telemetry.filter((t) => t.endpoint_id === selectedAgent.endpoint_id);
    const last = agentTel[agentTel.length - 1];
    return last && TELEMETRY_ERROR_KINDS.has(last.kind) ? last : null;
  }, [telemetry, selectedAgent]);

  /* ── Debug entries grouped by turn ── */
  const debugEntries = useMemo(() => {
    if (!selectedAgent) return [];
    type DebugEntry = { id: string; kind: string; summary: string; time: string; isError: boolean; turnId: string | null };
    const entries: DebugEntry[] = [];
    for (const t of telemetry) {
      if (t.endpoint_id !== selectedAgent.endpoint_id) continue;
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(t.payload_json); } catch { /* */ }
      const summary = (p.error_message ?? p.text ?? p.message ?? p.note ?? "") as string;
      entries.push({
        id: t.telemetry_id,
        kind: t.kind,
        summary: String(summary).slice(0, 120),
        time: new Date(t.created_at).toLocaleTimeString(),
        isError: TELEMETRY_ERROR_KINDS.has(t.kind),
        turnId: typeof p.runtime_turn_id === "string" ? p.runtime_turn_id : null,
      });
    }
    return entries;
  }, [telemetry, selectedAgent]);

  /* ── Actions ── */
  async function registerWorkspace() {
    if (!candidate.trim()) return;
    const r = await api<{ workspace: Workspace }>(busUrl, "/v1/workspaces/register", {
      method: "POST", body: { locator: candidate.trim(), init_authorized: true }
    });
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(r.workspace.workspace_id)}/select`, { method: "POST" });
    selectedWorkspaceIdRef.current = r.workspace.workspace_id;
    setSelectedWorkspaceId(r.workspace.workspace_id);
    await ensureHuman(r.workspace.workspace_id);
    await refresh(r.workspace.workspace_id);
    setCandidate("");
  }

  async function selectWorkspace(id: string) {
    selectedWorkspaceIdRef.current = id;
    setSelectedWorkspaceId(id);
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(id)}/select`, { method: "POST" });
    await ensureHuman(id);
    await refresh(id);
  }

  async function deleteWorkspace(ws: Workspace) {
    if (!window.confirm(`Remove workspace "${ws.name}"?`)) return;
    const delFiles = window.confirm(`Also delete files at:\n${ws.locator}\n\nOK = delete, Cancel = keep`);
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(ws.workspace_id)}/delete`, {
      method: "POST", body: { delete_locator: delFiles }
    });
    if (selectedWorkspaceIdRef.current === ws.workspace_id) {
      selectedWorkspaceIdRef.current = "";
      setSelectedWorkspaceId("");
    }
    await refresh();
  }

  async function ensureHuman(wsId: string) {
    await api(busUrl, "/v1/endpoints/register", {
      method: "POST", body: {
        endpoint_id: humanEndpointId(wsId), workspace_id: wsId,
        actor_type: "human", name: "Operator", status: "online",
        metadata: { registered_by: "floe-web" }
      }
    });
  }

  async function setWorkspaceProfile(profileId: string) {
    if (!selectedWorkspace) return;
    if (!profileId) {
      await api(busUrl, "/v1/runtime/bindings/clear", {
        method: "POST", body: { scope: "workspace_default", workspace_id: selectedWorkspace.workspace_id }
      });
    } else {
      await api(busUrl, "/v1/runtime/bindings", {
        method: "POST", body: {
          scope: "workspace_default", workspace_id: selectedWorkspace.workspace_id,
          auth_profile: profileId, model: null
        }
      });
    }
    await refresh(selectedWorkspace.workspace_id);
  }

  async function setWorkspaceModel(modelId: string) {
    if (!selectedWorkspace || !workspaceBinding?.auth_profile) return;
    await api(busUrl, "/v1/runtime/bindings", {
      method: "POST", body: {
        scope: "workspace_default", workspace_id: selectedWorkspace.workspace_id,
        auth_profile: workspaceBinding.auth_profile, model: modelId || null
      }
    });
    await refresh(selectedWorkspace.workspace_id);
  }

  async function setAgentProfile(profileId: string) {
    if (!selectedWorkspace || !selectedAgent) return;
    if (!profileId) {
      await api(busUrl, "/v1/runtime/bindings/clear", {
        method: "POST", body: {
          scope: "agent", workspace_id: selectedWorkspace.workspace_id,
          endpoint_id: selectedAgent.endpoint_id
        }
      });
    } else {
      await api(busUrl, "/v1/runtime/bindings", {
        method: "POST", body: {
          scope: "agent", workspace_id: selectedWorkspace.workspace_id,
          endpoint_id: selectedAgent.endpoint_id, auth_profile: profileId, model: null
        }
      });
    }
    await refresh(selectedWorkspace.workspace_id);
  }

  async function setAgentModel(modelId: string) {
    if (!selectedWorkspace || !selectedAgent) return;
    const profId = agentBinding?.auth_profile || workspaceBinding?.auth_profile;
    if (!profId) return;
    await api(busUrl, "/v1/runtime/bindings", {
      method: "POST", body: {
        scope: "agent", workspace_id: selectedWorkspace.workspace_id,
        endpoint_id: selectedAgent.endpoint_id,
        auth_profile: agentBinding?.auth_profile ?? profId,
        model: modelId || null
      }
    });
    await refresh(selectedWorkspace.workspace_id);
  }

  async function importSnapshot() {
    if (!selectedWorkspace) return;
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(selectedWorkspace.workspace_id)}/config-snapshot`, {
      method: "POST", body: {}
    });
    await refresh();
  }

  async function sendMessage() {
    if (!selectedWorkspace || !selectedAgent || !message.trim()) return;
    await ensureHuman(selectedWorkspace.workspace_id);
    await api(busUrl, "/v1/events/emit", {
      method: "POST", body: {
        type: "message", workspace_id: selectedWorkspace.workspace_id,
        source_endpoint_id: humanEndpoint,
        destination: { kind: "endpoint", endpoint_id: selectedAgent.endpoint_id },
        thread_id: threadId, correlation_id: null,
        content: { text: message.trim(), data: {} },
        response: { expected: false },
        metadata: { submitted_by: "floe-web" }
      }
    });
    setMessage("");
    await refresh();
  }

  const pill = selectedAgent ? statusPill(selectedAgent.status) : null;
  const connDot = status === "Connected" ? "dot-green" : status === "Offline" ? "dot-red" : "dot-amber";

  /* ── Render ── */
  return (
    <main className={`app-shell${showRightSidebar ? "" : " right-collapsed"}`}>
      {/* ══ LEFT SIDEBAR ══ */}
      <aside className="left-sidebar">
        <div className="sidebar-header">
          <div className="brand-mark"><Zap size={16} /></div>
          <div className="brand-text">
            <h1>FLOE</h1>
            <div className="conn-status">
              <span className={`dot ${connDot}`} />
              {status}
            </div>
          </div>
        </div>

        <div className="sidebar-section">
          <h3>Projects</h3>
        </div>

        <div className="workspace-list">
          {workspaces.map((ws) => (
            <div key={ws.workspace_id} style={{ display: "flex", alignItems: "center", gap: "2px" }}>
              <button
                className={`ws-item${ws.workspace_id === selectedWorkspaceId ? " active" : ""}`}
                onClick={() => void selectWorkspace(ws.workspace_id)}
              >
                <span className="ws-name">{ws.name}</span>
                <span className={`dot ${ws.status === "attached" ? "dot-green" : "dot-gray"}`} />
              </button>
              <button
                onClick={() => void deleteWorkspace(ws)}
                title={`Remove ${ws.name}`}
                style={{ border: "none", background: "transparent", padding: "4px", minHeight: "auto", color: "var(--text-muted)", cursor: "pointer" }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {workspaces.length === 0 && (
            <div style={{ color: "var(--text-muted)", fontSize: "12px", padding: "8px" }}>No projects yet</div>
          )}
        </div>

        <div className="add-workspace">
          <input
            value={candidate}
            onChange={(e) => setCandidate(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void registerWorkspace(); }}
            placeholder="Add project folder..."
          />
          <button onClick={() => void registerWorkspace()} title="Add workspace">
            <FolderPlus size={14} />
          </button>
        </div>

        {showBusUrl && (
          <div className="bus-url-bar">
            <input value={busUrl} onChange={(e) => setBusUrl(e.target.value)} placeholder="Bus URL" />
            <button onClick={() => void refresh()} title="Reconnect"><RefreshCw size={12} /></button>
          </div>
        )}

        <div className="sidebar-footer" onClick={() => setShowBusUrl(!showBusUrl)} style={{ cursor: "pointer" }}>
          <span className={`dot ${connDot}`} />
          Pi Bridge (local) · {status}
          <Settings size={10} style={{ marginLeft: "auto" }} />
        </div>
      </aside>

      {/* ══ CENTER: CHAT ══ */}
      <section className="chat-center">
        {error && <div className="error-bar">{error}</div>}

        <div className="chat-header">
          <div className="agent-avatar"><Bot size={18} /></div>
          <div className="agent-header-info">
            <h2>{selectedAgent?.name ?? "Floe"}</h2>
            <div className="agent-subtitle">
              {pill && <span className={`status-pill ${pill.cls}`}><span className={`dot dot-${pill.cls === "idle" ? "green" : pill.cls === "active" ? "amber" : pill.cls === "error" ? "red" : "gray"}`} />{pill.label}</span>}
              {effectiveModel && <span>· {effectiveModel}</span>}
              {effectiveProfile && <span>· {effectiveProfile.provider}</span>}
            </div>
          </div>
          <div className="chat-header-actions">
            <button onClick={() => void refresh()} title="Refresh"><RefreshCw size={15} /></button>
            <button onClick={() => setShowRightSidebar(!showRightSidebar)} title="Toggle panel">
              {showRightSidebar ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
            </button>
          </div>
        </div>

        <div className="chat-timeline">
          {chatMessages.length === 0 && Object.keys(streamingTurns).length === 0 && (
            <div className="chat-empty">
              <div className="empty-icon"><MessageCircle size={22} /></div>
              <h3>{selectedAgent ? `Chat with ${selectedAgent.name}` : "Select a project"}</h3>
              <p>
                {!selectedAgent
                  ? "Add a project folder to get started."
                  : !runtimeReady
                    ? "Configure a runtime profile and model in the right panel to begin."
                    : "Send a message to start the conversation."}
              </p>
            </div>
          )}

          {chatMessages.map((event) => {
            const isHuman = event.source_endpoint_id === humanEndpoint;
            return (
              <div key={event.event_id} className={`msg ${isHuman ? "human" : "agent"}`}>
                <div className="msg-avatar">
                  {isHuman ? <UserRound size={14} /> : <Bot size={14} />}
                </div>
                <div className="msg-body">
                  <div className="msg-meta">
                    <span className="msg-sender">{isHuman ? "You" : (selectedAgent?.name ?? "Agent")}</span>
                    <time>{new Date(event.created_at).toLocaleTimeString()}</time>
                  </div>
                  <div className="msg-content">
                    {isHuman ? event.content?.text : renderMarkdown(event.content?.text ?? "")}
                  </div>
                </div>
              </div>
            );
          })}

          {Object.entries(streamingTurns).map(([turnId, { text }]) => (
            <div key={turnId} className="msg agent streaming">
              <div className="msg-avatar"><Bot size={14} /></div>
              <div className="msg-body">
                <div className="msg-meta">
                  <span className="msg-sender">{selectedAgent?.name ?? "Agent"}</span>
                </div>
                <div className="msg-content">{renderMarkdown(text)}</div>
              </div>
            </div>
          ))}

          {agentError && (
            <div className="error-card">
              <AlertTriangle size={16} />
              <span>Runtime: <strong>{agentError.kind}</strong></span>
            </div>
          )}

          {selectedAgent?.status === "runtime_unconfigured" && chatMessages.length > 0 && (
            <div className="warning-card">
              <AlertTriangle size={16} />
              <span>Agent runtime is unconfigured. Select a profile and model.</span>
            </div>
          )}

          <div ref={chatEndRef} />
        </div>

        <div className="composer">
          <input
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
            placeholder={
              !selectedAgent ? "Select a project first"
              : !effectiveProfileId ? "Select a runtime profile →"
              : !effectiveModel ? "Select a model →"
              : `Message ${selectedAgent.name}...`
            }
            disabled={!selectedAgent || !runtimeReady}
          />
          <button
            className="send-btn"
            onClick={() => void sendMessage()}
            disabled={!selectedAgent || !runtimeReady || !message.trim()}
            title="Send"
          >
            <Send size={16} />
          </button>
        </div>
      </section>

      {/* ══ RIGHT SIDEBAR ══ */}
      {showRightSidebar && (
        <aside className="right-sidebar">
          {/* About this agent */}
          <div className="right-section">
            <h3>About This Agent</h3>
            <div className="detail-row"><span className="label">Name</span><span className="value">{selectedAgent?.name ?? "—"}</span></div>
            <div className="detail-row"><span className="label">Status</span><span className="value">{pill ? <span className={`status-pill ${pill.cls}`}><span className={`dot dot-${pill.cls === "idle" ? "green" : pill.cls === "active" ? "amber" : pill.cls === "error" ? "red" : "gray"}`} />{pill.label}</span> : "—"}</span></div>
            <div className="detail-row"><span className="label">Adapter</span><span className="value">{agentMeta?.runtime_adapter ?? "—"}</span></div>
            <div className="detail-row"><span className="label">Provider</span><span className="value">{effectiveProfile?.provider ?? "—"}</span></div>
            <div className="detail-row"><span className="label">Model</span><span className="value">{effectiveModel ?? "—"}</span></div>
            <div className="detail-row"><span className="label">Auth Profile</span><span className="value">{effectiveProfileId ?? "—"}</span></div>
          </div>

          {/* Runtime configuration */}
          <div className="right-section">
            <h3>Runtime Configuration</h3>
            {authProfiles.length === 0 ? (
              <div className="warning-card" style={{ fontSize: "12px" }}>
                <AlertTriangle size={14} />
                <span>No auth profiles found. Run <code>npm run floe -- login</code></span>
              </div>
            ) : (
              <>
                <div className="config-field">
                  <label>Workspace Profile</label>
                  <select
                    value={workspaceBinding?.auth_profile ?? ""}
                    onChange={(e) => void setWorkspaceProfile(e.target.value)}
                    disabled={!selectedWorkspace}
                  >
                    <option value="">Unconfigured</option>
                    {authProfiles.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.provider})</option>)}
                  </select>
                </div>
                <div className="config-field">
                  <label>Model {availableModels.length > 0 && `(${availableModels.length})`}</label>
                  <select
                    value={workspaceBinding?.model ?? ""}
                    onChange={(e) => void setWorkspaceModel(e.target.value)}
                    disabled={!workspaceBinding?.auth_profile || availableModels.length === 0}
                  >
                    <option value="">Select model…</option>
                    {availableModels.map((m) => <option key={m.id} value={m.id}>{m.name}{m.reasoning ? " ✦" : ""}</option>)}
                  </select>
                </div>
                <div className="config-field">
                  <label>Agent Override ({selectedAgent?.name ?? "—"})</label>
                  <select
                    value={agentBinding?.auth_profile ?? ""}
                    onChange={(e) => void setAgentProfile(e.target.value)}
                    disabled={!selectedWorkspace || !selectedAgent}
                  >
                    <option value="">Use workspace default</option>
                    {authProfiles.map((p) => <option key={p.id} value={p.id}>{p.id} ({p.provider})</option>)}
                  </select>
                </div>
                {agentBinding?.auth_profile && (
                  <div className="config-field">
                    <label>Agent Model</label>
                    <select
                      value={agentBinding?.model ?? ""}
                      onChange={(e) => void setAgentModel(e.target.value)}
                      disabled={availableModels.length === 0}
                    >
                      <option value="">Inherit workspace</option>
                      {availableModels.map((m) => <option key={m.id} value={m.id}>{m.name}{m.reasoning ? " ✦" : ""}</option>)}
                    </select>
                  </div>
                )}
                {!runtimeReady && effectiveProfileId && (
                  <div className="warning-card" style={{ fontSize: "12px", marginTop: "4px" }}>
                    <AlertTriangle size={14} />
                    <span>Select a model to enable messaging.</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Config drift recovery */}
          {selectedWorkspace?.status === "config_drift" && (
            <div className="right-section">
              <div className="warning-card">
                <AlertTriangle size={14} />
                <span>Config drift detected</span>
                <button onClick={() => void importSnapshot()} style={{ marginTop: "4px", fontSize: "11px" }}>Import Snapshot</button>
              </div>
            </div>
          )}

          {/* Debug trace */}
          <button className="debug-toggle" onClick={() => setShowDebug(!showDebug)}>
            {showDebug ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Debug Trace ({debugEntries.length})
          </button>
          {showDebug && (
            <div className="debug-content">
              {debugEntries.length === 0 && <div style={{ color: "var(--text-muted)", padding: "8px" }}>No telemetry</div>}
              {debugEntries.map((entry) => (
                <div key={entry.id} className={`debug-event${entry.isError ? " error" : ""}`}>
                  <div className="de-header">
                    <span className="de-kind">{entry.kind}</span>
                    <time>{entry.time}</time>
                  </div>
                  {entry.summary && <div className="de-body">{entry.summary}</div>}
                </div>
              ))}
            </div>
          )}
        </aside>
      )}
    </main>
  );
}

/* ── Helpers ── */
async function api<T>(baseUrl: string, path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!r.ok) throw new Error(`${options.method ?? "GET"} ${path}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

function humanEndpointId(wsId: string): string {
  return `endpoint:${wsId}:user:operator`;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
