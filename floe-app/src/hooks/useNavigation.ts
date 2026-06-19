import { useState, useCallback } from "react";

export type NavView = "home" | "activity";

export type NavigationState = {
  view: NavView;
  selectedScopeId: string | null;
  selectedActorId: string | null;
  selectedContextId: string | null;
  selectedContextLabel: string | null;
  showWorkspaceSettings: boolean;
  showNewActor: boolean;
};

export function useNavigation() {
  const [state, setState] = useState<NavigationState>({
    view: "home",
    selectedScopeId: null,
    selectedActorId: null,
    selectedContextId: null,
    selectedContextLabel: null,
    showWorkspaceSettings: false,
    showNewActor: false,
  });

  const navigateToHome = useCallback(() => {
    setState({
      view: "home",
      selectedScopeId: null,
      selectedActorId: null,
      selectedContextId: null,
      selectedContextLabel: null,
      showWorkspaceSettings: false,
      showNewActor: false,
    });
  }, []);

  const navigateToActivity = useCallback(() => {
    setState({
      view: "activity",
      selectedScopeId: null,
      selectedActorId: null,
      selectedContextId: null,
      selectedContextLabel: null,
      showWorkspaceSettings: false,
      showNewActor: false,
    });
  }, []);

  const navigateToScope = useCallback((scopeId: string | null) => {
    setState({
      view: "home",
      selectedScopeId: scopeId || null,
      selectedActorId: null,
      selectedContextId: null,
      selectedContextLabel: null,
      showWorkspaceSettings: false,
      showNewActor: false,
    });
  }, []);

  const navigateToActor = useCallback((actorId: string | null) => {
    setState({
      view: "home",
      selectedScopeId: null,
      selectedActorId: actorId || null,
      selectedContextId: null,
      selectedContextLabel: null,
      showWorkspaceSettings: false,
      showNewActor: false,
    });
  }, []);

  const navigateToContext = useCallback((contextId: string | null, scopeId: string | null = null, actorId: string | null = null) => {
    setState({
      view: "home",
      selectedScopeId: scopeId,
      selectedActorId: actorId,
      selectedContextId: contextId,
      selectedContextLabel: null,
      showWorkspaceSettings: false,
      showNewActor: false,
    });
  }, []);

  const navigateToWorkspaceSettings = useCallback(() => {
    setState({
      view: "home",
      selectedScopeId: null,
      selectedActorId: null,
      selectedContextId: null,
      selectedContextLabel: null,
      showWorkspaceSettings: true,
      showNewActor: false,
    });
  }, []);

  const navigateToNewActor = useCallback(() => {
    setState({
      view: "home",
      selectedScopeId: null,
      selectedActorId: null,
      selectedContextId: null,
      selectedContextLabel: null,
      showWorkspaceSettings: false,
      showNewActor: true,
    });
  }, []);

  const setContextLabel = useCallback((label: string | null) => {
    setState(prev => ({ ...prev, selectedContextLabel: label }));
  }, []);

  const clearActorSelection = useCallback(() => {
    setState(prev => ({ ...prev, selectedActorId: null }));
  }, []);

  const clearScopeSelection = useCallback(() => {
    setState(prev => ({ ...prev, selectedScopeId: null }));
  }, []);

  const clearContextSelection = useCallback(() => {
    setState(prev => ({ ...prev, selectedContextId: null }));
  }, []);

  const clearNewActor = useCallback(() => {
    setState(prev => ({ ...prev, showNewActor: false }));
  }, []);

  return {
    ...state,
    navigateToHome,
    navigateToActivity,
    navigateToScope,
    navigateToActor,
    navigateToContext,
    navigateToWorkspaceSettings,
    navigateToNewActor,
    setContextLabel,
    clearActorSelection,
    clearScopeSelection,
    clearContextSelection,
    clearNewActor,
  };
}
