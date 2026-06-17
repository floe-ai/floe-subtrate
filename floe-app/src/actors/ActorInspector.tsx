/**
 * ActorInspector — right-inspector content for a selected actor (Slice 3).
 *
 * Inline-editable, v6 style (no modal):
 *  - Name: editable, saves via registerEndpoint with the FULL current endpoint
 *    shape (endpoint_id, workspace_id, agent_id, bridge_id, status, metadata)
 *    so a name change doesn't clobber other fields.
 *  - Profile -> Model -> Effort (scope="agent"): selecting a profile constrains
 *    the Model dropdown to that profile's provider (see modelsForProfile.ts,
 *    lifted from floe-web's effectiveProfile/availableModels wiring).
 *    Clearing the profile removes the agent-level binding entirely
 *    (clearRuntimeBindings) so the actor falls back to workspace/global.
 *  - Effective resolved binding (resolveRuntimeBinding) shown with layer
 *    labels (actor / workspace / global) so inheritance is visible.
 */
import React, { useCallback, useEffect, useState } from "react";
import type {
  AuthModelRecord,
  AuthProfileRecord,
  EndpointRef,
  RuntimeBindingResolution,
} from "../bus-client/types.ts";
import {
  registerEndpoint,
  getAuthProfiles,
  resolveRuntimeBinding,
  upsertRuntimeBinding,
  clearRuntimeBindings,
} from "../bus-client/client.ts";
import { modelsForProfile, withSelectedModelOption, providerForProfile } from "./modelsForProfile.ts";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk)
// ---------------------------------------------------------------------------

const tk = {
  canvas: "#08090a",
  surface: "#0f1011",
  surfaceHov: "#191a1b",
  border: "rgba(255,255,255,0.08)",
  border2: "rgba(255,255,255,0.05)",
  ink: "#f7f8f8",
  ink2: "#d0d6e0",
  ink3: "#8a8f98",
  ink4: "#62666d",
  accent: "#8aa89c",
  accentHov: "#a1bcb1",
  danger: "#b85a5a",
  fontUi: '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3,
  r2: 5,
  r3: 8,
} as const;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

// ---------------------------------------------------------------------------
// Shared field chrome
// ---------------------------------------------------------------------------

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3, fontFamily: tk.fontUi }}>
      {children}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  border: `1px solid ${tk.border}`,
  borderRadius: tk.r2,
  padding: "6px 8px",
  fontSize: 13,
  color: tk.ink,
  fontFamily: tk.fontUi,
  outline: "none",
};

const selectStyle: React.CSSProperties = { ...inputStyle };

function StatRow({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "5px 0", fontSize: 12, borderBottom: `1px solid ${tk.border2}`,
      gap: 12, fontFamily: tk.fontUi,
    }}>
      <span style={{ color: tk.ink3, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tk.ink, fontWeight: 510, textAlign: "right", minWidth: 0, overflowWrap: "anywhere" }}>
        {value}
      </span>
    </div>
  );
}

