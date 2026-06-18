/**
 * NewActorForm — create-actor main view (Slice: create/edit actor).
 *
 * Files are the source of truth: this form serializes frontmatter + body
 * and writes `.floe/agents/<agent_id>.md` directly via the workspace FS
 * bridge (`writeWorkspaceFile` — Tauri locally, the bus's HTTP FS surface
 * when remote). It does NOT call `registerEndpoint` — the bridge's
 * disk-drift sync (every ~30s) picks up the new file and registers the
 * endpoint. See agentFile.ts for the exact frontmatter shape and
 * serialization, which mirrors floe-bridge/src/project.ts.
 *
 * Gated on fileAccessAvailable(): true in Tauri, or in a plain browser when
 * the bus reports `workspace_access.local_paths` enabled. Neither backend
 * present (browser + bus FS disabled) shows a short explanatory note
 * instead of the form.
 */
import React, { useEffect, useMemo, useState } from "react";
import { fileAccessAvailable, writeWorkspaceFile, type WorkspaceFsRef } from "../fs/workspaceFs.ts";
import { actorEndpointId, slugify } from "./modelsForProfile.ts";
import { buildFrontmatter, parseListField, serializeAgentFile } from "./agentFile.ts";
import { ActorBodyEditor } from "./ActorBodyEditor.tsx";

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
  accentHov: "#a1bcb1",
  danger: "#b85a5a",
  fontUi: '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3,
  r2: 5,
  r3: 8,
} as const;

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

function FieldLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: tk.ink3, fontFamily: tk.fontUi }}>
      {children}
    </label>
  );
}

type SaveState = { phase: "idle" } | { phase: "saving" } | { phase: "saved" } | { phase: "error"; message: string };

export type NewActorFormProps = {
  workspaceId: string;
  workspace: WorkspaceFsRef;
  existingAgentIds: string[];
  onCreated?: () => void;
};

