/**
 * WorkspaceSettings — main-area view (Slice 3), reached via the gear/"Settings"
 * affordance next to the workspace switcher in the topbar.
 *
 * Replaces the old read-only workspace "bindings" popup. Contains the single
 * "New actors inherit: [profile] -> [model] -> [effort]" control — the
 * workspace_default runtime binding — with the same profile->model constraint
 * used by the actor inspector (see ../actors/modelsForProfile.ts).
 */
import React, { useCallback, useEffect, useState } from "react";
import type { AuthModelRecord, AuthProfileRecord, WorkspaceRef } from "../bus-client/types.ts";
import {
  getAuthProfiles,
  getRuntimeBindings,
  upsertRuntimeBinding,
  clearRuntimeBindings,
} from "../bus-client/client.ts";
import { modelsForProfile, withSelectedModelOption, providerForProfile } from "../actors/modelsForProfile.ts";
import { ProviderAccess } from "../providers/ProviderAccess.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk)
// ---------------------------------------------------------------------------

const tk = {
  canvas: "#08090a",
  surface: "#0f1011",
  border: "rgba(255,255,255,0.08)",
  border2: "rgba(255,255,255,0.05)",
  ink: "#f7f8f8",
  ink2: "#d0d6e0",
  ink3: "#8a8f98",
  ink4: "#62666d",
  accent: "#8aa89c",
  danger: "#b85a5a",
  fontUi: '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3,
  r2: 5,
  r3: 8,
} as const;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

