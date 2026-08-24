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
import type { WorkspaceRef, ScopeRef, EndpointRef, AuthProfileRecord } from "./bus-client/types.ts";
import {
  listWorkspaces,
  listScopes,
  createScope,
  listEndpoints,
  subscribeEvents,
  registerWorkspace,
  registerEndpoint,
  deleteWorkspace,
  getAuthProfiles,
  upsertRuntimeBinding,
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
import { FloeHome } from "./features/home/FloeHome.tsx";
import {
  findOperatorEndpoint,
  OperatorConversations,
} from "./features/conversations/OperatorConversations.tsx";
import { OnboardingFlow } from "./features/onboarding/OnboardingFlow.tsx";
import { ActorView } from "./features/actor/ActorView.tsx";
import { SubstrateSettingsView } from "./features/substrate/SubstrateSettingsView.tsx";
import { useNavigation } from "./hooks/useNavigation.ts";
import { WorkspaceSwitcher } from "./workspace/WorkspaceSwitcher.tsx";
import { ScopeInspectorEmpty, DefaultInspector, useInspectorResize, readRinspWidth } from "./scope/ScopeInspector.tsx";
import { tk } from "./theme.ts";
import { getModelProviders, type ModelProviderStatus } from "./providers/modelProviders.ts";
import { isTauri } from "./fs/workspaceFs.ts";

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

async function listEndpointsForNewWorkspace(workspaceId: string): Promise<EndpointRef[]> {
  const endpoints = await listEndpoints(workspaceId).catch(() => [] as EndpointRef[]);
  if (endpoints.some(endpoint => endpoint.agent_id === "operator" || endpoint.endpoint_id.endsWith(":operator"))) {
    return endpoints;
  }

  const operator = await registerEndpoint({
    endpoint_id: `actor:${workspaceId}:operator`,
    workspace_id: workspaceId,
    name: "Operator",
    agent_id: "operator",
    bridge_id: null,
    status: "idle",
  });
  return [operator, ...endpoints];
}

// ---------------------------------------------------------------------------
// Main App Component
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<"loading" | "onboarding" | "error" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRef | null>(null);
  const [scopes, setScopes] = useState<ScopeRef[]>([]);
  const [actors, setActors] = useState<EndpointRef[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfileRecord[]>([]);
  const [modelProviders, setModelProviders] = useState<ModelProviderStatus[] | null>(null);

  const nav = useNavigation();
  const operatorEndpoint = findOperatorEndpoint(actors);

  const [inspWidth, setInspWidth] = useState<number>(readRinspWidth);
  const [addWsErr, setAddWsErr] = useState<string | null>(null);

  // Notification cleanup ref
  const notifUnsubRef = useRef<(() => void) | null>(null);

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    async function waitForSubstrate(): Promise<{ workspaces: WorkspaceRef[]; profiles: AuthProfileRecord[] }> {
      let lastError: unknown;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 800);
        try {
          const [wss, auth] = await Promise.all([
            listWorkspaces(controller.signal),
            getAuthProfiles(controller.signal),
          ]);
          return { workspaces: wss, profiles: auth.profiles };
        } catch (error) {
          lastError = error;
        } finally {
          window.clearTimeout(timeout);
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(150 + attempt * 50, 500)));
      }
      const detail = lastError instanceof Error && lastError.name !== "AbortError"
        ? ` (${lastError.message})`
        : "";
      throw new Error(
        `Floe's local services did not respond. A previous local service may be stuck; close Floe and try again${detail}`,
      );
    }

    async function boot() {
      try {
        const providersPromise = isTauri()
          ? getModelProviders().catch(() => null)
          : Promise.resolve(null);
        const substrate = await waitForSubstrate();
        const wss = substrate.workspaces;
        const usableProfiles = substrate.profiles.filter(profile => profile.provider !== "openai-codex-app-server");
        if (cancelled) return;
        setWorkspaces(wss);
        setAuthProfiles(usableProfiles);
        void providersPromise.then(providers => { if (!cancelled) setModelProviders(providers); });
        if (wss.length === 0 || usableProfiles.length === 0) {
          if (wss.length > 0) setActiveWorkspace(wss.find(w => w.selected_at !== null) ?? wss[0]!);
          setAppState("onboarding");
          return;
        }
        const active = wss.find(w => w.selected_at !== null) ?? wss[0]!;
        const [scs, eps] = await Promise.all([
          listScopes(active.workspace_id),
          listEndpoints(active.workspace_id).catch(() => [] as EndpointRef[]),
        ]);
        if (cancelled) return;
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
    nav.navigateToFloe();
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
        listEndpointsForNewWorkspace(ws.workspace_id),
      ]);
      setActiveWorkspace(ws);
      setScopes(scs);
      setActors(eps);
      nav.navigateToFloe();
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
        setAppState("onboarding");
        setActiveWorkspace(null);
      } else {
        const next = refreshed[0]!;
        setActiveWorkspace(next);
        setScopes([]);
        setActors([]);
        nav.navigateToFloe();
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
    }, {
      // Subscribe first, then take a fresh snapshot. This closes the startup
      // race where the bridge registered Floe between the onboarding snapshot
      // and the live stream becoming ready.
      onOpen: () => { void refreshActors(); },
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
        <FullPageCenter>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, textAlign: "center" }}>
            <span style={{ color: tk.ink2 }}>Starting Floe…</span>
            <span style={{ color: tk.ink3, fontSize: 12 }}>Starting the local substrate and checking its health.</span>
          </div>
        </FullPageCenter>
      </>
    );
  }

  if (appState === "error") {
    return (
      <>
        <GlobalStyles />
        <FullPageCenter>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, maxWidth: 420, textAlign: "center" }}>
            <span style={{ color: tk.ink, fontSize: 16 }}>Floe could not start its local services</span>
            <span style={{ color: tk.ink3 }}>{loadError}</span>
            <button onClick={() => window.location.reload()} style={{ background: tk.accent, color: "#0c1714", border: "none", borderRadius: tk.r2, padding: "7px 14px" }}>Try starting again</button>
          </div>
        </FullPageCenter>
      </>
    );
  }

  if (appState === "onboarding") {
    const existingProfile = authProfiles[0];
    return (
      <>
        <GlobalStyles />
        <OnboardingFlow
          workspaces={workspaces}
          hasProvider={authProfiles.length > 0}
          existingProfileId={existingProfile?.id}
          existingModel={existingProfile?.model}
          modelProviders={modelProviders}
          onReady={async ({ workspace, profileId, model }) => {
            await upsertRuntimeBinding({
              scope: "workspace_default",
              workspace_id: workspace.workspace_id,
              auth_profile: profileId,
              model: model || null,
              thinking_level: model ? "high" : null,
            });
            const [refreshed, scs, eps, auth] = await Promise.all([
              listWorkspaces(),
              listScopes(workspace.workspace_id),
              listEndpointsForNewWorkspace(workspace.workspace_id),
              getAuthProfiles(),
            ]);
            setWorkspaces(refreshed);
            setAuthProfiles(auth.profiles.filter(profile => profile.provider !== "openai-codex-app-server"));
            setActiveWorkspace(refreshed.find(item => item.workspace_id === workspace.workspace_id) ?? workspace);
            setScopes(scs);
            setActors(eps);
            nav.navigateToFloe();
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
            onClick={e => { e.preventDefault(); nav.navigateToFloe(); }}
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
            title="Settings"
            aria-label="Settings"
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
              if (v === "floe") nav.navigateToFloe();
              if (v === "conversations") nav.navigateToConversations();
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
                operatorEntry={nav.view === "conversations" && operatorEndpoint ? {
                  speakingAsEndpointId: operatorEndpoint.endpoint_id,
                  showContextIdentity: true,
                  onOpenSettings: handleOpenWorkspaceSettings,
                } : undefined}
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
            ) : nav.view === "floe" ? (
              <FloeHome
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                onOpenSettings={handleOpenWorkspaceSettings}
              />
            ) : nav.view === "conversations" ? (
              <OperatorConversations
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                onOpenContext={nav.navigateToOperatorContext}
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
          {nav.appMode !== "system" && nav.view !== "floe" && nav.view !== "conversations" && (!nav.selectedActorId || nav.selectedContextId) && (
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