export function NewActorForm({ workspaceId, workspace, existingAgentIds, onCreated }: NewActorFormProps): React.ReactElement {
  const [name, setName] = useState("");
  const [engine, setEngine] = useState("pi");
  const [scopePaths, setScopePaths] = useState("");
  const [pulseInherit, setPulseInherit] = useState<"" | "true" | "false">("");
  const [skills, setSkills] = useState("");
  const [extensions, setExtensions] = useState("");
  const [mcp, setMcp] = useState("");
  const [body, setBody] = useState("You are {name}, an actor in this Floe workspace.\n\nDescribe what this actor is responsible for here.");
  const [saveState, setSaveState] = useState<SaveState>({ phase: "idle" });
  const [fsAvailable, setFsAvailable] = useState<boolean | null>(null);

  const agentId = useMemo(() => slugify(name || "new-actor"), [name]);
  const endpointId = useMemo(() => actorEndpointId(workspaceId, name || "new-actor"), [workspaceId, name]);
  const idCollision = existingAgentIds.includes(agentId);

  useEffect(() => {
    let cancelled = false;
    fileAccessAvailable().then((available) => { if (!cancelled) setFsAvailable(available); });
    return () => { cancelled = true; };
  }, []);

  if (fsAvailable === false) {
    return (
      <div style={{ padding: "24px 32px", flex: 1 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 8 }}>
          New actor
        </div>
        <p style={{ color: tk.ink3, fontSize: 13.5, lineHeight: 1.55, maxWidth: "60ch" }} data-testid="new-actor-gated-note">
          File editing is unavailable: the bus has no local filesystem access configured
          (workspace_access.local_paths is off) and this isn't the desktop app.
        </p>
      </div>
    );
  }

  if (fsAvailable === null) {
    return (
      <div style={{ padding: "24px 32px", flex: 1 }}>
        <span style={{ fontSize: 13, color: tk.ink3 }}>Loading…</span>
      </div>
    );
  }

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setSaveState({ phase: "error", message: "Name is required." });
      return;
    }
    if (idCollision) {
      setSaveState({ phase: "error", message: `An actor file for "${agentId}" already exists.` });
      return;
    }
    setSaveState({ phase: "saving" });
    try {
      const frontmatter = buildFrontmatter({
        agentId,
        name: trimmedName,
        engine: engine.trim() || "pi",
        scopePaths: parseListField(scopePaths),
        pulseInherit: pulseInherit === "" ? null : pulseInherit === "true",
        skills: parseListField(skills),
        extensions: parseListField(extensions),
        mcp: parseListField(mcp),
      });
      const contents = serializeAgentFile(frontmatter, body.replace(/\{name\}/g, trimmedName));
      await writeWorkspaceFile(workspace, `.floe/agents/${agentId}.md`, contents);
      setSaveState({ phase: "saved" });
      onCreated?.();
    } catch (err) {
      setSaveState({ phase: "error", message: err instanceof Error ? err.message : "Failed to save actor file" });
    }
  }

  return (
    <div style={{ padding: "24px 32px 40px", overflow: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 18, maxWidth: 720 }}>
      <section>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510, marginBottom: 8 }}>
          New actor
        </div>
        <h1 style={{ fontWeight: 510, fontSize: 28, lineHeight: 1.1, letterSpacing: "-0.02em", color: tk.ink, margin: "0 0 8px" }}>
          Create actor
        </h1>
        <p style={{ color: tk.ink3, fontSize: 13.5, lineHeight: 1.55, maxWidth: "64ch", margin: 0 }}>
          Writes <code>.floe/agents/{agentId}.md</code> directly. The bridge's disk-drift sync
          registers the endpoint automatically — it appears in the Actors list within ~30s.
        </p>
      </section>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, border: `1px solid ${tk.border}`, borderRadius: tk.r3, background: tk.surface }}>
        <FieldLabel>
          Name
          <input
            aria-label="Actor name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Release Notes Drafter"
            autoFocus
            style={inputStyle}
          />
        </FieldLabel>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px", fontSize: 11, fontFamily: tk.fontUi }}>
          <span style={{ color: tk.ink3 }}>agent_id</span>
          <span style={{ color: tk.ink3 }}>endpoint (derived)</span>
          <code style={{ fontSize: 11.5, color: idCollision ? tk.danger : tk.ink }}>{agentId}</code>
          <code style={{ fontSize: 11.5, color: tk.ink4 }}>{endpointId}</code>
        </div>
        {idCollision && (
          <p role="alert" style={{ fontSize: 11.5, color: tk.danger, margin: 0 }}>
            An actor file for "{agentId}" already exists. Choose a different name.
          </p>
        )}

        <FieldLabel>
          Runtime engine
          <input
            aria-label="Runtime engine"
            value={engine}
            onChange={(e) => setEngine(e.target.value)}
            placeholder="pi"
            style={inputStyle}
          />
        </FieldLabel>

        <FieldLabel>
          Scope paths (comma or newline separated, optional)
          <input
            aria-label="Scope paths"
            value={scopePaths}
            onChange={(e) => setScopePaths(e.target.value)}
            placeholder="src/, docs/"
            style={inputStyle}
          />
        </FieldLabel>

        <FieldLabel>
          Pulse inherit
          <select
            aria-label="Pulse inherit"
            value={pulseInherit}
            onChange={(e) => setPulseInherit(e.target.value as "" | "true" | "false")}
            style={inputStyle}
          >
            <option value="">(unset)</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        </FieldLabel>

        <FieldLabel>
          Skills (comma separated, optional)
          <input aria-label="Skills" value={skills} onChange={(e) => setSkills(e.target.value)} style={inputStyle} />
        </FieldLabel>

        <FieldLabel>
          Extensions (comma separated, optional)
          <input aria-label="Extensions" value={extensions} onChange={(e) => setExtensions(e.target.value)} style={inputStyle} />
        </FieldLabel>

        <FieldLabel>
          MCP servers (comma separated, optional)
          <input aria-label="MCP servers" value={mcp} onChange={(e) => setMcp(e.target.value)} style={inputStyle} />
        </FieldLabel>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
          Instructions (markdown body)
        </div>
        <ActorBodyEditor value={body} onChange={setBody} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button
          onClick={() => void handleSave()}
          disabled={saveState.phase === "saving" || !name.trim() || idCollision}
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "7px 16px", fontSize: 13, fontWeight: 510,
            cursor: saveState.phase === "saving" || !name.trim() || idCollision ? "not-allowed" : "pointer",
            opacity: saveState.phase === "saving" || !name.trim() || idCollision ? 0.6 : 1,
            fontFamily: tk.fontUi,
          }}
        >
          {saveState.phase === "saving" ? "Saving…" : "Create actor"}
        </button>
        {saveState.phase === "saved" && (
          <span style={{ fontSize: 12, color: tk.accent }}>
            Saved — appears in the Actors list within ~30s.
          </span>
        )}
        {saveState.phase === "error" && (
          <span role="alert" style={{ fontSize: 12, color: tk.danger }}>{saveState.message}</span>
        )}
      </div>
    </div>
  );
}
