/**
 * ScopeDetail — main-area view shown when a scope is selected.
 *
 * Header: scope name + description + Delete scope action (409 scope_not_empty
 * renders inline "Has N contexts, N pulses — remove them first").
 *
 * Body: list of contexts in that scope, shown by human label (never raw id as
 * primary). Each row: label + meta line + delete affordance.
 *
 * Empty state: "No contexts in this scope yet"
 */
import React, { useEffect, useState, useCallback } from "react";
import type { ScopeRef, ContextRef } from "../bus-client/types.ts";
import {
  listContexts,
  deleteScope,
  deleteContext,
  ScopeNotEmptyError,
} from "../bus-client/client.ts";
import { Ops } from "./Ops.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk object)
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
  ok:           "#87b894",
  danger:       "#b85a5a",
  fontUi:       '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3, r2: 5, r3: 8,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a human-readable label for a context. */
export function contextLabel(ctx: ContextRef): string {
  const preview = ctx.first_message_preview?.trim();
  if (preview) return preview;
  if (ctx.participants.length > 0) {
    return `Conversation (${ctx.participants.length} participant${ctx.participants.length !== 1 ? "s" : ""})`;
  }
  return "Conversation";
}

export function relativeTime(dateStr: string | null): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Delete scope button with inline states
// ---------------------------------------------------------------------------

type ScopeDeleteState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "deleting" }
  | { phase: "error"; message: string }
  | { phase: "notEmpty"; context_count: number; pulse_count: number };

