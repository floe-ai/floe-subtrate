/**
 * App — neutral visual layer over the substrate.
 *
 * All actors are uniform endpoints. No special-casing Floe or the operator.
 * "Acting as" selector sets the source of every action from ALL endpoints.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRef, EndpointRef, ScopeRef } from "./bus-client/types.ts";
import {
  listWorkspaces,
  listEndpoints,
  listScopes,
  createScope,
} from "./bus-client/client.ts";
import { colors, space, font } from "./theme.ts";
import { Briefing } from "./briefing/Briefing.tsx";
import { Field } from "./field/Field.tsx";
import { Timeline } from "./timeline/Timeline.tsx";
import { ContextsList } from "./context/ContextsList.tsx";
import { ContextView } from "./context/ContextView.tsx";
import { ActorsDirectory } from "./actors/ActorsDirectory.tsx";
import { RecordList } from "./inspect/RecordList.tsx";
import {
  listDeliveries,
  listPendingResponses,
  listRuntimeTelemetry,
  getRuntimeBindings,
  listConfigs,
  listPulses,
} from "./bus-client/client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActiveView =
  | "contexts"
  | "actors"
  | "scopes"
  | "pulses"
  | "events"
  | "briefing"
  | "deliveries"
  | "pending"
  | "telemetry"
  | "bindings"
  | "configs"
  | "webhooks";

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------

const selectStyle: React.CSSProperties = {
  background: colors.surface,
  color: colors.text,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: font.meta,
  cursor: "pointer",
  fontFamily: "system-ui, sans-serif",
};

// ---------------------------------------------------------------------------
// Loading / empty states
// ---------------------------------------------------------------------------

function LoadingShell(): React.ReactElement {
  return (
    <div
      data-testid="app-loading"
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: colors.canvas,
        color: colors.muted,
        font: font.body,
      }}
    >
      Loading…
    </div>
  );
}

function EmptyState({ message }: { message: string }): React.ReactElement {
  return (
    <div
      data-testid="app-empty"
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: colors.canvas,
        color: colors.muted,
        font: font.body,
      }}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav item
// ---------------------------------------------------------------------------

type NavGroup = {
  label: string;
  items: { id: ActiveView; label: string }[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "WORK",
    items: [
      { id: "contexts", label: "Contexts" },
      { id: "actors",   label: "Actors" },
      { id: "scopes",   label: "Scopes" },
      { id: "pulses",   label: "Pulses" },
      { id: "events",   label: "Events" },
    ],
  },
  {
    label: "LENS",
    items: [{ id: "briefing", label: "Briefing" }],
  },
  {
    label: "INSPECT",
    items: [
      { id: "deliveries", label: "Deliveries" },
      { id: "pending",    label: "Pending" },
      { id: "telemetry",  label: "Telemetry" },
      { id: "bindings",   label: "Bindings" },
      { id: "configs",    label: "Configs" },
      { id: "webhooks",   label: "Webhooks" },
    ],
  },
];

function NavButton({
  id,
  label,
  isActive,
  onClick,
}: {
  id: ActiveView;
  label: string;
  isActive: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button
      data-view={id}
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      style={{
        display: "block",
        width: "100%",
        padding: `${space.sm}px ${space.lg}px`,
        textAlign: "left",
        background: isActive ? colors.accent : "transparent",
        border: "none",
        borderLeft: isActive
          ? `3px solid ${colors.accentText}`
          : "3px solid transparent",
        color: isActive ? colors.accentText : colors.text,
        cursor: "pointer",
        fontWeight: isActive ? font.h : 400,
        fontSize: 14,
        fontFamily: "system-ui, sans-serif",
        transition: "background 0.1s",
      }}
      onFocus={(e) => {
        (e.currentTarget as HTMLButtonElement).style.outline = `2px solid ${colors.accent}`;
        (e.currentTarget as HTMLButtonElement).style.outlineOffset = "-2px";
      }}
      onBlur={(e) => {
        (e.currentTarget as HTMLButtonElement).style.outline = "none";
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Scopes view (inline — no separate file needed)
// ---------------------------------------------------------------------------

function ScopesView({
  workspaceId,
  scopes,
  onRefresh,
  onOpenContext,
}: {
  workspaceId: string;
  scopes: ScopeRef[];
  onRefresh: () => void;
  onOpenContext: (id: string) => void;
}): React.ReactElement {
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(
    scopes[0]?.scope_id ?? null
  );
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);

  async function handleCreate() {
    const title = newTitle.trim();
    if (!title) return;
    setCreating(true);
    setCreateErr(null);
    try {
      await createScope(workspaceId, { title });
      setNewTitle("");
      onRefresh();
    } catch (err) {
      setCreateErr(err instanceof Error ? err.message : "Failed to create scope");
    } finally {
      setCreating(false);
    }
  }

  if (scopes.length === 0) {
    return (
      <div style={{ padding: space.xl, font: font.body, color: colors.text }}>
        <h2 style={{ fontSize: 16, fontWeight: font.h, marginBottom: space.md }}>Scopes</h2>
        <p style={{ color: colors.muted, marginBottom: space.lg }}>
          Scopes are optional organizing boundaries. Direct work can live in Contexts without a scope.
        </p>
        <div style={{ display: "flex", gap: space.sm, alignItems: "center" }}>
          <input
            aria-label="New scope title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Scope title"
            style={{
              ...selectStyle,
              padding: "4px 8px",
              fontSize: 14,
              minWidth: 200,
            }}
          />
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !newTitle.trim()}
            style={{
              background: colors.accent,
              color: colors.accentText,
              border: "none",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {creating ? "Creating…" : "Create scope"}
          </button>
        </div>
        {createErr && (
          <p role="alert" style={{ color: colors.danger, marginTop: space.sm }}>
            {createErr}
          </p>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={{ padding: `${space.md}px ${space.lg}px`, borderBottom: `1px solid ${colors.border}`, display: "flex", gap: space.md, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="scope-select" style={{ fontSize: font.meta, color: colors.muted }}>
          Scope
        </label>
        <select
          id="scope-select"
          style={selectStyle}
          value={selectedScopeId ?? ""}
          onChange={(e) => setSelectedScopeId(e.target.value)}
          aria-label="Select scope"
        >
          {scopes.map((s) => (
            <option key={s.scope_id} value={s.scope_id}>
              {s.title || s.scope_id}
            </option>
          ))}
        </select>
        <div style={{ marginLeft: "auto", display: "flex", gap: space.sm, alignItems: "center" }}>
          <input
            aria-label="New scope title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New scope title"
            style={{ ...selectStyle, padding: "4px 8px", fontSize: 14, minWidth: 160 }}
          />
          <button
            onClick={() => void handleCreate()}
            disabled={creating || !newTitle.trim()}
            style={{
              background: colors.accent,
              color: colors.accentText,
              border: "none",
              borderRadius: 4,
              padding: "4px 12px",
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            {creating ? "Creating…" : "Create scope"}
          </button>
        </div>
      </div>
      {createErr && (
        <p role="alert" style={{ color: colors.danger, padding: `0 ${space.lg}px`, marginTop: space.sm }}>
          {createErr}
        </p>
      )}
      {selectedScopeId ? (
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Field
            workspaceId={workspaceId}
            scopeId={selectedScopeId}
            onOpenContext={onOpenContext}
          />
        </div>
      ) : (
        <p style={{ padding: space.lg, color: colors.muted }}>Select a scope above.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  // Identity
  const [loading, setLoading] = useState(true);
  const [noWorkspaces, setNoWorkspaces] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRef | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRef[]>([]);
  const [actingAsEndpointId, setActingAsEndpointId] = useState<string>("");
  const [scopes, setScopes] = useState<ScopeRef[]>([]);

  // Navigation
  const [activeView, setActiveView] = useState<ActiveView>("contexts");
  const [selectedContextId, setSelectedContextId] = useState<string | null>(null);

  // Notifications cleanup
  const notifUnsubRef = useRef<(() => void) | null>(null);

  // ---------------------------------------------------------------------------
  // Identity resolution on mount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function resolve() {
      try {
        const wss = await listWorkspaces();
        if (cancelled) return;
        if (wss.length === 0) {
          setNoWorkspaces(true);
          setLoading(false);
          return;
        }
        const active = wss.find((w) => w.selected_at !== null) ?? wss[0]!;
        const [eps, scs] = await Promise.all([
          listEndpoints(active.workspace_id),
          listScopes(active.workspace_id),
        ]);
        if (cancelled) return;
        setWorkspaces(wss);
        setActiveWorkspace(active);
        setEndpoints(eps);
        setActingAsEndpointId(eps[0]?.endpoint_id ?? "");
        setScopes(scs);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    void resolve();
    return () => { cancelled = true; };
  }, []);

  // Notifications
  useEffect(() => {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.workspace_id;
    let cleanup: (() => void) | null = null;
    import("./shell/notifications.ts")
      .then(({ requestNotificationPermission, startDecisionNotifications }) => {
        void requestNotificationPermission();
        cleanup = startDecisionNotifications({ workspaceId });
        notifUnsubRef.current = cleanup;
      })
      .catch(() => { /* degrade silently */ });
    return () => {
      if (cleanup) cleanup();
      if (notifUnsubRef.current) { notifUnsubRef.current(); notifUnsubRef.current = null; }
    };
  }, [activeWorkspace?.workspace_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Workspace switch
  // ---------------------------------------------------------------------------
  const handleWorkspaceChange = useCallback(
    async (wsId: string) => {
      const ws = workspaces.find((w) => w.workspace_id === wsId);
      if (!ws || ws.workspace_id === activeWorkspace?.workspace_id) return;
      setActiveWorkspace(ws);
      setEndpoints([]);
      setActingAsEndpointId("");
      setScopes([]);
      setSelectedContextId(null);
      setActiveView("contexts");
      try {
        const [eps, scs] = await Promise.all([
          listEndpoints(ws.workspace_id),
          listScopes(ws.workspace_id),
        ]);
        setEndpoints(eps);
        setActingAsEndpointId(eps[0]?.endpoint_id ?? "");
        setScopes(scs);
      } catch { /* best-effort */ }
    },
    [workspaces, activeWorkspace]
  );

  // Refresh scopes (e.g., after creating one)
  const refreshScopes = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      const scs = await listScopes(activeWorkspace.workspace_id);
      setScopes(scs);
    } catch { /* best-effort */ }
  }, [activeWorkspace]);

  // Open context
  const handleOpenContext = useCallback((contextId: string) => {
    setSelectedContextId(contextId);
    setActiveView("contexts");
  }, []);

  // ---------------------------------------------------------------------------
  // Guard states
  // ---------------------------------------------------------------------------
  if (loading) return <LoadingShell />;
  if (noWorkspaces)
    return <EmptyState message="No workspaces found. Create a workspace to get started." />;
  if (loadError)
    return <EmptyState message={`Failed to load: ${loadError}`} />;
  if (!activeWorkspace) return <LoadingShell />;

  const workspaceId = activeWorkspace.workspace_id;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div
      data-testid="app"
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gridTemplateRows: "48px 1fr",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        background: colors.canvas,
        color: colors.text,
      }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Top bar                                                             */}
      {/* ------------------------------------------------------------------ */}
      <header
        data-section="topbar"
        style={{
          gridColumn: "1 / -1",
          gridRow: "1",
          display: "flex",
          alignItems: "center",
          padding: `0 ${space.lg}px`,
          gap: space.md,
          borderBottom: `1px solid ${colors.border}`,
          background: colors.surface,
        }}
      >
        <span style={{ fontWeight: font.h, letterSpacing: "-0.01em", fontSize: 15 }}>
          Floe
        </span>

        {/* Workspace selector */}
        <div data-section="workspace-selector">
          <label
            htmlFor="workspace-select"
            style={{ fontSize: font.meta, color: colors.muted, marginRight: 6 }}
          >
            Workspace
          </label>
          <select
            id="workspace-select"
            style={selectStyle}
            value={workspaceId}
            onChange={(e) => void handleWorkspaceChange(e.target.value)}
            aria-label="Select workspace"
          >
            {workspaces.map((ws) => (
              <option key={ws.workspace_id} value={ws.workspace_id}>
                {ws.name || ws.workspace_id}
              </option>
            ))}
          </select>
        </div>

        {/* Acting as — ALL endpoints, uniform */}
        {endpoints.length > 0 && (
          <div data-section="acting-as-selector">
            <label
              htmlFor="acting-as-select"
              style={{ fontSize: font.meta, color: colors.muted, marginRight: 6 }}
            >
              Acting as
            </label>
            <select
              id="acting-as-select"
              style={selectStyle}
              value={actingAsEndpointId}
              onChange={(e) => setActingAsEndpointId(e.target.value)}
              aria-label="Select acting-as endpoint"
            >
              {endpoints.map((ep) => (
                <option key={ep.endpoint_id} value={ep.endpoint_id}>
                  {ep.name || ep.endpoint_id}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Left nav — three groups: WORK / LENS / INSPECT                     */}
      {/* ------------------------------------------------------------------ */}
      <nav
        data-section="nav"
        aria-label="App navigation"
        style={{
          gridColumn: "1",
          gridRow: "2",
          display: "flex",
          flexDirection: "column",
          padding: `${space.md}px 0`,
          gap: 0,
          borderRight: `1px solid ${colors.border}`,
          background: colors.surface,
          overflowY: "auto",
        }}
      >
        {NAV_GROUPS.map((group) => (
          <div key={group.label} style={{ marginBottom: space.sm }}>
            <div
              style={{
                padding: `${space.xs}px ${space.lg}px`,
                fontSize: 10,
                fontWeight: font.h,
                color: colors.muted,
                letterSpacing: "0.08em",
              }}
            >
              {group.label}
            </div>
            {group.items.map(({ id, label }) => (
              <NavButton
                key={id}
                id={id}
                label={label}
                isActive={activeView === id}
                onClick={() => {
                  setActiveView(id);
                  if (id !== "contexts") setSelectedContextId(null);
                }}
              />
            ))}
          </div>
        ))}
      </nav>

      {/* ------------------------------------------------------------------ */}
      {/* Main content                                                        */}
      {/* ------------------------------------------------------------------ */}
      <main
        data-section="main"
        style={{
          gridColumn: "2",
          gridRow: "2",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          background: colors.canvas,
        }}
      >
        {/* Contexts — list or view */}
        {activeView === "contexts" && (
          selectedContextId ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
              <div style={{ padding: `${space.sm}px ${space.lg}px`, borderBottom: `1px solid ${colors.border}`, background: colors.surface }}>
                <button
                  onClick={() => setSelectedContextId(null)}
                  style={{
                    background: "none",
                    border: "none",
                    color: colors.accent,
                    cursor: "pointer",
                    fontSize: 13,
                    padding: 0,
                  }}
                  aria-label="Back to contexts list"
                >
                  ← All contexts
                </button>
              </div>
              <div style={{ flex: 1, overflow: "auto" }}>
                <ContextView
                  contextId={selectedContextId}
                  actingAsEndpointId={actingAsEndpointId}
                  endpoints={endpoints}
                />
              </div>
            </div>
          ) : (
            <ContextsList
              workspaceId={workspaceId}
              onOpen={(id) => setSelectedContextId(id)}
            />
          )
        )}

        {/* Actors */}
        {activeView === "actors" && (
          <ActorsDirectory
            workspaceId={workspaceId}
            onOpenContext={handleOpenContext}
          />
        )}

        {/* Scopes */}
        {activeView === "scopes" && (
          <ScopesView
            workspaceId={workspaceId}
            scopes={scopes}
            onRefresh={() => void refreshScopes()}
            onOpenContext={handleOpenContext}
          />
        )}

        {/* Pulses */}
        {activeView === "pulses" && (
          <RecordList
            title="Pulses"
            load={() =>
              listPulses(workspaceId).then((rows) =>
                rows.map((r) => ({
                  pulse_id: r.pulse_id,
                  status: r.status,
                  next_fire_at: r.next_fire_at ?? "",
                  fire_count: r.fire_count,
                }))
              )
            }
            columns={["pulse_id", "status", "next_fire_at", "fire_count"]}
          />
        )}

        {/* Events */}
        {activeView === "events" && (
          <div style={{ flex: 1, overflow: "auto", padding: space.lg }}>
            <Timeline workspaceId={workspaceId} />
          </div>
        )}

        {/* Briefing */}
        {activeView === "briefing" && (
          <div style={{ flex: 1, overflow: "auto" }}>
            <Briefing
              workspaceId={workspaceId}
              operatorEndpointId={actingAsEndpointId || undefined}
            />
          </div>
        )}

        {/* Deliveries */}
        {activeView === "deliveries" && (
          <RecordList
            title="Deliveries"
            load={() =>
              listDeliveries({ workspace_id: workspaceId }).then((rows) =>
                rows.map((r) => ({
                  delivery_id: r.delivery_id,
                  endpoint_id: r.endpoint_id,
                  state: r.state,
                  attempt_count: r.attempt_count,
                  created_at: r.created_at,
                }))
              )
            }
          />
        )}

        {/* Pending responses */}
        {activeView === "pending" && (
          <RecordList
            title="Pending Responses"
            load={() =>
              listPendingResponses(workspaceId).then((rows) =>
                rows.map((r) => ({
                  pending_id: r.pending_id,
                  waiting_endpoint_id: r.waiting_endpoint_id,
                  mode: r.mode,
                  status: r.status,
                  created_at: r.created_at,
                  resolved_at: r.resolved_at ?? "",
                }))
              )
            }
          />
        )}

        {/* Telemetry */}
        {activeView === "telemetry" && (
          <RecordList
            title="Runtime Telemetry"
            load={() =>
              listRuntimeTelemetry({ workspace_id: workspaceId }).then((rows) =>
                rows.map((r) => ({
                  telemetry_id: r.telemetry_id,
                  endpoint_id: r.endpoint_id,
                  kind: r.kind,
                  delivery_id: r.delivery_id ?? "",
                  created_at: r.created_at,
                }))
              )
            }
          />
        )}

        {/* Bindings */}
        {activeView === "bindings" && (
          <RecordList
            title="Runtime Bindings"
            load={() =>
              getRuntimeBindings(workspaceId).then((rows) =>
                rows.map((r) => ({
                  binding_key: r.binding_key,
                  scope: r.scope,
                  auth_profile: r.auth_profile,
                  model: r.model ?? "",
                  thinking_level: r.thinking_level ?? "",
                }))
              )
            }
          />
        )}

        {/* Configs */}
        {activeView === "configs" && (
          <RecordList
            title="Saved Configs"
            load={() =>
              listConfigs().then((rows) =>
                rows.map((r) => ({
                  config_id: r.config_id,
                  name: r.name,
                  created_at: r.created_at,
                  updated_at: r.updated_at,
                }))
              )
            }
          />
        )}

        {/* Webhooks — no list endpoint */}
        {activeView === "webhooks" && (
          <div style={{ padding: space.xl, font: font.body, color: colors.text }}>
            <h2 style={{ fontSize: 16, fontWeight: font.h, marginBottom: space.md }}>Webhooks</h2>
            <p style={{ color: colors.muted }}>
              Webhooks are ingest-only endpoints — they accept payloads via{" "}
              <code>POST /v1/webhooks/:workspace_id/:route_id</code> and do not have
              a list view. Use your external service's delivery log to inspect
              webhook traffic.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