function profileDisplayName(profile: AuthProfileRecord): string {
  if (profile.label) return profile.label;
  if (profile.provider === "openai-codex-app-server") return "ChatGPT";
  return profile.provider;
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${tk.border}`,
  borderRadius: tk.r2,
  padding: "7px 10px",
  fontSize: 13,
  color: tk.ink,
  fontFamily: tk.fontUi,
  outline: "none",
};

type SaveState = { phase: "idle" } | { phase: "saving" } | { phase: "saved" } | { phase: "error"; message: string };

function SaveStatus({ state }: { state: SaveState }): React.ReactElement | null {
  if (state.phase === "idle") return null;
  if (state.phase === "saving") return <span style={{ fontSize: 12, color: tk.ink3 }}>Saving…</span>;
  if (state.phase === "saved") return <span style={{ fontSize: 12, color: tk.accent }}>Saved</span>;
  return <span role="alert" style={{ fontSize: 12, color: tk.danger }}>{state.message}</span>;
}

export type WorkspaceSettingsProps = {
  workspace: WorkspaceRef;
  onRemove: (deleteLocator?: boolean) => Promise<void>;
};

export function WorkspaceSettings({ workspace, onRemove }: WorkspaceSettingsProps): React.ReactElement {
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [models, setModels] = useState<AuthModelRecord[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [profileId, setProfileId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("off");
  const [save, setSave] = useState<SaveState>({ phase: "idle" });

  const loadResolution = useCallback(() => {
    // workspace_default has no single endpoint to resolve against — read the
    // raw bindings list for this workspace (includes global_default rows too,
    // per GET /v1/runtime/bindings?workspace_id=...) and pick out the
    // workspace_default / global_default rows directly.
    getRuntimeBindings(workspace.workspace_id)
      .then((bindings) => {
        const wsBinding = bindings.find((b) => b.scope === "workspace_default" && b.workspace_id === workspace.workspace_id) ?? null;
        setProfileId(wsBinding?.auth_profile ?? "");
        setModelId(wsBinding?.model ?? "");
        setEffort(wsBinding?.thinking_level ?? "off");
      })
      .catch(() => {});
  }, [workspace.workspace_id]);

  useEffect(() => {
    setSave({ phase: "idle" });
    loadResolution();
  }, [workspace.workspace_id, loadResolution]);

  const loadProfiles = useCallback(() => {
    let cancelled = false;
    getAuthProfiles()
      .then((res) => { if (!cancelled) setProfiles(res.profiles); })
      .catch(() => { if (!cancelled) setProfiles([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => loadProfiles(), [loadProfiles]);

  useEffect(() => {
    if (!profileId) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    modelsForProfile(profiles, profileId)
      .then((list) => { if (!cancelled) { setModels(list); setModelsLoading(false); } })
      .catch(() => { if (!cancelled) { setModels([]); setModelsLoading(false); } });
    return () => { cancelled = true; };
  }, [profiles, profileId]);

  const provider = providerForProfile(profiles, profileId || null);
  const modelOptions = withSelectedModelOption(models, modelId, provider);
  const selectedModel = modelOptions.find((m) => m.id === modelId);
  const reasoningSupported = !!selectedModel?.reasoning;

  async function saveBinding(next: { profileId: string; modelId: string; effort: string }) {
    setSave({ phase: "saving" });
    try {
      if (!next.profileId) {
        await clearRuntimeBindings({ scope: "workspace_default", workspace_id: workspace.workspace_id });
      } else {
        await upsertRuntimeBinding({
          scope: "workspace_default",
          workspace_id: workspace.workspace_id,
          auth_profile: next.profileId,
          model: next.modelId || null,
          thinking_level: next.modelId ? next.effort || null : null,
        });
      }
      setSave({ phase: "saved" });
      loadResolution();
    } catch (err) {
      setSave({ phase: "error", message: err instanceof Error ? err.message : "Failed to save" });
    }
  }

  function handleProfileChange(value: string) {
    setProfileId(value);
    setModelId("");
    setEffort("off");
    void saveBinding({ profileId: value, modelId: "", effort: "off" });
  }

  function handleModelChange(value: string) {
    const nextModel = modelOptions.find((m) => m.id === value);
    const nextReasoningSupported = !!nextModel?.reasoning;
    const nextEffort = nextReasoningSupported ? effort : "off";
    setModelId(value);
    setEffort(nextEffort);
    void saveBinding({ profileId, modelId: value, effort: nextEffort });
  }

  function handleEffortChange(value: string) {
    setEffort(value);
    void saveBinding({ profileId, modelId, effort: value });
  }

  return (
    <div style={{ padding: "24px 32px 40px", overflow: "auto", flex: 1, fontFamily: tk.fontUi }} data-testid="workspace-settings">
      <section style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 8 }}>
          Floe
        </div>
        <h1 style={{ fontWeight: 510, fontSize: 30, lineHeight: 1.1, letterSpacing: "-0.02em", color: tk.ink, margin: "0 0 6px" }}>
          Settings
        </h1>
        <p style={{ color: tk.ink3, fontSize: 13.5, margin: 0 }}>
          Providers for Floe, and defaults for {workspace.name || workspace.workspace_id}.
        </p>
      </section>

      <section style={{ marginBottom: 28 }}>
        <h2 style={{ fontSize: 14, fontWeight: 560, color: tk.ink, margin: "0 0 4px" }}>Model providers</h2>
        <p style={{ fontSize: 12.5, color: tk.ink3, lineHeight: 1.5, margin: "0 0 14px", maxWidth: 620 }}>
          Connections made here are available to Floe on this device. Individual workspaces choose from these providers below.
        </p>
        <ProviderAccess compact onReady={() => { loadProfiles(); }} />
      </section>

      <section style={{
        background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3,
        padding: 20, maxWidth: 620,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 510, color: tk.ink, margin: "0 0 4px" }}>
          Workspace model
        </h2>
        <p style={{ fontSize: 12.5, color: tk.ink3, lineHeight: 1.5, margin: "0 0 16px" }}>
          Choose what Floe normally uses in {workspace.name || "this workspace"}. More specialised actors can still use a different model when needed.
        </p>

        {profiles.length === 0 ? (
          <p style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
            Connect a model provider above to choose a workspace model.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              Provider
              <select
                aria-label="Default profile"
                value={profileId}
                onChange={(e) => handleProfileChange(e.target.value)}
                style={inputStyle}
              >
                <option value="">Choose a provider</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{profileDisplayName(p)}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              Model
              <select
                aria-label="Default model"
                value={modelId}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={!profileId || modelsLoading}
                style={inputStyle}
              >
                <option value="">{modelsLoading ? "Loading models…" : "Select model"}</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.reasoning ? " · reasoning" : ""}</option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              Effort
              <select
                aria-label="Default effort"
                value={effort}
                onChange={(e) => handleEffortChange(e.target.value)}
                disabled={!profileId || !modelId || !reasoningSupported}
                style={inputStyle}
              >
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </label>
            {profileId && modelId && !reasoningSupported && (
              <p style={{ fontSize: 11, color: tk.ink4, margin: 0, fontStyle: "italic" }}>
                Selected model doesn't support reasoning effort.
              </p>
            )}

            <SaveStatus state={save} />
          </div>
        )}
      </section>

      {/* ---- Danger zone ---- */}
      <section style={{
        marginTop: 32, maxWidth: 480,
        background: tk.surface, border: `1px solid rgba(184,90,90,0.25)`, borderRadius: tk.r3,
        padding: 20,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 510, color: tk.danger, margin: "0 0 4px" }}>
          Danger zone
        </h2>
        <p style={{ fontSize: 12.5, color: tk.ink3, lineHeight: 1.5, margin: "0 0 16px" }}>
          Remove this workspace from Floe, or permanently delete all project files.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <button
            onClick={() => void onRemove(false)}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 14px", borderRadius: tk.r2,
              background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
              color: tk.ink, fontSize: 13, fontFamily: tk.fontUi, cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.07)"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)"}
          >
            <span style={{ flex: "0 0 auto", fontSize: 15 }}>🗂</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 510 }}>Remove from Floe</span>
              <span style={{ display: "block", fontSize: 11, color: tk.ink3, marginTop: 2 }}>
                Deregister this workspace. Project files remain on disk.
              </span>
            </span>
          </button>
          <button
            onClick={() => void onRemove(true)}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "9px 14px", borderRadius: tk.r2,
              background: "rgba(184,90,90,0.08)", border: `1px solid rgba(184,90,90,0.25)`,
              color: tk.danger, fontSize: 13, fontFamily: tk.fontUi, cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(184,90,90,0.15)"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(184,90,90,0.08)"}
          >
            <span style={{ flex: "0 0 auto", fontSize: 15 }}>🗑</span>
            <span style={{ flex: 1 }}>
              <span style={{ display: "block", fontWeight: 510 }}>Delete workspace and files</span>
              <span style={{ display: "block", fontSize: 11, color: tk.ink3, marginTop: 2 }}>
                Permanently remove this workspace and delete all project files from disk.
              </span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
