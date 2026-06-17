/**
 * App — v6 shell: topbar + 240px left nav + resizable right inspector.
 *
 * Slice 1: scope-centric Home. Later slices will fill in contexts, actors,
 * activity, etc. in the main column and inspector.
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
  deleteScope,
  registerWorkspace,
  deleteWorkspace,
  getScopeProjection,
  listEndpoints,
  ScopeNotEmptyError,
} from "./bus-client/client.ts";
import { ScopeDetail } from "./scope/ScopeDetail.tsx";
import { ContextConversation } from "./scope/ContextConversation.tsx";
import { ContextInspector } from "./scope/ContextInspector.tsx";
import { ActorInspector } from "./actors/ActorInspector.tsx";
import { WorkspaceSettings } from "./workspace/WorkspaceSettings.tsx";
import { Activity } from "./activity/Activity.tsx";

// ---------------------------------------------------------------------------
// V6 design tokens — dark-mode-first, calm sage-slate accent
// ---------------------------------------------------------------------------

const tk = {
  canvas:       "#08090a",
  surface:      "#0f1011",
  surfaceHov:   "#191a1b",
  surfaceSunk:  "#0b0c0d",
  border:       "rgba(255,255,255,0.08)",
  border2:      "rgba(255,255,255,0.05)",
  ink:          "#f7f8f8",
  ink2:         "#d0d6e0",
  ink3:         "#8a8f98",
  ink4:         "#62666d",
  accent:       "#8aa89c",
  accentHov:    "#a1bcb1",
  accentSoft:   "#16201d",
  accentSoft2:  "#1f2c28",
  accentRing:   "rgba(138,168,156,0.28)",
  ok:           "#87b894",
  danger:       "#b85a5a",
  fontUi:       '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3, r2: 5, r3: 8,
} as const;

// ---------------------------------------------------------------------------
// Inspector width — persisted to localStorage
// ---------------------------------------------------------------------------

const RINSP_KEY = "floe.rinspW";
const RINSP_MIN = 260;
const RINSP_MAX = 720;
const RINSP_DEFAULT = 320;

function readRinspWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(RINSP_KEY) ?? "", 10);
    if (Number.isFinite(v) && v >= RINSP_MIN && v <= RINSP_MAX) return v;
  } catch { /* ignore */ }
  return RINSP_DEFAULT;
}

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
      }
      * { scrollbar-color: rgba(255,255,255,0.10) transparent; scrollbar-width: thin; }
      *::-webkit-scrollbar { width: 8px; height: 8px; }
      *::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
      button { font-family: inherit; cursor: pointer; }
      input, select { font-family: inherit; }
    `;
    document.head.appendChild(style);
  }, []);
  return <></>;
}

// ---------------------------------------------------------------------------
// Loading / error guards
// ---------------------------------------------------------------------------

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
// Workspace switcher dropdown
// ---------------------------------------------------------------------------

type WsSwitcherProps = {
  workspaces: WorkspaceRef[];
  active: WorkspaceRef;
  onSwitch: (id: string) => void;
  onAdd: (locator: string, name: string) => Promise<void>;
  onDelete: () => void;
  addErr: string | null;
};

function WorkspaceSwitcher({
  workspaces, active, onSwitch, onAdd, onDelete, addErr,
}: WsSwitcherProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [locator, setLocator] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setShowAdd(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  async function handleAdd() {
    if (!locator.trim()) return;
    setAdding(true);
    try {
      await onAdd(locator.trim(), name.trim());
      setLocator("");
      setName("");
      setShowAdd(false);
      setOpen(false);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => { setOpen(v => !v); setShowAdd(false); }}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: "transparent", border: `1px solid transparent`,
          padding: "4px 8px", borderRadius: tk.r2,
          fontFamily: tk.fontUi, fontWeight: 510, fontSize: 13,
          color: tk.ink, cursor: "pointer",
        }}
        onMouseEnter={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)";
          (e.currentTarget as HTMLButtonElement).style.borderColor = tk.border;
        }}
        onMouseLeave={e => {
          (e.currentTarget as HTMLButtonElement).style.background = "transparent";
          (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent";
        }}
        aria-label="Switch workspace"
        aria-expanded={open}
      >
        <span>{active.name || active.workspace_id}</span>
        <span style={{ color: tk.ink4, fontSize: 9 }}>▾</span>
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0,
          minWidth: 260, background: tk.surfaceHov,
          border: `1px solid ${tk.border}`,
          borderRadius: tk.r3,
          boxShadow: "0 0 0 1px rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.6)",
          padding: 4, zIndex: 60,
        }}>
          {workspaces.map(ws => (
            <button
              key={ws.workspace_id}
              onClick={() => { onSwitch(ws.workspace_id); setOpen(false); }}
              style={{
                display: "grid", gridTemplateColumns: "18px 1fr auto",
                gap: 8, alignItems: "center",
                width: "100%", padding: "8px 10px", borderRadius: tk.r2,
                background: "transparent", border: "none",
                textAlign: "left", fontSize: 13, color: tk.ink, cursor: "pointer",
              }}
              onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)"}
              onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
            >
              <span style={{ color: ws.workspace_id === active.workspace_id ? tk.accent : tk.ink4, fontSize: 11 }}>
                {ws.workspace_id === active.workspace_id ? "✓" : ""}
              </span>
              <span>{ws.name || ws.workspace_id}</span>
              <span style={{ color: tk.ink4, fontSize: 11, fontFamily: "monospace" }}>
                {ws.workspace_id.slice(0, 8)}
              </span>
            </button>
          ))}

          <div style={{ height: 1, background: tk.border2, margin: "4px 6px" }} />

          {/* Delete current workspace */}
          <button
            onClick={() => { onDelete(); setOpen(false); }}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              width: "100%", padding: "8px 10px", borderRadius: tk.r2,
              background: "transparent", border: "none",
              textAlign: "left", fontSize: 12, color: tk.danger, cursor: "pointer",
            }}
            onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)"}
            onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
          >
            <span style={{ width: 18, textAlign: "center" }}>×</span>
            <span>Remove "{active.name || active.workspace_id}"</span>
          </button>

          <div style={{ height: 1, background: tk.border2, margin: "4px 6px" }} />

          {/* Add workspace */}
          {!showAdd ? (
            <button
              onClick={() => setShowAdd(true)}
              style={{
                display: "flex", alignItems: "center", gap: 8,
                width: "100%", padding: "8px 10px", borderRadius: tk.r2,
                background: "transparent", border: "none",
                textAlign: "left", fontSize: 13, color: tk.accentHov, cursor: "pointer",
              }}
              onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.04)"}
              onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = "transparent"}
            >
              <span style={{ width: 18, textAlign: "center", color: tk.accentHov }}>+</span>
              <span>Register workspace…</span>
            </button>
          ) : (
            <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
              <input
                autoFocus
                placeholder="Workspace path"
                value={locator}
                onChange={e => setLocator(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleAdd(); if (e.key === "Escape") setShowAdd(false); }}
                style={{
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
                  borderRadius: tk.r2, padding: "5px 8px", fontSize: 12, color: tk.ink,
                }}
              />
              <input
                placeholder="Name (optional)"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void handleAdd(); if (e.key === "Escape") setShowAdd(false); }}
                style={{
                  background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
                  borderRadius: tk.r2, padding: "5px 8px", fontSize: 12, color: tk.ink,
                }}
              />
              {addErr && <p style={{ color: tk.danger, fontSize: 11, margin: 0 }}>{addErr}</p>}
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  onClick={() => void handleAdd()}
                  disabled={adding || !locator.trim()}
                  style={{
                    background: tk.accent, color: "#0c1714", border: "none",
                    borderRadius: tk.r2, padding: "4px 10px", fontSize: 12, cursor: "pointer",
                  }}
                >
                  {adding ? "Registering…" : "Register"}
                </button>
                <button
                  onClick={() => setShowAdd(false)}
                  style={{
                    background: "transparent", border: `1px solid ${tk.border}`,
                    color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left nav
// ---------------------------------------------------------------------------

type NavView = "home" | "activity";

type NavProps = {
  view: NavView;
  scopes: ScopeRef[];
  selectedScopeId: string | null;
  actors: EndpointRef[];
  selectedActorId: string | null;
  onView: (v: NavView) => void;
  onSelectScope: (id: string) => void;
  onSelectActor: (id: string) => void;
  onNewScope: () => void;
};

function LeftNav({
  view, scopes, selectedScopeId, actors, selectedActorId,
  onView, onSelectScope, onSelectActor, onNewScope,
}: NavProps): React.ReactElement {
  return (
    <aside style={{
      flex: "0 0 240px",
      width: 240,
      height: "100%",
      background: tk.surface,
      borderRight: `1px solid ${tk.border}`,
      overflowY: "auto",
      padding: "8px 0",
      display: "flex", flexDirection: "column",
    }}>
      {/* Home */}
      <NavRow
        label="Home"
        glyph="⌂"
        isOn={view === "home" && selectedScopeId === null}
        onClick={() => { onView("home"); onSelectScope(""); /* empty string → null in handleSelectScope */ }}
      />
      {/* Activity */}
      <NavRow
        label="Activity"
        glyph="≋"
        isOn={view === "activity"}
        onClick={() => { onView("activity"); onSelectScope(""); /* empty string → null in handleSelectScope; also clears context/actor/settings */ }}
      />

      {/* Scopes section */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "16px 14px 6px",
        fontWeight: 510, fontSize: 10.5, letterSpacing: "0.10em",
        textTransform: "uppercase", color: tk.ink3,
      }}>
        <span>Scopes</span>
        <span style={{ marginLeft: "auto", color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
          {scopes.length}
        </span>
      </div>

      {scopes.map(s => (
        <NavRow
          key={s.scope_id}
          label={s.title || s.scope_id}
          glyph={(s.title || s.scope_id).charAt(0).toUpperCase()}
          isOn={selectedScopeId === s.scope_id}
          onClick={() => onSelectScope(s.scope_id)}
        />
      ))}

      <NavRow
        label="New scope"
        glyph="+"
        isOn={false}
        onClick={onNewScope}
        faint
      />

      {/* Actors section */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "16px 14px 6px",
        fontWeight: 510, fontSize: 10.5, letterSpacing: "0.10em",
        textTransform: "uppercase", color: tk.ink3,
      }}>
        <span>Actors</span>
        <span style={{ marginLeft: "auto", color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontVariantNumeric: "tabular-nums", fontSize: 11 }}>
          {actors.length}
        </span>
      </div>

      {actors.map(a => (
        <NavRow
          key={a.endpoint_id}
          label={a.name || a.endpoint_id}
          glyph={(a.name || a.endpoint_id).charAt(0).toUpperCase()}
          isOn={selectedActorId === a.endpoint_id}
          onClick={() => onSelectActor(a.endpoint_id)}
        />
      ))}

      {actors.length === 0 && (
        <div style={{ padding: "4px 14px", fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
          No actors registered
        </div>
      )}
    </aside>
  );
}

function NavRow({
  label, glyph, isOn, onClick, faint, disabled, title,
}: {
  label: string;
  glyph: string;
  isOn: boolean;
  onClick: () => void;
  faint?: boolean;
  disabled?: boolean;
  title?: string;
}): React.ReactElement {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      title={title}
      disabled={disabled}
      style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "5px 14px",
        background: isOn ? "rgba(255,255,255,0.04)" : hov ? "rgba(255,255,255,0.03)" : "transparent",
        border: "none",
        borderLeft: isOn ? `2px solid ${tk.accent}` : "2px solid transparent",
        color: faint ? tk.ink4 : isOn ? tk.ink : hov ? tk.ink : tk.ink2,
        fontSize: 13, cursor: disabled ? "not-allowed" : "pointer",
        textAlign: "left", width: "100%",
        opacity: disabled ? 0.4 : 1,
        transition: "background 120ms ease, color 120ms ease",
      }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    >
      <span style={{
        width: 16, display: "inline-flex", alignItems: "center", justifyContent: "center",
        color: isOn ? tk.accent : faint ? tk.ink4 : tk.ink4, fontSize: 12, flexShrink: 0,
      }}>{glyph}</span>
      <span>{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Scope card stats — fetched lazily via getScopeProjection
// ---------------------------------------------------------------------------

type ScopeStats = { contexts: number; pulses: number } | null;

function useScopeStats(workspaceId: string, scopeId: string): ScopeStats {
  const [stats, setStats] = useState<ScopeStats>(null);
  useEffect(() => {
    let cancelled = false;
    getScopeProjection(workspaceId, scopeId)
      .then(p => {
        if (cancelled) return;
        setStats({ contexts: p.refs.contexts.length, pulses: p.refs.pulses.length });
      })
      .catch(() => {
        if (!cancelled) setStats({ contexts: 0, pulses: 0 });
      });
    return () => { cancelled = true; };
  }, [workspaceId, scopeId]);
  return stats;
}

function ScopeCard({
  scope,
  workspaceId,
  isSelected,
  onClick,
}: {
  scope: ScopeRef;
  workspaceId: string;
  isSelected: boolean;
  onClick: () => void;
}): React.ReactElement {
  const [hov, setHov] = useState(false);
  const stats = useScopeStats(workspaceId, scope.scope_id);
  const glyph = (scope.title || scope.scope_id).charAt(0).toUpperCase();

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", flexDirection: "column", gap: 8,
        padding: 14, textAlign: "left",
        background: isSelected ? tk.accentSoft : hov ? "#1f2022" : tk.surfaceHov,
        border: `1px solid ${isSelected ? "rgba(138,168,156,0.35)" : hov ? "rgba(255,255,255,0.12)" : tk.border}`,
        borderRadius: tk.r3, cursor: "pointer",
        transition: "border-color 120ms ease, background 120ms ease",
      }}
    >
      {/* Head row: glyph + name */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{
          width: 26, height: 26, borderRadius: 5,
          background: tk.accentSoft2, color: tk.accentHov,
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          fontWeight: 590, fontSize: 12, flexShrink: 0,
        }}>
          {glyph}
        </span>
        <span style={{ fontWeight: 510, color: tk.ink, fontSize: 13.5 }}>
          {scope.title || scope.scope_id}
        </span>
      </div>

      {/* Description */}
      {scope.description ? (
        <p style={{ color: tk.ink3, fontSize: 12.5, lineHeight: 1.45, margin: 0 }}>
          {scope.description}
        </p>
      ) : (
        <p style={{ color: tk.ink4, fontSize: 12, margin: 0, fontStyle: "italic" }}>No description</p>
      )}

      {/* Stats footer */}
      <div style={{
        display: "flex", gap: 14, paddingTop: 6, marginTop: 2,
        borderTop: `1px solid ${tk.border2}`,
        color: tk.ink3, fontSize: 11,
        fontVariantNumeric: "tabular-nums",
      }}>
        {stats ? (
          <>
            <span><b style={{ color: tk.ink, fontWeight: 510 }}>{stats.contexts}</b> contexts</span>
            <span><b style={{ color: tk.ink, fontWeight: 510 }}>{stats.pulses}</b> pulses</span>
          </>
        ) : (
          <span style={{ color: tk.ink4 }}>Loading…</span>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Create scope inline tile
// ---------------------------------------------------------------------------

function CreateScopeTile({ onCreated }: { onCreated: (title: string, description: string) => Promise<void> }): React.ReactElement {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hov, setHov] = useState(false);

  async function handleCreate() {
    const t = title.trim();
    if (!t) return;
    setCreating(true);
    setErr(null);
    try {
      await onCreated(t, description.trim());
      setTitle("");
      setDescription("");
      setEditing(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create scope");
    } finally {
      setCreating(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        onMouseEnter={() => setHov(true)}
        onMouseLeave={() => setHov(false)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          padding: 14,
          border: `1px dashed ${hov ? tk.accent : tk.border}`,
          borderRadius: tk.r3, background: "transparent",
          color: hov ? tk.accentHov : tk.ink3, fontSize: 13,
          cursor: "pointer",
          transition: "border-color 120ms ease, color 120ms ease",
        }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>+</span>
        <span>New scope</span>
      </button>
    );
  }

  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: 8, padding: 14,
      border: `1px solid ${tk.accent}`,
      borderRadius: tk.r3, background: tk.surfaceHov,
    }}>
      <input
        autoFocus
        placeholder="Scope title"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") void handleCreate(); if (e.key === "Escape") setEditing(false); }}
        style={{
          background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
          borderRadius: tk.r2, padding: "6px 8px", fontSize: 13, color: tk.ink,
          outline: "none",
        }}
      />
      <input
        placeholder="Description (optional)"
        value={description}
        onChange={e => setDescription(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") void handleCreate(); if (e.key === "Escape") setEditing(false); }}
        style={{
          background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
          borderRadius: tk.r2, padding: "6px 8px", fontSize: 13, color: tk.ink,
          outline: "none",
        }}
      />
      {err && <p style={{ color: tk.danger, fontSize: 12, margin: 0 }}>{err}</p>}
      <div style={{ display: "flex", gap: 6 }}>
        <button
          onClick={() => void handleCreate()}
          disabled={creating || !title.trim()}
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "5px 12px", fontSize: 12, cursor: "pointer",
            fontWeight: 510,
          }}
        >
          {creating ? "Creating…" : "Create"}
        </button>
        <button
          onClick={() => { setEditing(false); setErr(null); }}
          style={{
            background: "transparent", border: `1px solid ${tk.border}`,
            color: tk.ink3, borderRadius: tk.r2, padding: "5px 12px", fontSize: 12,
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home view — scope card grid
// ---------------------------------------------------------------------------

function HomeView({
  workspaceId,
  scopes,
  selectedScopeId,
  onSelectScope,
  onScopeCreated,
}: {
  workspaceId: string;
  scopes: ScopeRef[];
  selectedScopeId: string | null;
  onSelectScope: (id: string | null) => void;
  onScopeCreated: (title: string, description: string) => Promise<void>;
}): React.ReactElement {
  return (
    <div style={{ padding: "24px 32px 40px", overflow: "auto", flex: 1 }}>
      {/* Hero */}
      <section style={{ marginBottom: 24 }}>
        <div style={{
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510, marginBottom: 8,
        }}>
          Workspace
        </div>
        <h1 style={{
          fontWeight: 510, fontSize: 36, lineHeight: 1.08,
          letterSpacing: "-0.025em", color: tk.ink, margin: "0 0 8px",
        }}>
          {/* workspace name rendered in App, passed via context — here just "Home" */}
          Scopes
        </h1>
        <p style={{ color: tk.ink3, fontSize: 14, lineHeight: 1.55, maxWidth: "64ch" }}>
          Scopes are optional organizing boundaries. Open a scope to see its contexts.
          Direct work can live in contexts without a scope.
        </p>
      </section>

      {/* Section header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        margin: "0 0 12px",
        fontWeight: 510, fontSize: 11, letterSpacing: "0.08em",
        textTransform: "uppercase", color: tk.ink3,
      }}>
        <span>Scopes</span>
        <span style={{ color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
          {scopes.length}
        </span>
      </div>

      {/* Grid */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 10,
      }}>
        {scopes.map(s => (
          <ScopeCard
            key={s.scope_id}
            scope={s}
            workspaceId={workspaceId}
            isSelected={selectedScopeId === s.scope_id}
            onClick={() => onSelectScope(s.scope_id)}
          />
        ))}
        <CreateScopeTile onCreated={onScopeCreated} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scope inspector panel content
// ---------------------------------------------------------------------------

type DeleteState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "deleting" }
  | { phase: "error"; message: string }
  | { phase: "notEmpty"; context_count: number; pulse_count: number };

function ScopeInspector({
  scope,
  workspaceId,
  onDeleted,
}: {
  scope: ScopeRef;
  workspaceId: string;
  onDeleted: () => void;
}): React.ReactElement {
  const [deleteState, setDeleteState] = useState<DeleteState>({ phase: "idle" });
  const stats = useScopeStats(workspaceId, scope.scope_id);

  async function handleDelete() {
    setDeleteState({ phase: "deleting" });
    try {
      await deleteScope(workspaceId, scope.scope_id);
      onDeleted();
    } catch (err) {
      if (err instanceof ScopeNotEmptyError) {
        setDeleteState({ phase: "notEmpty", context_count: err.context_count, pulse_count: err.pulse_count });
      } else {
        setDeleteState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto" }}>
      {/* Head */}
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${tk.border}` }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
          Scope
        </div>
        <div style={{ fontSize: 17, fontWeight: 510, color: tk.ink, marginTop: 4, letterSpacing: "-0.01em" }}>
          {scope.title || scope.scope_id}
        </div>
        {scope.description && (
          <div style={{ fontSize: 12, color: tk.ink3, marginTop: 4, lineHeight: 1.45 }}>
            {scope.description}
          </div>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
          <StatRow label="Contexts" value={stats.contexts} />
          <StatRow label="Pulses" value={stats.pulses} />
        </div>
      )}

      {/* Delete action */}
      <div style={{ padding: "12px 16px" }}>
        {deleteState.phase === "idle" && (
          <button
            onClick={() => setDeleteState({ phase: "confirming" })}
            style={{
              background: "transparent", border: `1px solid ${tk.danger}`,
              color: tk.danger, borderRadius: tk.r2, padding: "5px 12px",
              fontSize: 12, cursor: "pointer", fontWeight: 510,
            }}
          >
            Delete scope
          </button>
        )}

        {deleteState.phase === "confirming" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ fontSize: 12, color: tk.ink2, lineHeight: 1.45 }}>
              Delete "{scope.title || scope.scope_id}"? This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => void handleDelete()}
                style={{
                  background: tk.danger, color: "#fff", border: "none",
                  borderRadius: tk.r2, padding: "5px 12px", fontSize: 12, cursor: "pointer",
                }}
              >
                Confirm delete
              </button>
              <button
                onClick={() => setDeleteState({ phase: "idle" })}
                style={{
                  background: "transparent", border: `1px solid ${tk.border}`,
                  color: tk.ink3, borderRadius: tk.r2, padding: "5px 12px", fontSize: 12,
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
            <p role="alert" style={{ fontSize: 12, color: tk.danger }}>{deleteState.message}</p>
            <button
              onClick={() => setDeleteState({ phase: "idle" })}
              style={{
                background: "transparent", border: `1px solid ${tk.border}`,
                color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
                alignSelf: "flex-start",
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {deleteState.phase === "notEmpty" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p role="alert" style={{ fontSize: 12, color: tk.ink2, lineHeight: 1.5 }}>
              Can't delete — scope has{" "}
              <strong style={{ color: tk.ink }}>{deleteState.context_count} context{deleteState.context_count !== 1 ? "s" : ""}</strong>
              {deleteState.pulse_count > 0 && (
                <> and{" "}
                  <strong style={{ color: tk.ink }}>{deleteState.pulse_count} pulse{deleteState.pulse_count !== 1 ? "s" : ""}</strong>
                </>
              )}.
              {" "}Remove them first.
            </p>
            <button
              onClick={() => setDeleteState({ phase: "idle" })}
              style={{
                background: "transparent", border: `1px solid ${tk.border}`,
                color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
                alignSelf: "flex-start",
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown in the inspector when a scope is selected but no context row has been clicked. */
function ScopeInspectorEmpty({ scope }: { scope: ScopeRef }): React.ReactElement {
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
        Scope
      </div>
      <div style={{ fontSize: 17, fontWeight: 510, color: tk.ink, marginTop: 4, letterSpacing: "-0.01em" }}>
        {scope.title || scope.scope_id}
      </div>
      <p style={{ marginTop: 14, fontSize: 12.5, color: tk.ink3, lineHeight: 1.5 }}>
        Click a context row to see its details.
      </p>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number | string }): React.ReactElement {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: "4px 0", fontSize: 13, borderBottom: `1px solid ${tk.border2}`,
    }}>
      <span style={{ color: tk.ink3 }}>{label}</span>
      <span style={{ color: tk.ink, fontVariantNumeric: "tabular-nums", fontWeight: 510 }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector default (nothing selected)
// ---------------------------------------------------------------------------

function DefaultInspector({ workspace }: { workspace: WorkspaceRef }): React.ReactElement {
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
        Workspace
      </div>
      <div style={{ fontSize: 17, fontWeight: 510, color: tk.ink, marginTop: 4, letterSpacing: "-0.01em" }}>
        {workspace.name || workspace.workspace_id}
      </div>
      <div style={{ fontSize: 12, color: tk.ink4, marginTop: 2 }}>
        {workspace.locator}
      </div>
      <p style={{ marginTop: 14, fontSize: 12.5, color: tk.ink3, lineHeight: 1.5 }}>
        Select a scope card to see its details and actions.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inspector resize handle (pointer-based drag)
// ---------------------------------------------------------------------------

function useInspectorResize(
  onWidthChange: (w: number) => void
): React.RefCallback<HTMLDivElement> {
  return useCallback((handle: HTMLDivElement | null) => {
    if (!handle) return;
    let dragging = false;

    function setWidth(clientX: number) {
      const next = Math.max(RINSP_MIN, Math.min(RINSP_MAX, window.innerWidth - clientX));
      onWidthChange(next);
      try { localStorage.setItem(RINSP_KEY, String(next)); } catch { /* ignore */ }
    }

    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      dragging = true;
      try { handle.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      setWidth(ev.clientX);
    });

    function end(ev: PointerEvent) {
      if (!dragging) return;
      dragging = false;
      try { (handle as HTMLDivElement).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  }, [onWidthChange]);
}

// ---------------------------------------------------------------------------
// No-workspaces screen
// ---------------------------------------------------------------------------

function RegisterWorkspaceScreen({
  onRegistered,
}: {
  onRegistered: (ws: WorkspaceRef) => void;
}): React.ReactElement {
  const [locator, setLocator] = useState("");
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleRegister() {
    if (!locator.trim()) return;
    setAdding(true);
    setErr(null);
    try {
      const ws = await registerWorkspace({ locator: locator.trim(), name: name.trim() || undefined, init_authorized: true });
      onRegistered(ws);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to register workspace");
    } finally {
      setAdding(false);
    }
  }

  return (
    <FullPageCenter>
      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 340 }}>
        <p style={{ color: tk.ink3, marginBottom: 4 }}>No workspaces. Register one to get started.</p>
        <input
          autoFocus
          placeholder="Workspace path"
          value={locator}
          onChange={e => setLocator(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void handleRegister(); }}
          style={{
            background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
            borderRadius: tk.r2, padding: "7px 10px", fontSize: 13, color: tk.ink, outline: "none",
          }}
        />
        <input
          placeholder="Name (optional)"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") void handleRegister(); }}
          style={{
            background: "rgba(255,255,255,0.04)", border: `1px solid ${tk.border}`,
            borderRadius: tk.r2, padding: "7px 10px", fontSize: 13, color: tk.ink, outline: "none",
          }}
        />
        {err && <p style={{ color: tk.danger, fontSize: 12 }}>{err}</p>}
        <button
          onClick={() => void handleRegister()}
          disabled={adding || !locator.trim()}
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "7px 16px", fontSize: 13, cursor: "pointer", fontWeight: 510,
          }}
        >
          {adding ? "Registering…" : "Register workspace"}
        </button>
      </div>
    </FullPageCenter>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<"loading" | "no-workspaces" | "error" | "ready">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceRef | null>(null);
  const [scopes, setScopes] = useState<ScopeRef[]>([]);
  const [actors, setActors] = useState<EndpointRef[]>([]);

  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null);
  const [selectedContextId, setSelectedContextId] = useState<string | null>(null);
  const [selectedContextLabel, setSelectedContextLabel] = useState<string | null>(null);
  const [selectedActorId, setSelectedActorId] = useState<string | null>(null);
  const [showWorkspaceSettings, setShowWorkspaceSettings] = useState(false);
  const [view, setView] = useState<NavView>("home");

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
    setSelectedScopeId(null);
    setSelectedContextId(null);
    setSelectedContextLabel(null);
    setSelectedActorId(null);
    setShowWorkspaceSettings(false);
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
  }, [workspaces, activeWorkspace]);

  const addWorkspace = useCallback(async (locator: string, name: string) => {
    setAddWsErr(null);
    try {
      const ws = await registerWorkspace({ locator, name: name || undefined, init_authorized: true });
      const refreshed = await listWorkspaces();
      setWorkspaces(refreshed);
      const [scs, eps] = await Promise.all([
        listScopes(ws.workspace_id),
        listEndpoints(ws.workspace_id).catch(() => [] as EndpointRef[]),
      ]);
      setActiveWorkspace(ws);
      setScopes(scs);
      setActors(eps);
      setSelectedScopeId(null);
      setSelectedActorId(null);
      setShowWorkspaceSettings(false);
      setAppState("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to register workspace";
      setAddWsErr(msg);
      throw new Error(msg);
    }
  }, []);

  const removeWorkspace = useCallback(async () => {
    if (!activeWorkspace) return;
    const name = activeWorkspace.name || activeWorkspace.workspace_id;
    if (!window.confirm(`Remove workspace "${name}"? This cannot be undone.`)) return;
    try {
      await deleteWorkspace(activeWorkspace.workspace_id, { delete_locator: false });
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
        setSelectedScopeId(null);
        setSelectedActorId(null);
        setShowWorkspaceSettings(false);
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
  }, [activeWorkspace]);

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
    setSelectedScopeId(scope.scope_id);
  }, [activeWorkspace, refreshScopes]);

  const handleScopeDeleted = useCallback(async () => {
    setSelectedScopeId(null);
    setSelectedContextId(null);
    setSelectedContextLabel(null);
    await refreshScopes();
  }, [refreshScopes]);

  const handleSelectScope = useCallback((id: string) => {
    setSelectedScopeId(id || null);
    setSelectedContextId(null);
    setSelectedContextLabel(null);
    setSelectedActorId(null);
    setShowWorkspaceSettings(false);
  }, []);

  const handleSelectContext = useCallback((id: string | null) => {
    setSelectedContextId(id);
    if (id === null) setSelectedContextLabel(null);
  }, []);

  const handleContextDeleted = useCallback(() => {
    setSelectedContextId(null);
    setSelectedContextLabel(null);
  }, []);

  const handleSelectActor = useCallback((id: string) => {
    setSelectedActorId(id);
    setSelectedScopeId(null);
    setSelectedContextId(null);
    setSelectedContextLabel(null);
    setShowWorkspaceSettings(false);
  }, []);

  const handleOpenWorkspaceSettings = useCallback(() => {
    setShowWorkspaceSettings(true);
    setSelectedScopeId(null);
    setSelectedContextId(null);
    setSelectedContextLabel(null);
    setSelectedActorId(null);
  }, []);

  const handleActorSaved = useCallback((updated: EndpointRef) => {
    setActors(prev => prev.map(a => a.endpoint_id === updated.endpoint_id ? updated : a));
    void refreshActors();
  }, [refreshActors]);

  const inspResizeRef = useInspectorResize(setInspWidth);

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

  const selectedScope = scopes.find(s => s.scope_id === selectedScopeId) ?? null;

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
            onClick={e => { e.preventDefault(); setSelectedScopeId(null); setSelectedContextId(null); setSelectedContextLabel(null); setSelectedActorId(null); setShowWorkspaceSettings(false); setView("home"); }}
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
            onDelete={() => void removeWorkspace()}
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
              background: showWorkspaceSettings ? "rgba(255,255,255,0.06)" : "transparent",
              border: `1px solid ${showWorkspaceSettings ? tk.border : "transparent"}`,
              color: showWorkspaceSettings ? tk.accent : tk.ink3,
              fontSize: 14, cursor: "pointer",
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
            onMouseLeave={e => { if (!showWorkspaceSettings) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
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
          {selectedScope && selectedContextId && selectedContextLabel && (
            <>
              <span style={{ color: tk.ink4, fontSize: 12 }}>/</span>
              <span style={{
                color: tk.ink2, fontSize: 13, fontWeight: 510, padding: "3px 6px", borderRadius: 4,
                maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {selectedContextLabel}
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
            view={view}
            scopes={scopes}
            selectedScopeId={selectedScopeId}
            actors={actors}
            selectedActorId={selectedActorId}
            onView={setView}
            onSelectScope={handleSelectScope}
            onSelectActor={handleSelectActor}
            onNewScope={() => {
              setSelectedScopeId(null); // focus back on home so create tile is visible
              setSelectedActorId(null);
              setShowWorkspaceSettings(false);
              setView("home");
            }}
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
            {showWorkspaceSettings ? (
              <WorkspaceSettings workspace={activeWorkspace} />
            ) : view === "home" && selectedScope && selectedContextId ? (
              <ContextConversation
                key={selectedContextId}
                contextId={selectedContextId}
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                onLabelResolved={setSelectedContextLabel}
              />
            ) : view === "home" && selectedScope ? (
              <ScopeDetail
                scope={selectedScope}
                workspaceId={activeWorkspace.workspace_id}
                selectedContextId={selectedContextId}
                onSelectContext={handleSelectContext}
                onScopeDeleted={() => void handleScopeDeleted()}
              />
            ) : view === "home" && !selectedActorId ? (
              <HomeView
                workspaceId={activeWorkspace.workspace_id}
                scopes={scopes}
                selectedScopeId={selectedScopeId}
                onSelectScope={id => setSelectedScopeId(id)}
                onScopeCreated={handleScopeCreated}
              />
            ) : view === "activity" ? (
              <Activity
                workspaceId={activeWorkspace.workspace_id}
                endpoints={actors}
                scopes={scopes}
              />
            ) : null}
          </main>

          {/* Right inspector */}
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
            <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: (selectedContextId || selectedActorId) ? 0 : "18px 16px 24px" }}>
              {selectedActorId && actors.find(a => a.endpoint_id === selectedActorId) ? (
                <ActorInspector
                  actor={actors.find(a => a.endpoint_id === selectedActorId)!}
                  workspaceId={activeWorkspace.workspace_id}
                  onSaved={handleActorSaved}
                />
              ) : selectedContextId && selectedScope ? (
                <ContextInspector
                  contextId={selectedContextId}
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
        </div>
      </div>
    </>
  );
}
