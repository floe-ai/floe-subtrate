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
import type { AuthModelRecord, AuthProfileRecord, RuntimeBindingRecord, WorkspaceRef } from "../bus-client/types.ts";
import {
  getAuthProfiles,
  getRuntimeBindings,
  upsertRuntimeBinding,
  clearRuntimeBindings,
} from "../bus-client/client.ts";
import { modelsForProfile, withSelectedModelOption, providerForProfile } from "../actors/modelsForProfile.ts";

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
};

export function WorkspaceSettings({ workspace }: WorkspaceSettingsProps): React.ReactElement {
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [models, setModels] = useState<AuthModelRecord[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [profileId, setProfileId] = useState("");
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState("off");
  const [save, setSave] = useState<SaveState>({ phase: "idle" });

  const [workspaceBinding, setWorkspaceBinding] = useState<RuntimeBindingRecord | null>(null);
  const [globalBinding, setGlobalBinding] = useState<RuntimeBindingRecord | null>(null);
  const [resolutionLoading, setResolutionLoading] = useState(true);

  const loadResolution = useCallback(() => {
    setResolutionLoading(true);
    // workspace_default has no single endpoint to resolve against — read the
    // raw bindings list for this workspace (includes global_default rows too,
    // per GET /v1/runtime/bindings?workspace_id=...) and pick out the
    // workspace_default / global_default rows directly.
    getRuntimeBindings(workspace.workspace_id)
      .then((bindings) => {
        const wsBinding = bindings.find((b) => b.scope === "workspace_default" && b.workspace_id === workspace.workspace_id) ?? null;
        const glBinding = bindings.find((b) => b.scope === "global_default") ?? null;
        setWorkspaceBinding(wsBinding);
        setGlobalBinding(glBinding);
        setResolutionLoading(false);
        setProfileId(wsBinding?.auth_profile ?? "");
        setModelId(wsBinding?.model ?? "");
        setEffort(wsBinding?.thinking_level ?? "off");
      })
      .catch(() => setResolutionLoading(false));
  }, [workspace.workspace_id]);

  useEffect(() => {
    setSave({ phase: "idle" });
    loadResolution();
  }, [workspace.workspace_id, loadResolution]);

  useEffect(() => {
    let cancelled = false;
    getAuthProfiles()
      .then((res) => { if (!cancelled) setProfiles(res.profiles); })
      .catch(() => { if (!cancelled) setProfiles([]); });
    return () => { cancelled = true; };
  }, []);

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
    void saveBinding({ profileId: value, modelId: "", effort: "off" });
  }

  function handleModelChange(value: string) {
    setModelId(value);
    void saveBinding({ profileId, modelId: value, effort });
  }

  function handleEffortChange(value: string) {
    setEffort(value);
    void saveBinding({ profileId, modelId, effort: value });
  }

  return (
    <div style={{ padding: "24px 32px 40px", overflow: "auto", flex: 1, fontFamily: tk.fontUi }} data-testid="workspace-settings">
      <section style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 8 }}>
          Workspace
        </div>
        <h1 style={{ fontWeight: 510, fontSize: 30, lineHeight: 1.1, letterSpacing: "-0.02em", color: tk.ink, margin: "0 0 6px" }}>
          Settings
        </h1>
        <p style={{ color: tk.ink3, fontSize: 13.5, margin: 0 }}>
          {workspace.name || workspace.workspace_id}
        </p>
      </section>

      <section style={{
        background: tk.surface, border: `1px solid ${tk.border}`, borderRadius: tk.r3,
        padding: 20, maxWidth: 480,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 510, color: tk.ink, margin: "0 0 4px" }}>
          New actors inherit
        </h2>
        <p style={{ fontSize: 12.5, color: tk.ink3, lineHeight: 1.5, margin: "0 0 16px" }}>
          Default profile, model, and effort for actors that don't set their own binding.
          This is the <code>workspace_default</code> runtime binding.
        </p>

        {profiles.length === 0 ? (
          <p style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
            No auth profiles found. Run <code>npm run floe -- login</code>.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3 }}>
              Profile
              <select
                aria-label="Default profile"
                value={profileId}
                onChange={(e) => handleProfileChange(e.target.value)}
                style={inputStyle}
              >
                <option value="">Unconfigured</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.id} ({p.provider})</option>
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

      <section style={{ marginTop: 20, maxWidth: 480 }}>
        <h3 style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 8 }}>
          Effective default (resolved)
        </h3>
        {resolutionLoading ? (
          <span style={{ fontSize: 12, color: tk.ink3 }}>Loading…</span>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: "4px 8px", fontSize: 12 }}>
            <span style={{ color: tk.ink3 }}>Profile</span>
            <span><code>{workspaceBinding?.auth_profile ?? globalBinding?.auth_profile ?? "(none)"}</code></span>
            <span style={{ color: tk.ink3 }}>Model</span>
            <span><code>{workspaceBinding?.model ?? globalBinding?.model ?? "(inherit)"}</code></span>
            <span style={{ color: tk.ink3 }}>Effort</span>
            <span><code>{workspaceBinding?.thinking_level ?? globalBinding?.thinking_level ?? "(inherit)"}</code></span>
          </div>
        )}
      </section>
    </div>
  );
}
