/**
 * App — v6 shell: topbar + 240px left nav + resizable right inspector.
 *
 * App.tsx acts as a thin orchestrator layer connecting views, layout, and state.
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { WorkspaceRef, ScopeRef, EndpointRef } from "./bus-client/types.ts";
import {
  listWorkspaces,
  listScopes,
  createScope,
  listEndpoints,
  subscribeEvents,
  registerWorkspace,
  deleteWorkspace,
  DirectoryNotFoundError,
} from "./bus-client/client.ts";
import { ScopeDetail } from "./scope/ScopeDetail.tsx";
import { ContextConversation } from "./scope/ContextConversation.tsx";
import { ContextInspector } from "./scope/ContextInspector.tsx";
import { NewActorForm } from "./actors/NewActorForm.tsx";
import { WorkspaceSettings } from "./workspace/WorkspaceSettings.tsx";
import { Activity } from "./activity/Activity.tsx";

import { LeftNav } from "./app/layout/LeftNav.tsx";
import { HomeView } from "./features/home/HomeView.tsx";
import { ActorView } from "./features/actor/ActorView.tsx";
import { SubstrateSettingsView } from "./features/substrate/SubstrateSettingsView.tsx";
import { useNavigation } from "./hooks/useNavigation.ts";
import { WorkspaceSwitcher, RegisterWorkspaceScreen } from "./workspace/WorkspaceSwitcher.tsx";
import { ScopeInspectorEmpty, DefaultInspector, useInspectorResize, readRinspWidth } from "./scope/ScopeInspector.tsx";
import { tk } from "./theme.ts";

// ---------------------------------------------------------------------------
// Global style injection (scrollbars, html/body reset, focus ring)
// ---------------------------------------------------------------------------

function GlobalStyles(): React.ReactElement {
  useEffect(() => {
    const id = "floe-global";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
      html, body, #root {
        height: 100%; background: ${tk.canvas}; color: ${tk.ink};
        font-family: ${tk.fontUi}; font-size: 13px; line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        color-scheme: dark;
      }
      * { scrollbar-color: rgba(255,255,255,0.10) transparent; scrollbar-width: thin; }
      *::-webkit-scrollbar { width: 8px; height: 8px; }
      *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
      button { font-family: inherit; cursor: pointer; }
      input, select {
        font-family: inherit;
        color-scheme: dark;
        background-color: ${tk.surfaceHov};
        color: ${tk.ink};
      }
      select option {
        background-color: ${tk.surfaceHov};
        color: ${tk.ink};
      }
    `;
    document.head.appendChild(style);
  }, []);
  return <></>;
}

function FullPageCenter({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100vh", background: tk.canvas, color: tk.ink3,
      fontFamily: tk.fontUi, fontSize: 13,
    }}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App Component
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<"loading" | "no-workspaces" | "error" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRef | null>(null);
  const [scopes, setScopes] = useState<ScopeRef[]>([]);
  const [actors, setActors] = useState<EndpointRef[]>([]);

  const nav = useNavigation();

  const [inspWidth, setInspWidth] = useState<number>(readRinspWidth);
  const [addWsErr, setAddWsErr] = useState<string | null>(null);

  // Notification cleanup ref
  const notifUnsubRef = useRef<(() => void) | null>(null);

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const wss = await listWorkspaces();
        if (cancelled) return;
        if (wss.length === 0) { setAppState("no-workspaces"); return; }
        const active = wss.find(w => w.selected_at !== null) ?? wss[0]!;
        const [scs, eps] = await Promise.all([
          listScopes(active.workspace_id),
          listEndpoints(active.workspace_id).catch(() => [] as EndpointRef[]),
        ]);
        if (cancelled) return;
        setWorkspaces(wss);
        setActiveWorkspace(active);
        setScopes(scs);
        setActors(eps);
        setAppState("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        setAppState("error");
      }
    }
    void boot();
    return () => { cancelled = true; };
  }, []);

  // Notification subscription
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
  // Handlers
  // ---------------------------------------------------------------------------
  const switchWorkspace = useCallback(async (wsId: string) => {
    const ws = workspaces.find(w => w.workspace_id === wsId);
    if (!ws || ws.workspace_id === activeWorkspace?.workspace_id) return;
    nav.navigateToHome();
    setScopes([]);
    setActors([]);
    setActiveWorkspace(ws);
    try {
      const [scs, eps] = await Promise.all([
        listScopes(ws.workspace_id),
        listEndpoints(ws.workspace_id).catch(() => [] as EndpointRef[]),
      ]);
      setScopes(scs);
      setActors(eps);
    } catch { /* best-effort */ }
  }, [workspaces, activeWorkspace, nav]);

  const addWorkspace = useCallback(async (locator: string, name: string, create_directory?: boolean) => {
    setAddWsErr(null);
    try {
      const ws = await registerWorkspace({ locator, name: name || undefined, init_authorized: true, create_directory });
      const refreshed = await listWorkspaces();
      setWorkspaces(refreshed);
      const [scs, eps] = await Promise.all([
        listScopes(ws.workspace_id),
        listEndpoints(ws.workspace_id).catch(() => [] as EndpointRef[]),
      ]);
      setActiveWorkspace(ws);
      setScopes(scs);
      setActors(eps);
      nav.navigateToHome();
      setAppState("ready");
    } catch (err) {
      if (err instanceof DirectoryNotFoundError && !create_directory) {
        if (window.confirm(`Directory does not exist: ${locator}\nWould you like to create it?`)) {
          return addWorkspace(locator, name, true);
        } else {
          setAddWsErr(err.message);
          throw err;
        }
      }
      const msg = err instanceof Error ? err.message : "Failed to register workspace";
      setAddWsErr(msg);
      throw new Error(msg);
    }
  }, [nav]);

  const removeWorkspace = useCallback(async (deleteLocator?: boolean) => {
    if (!activeWorkspace) return;
    const name = activeWorkspace.name || activeWorkspace.workspace_id;
    if (deleteLocator) {
      if (!window.confirm(`Permanently delete workspace "${name}" and all its project files from disk? This cannot be undone.`)) return;
    } else {
      if (!window.confirm(`Remove workspace "${name}" from Floe? The files will remain on disk.`)) return;
    }
    try {
      await deleteWorkspace(activeWorkspace.workspace_id, { delete_locator: !!deleteLocator });
      const refreshed = await listWorkspaces();
      setWorkspaces(refreshed);
      if (refreshed.length === 0) {
        setAppState("no-workspaces");
        setActiveWorkspace(null);
      } else {
        const next = refreshed[0]!;
        setActiveWorkspace(next);
        setScopes([]);
        setActors([]);
        nav.navigateToHome();
        const [scs, eps] = await Promise.all([
          listScopes(next.workspace_id),
          listEndpoints(next.workspace_id).catch(() => [] as EndpointRef[]),
        ]);
        setScopes(scs);
        setActors(eps);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to remove workspace");
    }
  }, [activeWorkspace, nav]);

  const refreshScopes = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      const scs = await listScopes(activeWorkspace.workspace_id);
      setScopes(scs);
    } catch { /* best-effort */ }
  }, [activeWorkspace]);

  const refreshActors = useCallback(async () => {
    if (!activeWorkspace) return;
    try {
      const eps = await listEndpoints(activeWorkspace.workspace_id);
      setActors(eps);
    } catch { /* best-effort */ }
  }, [activeWorkspace]);

  const handleScopeCreated = useCallback(async (title: string, description: string) => {
    if (!activeWorkspace) return;
    const scope = await createScope(activeWorkspace.workspace_id, { title, description: description || null });
    await refreshScopes();
    nav.navigateToScope(scope.scope_id);
  }, [activeWorkspace, refreshScopes, nav]);

  const handleScopeDeleted = useCallback(async () => {
    nav.navigateToHome();
    await refreshScopes();
  }, [refreshScopes, nav]);

  const handleSelectScope = useCallback((id: string) => {
    if (id) {
      nav.navigateToScope(id);
    } else {
      // Clear selections but DO NOT reset general navigation view (like activity) to home!
      nav.clearScopeSelection();
      nav.clearContextSelection();
    }
  }, [nav]);

  const handleSelectContext = useCallback((id: string | null) => {
    nav.navigateToContext(id, nav.selectedScopeId);
  }, [nav]);

  const handleContextDeleted = useCallback(() => {
    nav.navigateToContext(null, nav.selectedScopeId);
  }, [nav]);

  const handleOpenContext = useCallback((id: string) => {
    nav.navigateToContext(id, null);
  }, [nav]);

  const handleSelectActor = useCallback((id: string) => {
    nav.navigateToActor(id);
  }, [nav]);

  const handleOpenWorkspaceSettings = useCallback(() => {
    nav.navigateToWorkspaceSettings();
  }, [nav]);

  const handleOpenNewActor = useCallback(() => {
    nav.navigateToNewActor();
  }, [nav]);

  const handleActorCreated = useCallback(() => {
    nav.clearNewActor();
    void refreshActors();
  }, [refreshActors, nav]);

  const handleActorSaved = useCallback((updated: EndpointRef) => {
    setActors(prev => prev.map(a => a.endpoint_id === updated.endpoint_id ? updated : a));
    void refreshActors();
  }, [refreshActors]);

  const handleActorDeleted = useCallback((endpointId: string) => {
    setActors(prev => prev.filter(a => a.endpoint_id !== endpointId));
    if (nav.selectedActorId === endpointId) {
      nav.clearActorSelection();
    }
    void refreshActors();
  }, [refreshActors, nav]);

  const inspResizeRef = useInspectorResize(setInspWidth);

  // Auto-refresh actors when registered by bridge
  useEffect(() => {
    if (!activeWorkspace) return;
    const workspaceId = activeWorkspace.workspace_id;
    const unsub = subscribeEvents((msg) => {
      if (msg.type === "endpoint_registered" || msg.type === "endpoint_updated" || msg.type === "endpoint_deleted") {
        const epWsId = (msg.payload?.endpoint as any)?.workspace_id;
        if (msg.payload?.workspace_id === workspaceId || epWsId === workspaceId) {
          void refreshActors();
        }
      }
    });
    return unsub;
  }, [activeWorkspace?.workspace_id, refreshActors]);

  // ---------------------------------------------------------------------------
  // Guard states
  // ---------------------------------------------------------------------------
  if (appState === "loading") {
    return (
      <>
        <GlobalStyles />
        <FullPageCenter><span>Loading…</span></FullPageCenter>
      </>
    );
  }

  if (appState === "error") {
    return (
      <>
        <GlobalStyles />
        <FullPageCenter>
          <span style={{ color: tk.danger }}>Failed to load: {loadError}</span>
        </FullPageCenter>
      </>
    );
  }

  if (appState === "no-workspaces") {
    return (
      <>
        <GlobalStyles />
        <RegisterWorkspaceScreen
          onRegistered={ws => {
            setWorkspaces([ws]);
            setActiveWorkspace(ws);
            setScopes([]);
            setAppState("ready");
          }}
        />
      </>
    );
  }

  if (!activeWorkspace) return <></>;

  const selectedScope = scopes.find(s => s.scope_id === nav.selectedScopeId) ?? null;

  // ---------------------------------------------------------------------------
  // Render shell
  // ---------------------------------------------------------------------------
  return (
    <>
      <GlobalStyles />
      <div
        data-testid="app"
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          background: tk.canvas,
          color: tk.ink,
          fontFamily: tk.fontUi,
          overflow: "hidden",
        }}
      >
        {/* ---------------------------------------------------------------- */}
        {/* Topbar                                                           */}
        {/* ---------------------------------------------------------------- */}
        <header style={{
          flex: "0 0 auto",
          display: "flex", alignItems: "center", gap: 10,
          padding: "0 16px",
          height: 52,
          background: "rgba(15,16,17,0.9)",
          backdropFilter: "saturate(160%) blur(10px)",
          borderBottom: `1px solid ${tk.border}`,
          zIndex: 10,
        }}>
          {/* Brand */}
          <a href="#" style={{ display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none", color: tk.ink2 }}
            onClick={e => { e.preventDefault(); nav.navigateToHome(); }}
          >
            <span style={{
              width: 22, height: 22, borderRadius: 6,
              background: tk.accent, color: "#0c1714",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 590,
            }}>F</span>
            <span style={{ fontWeight: 510, fontSize: 13 }}>Floe</span>
          </a>

          {/* Sep + workspace switcher */}
          <span style={{ color: tk.ink4, fontSize: 12 }}>/</span>
          <WorkspaceSwitcher
            workspaces={workspaces}
            active={activeWorkspace}
            onSwitch={id => void switchWorkspace(id)}
            onAdd={addWorkspace}
            addErr={addWsErr}
          />

          {/* Settings affordance */}
          <button
            onClick={handleOpenWorkspaceSettings}
            title="Workspace settings"
            aria-label="Workspace settings"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              width: 26, height: 26, borderRadius: tk.r2,
              background: nav.showWorkspaceSettings ? "rgba(255,255,255,0.06)" : "transparent",
              border: `1px solid ${nav.showWorkspaceSettings ? tk.border : "transparent"}`,
              color: nav.showWorkspaceSettings ? tk.accent : tk.ink3,
              fontSize: 14, cursor: "pointer",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
            onMouseLeave={e => { if (!nav.showWorkspaceSettings) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
          >
            ⚙
          </button>

          {/* Breadcrumb for selected scope */}
          {selectedScope && (
            <>
              <span style={{ color: tk.ink4, fontSize: 12 }}>/</span>
              <span style={{ color: tk.ink, fontSize: 13, fontWeight: 510, padding: "3px 6px", borderRadius: 4 }}>
                {selectedScope.title || selectedScope.scope_id}
              </span>
            </>
          )}

          {/* Breadcrumb for selected context (within a scope) */}
          {selectedScope && nav.selectedContextId && nav.selectedContextLabel && (
            <>
              <span style={{ color: tk.ink4, fontSize: 12 }}>/</span>
              <span style={{
                color: tk.ink2, fontSize: 13, fontWeight: 510, padding: "3px 6px", borderRadius: 4,
                maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {nav.selectedContextLabel}
              </span>
            </>
          )}
        </header>

        {/* ---------------------------------------------------------------- */}
        {/* Body: left nav + main + inspector                                */}
        {/* ---------------------------------------------------------------- */}
        <div style={{
          flex: "1 1 auto",
          display: "flex",
          flexDirection: "row",
          minHeight: 0,
          overflow: "hidden",
        }}>
          {/* Left nav */}
          <LeftNav
            view={nav.view}
            scopes={scopes}
            selectedScopeId={nav.selectedScopeId}
            actors={actors}
            selectedActorId={nav.selectedActorId}
            onView={(v) => {
              if (v === "home") nav.navigateToHome();
              if (v === "activity") nav.navigateToActivity();
            }}
            onSelectScope={handleSelectScope}
            onSelectActor={handleSelectActor}
            onNewScope={() => {
              nav.navigateToHome();
            }}
            onNewActor={handleOpenNewActor}
            showNewActor={nav.showNewActor}
            appMode={nav.appMode}
            onViewSystem={nav.navigateToSystem}
          />

          {/* Main column */}
          <main style={{
            flex: "1 1 auto",
            minWidth: 0,
            height: "100%",
            overflow: "auto",
            background: tk.canvas,
            display: "flex",
            flexDirection: "column",
          }}>
            {nav.appMode === "system" ? (
              <SubstrateSettingsView />
            ) : nav.showWorkspaceSettings ? (
              <WorkspaceSettings workspace={activeWorkspace} onRemove={removeWorkspace} />
            ) : nav.showNewActor ? (
              <NewActorForm
                workspaceId={activeWorkspace.workspace_id}
                workspace={activeWorkspace}
                existingAgentIds={actors.map(a => a.agent_id).filter((id): id is string => !!id)}
                onCreated={handleActorCreated}
              />
            ) : nav.selectedContextId ? (
              // Conversation is scope-independent: it can be reached from a scope's
              // context list, an actor's "Contexts" list (Gap A — may be in a
              // different scope or no scope at all), or the Direct list (Gap B).
              <ContextConversation
                key={nav.selectedContextId}
                contextId={nav.selectedContextId}
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                onLabelResolved={nav.setContextLabel}
              />
            ) : nav.selectedActorId ? (
              <ActorView
                actor={actors.find(a => a.endpoint_id === nav.selectedActorId)!}
                workspaceId={activeWorkspace.workspace_id}
                workspace={activeWorkspace}
                onSaved={handleActorSaved}
                onDeleted={handleActorDeleted}
                onOpenContext={(id) => nav.navigateToContext(id, null, nav.selectedActorId)}
                endpoints={actors}
              />
            ) : nav.view === "home" && selectedScope ? (
              <ScopeDetail
                scope={selectedScope}
                workspaceId={activeWorkspace.workspace_id}
                selectedContextId={nav.selectedContextId}
                onSelectContext={handleSelectContext}
                onScopeDeleted={() => void handleScopeDeleted()}
              />
            ) : nav.view === "home" && !nav.selectedActorId ? (
              <HomeView
                workspaceId={activeWorkspace.workspace_id}
                scopes={scopes}
                selectedScopeId={nav.selectedScopeId}
                onSelectScope={id => handleSelectScope(id || "")}
                onScopeCreated={handleScopeCreated}
              />
            ) : nav.view === "activity" ? (
              <Activity
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                scopes={scopes}
              />
            ) : null}
          </main>

          {/* Right inspector */}
          {nav.appMode !== "system" && (!nav.selectedActorId || nav.selectedContextId) && (
            <aside style={{
              flex: `0 0 ${inspWidth}px`,
              width: inspWidth,
              height: "100%",
              position: "relative",
              background: tk.surface,
              borderLeft: `1px solid ${tk.border}`,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}>
              {/* Resize handle */}
              <div
                ref={inspResizeRef}
                style={{
                  position: "absolute", left: -3, top: 0, bottom: 0, width: 6,
                  cursor: "col-resize", zIndex: 10, background: "transparent",
                }}
                title="Drag to resize"
              />
              {/* Inspector body */}
              <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: (nav.selectedContextId || nav.selectedActorId) ? 0 : "18px 16px 24px" }}>
                {nav.selectedContextId ? (
                  <ContextInspector
                    contextId={nav.selectedContextId}
                    scope={selectedScope}
                    workspaceId={activeWorkspace.workspace_id}
                    onDeleted={handleContextDeleted}
                  />
                ) : selectedScope ? (
                  <ScopeInspectorEmpty scope={selectedScope} />
                ) : (
                  <DefaultInspector workspace={activeWorkspace} />
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </>
  );
}
