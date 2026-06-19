import React, { useState, useEffect } from "react";
import type { ScopeRef } from "../../bus-client/types.ts";
import { getScopeProjection } from "../../bus-client/client.ts";
import { tk } from "../../theme.ts";

export type ScopeStats = { contexts: number; pulses: number } | null;

export function useScopeStats(workspaceId: string, scopeId: string): ScopeStats {
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

export type ScopeCardProps = {
  scope: ScopeRef;
  workspaceId: string;
  isSelected: boolean;
  onClick: () => void;
};

export function ScopeCard({
  scope,
  workspaceId,
  isSelected,
  onClick,
}: ScopeCardProps): React.ReactElement {
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

export type CreateScopeTileProps = {
  onCreated: (title: string, description: string) => Promise<void>;
};

export function CreateScopeTile({ onCreated }: CreateScopeTileProps): React.ReactElement {
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

export type HomeViewProps = {
  workspaceId: string;
  scopes: ScopeRef[];
  selectedScopeId: string | null;
  onSelectScope: (id: string | null) => void;
  onScopeCreated: (title: string, description: string) => Promise<void>;
};

export function HomeView({
  workspaceId,
  scopes,
  selectedScopeId,
  onSelectScope,
  onScopeCreated,
}: HomeViewProps): React.ReactElement {
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