/** Layer-labeled resolved value: shows which layer (actor/workspace/global) supplied it. */
function ResolvedRow({
  label,
  endpointValue,
  workspaceValue,
  globalValue,
}: {
  label: string;
  endpointValue: string | null;
  workspaceValue: string | null;
  globalValue: string | null;
}): React.ReactElement {
  const value = endpointValue ?? workspaceValue ?? globalValue;
  const layer = endpointValue ? "actor" : workspaceValue ? "workspace" : globalValue ? "global" : null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: "2px 8px", fontSize: 11, fontFamily: tk.fontUi }}>
      <span style={{ color: tk.ink3 }}>{label}</span>
      <span>
        <code style={{ fontSize: 11, color: tk.ink }}>{value ?? "(none)"}</code>
        {layer && (
          <span style={{ color: layer === "actor" ? tk.accent : tk.ink4, marginLeft: 6 }}>
            ({layer})
          </span>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save status chip
// ---------------------------------------------------------------------------

type SaveState = { phase: "idle" } | { phase: "saving" } | { phase: "saved" } | { phase: "error"; message: string };

function SaveStatus({ state }: { state: SaveState }): React.ReactElement | null {
  if (state.phase === "idle") return null;
  if (state.phase === "saving") return <span style={{ fontSize: 11, color: tk.ink3 }}>Saving…</span>;
  if (state.phase === "saved") return <span style={{ fontSize: 11, color: tk.accent }}>Saved</span>;
  return <span role="alert" style={{ fontSize: 11, color: tk.danger }}>{state.message}</span>;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ActorInspectorProps = {
  actor: EndpointRef;
  workspaceId: string;
  onSaved?: (updated: EndpointRef) => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActorInspector({ actor, workspaceId, onSaved }: ActorInspectorProps): React.ReactElement {
  // Name editing
  const [name, setName] = useState(actor.name);
  const [nameSave, setNameSave] = useState<SaveState>({ phase: "idle" });

  // Auth profiles + models
  const [profiles, setProfiles] = useState<AuthProfileRecord[]>([]);
  const [models, setModels] = useState<AuthModelRecord[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Binding form state (uncommitted draft mirrors current agent binding)
  const [profileId, setProfileId] = useState<string>("");
  const [modelId, setModelId] = useState<string>("");
  const [effort, setEffort] = useState<string>("off");
  const [bindingSave, setBindingSave] = useState<SaveState>({ phase: "idle" });

  // Resolved (effective) binding for inheritance display
  const [resolution, setResolution] = useState<RuntimeBindingResolution | null>(null);
  const [resolutionLoading, setResolutionLoading] = useState(true);

  const loadResolution = useCallback(() => {
    setResolutionLoading(true);
    resolveRuntimeBinding(workspaceId, actor.endpoint_id)
      .then((res) => {
        setResolution(res);
        setResolutionLoading(false);
        // Seed the editable binding form from the actor-level (not inherited) values.
        setProfileId(res.endpoint_auth_profile ?? "");
        setModelId(res.endpoint_model ?? "");
        setEffort(res.endpoint_thinking_level ?? "off");
      })
      .catch(() => setResolutionLoading(false));
  }, [workspaceId, actor.endpoint_id]);

  // Reset all local state when the selected actor changes.
  useEffect(() => {
    setName(actor.name);
    setNameSave({ phase: "idle" });
    setBindingSave({ phase: "idle" });
    loadResolution();
  }, [actor.endpoint_id, actor.name, loadResolution]);

  // Load auth profiles once.
  useEffect(() => {
    let cancelled = false;
    getAuthProfiles()
      .then((res) => { if (!cancelled) setProfiles(res.profiles); })
      .catch(() => { if (!cancelled) setProfiles([]); });
    return () => { cancelled = true; };
  }, []);

  // Constrain models to the selected profile's provider whenever profileId changes.
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

  async function handleNameSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === actor.name) return;
    setNameSave({ phase: "saving" });
    try {
      const updated = await registerEndpoint({
        endpoint_id: actor.endpoint_id,
        workspace_id: actor.workspace_id,
        name: trimmed,
        agent_id: actor.agent_id ?? null,
        bridge_id: actor.bridge_id ?? null,
        status: actor.status,
        metadata: actor.metadata_json ? (JSON.parse(actor.metadata_json) as Record<string, unknown>) : undefined,
      });
      setNameSave({ phase: "saved" });
      onSaved?.(updated);
    } catch (err) {
      setNameSave({ phase: "error", message: err instanceof Error ? err.message : "Failed to save name" });
    }
  }

  async function saveBinding(next: { profileId: string; modelId: string; effort: string }) {
    setBindingSave({ phase: "saving" });
    try {
      if (!next.profileId) {
        await clearRuntimeBindings({ scope: "agent", workspace_id: workspaceId, endpoint_id: actor.endpoint_id });
      } else {
        await upsertRuntimeBinding({
          scope: "agent",
          workspace_id: workspaceId,
          endpoint_id: actor.endpoint_id,
          auth_profile: next.profileId,
          model: next.modelId || null,
          thinking_level: next.modelId ? next.effort || null : null,
        });
      }
      setBindingSave({ phase: "saved" });
      loadResolution();
    } catch (err) {
      setBindingSave({ phase: "error", message: err instanceof Error ? err.message : "Failed to save binding" });
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto", fontFamily: tk.fontUi }}>
      {/* Head */}
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${tk.border}` }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
          Actor
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          <input
            aria-label="Actor name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void handleNameSave()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleNameSave();
              if (e.key === "Escape") setName(actor.name);
            }}
            style={{ ...inputStyle, flex: 1, fontSize: 15, fontWeight: 510 }}
          />
        </div>
        <div style={{ marginTop: 6 }}>
          <SaveStatus state={nameSave} />
        </div>
      </div>

      {/* Identity */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <StatRow label="Endpoint ID" value={<code style={{ fontSize: 11 }}>{actor.endpoint_id}</code>} />
        <StatRow label="Status" value={actor.status} />
        {actor.agent_id && <StatRow label="Agent" value={<code style={{ fontSize: 11 }}>{actor.agent_id}</code>} />}
        {actor.bridge_id && <StatRow label="Bridge" value={<code style={{ fontSize: 11 }}>{actor.bridge_id}</code>} />}
        <StatRow label="Created" value={new Date(actor.created_at).toLocaleString()} />
      </div>

      {/* Profile -> Model -> Effort */}
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}`, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
          Model binding
        </div>

        {profiles.length === 0 ? (
          <p style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic", margin: 0 }}>
            No auth profiles found. Run <code>npm run floe -- login</code>.
          </p>
        ) : (
          <>
            <FieldLabel>
              Profile
              <select
                aria-label="Profile"
                value={profileId}
                onChange={(e) => handleProfileChange(e.target.value)}
                style={selectStyle}
              >
                <option value="">Inherit (no actor override)</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.id} ({p.provider})</option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel>
              Model
              <select
                aria-label="Model"
                value={modelId}
                onChange={(e) => handleModelChange(e.target.value)}
                disabled={!profileId || modelsLoading}
                style={selectStyle}
              >
                <option value="">{modelsLoading ? "Loading models…" : "Select model"}</option>
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}{m.reasoning ? " · reasoning" : ""}</option>
                ))}
              </select>
            </FieldLabel>

            <FieldLabel>
              Effort
              <select
                aria-label="Effort"
                value={effort}
                onChange={(e) => handleEffortChange(e.target.value)}
                disabled={!profileId || !modelId || !reasoningSupported}
                style={selectStyle}
              >
                {THINKING_LEVELS.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </FieldLabel>
            {profileId && modelId && !reasoningSupported && (
              <p style={{ fontSize: 11, color: tk.ink4, margin: 0, fontStyle: "italic" }}>
                Selected model doesn't support reasoning effort.
              </p>
            )}
          </>
        )}

        <SaveStatus state={bindingSave} />
      </div>

      {/* Effective resolved binding */}
      <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 4 }}>
          Effective binding (resolved)
        </div>
        {resolutionLoading ? (
          <span style={{ fontSize: 12, color: tk.ink3 }}>Loading…</span>
        ) : resolution ? (
          <>
            <ResolvedRow
              label="Profile"
              endpointValue={resolution.endpoint_auth_profile}
              workspaceValue={resolution.workspace_auth_profile}
              globalValue={resolution.global_auth_profile}
            />
            <ResolvedRow
              label="Model"
              endpointValue={resolution.endpoint_model}
              workspaceValue={resolution.workspace_model}
              globalValue={resolution.global_model}
            />
            <ResolvedRow
              label="Effort"
              endpointValue={resolution.endpoint_thinking_level}
              workspaceValue={resolution.workspace_thinking_level}
              globalValue={resolution.global_thinking_level}
            />
          </>
        ) : (
          <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>Unavailable</span>
        )}
      </div>
    </div>
  );
}
