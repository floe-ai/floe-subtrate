import React, { useEffect, useMemo, useState } from "react";
import type { AuthModelRecord, AuthProfileRecord } from "../bus-client/types.ts";
import {
  clearRuntimeBindings,
  getAuthProfiles,
  getRuntimeBindings,
  upsertRuntimeBinding,
} from "../bus-client/client.ts";
import { modelsForProfile, providerForProfile, withSelectedModelOption } from "../actors/modelsForProfile.ts";
import { tk } from "../theme.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type Selection = { profileId: string; modelId: string; effort: string };

export function profileDisplayName(profile: AuthProfileRecord): string {
  if (profile.label) return profile.label;
  if (profile.provider === "openai-codex-app-server") return "ChatGPT";
  return profile.provider;
}

export function FloeModelControl({
  workspaceId,
  onReadyChange,
  onOpenSettings,
}: {
  workspaceId: string;
  onReadyChange: (ready: boolean) => void;
  onOpenSettings?: () => void;
}): React.ReactElement {
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [models, setModels] = useState<AuthModelRecord[]>([]);
  const [profileId, setProfileId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("off");
  const [loaded, setLoaded] = useState(false);
  const [modelsLoadedFor, setModelsLoadedFor] = useState<string | null>(null);
  const [savedSelection, setSavedSelection] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setModelsLoadedFor(null);
    setSavedSelection(null);
    setError(null);
    onReadyChange(false);

    Promise.all([getAuthProfiles(), getRuntimeBindings(workspaceId)])
      .then(([auth, bindings]) => {
        if (cancelled) return;
        const binding = bindings.find(item => item.scope === "workspace_default" && item.workspace_id === workspaceId) ?? null;
        const selection = {
          profileId: binding?.auth_profile ?? "",
          modelId: binding?.model ?? "",
          effort: binding?.thinking_level ?? "off",
        };
        setProfiles(auth.profiles);
        setProfileId(selection.profileId);
        setModelId(selection.modelId);
        setEffort(selection.effort);
        setSavedSelection(selection);
        setLoaded(true);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not read the workspace model");
        setLoaded(true);
      });

    return () => { cancelled = true; };
  }, [workspaceId, onReadyChange]);

  useEffect(() => {
    if (!profileId) {
      setModels([]);
      setModelsLoadedFor("");
      return;
    }
    let cancelled = false;
    setModelsLoadedFor(null);
    modelsForProfile(profiles, profileId)
      .then(next => {
        if (cancelled) return;
        setModels(next);
        setModelsLoadedFor(profileId);
      })
      .catch(err => {
        if (cancelled) return;
        setModels([]);
        setModelsLoadedFor(profileId);
        setError(err instanceof Error ? err.message : "Could not load models");
      });
    return () => { cancelled = true; };
  }, [profiles, profileId]);

  const provider = providerForProfile(profiles, profileId || null);
  const modelOptions = useMemo(
    () => withSelectedModelOption(models, modelId, provider),
    [models, modelId, provider],
  );
  const selectedModel = modelOptions.find(model => model.id === modelId);
  const reasoningSupported = selectedModel?.reasoning === true;
  const persisted = savedSelection?.profileId === profileId
    && savedSelection?.modelId === modelId
    && savedSelection?.effort === effort;
  const ready = loaded
    && !saving
    && persisted
    && profiles.some(profile => profile.id === profileId)
    && Boolean(modelId)
    && modelsLoadedFor === profileId;

  useEffect(() => onReadyChange(ready), [ready, onReadyChange]);

  async function save(next: Selection) {
    setSaving(true);
    setSavedSelection(null);
    setError(null);
    try {
      if (!next.profileId) {
        await clearRuntimeBindings({ scope: "workspace_default", workspace_id: workspaceId });
      } else {
        await upsertRuntimeBinding({
          scope: "workspace_default",
          workspace_id: workspaceId,
          auth_profile: next.profileId,
          model: next.modelId || null,
          thinking_level: next.modelId ? next.effort : null,
        });
      }
      setSavedSelection(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the workspace model");
    } finally {
      setSaving(false);
    }
  }

  function changeProfile(nextProfileId: string) {
    const next = { profileId: nextProfileId, modelId: "", effort: "off" };
    setProfileId(next.profileId);
    setModelId(next.modelId);
    setEffort(next.effort);
    void save(next);
  }

  function changeModel(nextModelId: string) {
    const model = modelOptions.find(option => option.id === nextModelId);
    const nextEffort = model?.reasoning ? effort : "off";
    const next = { profileId, modelId: nextModelId, effort: nextEffort };
    setModelId(next.modelId);
    setEffort(next.effort);
    void save(next);
  }

  function changeEffort(nextEffort: string) {
    const next = { profileId, modelId, effort: nextEffort };
    setEffort(next.effort);
    void save(next);
  }

  if (loaded && profiles.length === 0) {
    return (
      <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, color: tk.ink3, fontSize: 12.5 }}>
        <span>Connect a model provider before talking to Floe.</span>
        {onOpenSettings && <button type="button" onClick={onOpenSettings} style={linkButtonStyle}>Open settings</button>}
      </div>
    );
  }

  return (
    <div aria-label="Workspace model selection" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <select
        aria-label="Floe provider"
        value={profileId}
        onChange={event => changeProfile(event.target.value)}
        disabled={!loaded || saving}
        style={selectStyle}
      >
        <option value="">Provider</option>
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profileDisplayName(profile)}</option>)}
      </select>
      <select
        aria-label="Floe model"
        value={modelId}
        onChange={event => changeModel(event.target.value)}
        disabled={!loaded || saving || !profileId || modelsLoadedFor !== profileId}
        style={selectStyle}
      >
        <option value="">{profileId && modelsLoadedFor !== profileId ? "Loading models…" : "Model"}</option>
        {modelOptions.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
      <select
        aria-label="Floe effort"
        value={effort}
        onChange={event => changeEffort(event.target.value)}
        disabled={!loaded || saving || !modelId || !reasoningSupported}
        style={selectStyle}
      >
        {THINKING_LEVELS.map(level => <option key={level} value={level}>{level === "off" ? "No effort" : `${level} effort`}</option>)}
      </select>
      <span style={{ color: error ? tk.danger : ready ? tk.accent : tk.ink4, fontSize: 11.5 }} role={error ? "alert" : "status"}>
        {error ?? (saving ? "Saving…" : ready ? "Ready" : loaded ? "Choose a provider and model" : "Loading model…")}
      </span>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${tk.border}`,
  borderRadius: tk.r2,
  padding: "6px 9px",
  color: tk.ink,
  fontSize: 12,
  outline: "none",
  minWidth: 116,
};

const linkButtonStyle: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: tk.accent,
  fontSize: 12.5,
  padding: 0,
  textDecoration: "underline",
};
