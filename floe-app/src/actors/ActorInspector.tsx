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
  ContextRef,
  EndpointRef,
  RuntimeBindingResolution,
} from "../bus-client/types.ts";
import {
  registerEndpoint,
  deleteEndpoint,
  getAuthProfiles,
  resolveRuntimeBinding,
  upsertRuntimeBinding,
  clearRuntimeBindings,
  listContextsByParticipant,
} from "../bus-client/client.ts";
import { modelsForProfile, withSelectedModelOption, providerForProfile } from "./modelsForProfile.ts";
import { contextLabel } from "../scope/ScopeDetail.tsx";
import { fileAccessAvailable, readWorkspaceFile, writeWorkspaceFile, type WorkspaceFsRef } from "../fs/workspaceFs.ts";
import { parseAgentFile, serializeAgentFile, type AgentFrontmatter } from "./agentFile.ts";
import { ActorBodyEditor } from "./ActorBodyEditor.tsx";

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
// Contexts the actor participates in (Gap A — v6 parity)
// ---------------------------------------------------------------------------
// v6 shows this in the inspector when an actor is selected ("Click an actor
// to see what they participate in" — Home hero copy). We mirror that: a
// list of contexts by human name, each clickable to open that context's
// conversation.

function ActorContexts({
  endpointId,
  workspaceId,
  onOpenContext,
}: {
  endpointId: string;
  workspaceId: string;
  onOpenContext: (contextId: string) => void;
}): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listContextsByParticipant({ participant: endpointId, workspace_id: workspaceId })
      .then(rows => {
        if (cancelled) return;
        const sorted = [...rows].sort((a, b) => {
          const ta = a.last_event_at ?? a.created_at;
          const tb = b.last_event_at ?? b.created_at;
          return tb.localeCompare(ta);
        });
        setContexts(sorted);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load contexts");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [endpointId, workspaceId]);

  return (
    <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
        color: tk.ink3, fontWeight: 510,
      }}>
        <span>Contexts</span>
        {!loading && (
          <span style={{ color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
            {contexts.length}
          </span>
        )}
      </div>

      {loading && <span style={{ fontSize: 12, color: tk.ink3 }}>Loading…</span>}

      {error && <span role="alert" style={{ fontSize: 12, color: tk.danger }}>{error}</span>}

      {!loading && !error && contexts.length === 0 && (
        <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
          Not participating in any contexts.
        </span>
      )}

      {!loading && !error && contexts.length > 0 && (
        <div role="list" aria-label="Contexts this actor participates in" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {contexts.map(ctx => (
            <button
              key={ctx.context_id}
              role="listitem"
              onClick={() => onOpenContext(ctx.context_id)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1,
                width: "100%", textAlign: "left",
                background: "transparent", border: `1px solid ${tk.border}`,
                borderRadius: tk.r2, padding: "7px 10px", cursor: "pointer",
                fontFamily: tk.fontUi,
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = tk.surfaceHov; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <span style={{
                fontSize: 12.5, color: tk.ink, fontWeight: 510,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%",
              }}>
                {contextLabel(ctx)}
              </span>
              <span style={{ fontSize: 10.5, color: tk.ink4 }}>
                {ctx.scope_id ? "in scope" : "direct · no scope"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete action (mirrors ScopeInspector's delete-confirm pattern in App.tsx)
// ---------------------------------------------------------------------------

type DeleteState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "deleting" }
  | { phase: "error"; message: string };

function ActorDeleteSection({
  actor,
  onDeleted,
}: {
  actor: EndpointRef;
  onDeleted: () => void;
}): React.ReactElement {
  const [deleteState, setDeleteState] = useState<DeleteState>({ phase: "idle" });
  const [confirmName, setConfirmName] = useState("");
  const actorLabel = actor.name || actor.endpoint_id;

  // Reset the confirm/error state whenever the selected actor changes.
  useEffect(() => {
    setDeleteState({ phase: "idle" });
    setConfirmName("");
  }, [actor.endpoint_id]);

  async function handleDelete() {
    setDeleteState({ phase: "deleting" });
    try {
      await deleteEndpoint(actor.endpoint_id);
      onDeleted();
    } catch (err) {
      // Treat "already gone" as success — the desired end state is reached.
      if (err instanceof Error && /(404|not.?found)/i.test(err.message)) {
        onDeleted();
        return;
      }
      setDeleteState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <div style={{ padding: "12px 16px" }}>
      {deleteState.phase === "idle" && (
        <button
          onClick={() => { setDeleteState({ phase: "confirming" }); setConfirmName(""); }}
          style={{
            background: "transparent", border: `1px solid ${tk.danger}`,
            color: tk.danger, borderRadius: tk.r2, padding: "5px 12px",
            fontSize: 12, cursor: "pointer", fontWeight: 510, fontFamily: tk.fontUi,
          }}
        >
          Delete actor
        </button>
      )}

      {deleteState.phase === "confirming" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 12, color: tk.ink2, lineHeight: 1.45, margin: 0 }}>
            Type "{actorLabel}" to confirm deletion. This cannot be undone.
          </p>
          <input
            aria-label="Confirm actor name"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={actorLabel}
            autoFocus
            style={{ ...inputStyle }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => void handleDelete()}
              disabled={confirmName !== actorLabel}
              style={{
                background: confirmName === actorLabel ? tk.danger : "rgba(184,90,90,0.35)",
                color: "#fff", border: "none",
                borderRadius: tk.r2, padding: "5px 12px", fontSize: 12,
                cursor: confirmName === actorLabel ? "pointer" : "not-allowed",
                fontFamily: tk.fontUi,
              }}
            >
              Confirm delete
            </button>
            <button
              onClick={() => { setDeleteState({ phase: "idle" }); setConfirmName(""); }}
              style={{
                background: "transparent", border: `1px solid ${tk.border}`,
                color: tk.ink3, borderRadius: tk.r2, padding: "5px 12px", fontSize: 12,
                fontFamily: tk.fontUi, cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {deleteState.phase === "deleting" && (
        <p style={{ fontSize: 12, color: tk.ink3 }}>Deleting…</p>
      )}

      {deleteState.phase === "error" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <p role="alert" style={{ fontSize: 12, color: tk.danger, margin: 0 }}>{deleteState.message}</p>
          <button
            onClick={() => setDeleteState({ phase: "idle" })}
            style={{
              background: "transparent", border: `1px solid ${tk.border}`,
              color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
              alignSelf: "flex-start", fontFamily: tk.fontUi, cursor: "pointer",
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File-backed definition (frontmatter + body) for bridge-registered actors
// ---------------------------------------------------------------------------
// The actor's `.floe/agents/<id>.md` file is the source of truth for its
// frontmatter + instructions. Path = ".floe/" + JSON.parse(metadata_json).file
// (set by floe-bridge's daemon.ts reconcileFromBus, ~line 257-258). Editing
// here writes the file directly via the Tauri FS bridge; we do NOT call
// registerEndpoint — the bridge's disk-drift sync (every ~30s) re-reads the
// file and updates the endpoint.

type FileLoadState =
  | { phase: "unavailable" } // no FS backend, or actor has no on-disk file
  | { phase: "loading" }
  | { phase: "loaded"; relPath: string; frontmatter: AgentFrontmatter; body: string }
  | { phase: "error"; message: string };

function actorFileRelPath(actor: EndpointRef): string | null {
  if (!actor.metadata_json) return null;
  try {
    const meta = JSON.parse(actor.metadata_json) as { file?: unknown };
    if (typeof meta.file !== "string" || !meta.file) return null;
    return `.floe/${meta.file}`;
  } catch {
    return null;
  }
}

function ActorFileSection({
  actor,
  workspace,
}: {
  actor: EndpointRef;
  workspace: WorkspaceFsRef | null;
}): React.ReactElement | null {
  const [state, setState] = useState<FileLoadState>({ phase: "unavailable" });
  const [frontmatter, setFrontmatter] = useState<AgentFrontmatter | null>(null);
  const [body, setBody] = useState("");
  const [scopePaths, setScopePaths] = useState("");
  const [skills, setSkills] = useState("");
  const [extensions, setExtensions] = useState("");
  const [mcp, setMcp] = useState("");
  const [engine, setEngine] = useState("pi");
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });
  const [fsAvailable, setFsAvailable] = useState<boolean | null>(null);
  const relPath = actorFileRelPath(actor);

  useEffect(() => {
    let cancelled = false;
    fileAccessAvailable().then((available) => { if (!cancelled) setFsAvailable(available); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setSaveState({ phase: "idle" });
    if (!fsAvailable || !workspace || !relPath) {
      setState({ phase: "unavailable" });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    readWorkspaceFile(workspace, relPath)
      .then((contents) => {
        if (cancelled) return;
        const parsed = parseAgentFile(contents);
        setFrontmatter(parsed.frontmatter);
        setBody(parsed.body);
        setScopePaths((parsed.frontmatter.scope?.paths ?? []).join(", "));
        setSkills((parsed.frontmatter.skills ?? []).join(", "));
        setExtensions((parsed.frontmatter.extensions ?? []).join(", "));
        setMcp((parsed.frontmatter.mcp ?? []).join(", "));
        setEngine(parsed.frontmatter.runtime?.engine ?? "pi");
        setState({ phase: "loaded", relPath, frontmatter: parsed.frontmatter, body: parsed.body });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to read actor file" });
      });
    return () => { cancelled = true; };
  }, [actor.endpoint_id, workspace, relPath, fsAvailable]);

  if (fsAvailable === null) {
    return (
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <span style={{ fontSize: 12, color: tk.ink3 }}>Loading…</span>
      </div>
    );
  }

  if (!fsAvailable) {
    return (
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <p style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic", margin: 0 }}>
          File editing is unavailable: the bus has no local filesystem access configured
          (workspace_access.local_paths is off) and this isn't the desktop app.
        </p>
      </div>
    );
  }

  if (!relPath) {
    return null; // no on-disk file to edit (e.g. actor registered without metadata.file)
  }

  if (state.phase === "loading") {
    return (
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <span style={{ fontSize: 12, color: tk.ink3 }}>Loading definition…</span>
      </div>
    );
  }

  if (state.phase === "error") {
    return (
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
        <p role="alert" style={{ fontSize: 12, color: tk.danger, margin: 0 }}>{state.message}</p>
      </div>
    );
  }

  if (state.phase !== "loaded" || !frontmatter) return null;
  const loadedFrontmatter = frontmatter;

  async function handleSave() {
    if (!workspace || !relPath) return;
    setSaveState({ phase: "saving" });
    try {
      // Spread preserves every existing field verbatim (including `label`
      // on legacy files, and `name` only if the file already had one — see
      // agentFile.ts's AgentFrontmatter.name comment); we only override
      // runtime.engine and the list fields below.
      const nextFrontmatter: AgentFrontmatter = {
        ...loadedFrontmatter,
        schema: loadedFrontmatter.schema,
        agent_id: loadedFrontmatter.agent_id,
        runtime: { engine: engine.trim() || "pi" },
      };
      const scopeList = scopePaths.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const skillsList = skills.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const extensionsList = extensions.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const mcpList = mcp.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      if (scopeList.length > 0) nextFrontmatter.scope = { paths: scopeList };
      else delete nextFrontmatter.scope;
      if (skillsList.length > 0) nextFrontmatter.skills = skillsList;
      else delete nextFrontmatter.skills;
      if (extensionsList.length > 0) nextFrontmatter.extensions = extensionsList;
      else delete nextFrontmatter.extensions;
      if (mcpList.length > 0) nextFrontmatter.mcp = mcpList;
      else delete nextFrontmatter.mcp;

      const contents = serializeAgentFile(nextFrontmatter, body);
      await writeWorkspaceFile(workspace, relPath, contents);
      setSaveState({ phase: "saved" });
    } catch (err) {
      setSaveState({ phase: "error", message: err instanceof Error ? err.message : "Failed to save actor file" });
    }
  }

  return (
    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}`, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
        Definition (file)
      </div>
      <StatRow label="File" value={<code style={{ fontSize: 11 }}>{relPath}</code>} />

      <FieldLabel>
        Runtime engine
        <input
          aria-label="Runtime engine"
          value={engine}
          onChange={(e) => setEngine(e.target.value)}
          style={inputStyle}
        />
      </FieldLabel>

      <FieldLabel>
        Scope paths (comma separated)
        <input aria-label="Scope paths" value={scopePaths} onChange={(e) => setScopePaths(e.target.value)} style={inputStyle} />
      </FieldLabel>

      <FieldLabel>
        Skills (comma separated)
        <input aria-label="Skills" value={skills} onChange={(e) => setSkills(e.target.value)} style={inputStyle} />
      </FieldLabel>

      <FieldLabel>
        Extensions (comma separated)
        <input aria-label="Extensions" value={extensions} onChange={(e) => setExtensions(e.target.value)} style={inputStyle} />
      </FieldLabel>

      <FieldLabel>
        MCP servers (comma separated)
        <input aria-label="MCP servers" value={mcp} onChange={(e) => setMcp(e.target.value)} style={inputStyle} />
      </FieldLabel>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <span style={{ fontSize: 11, color: tk.ink3 }}>Instructions (markdown body)</span>
        <ActorBodyEditor value={body} onChange={setBody} minHeight={160} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => void handleSave()}
          disabled={saveState.phase === "saving"}
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "6px 14px", fontSize: 12.5, fontWeight: 510,
            cursor: saveState.phase === "saving" ? "not-allowed" : "pointer",
            fontFamily: tk.fontUi,
          }}
        >
          {saveState.phase === "saving" ? "Saving…" : "Save definition"}
        </button>
        <SaveStatus state={saveState} />
        {saveState.phase === "saved" && (
          <span style={{ fontSize: 11, color: tk.ink4 }}>Bridge picks up changes within ~30s.</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type ActorInspectorProps = {
  actor: EndpointRef;
  workspaceId: string;
  /** Selected workspace's identity (workspace_id + locator) — required for file-backed actor editing. */
  workspace?: WorkspaceFsRef | null;
  onSaved?: (updated: EndpointRef) => void;
  /** Open this context's conversation (sets selected context + switches main view). */
  onOpenContext?: (contextId: string) => void;
  /** Actor was deleted — caller should remove it from the Actors nav and clear selection. */
  onDeleted?: (endpointId: string) => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActorInspector({ actor, workspaceId, workspace, onSaved, onOpenContext, onDeleted }: ActorInspectorProps): React.ReactElement {
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

      {/* Contexts this actor participates in (Gap A — v6 parity) */}
      <div style={{ borderBottom: `1px solid ${tk.border2}` }}>
        <ActorContexts
          endpointId={actor.endpoint_id}
          workspaceId={workspaceId}
          onOpenContext={(contextId) => onOpenContext?.(contextId)}
        />
      </div>

      {/* File-backed definition (frontmatter + body) — Tauri only */}
      <ActorFileSection actor={actor} workspace={workspace ?? null} />

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

      {/* Delete action */}
      <div style={{ borderTop: `1px solid ${tk.border2}` }}>
        <ActorDeleteSection actor={actor} onDeleted={() => onDeleted?.(actor.endpoint_id)} />
      </div>
    </div>
  );
}
