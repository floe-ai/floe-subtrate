/**
 * App — shell page with lens routing and live component wiring.
 *
 * Identity resolution: on mount, picks the active workspace (selected_at
 * non-null, else first) and the operator endpoint (first endpoint, switchable
 * via dropdown). All lens components receive real props from resolved identity.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceRef, EndpointRef, ScopeRef } from "./bus-client/types.ts";
import { listWorkspaces, listEndpoints, listScopes } from "./bus-client/client.ts";
import { Briefing } from "./briefing/Briefing.tsx";
import { Field } from "./field/Field.tsx";
import { ContextView } from "./context/ContextView.tsx";
import { Timeline } from "./timeline/Timeline.tsx";
import { FloeCommand } from "./floe/FloeCommand.tsx";
import { FeedbackAffordance } from "./feedback/FeedbackAffordance.tsx";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Lens = "briefing" | "field" | "context" | "timeline";

export type AppState = {
  workspace: WorkspaceRef | null;
  activeLens: Lens;
  selectedContextId: string | null;
  selectedEventId: string | null;
  selectedScopeId: string | null;
};

// ---------------------------------------------------------------------------
// Styles (shared constants)
// ---------------------------------------------------------------------------

const COLOR = {
  bg: "#0f0f0f",
  surface: "#111",
  border: "#222",
  text: "#e0e0e0",
  muted: "#888",
  active: "#4f8ef7",
  activeText: "#fff",
  focus: "#4f8ef7",
} as const;

const selectStyle: React.CSSProperties = {
  background: "#1a1a1a",
  color: COLOR.text,
  border: `1px solid ${COLOR.border}`,
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: "0.875rem",
  cursor: "pointer",
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
        background: COLOR.bg,
        color: COLOR.muted,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      Loading Floe…
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
        background: COLOR.bg,
        color: COLOR.muted,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav item
// ---------------------------------------------------------------------------

const NAV_LENSES: { id: Lens; label: string }[] = [
  { id: "briefing", label: "Briefing" },
  { id: "field", label: "Field" },
  { id: "context", label: "Context" },
  { id: "timeline", label: "Timeline" },
];

// ---------------------------------------------------------------------------
// Scope selector (for the Field lens)
// ---------------------------------------------------------------------------

function ScopeSelector({
  scopes,
  activeScopeId,
  onSelect,
}: {
  scopes: ScopeRef[];
  activeScopeId: string | null;
  onSelect: (id: string) => void;
}): React.ReactElement {
  if (scopes.length === 0) {
    return (
      <p style={{ color: COLOR.muted, padding: "12px 16px" }}>
        No scopes in this workspace.
      </p>
    );
  }
  return (
    <div style={{ padding: "8px 16px", borderBottom: `1px solid ${COLOR.border}` }}>
      <label
        htmlFor="scope-selector"
        style={{ fontSize: "0.75rem", color: COLOR.muted, marginRight: 8 }}
      >
        Scope
      </label>
      <select
        id="scope-selector"
        style={selectStyle}
        value={activeScopeId ?? ""}
        onChange={(e) => onSelect(e.target.value)}
        aria-label="Select scope"
      >
        {scopes.map((s) => (
          <option key={s.scope_id} value={s.scope_id}>
            {s.title || s.scope_id}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  // --- Identity state ---
  const [loading, setLoading] = useState(true);
  const [noWorkspaces, setNoWorkspaces] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRef | null>(null);
  const [endpoints, setEndpoints] = useState<EndpointRef[]>([]);
  const [operatorEndpointId, setOperatorEndpointId] = useState<string>("");
  const [scopes, setScopes] = useState<ScopeRef[]>([]);

  // --- App navigation state ---
  const [activeLens, setActiveLens] = useState<Lens>("briefing");
  const [selectedContextId, setSelectedContextId] = useState<string | null>(null);
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null);

  // --- Notifications cleanup ref ---
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
        setOperatorEndpointId(eps[0]?.endpoint_id ?? "");
        setScopes(scs);
        // Default selected scope to first scope
        setSelectedScopeId(scs[0]?.scope_id ?? null);
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    }
    void resolve();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Notifications — start once we have a workspace; clean up on unmount
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.workspace_id;

    // Dynamic import to avoid crashing in test environments
    let cleanup: (() => void) | null = null;

    import("./shell/notifications.ts")
      .then(({ requestNotificationPermission, startDecisionNotifications }) => {
        void requestNotificationPermission();
        cleanup = startDecisionNotifications({ workspaceId });
        notifUnsubRef.current = cleanup;
      })
      .catch(() => {
        // Degrade silently — notifications are not critical
      });

    return () => {
      if (cleanup) cleanup();
      if (notifUnsubRef.current) {
        notifUnsubRef.current();
        notifUnsubRef.current = null;
      }
    };
  }, [activeWorkspace?.workspace_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Workspace switch
  // ---------------------------------------------------------------------------
  const handleWorkspaceChange = useCallback(
    async (workspaceId: string) => {
      const ws = workspaces.find((w) => w.workspace_id === workspaceId);
      if (!ws || ws.workspace_id === activeWorkspace?.workspace_id) return;

      setActiveWorkspace(ws);
      setEndpoints([]);
      setOperatorEndpointId("");
      setScopes([]);
      setSelectedScopeId(null);
      setSelectedContextId(null);
      setActiveLens("briefing");

      try {
        const [eps, scs] = await Promise.all([
          listEndpoints(ws.workspace_id),
          listScopes(ws.workspace_id),
        ]);
        setEndpoints(eps);
        setOperatorEndpointId(eps[0]?.endpoint_id ?? "");
        setScopes(scs);
        setSelectedScopeId(scs[0]?.scope_id ?? null);
      } catch {
        // best-effort; identity stays partially populated
      }
    },
    [workspaces, activeWorkspace]
  );

  // ---------------------------------------------------------------------------
  // Open context from Field / Briefing
  // ---------------------------------------------------------------------------
  const handleOpenContext = useCallback((contextId: string) => {
    setSelectedContextId(contextId);
    setActiveLens("context");
  }, []);

  // ---------------------------------------------------------------------------
  // Feedback target — derives from current selection
  // ---------------------------------------------------------------------------
  const feedbackTarget = (() => {
    if (activeLens === "context" && selectedContextId) {
      return { kind: "context", id: selectedContextId };
    }
    if (activeLens === "field" && selectedScopeId) {
      return { kind: "scope", id: selectedScopeId };
    }
    return { kind: "lens", id: activeLens };
  })();

  // ---------------------------------------------------------------------------
  // Guard states
  // ---------------------------------------------------------------------------
  if (loading) return <LoadingShell />;
  if (noWorkspaces)
    return <EmptyState message="No workspaces found. Create a workspace to get started." />;
  if (loadError)
    return <EmptyState message={`Failed to load: ${loadError}`} />;
  if (!activeWorkspace)
    return <LoadingShell />;

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
        gridTemplateRows: "48px 1fr 48px",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        background: COLOR.bg,
        color: COLOR.text,
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
          padding: "0 16px",
          gap: 12,
          borderBottom: `1px solid ${COLOR.border}`,
          background: COLOR.surface,
        }}
      >
        <span style={{ fontWeight: 700, letterSpacing: "-0.01em" }}>Floe</span>

        {/* Workspace selector */}
        <div data-section="workspace-selector">
          <label
            htmlFor="workspace-select"
            style={{ fontSize: "0.75rem", color: COLOR.muted, marginRight: 6 }}
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

        {/* Operator endpoint selector */}
        {endpoints.length > 0 && (
          <div data-section="endpoint-selector">
            <label
              htmlFor="endpoint-select"
              style={{ fontSize: "0.75rem", color: COLOR.muted, marginRight: 6 }}
            >
              As
            </label>
            <select
              id="endpoint-select"
              style={selectStyle}
              value={operatorEndpointId}
              onChange={(e) => setOperatorEndpointId(e.target.value)}
              aria-label="Select operator endpoint"
            >
              {endpoints.map((ep) => (
                <option key={ep.endpoint_id} value={ep.endpoint_id}>
                  {ep.name || ep.endpoint_id}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Persistent FloeCommand */}
        {operatorEndpointId && (
          <div data-section="floe-command" style={{ marginLeft: "auto", flex: "0 1 420px" }}>
            <FloeCommand
              workspaceId={workspaceId}
              sourceEndpointId={operatorEndpointId}
              contextId={selectedContextId}
              placeholder="Enter a command…"
            />
          </div>
        )}
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Left nav                                                            */}
      {/* ------------------------------------------------------------------ */}
      <nav
        data-section="nav"
        aria-label="Lens navigation"
        style={{
          gridColumn: "1",
          gridRow: "2",
          display: "flex",
          flexDirection: "column",
          padding: "12px 0",
          gap: 2,
          borderRight: `1px solid ${COLOR.border}`,
          background: COLOR.surface,
        }}
      >
        {NAV_LENSES.map(({ id, label }) => {
          const isActive = activeLens === id;
          return (
            <button
              key={id}
              data-lens={id}
              onClick={() => setActiveLens(id)}
              aria-current={isActive ? "page" : undefined}
              style={{
                padding: "8px 16px",
                textAlign: "left",
                background: isActive ? COLOR.active : "transparent",
                border: "none",
                borderLeft: isActive
                  ? `3px solid ${COLOR.activeText}`
                  : "3px solid transparent",
                color: isActive ? COLOR.activeText : COLOR.text,
                cursor: "pointer",
                fontWeight: isActive ? 600 : 400,
                fontSize: "0.9rem",
                outline: "none",
                transition: "background 0.12s",
              }}
              onFocus={(e) => {
                (e.currentTarget as HTMLButtonElement).style.outline = `2px solid ${COLOR.focus}`;
                (e.currentTarget as HTMLButtonElement).style.outlineOffset = "-2px";
              }}
              onBlur={(e) => {
                (e.currentTarget as HTMLButtonElement).style.outline = "none";
              }}
            >
              {label}
            </button>
          );
        })}
      </nav>

      {/* ------------------------------------------------------------------ */}
      {/* Main content area                                                   */}
      {/* ------------------------------------------------------------------ */}
      <main
        data-section="main"
        style={{
          gridColumn: "2",
          gridRow: "2",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Briefing */}
        {activeLens === "briefing" && (
          <div style={{ flex: 1, overflow: "auto" }}>
            <Briefing
              workspaceId={workspaceId}
              operatorEndpointId={operatorEndpointId || undefined}
            />
          </div>
        )}

        {/* Field — with scope selector header */}
        {activeLens === "field" && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <ScopeSelector
              scopes={scopes}
              activeScopeId={selectedScopeId}
              onSelect={setSelectedScopeId}
            />
            {selectedScopeId ? (
              <div style={{ flex: 1, overflow: "hidden" }}>
                <Field
                  workspaceId={workspaceId}
                  scopeId={selectedScopeId}
                  onOpenContext={handleOpenContext}
                />
              </div>
            ) : (
              <p style={{ padding: "24px 16px", color: COLOR.muted }}>
                No scopes available in this workspace.
              </p>
            )}
          </div>
        )}

        {/* Context */}
        {activeLens === "context" && (
          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            {selectedContextId && operatorEndpointId ? (
              <ContextView
                contextId={selectedContextId}
                sourceEndpointId={operatorEndpointId}
              />
            ) : (
              <p
                role="status"
                style={{ color: COLOR.muted, fontStyle: "italic" }}
              >
                No context selected. Open a context from the Field or Briefing.
              </p>
            )}
          </div>
        )}

        {/* Timeline */}
        {activeLens === "timeline" && (
          <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
            <Timeline workspaceId={workspaceId} />
          </div>
        )}
      </main>

      {/* ------------------------------------------------------------------ */}
      {/* Footer — FeedbackAffordance                                         */}
      {/* ------------------------------------------------------------------ */}
      <footer
        data-section="footer"
        style={{
          gridColumn: "1 / -1",
          gridRow: "3",
          display: "flex",
          alignItems: "center",
          padding: "0 16px",
          borderTop: `1px solid ${COLOR.border}`,
          background: COLOR.surface,
        }}
      >
        {operatorEndpointId && (
          <div data-section="feedback">
            <FeedbackAffordance
              workspaceId={workspaceId}
              sourceEndpointId={operatorEndpointId}
              target={feedbackTarget}
            />
          </div>
        )}
      </footer>
    </div>
  );
}