function DeleteScopeAction({
  scope,
  workspaceId,
  onDeleted,
}: {
  scope: ScopeRef;
  workspaceId: string;
  onDeleted: () => void;
}): React.ReactElement {
  const [state, setState] = useState<ScopeDeleteState>({ phase: "idle" });

  async function handleDelete() {
    setState({ phase: "deleting" });
    try {
      await deleteScope(workspaceId, scope.scope_id);
      onDeleted();
    } catch (err) {
      if (err instanceof ScopeNotEmptyError) {
        setState({ phase: "notEmpty", context_count: err.context_count, pulse_count: err.pulse_count });
      } else {
        setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  if (state.phase === "idle") {
    return (
      <button
        onClick={() => setState({ phase: "confirming" })}
        style={{
          background: "transparent", border: `1px solid ${tk.danger}`,
          color: tk.danger, borderRadius: tk.r2, padding: "4px 12px",
          fontSize: 12, cursor: "pointer", fontWeight: 510,
          fontFamily: tk.fontUi,
        }}
      >
        Delete scope
      </button>
    );
  }

  if (state.phase === "confirming") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: tk.ink2 }}>
          Delete "{scope.title || scope.scope_id}"?
        </span>
        <button
          onClick={() => void handleDelete()}
          style={{
            background: tk.danger, color: "#fff", border: "none",
            borderRadius: tk.r2, padding: "4px 12px", fontSize: 12, cursor: "pointer",
            fontFamily: tk.fontUi,
          }}
        >
          Confirm
        </button>
        <button
          onClick={() => setState({ phase: "idle" })}
          style={{
            background: "transparent", border: `1px solid ${tk.border}`,
            color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
            fontFamily: tk.fontUi,
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  if (state.phase === "deleting") {
    return <span style={{ fontSize: 12, color: tk.ink3, fontFamily: tk.fontUi }}>Deleting…</span>;
  }

  if (state.phase === "notEmpty") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span role="alert" style={{ fontSize: 12, color: tk.ink2, lineHeight: 1.45 }}>
          Has{" "}
          <strong style={{ color: tk.ink }}>{state.context_count} context{state.context_count !== 1 ? "s" : ""}</strong>
          {state.pulse_count > 0 && (
            <>, <strong style={{ color: tk.ink }}>{state.pulse_count} pulse{state.pulse_count !== 1 ? "s" : ""}</strong></>
          )}
          {" "}— remove them first.
        </span>
        <button
          onClick={() => setState({ phase: "idle" })}
          style={{
            background: "transparent", border: `1px solid ${tk.border}`,
            color: tk.ink3, borderRadius: tk.r2, padding: "3px 8px", fontSize: 11,
            fontFamily: tk.fontUi,
          }}
        >
          Dismiss
        </button>
      </div>
    );
  }

  // error
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span role="alert" style={{ fontSize: 12, color: tk.danger }}>{state.message}</span>
      <button
        onClick={() => setState({ phase: "idle" })}
        style={{
          background: "transparent", border: `1px solid ${tk.border}`,
          color: tk.ink3, borderRadius: tk.r2, padding: "3px 8px", fontSize: 11,
          fontFamily: tk.fontUi,
        }}
      >
        Dismiss
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context row
// ---------------------------------------------------------------------------

export function ContextRow({
  ctx,
  isSelected,
  onClick,
  onDelete,
  isDeleting,
}: {
  ctx: ContextRef;
  isSelected: boolean;
  onClick: () => void;
  onDelete?: (e: React.MouseEvent) => void;
  isDeleting?: boolean;
}): React.ReactElement {
  const [hov, setHov] = useState(false);
  const label = contextLabel(ctx);
  const participantCount = ctx.participants.length;
  const lastActivity = relativeTime(ctx.last_event_at ?? ctx.created_at);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      aria-selected={isSelected}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        borderBottom: `1px solid ${tk.border2}`,
        background: isSelected ? tk.accentSoft : hov ? tk.surfaceHov : "transparent",
        borderLeft: `2px solid ${isSelected ? tk.accent : "transparent"}`,
        cursor: "pointer",
        transition: "background 100ms ease",
        opacity: isDeleting ? 0.4 : 1,
      }}
    >
      {/* Label + meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, color: tk.ink, fontWeight: 510,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          fontFamily: tk.fontUi,
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 11, color: tk.ink3, marginTop: 1,
          display: "flex", gap: 10, fontFamily: tk.fontUi,
        }}>
          <span>{participantCount} participant{participantCount !== 1 ? "s" : ""}</span>
          <span>{lastActivity}</span>
        </div>
      </div>

      {/* Delete affordance (omitted when onDelete is not provided, e.g. read-only lists) */}
      {onDelete && (
        <button
          onClick={e => { e.stopPropagation(); onDelete(e); }}
          disabled={isDeleting}
          aria-label={`Delete context: ${label}`}
          title="Delete context"
          style={{
            background: "transparent",
            border: `1px solid ${tk.danger}`,
            color: tk.danger,
            borderRadius: tk.r1,
            padding: "2px 8px",
            fontSize: 11,
            cursor: "pointer",
            fontFamily: tk.fontUi,
            flexShrink: 0,
            opacity: isDeleting ? 0.5 : 1,
          }}
          onMouseEnter={e => { if (!isDeleting) (e.currentTarget as HTMLButtonElement).style.background = "rgba(184,90,90,0.12)"; }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
        >
          {isDeleting ? "…" : "×"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScopeDetail props
// ---------------------------------------------------------------------------

export type ScopeDetailProps = {
  scope: ScopeRef;
  workspaceId: string;
  selectedContextId: string | null;
  onSelectContext: (id: string | null) => void;
  onScopeDeleted: () => void;
};

// ---------------------------------------------------------------------------
// ScopeDetail
// ---------------------------------------------------------------------------

type ScopeDetailView = "contexts" | "ops";

export function ScopeDetail({
  scope,
  workspaceId,
  selectedContextId,
  onSelectContext,
  onScopeDeleted,
}: ScopeDetailProps): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingContextId, setDeletingContextId] = useState<string | null>(null);
  const [view, setView] = useState<ScopeDetailView>("contexts");

  const loadContexts = useCallback(() => {
    setLoading(true);
    setError(null);
    listContexts(workspaceId, { scope: "scoped" })
      .then(rows => {
        // Filter to this scope only (API doesn't support scope_id filter)
        const filtered = rows.filter(c => c.scope_id === scope.scope_id);
        // Sort newest first
        const sorted = [...filtered].sort((a, b) => {
          const ta = a.last_event_at ?? a.created_at;
          const tb = b.last_event_at ?? b.created_at;
          return tb.localeCompare(ta);
        });
        setContexts(sorted);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Failed to load contexts");
        setLoading(false);
      });
  }, [workspaceId, scope.scope_id]);

  useEffect(() => {
    loadContexts();
  }, [loadContexts]);

  async function handleDeleteContext(ctx: ContextRef, e: React.MouseEvent) {
    e.stopPropagation();
    setDeletingContextId(ctx.context_id);
    try {
      await deleteContext(ctx.context_id);
      // If this was the selected context, clear it
      if (selectedContextId === ctx.context_id) {
        onSelectContext(null);
      }
      // Remove from list
      setContexts(prev => prev.filter(c => c.context_id !== ctx.context_id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to delete";
      // Treat 404 as already gone
      if (msg.includes("404")) {
        setContexts(prev => prev.filter(c => c.context_id !== ctx.context_id));
        if (selectedContextId === ctx.context_id) {
          onSelectContext(null);
        }
      } else {
        alert(msg);
      }
    } finally {
      setDeletingContextId(null);
    }
  }

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      fontFamily: tk.fontUi,
    }}>
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        padding: "20px 28px 16px",
        borderBottom: `1px solid ${tk.border}`,
        background: tk.surface,
        flexShrink: 0,
      }}>
        {/* Eyebrow */}
        <div style={{
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510, marginBottom: 4,
        }}>
          Scope
        </div>
        {/* Title row */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{
              margin: "0 0 4px", fontSize: 22, fontWeight: 510, color: tk.ink,
              letterSpacing: "-0.015em", lineHeight: 1.1,
            }}>
              {scope.title || scope.scope_id}
            </h2>
            {scope.description ? (
              <p style={{ margin: 0, fontSize: 13, color: tk.ink3, lineHeight: 1.45 }}>
                {scope.description}
              </p>
            ) : (
              <p style={{ margin: 0, fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
                No description
              </p>
            )}
          </div>
          {/* Delete scope action */}
          <div style={{ flexShrink: 0, paddingTop: 2 }}>
            <DeleteScopeAction
              scope={scope}
              workspaceId={workspaceId}
              onDeleted={onScopeDeleted}
            />
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* View toggle: Contexts / Ops                                          */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        display: "flex", gap: 4, padding: "10px 28px 0",
        borderBottom: `1px solid ${tk.border}`, background: tk.surface, flexShrink: 0,
      }}>
        {(["contexts", "ops"] as const).map(v => (
          <button
            key={v}
            onClick={() => setView(v)}
            aria-pressed={view === v}
            style={{
              background: "transparent", border: "none",
              borderBottom: `2px solid ${view === v ? tk.accent : "transparent"}`,
              color: view === v ? tk.ink : tk.ink3,
              padding: "6px 10px 8px",
              fontSize: 12.5, fontWeight: 510, cursor: "pointer",
              fontFamily: tk.fontUi, textTransform: "capitalize",
            }}
          >
            {v === "contexts" ? "Contexts" : "Ops"}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Body: Contexts list or Ops (events & pulses)                        */}
      {/* ------------------------------------------------------------------ */}
      {view === "ops" ? (
        <Ops workspaceId={workspaceId} scopeId={scope.scope_id} />
      ) : (
      <div style={{ flex: 1, overflow: "auto" }}>
        {/* Section header */}
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 28px 8px",
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

        {loading && (
          <div style={{ padding: "20px 28px", color: tk.ink3, fontSize: 13 }}>
            Loading contexts…
          </div>
        )}

        {error && (
          <div role="alert" style={{ padding: "16px 28px", color: tk.danger, fontSize: 13 }}>
            {error}
          </div>
        )}

        {!loading && !error && contexts.length === 0 && (
          <div style={{ padding: "32px 28px", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
            No contexts in this scope yet.
          </div>
        )}

        {!loading && !error && contexts.length > 0 && (
          <div role="list" aria-label="Contexts in scope">
            {contexts.map(ctx => (
              <ContextRow
                key={ctx.context_id}
                ctx={ctx}
                isSelected={selectedContextId === ctx.context_id}
                onClick={() => onSelectContext(ctx.context_id)}
                onDelete={e => void handleDeleteContext(ctx, e)}
                isDeleting={deletingContextId === ctx.context_id}
              />
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}
