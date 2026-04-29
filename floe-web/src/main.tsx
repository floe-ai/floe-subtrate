import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Bot,
  Check,
  FolderPlus,
  FileJson,
  PlugZap,
  RefreshCw,
  Save,
  Send,
  Terminal,
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
};

type EventEnvelope = {
  event_id: string;
  type: string;
  workspace_id: string;
  source_endpoint_id: string;
  destination_endpoint_id: string;
  thread_id: string;
  content: { text?: string; data?: unknown };
  created_at: string;
};

type SavedConfig = {
  config_id: string;
  name: string;
  config_json: string;
};

const defaultBusUrl = localStorage.getItem("floe.busUrl") ?? "http://127.0.0.1:5377";

function App() {
  const params = new URLSearchParams(window.location.search);
  const [busUrl, setBusUrl] = useState(defaultBusUrl);
  const [candidate, setCandidate] = useState(params.get("candidate") ?? params.get("workspace") ?? "");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
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

  const selectedWorkspace = workspaces.find((workspace) => workspace.workspace_id === selectedWorkspaceId) ?? workspaces[0];
  const agents = endpoints.filter((endpoint) => endpoint.actor_type === "agent");
  const humanEndpoint = selectedWorkspace ? humanEndpointId(selectedWorkspace.workspace_id) : "";
  const selectedAgent = agents[0];
  const threadId = selectedWorkspace ? `thread:${selectedWorkspace.workspace_id}:operator` : "";

  async function refresh() {
    try {
      setError(null);
      const workspaceResult = await api<{ workspaces: Workspace[] }>(busUrl, "/v1/workspaces");
      setWorkspaces(workspaceResult.workspaces);
      const configResult = await api<{ configs: SavedConfig[] }>(busUrl, "/v1/configs");
      setConfigs(configResult.configs);
      if (!selectedConfigId && configResult.configs[0]) setSelectedConfigId(configResult.configs[0].config_id);
      const preferred = selectedWorkspaceId || workspaceResult.workspaces[0]?.workspace_id || "";
      setSelectedWorkspaceId(preferred);
      if (preferred) {
        const endpointResult = await api<{ endpoints: Endpoint[] }>(busUrl, `/v1/workspaces/${encodeURIComponent(preferred)}/endpoints`);
        setEndpoints(endpointResult.endpoints);
        const eventResult = await api<{ events: EventEnvelope[] }>(busUrl, `/v1/events?workspace_id=${encodeURIComponent(preferred)}&limit=200`);
        setEvents(eventResult.events);
      } else {
        setEndpoints([]);
        setEvents([]);
      }
      setStatus("Connected");
    } catch (err) {
      setStatus("Offline");
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    localStorage.setItem("floe.busUrl", busUrl);
    void refresh();
    const socketUrl = busUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:").replace(/\/$/, "") + "/v1/events/stream";
    const socket = new WebSocket(socketUrl);
    socket.onmessage = () => void refresh();
    socket.onerror = () => setStatus("Socket retrying");
    const recoveryInterval = setInterval(() => void refresh(), 30_000);
    return () => {
      socket.close();
      clearInterval(recoveryInterval);
    };
  }, [busUrl, selectedWorkspaceId]);

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
    setSelectedWorkspaceId(result.workspace.workspace_id);
    await ensureHuman(result.workspace.workspace_id);
    await refresh();
  }

  async function selectWorkspace(workspaceId: string) {
    setSelectedWorkspaceId(workspaceId);
    await api(busUrl, `/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, { method: "POST" });
    await ensureHuman(workspaceId);
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

  async function sendMessage() {
    if (!selectedWorkspace || !selectedAgent || !message.trim()) return;
    await ensureHuman(selectedWorkspace.workspace_id);
    await api(busUrl, "/v1/events/emit", {
      method: "POST",
      body: {
        type: "message",
        workspace_id: selectedWorkspace.workspace_id,
        source_endpoint_id: humanEndpoint,
        destination_endpoint_id: selectedAgent.endpoint_id,
        thread_id: threadId,
        correlation_id: null,
        content: {
          text: message.trim(),
          data: {}
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

  const sortedEvents = useMemo(() => [...events].sort((a, b) => a.created_at.localeCompare(b.created_at)), [events]);

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
              <button
                key={workspace.workspace_id}
                className={workspace.workspace_id === selectedWorkspace?.workspace_id ? "workspace-item active" : "workspace-item"}
                onClick={() => void selectWorkspace(workspace.workspace_id)}
              >
                <strong>{workspace.name}</strong>
                <span>{workspace.status}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="thread-panel">
          <div className="panel-heading split">
            <div>
              <Activity size={17} />
              <h2>Event History</h2>
            </div>
            <span>{selectedWorkspace?.active_config_hash ?? "No config hash"}</span>
          </div>
          <div className="event-list">
            {sortedEvents.map((event) => (
              <article key={event.event_id} className={event.source_endpoint_id === humanEndpoint ? "event human" : "event agent"}>
                <div className="event-meta">
                  <span>{event.type}</span>
                  <time>{new Date(event.created_at).toLocaleTimeString()}</time>
                </div>
                <p>{event.content?.text ?? JSON.stringify(event.content)}</p>
              </article>
            ))}
            {sortedEvents.length === 0 && <div className="empty">No events yet.</div>}
          </div>
          <div className="composer">
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void sendMessage();
              }}
              placeholder={selectedAgent ? `Message ${selectedAgent.name}` : "Waiting for an agent endpoint"}
              disabled={!selectedAgent}
            />
            <button onClick={() => void sendMessage()} disabled={!selectedAgent || !message.trim()} title="Send">
              <Send size={18} />
            </button>
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
