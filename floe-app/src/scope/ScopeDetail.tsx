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
  listContextsForScope,
  deleteScope,
  deleteContext,
  ScopeNotEmptyError,
} from "../bus-client/client.ts";
import { Ops } from "./Ops.tsx";

// ---------------------------------------------------------------------------
// Extension view registry
// ---------------------------------------------------------------------------

export interface ExtensionViewProps {
  workspaceId: string;
  scopeId: string;
  busBaseUrl: string;
  extensionName: string;
}

/** A registered extension view (one tab slot: "scope-detail-tab") */
export interface ExtensionViewEntry {
  id: string;         // unique key: extension name (e.g. "snowball")
  label: string;      // tab label (e.g. "Board")
  extensionName: string;
  /**
   * Component to render. For the stub/test placeholder this is a simple
   * functional component. The real extension component (SnowballBoard) is
   * wired here at integration-join time (see PR description).
   *
   * TODO(integration-join): replace placeholder with:
   *   import { SnowballBoard } from "@floe/ext-snowball/BoardView";
   * once snowball-ext-x2 track lands.
   */
  component: React.ComponentType<ExtensionViewProps>;
}

// Built-in placeholder stub — validates the registry mechanism without
// importing the (not-yet-existing) extension package.
function PlaceholderExtensionView({ extensionName, scopeId }: ExtensionViewProps): React.ReactElement {
  return (
    <div style={{ padding: 28, color: "#8a8f98", fontSize: 13, fontFamily: '"Inter Variable","Inter",-apple-system,system-ui,sans-serif' }}>
      <strong style={{ color: "#d0d6e0" }}>{extensionName}</strong> view — {scopeId}
      <br />
      <span style={{ fontSize: 11, color: "#62666d", marginTop: 8, display: "block" }}>
        (Placeholder: wiring to real extension component pending integration-join.)
      </span>
    </div>
  );
}

// In-memory view registry. The app fetches from GET /v1/extensions at mount
// and populates this with extension views for the scope-detail-tab slot.
// For the integration join, import the real component and replace Placeholder.
const BUS_BASE = "http://127.0.0.1:5377";

type ExtensionApiEntry = {
  name: string;
  workspace_id: string;
  views: Array<{ slot: string; label: string; component: string }>;
  errors: string[];
};

function useFetchedExtensionViews(workspaceId: string): ExtensionViewEntry[] {
  const [views, setViews] = useState<ExtensionViewEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5000);
    fetch(`${BUS_BASE}/v1/extensions?workspace_id=${encodeURIComponent(workspaceId)}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() as Promise<{ extensions: ExtensionApiEntry[] }> : null)
      .then(data => {
        if (cancelled || !data) return;
        const entries: ExtensionViewEntry[] = [];
        for (const ext of data.extensions) {
          for (const v of ext.views) {
            if (v.slot === "scope-detail-tab") {
              entries.push({
                id: ext.name,
                label: v.label,
                extensionName: ext.name,
                // TODO(integration-join): map v.component to real imported component
                component: PlaceholderExtensionView
              });
            }
          }
        }
        setViews(entries);
      })
      .catch(() => { /* extension views unavailable — degrade gracefully */ })
      .finally(() => clearTimeout(timeout));
    return () => { cancelled = true; ctrl.abort(); };
  }, [workspaceId]);
  return views;
}

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

/** Derive a human-readable label for a context.
 * Prefers `title` (extension-owned card title) over `first_message_preview`.
 */
export function contextLabel(ctx: ContextRef): string {
  const title = ctx.title?.trim();
  if (title) return title;
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

/** Built-in views (always present) */
const BUILTIN_VIEWS = [
  { id: "contexts", label: "Contexts" },
  { id: "ops",      label: "Ops" },
] as const;

type BuiltinViewId = (typeof BUILTIN_VIEWS)[number]["id"];
type ScopeDetailView = BuiltinViewId | string; // string for extension views

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

  // Fetch extension views for this workspace
  const extensionViews = useFetchedExtensionViews(workspaceId);

  const loadContexts = useCallback(() => {
    setLoading(true);
    setError(null);
    listContextsForScope(workspaceId, scope.scope_id)
      .then(rows => {
        // Sort newest first
        const sorted = [...rows].sort((a, b) => {
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
      {/* View toggle: Contexts / Ops / extension tabs                         */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        display: "flex", gap: 4, padding: "10px 28px 0",
        borderBottom: `1px solid ${tk.border}`, background: tk.surface, flexShrink: 0,
      }}>
        {BUILTIN_VIEWS.map(v => (
          <button
            key={v.id}
            onClick={() => setView(v.id)}
            aria-pressed={view === v.id}
            style={{
              background: "transparent", border: "none",
              borderBottom: `2px solid ${view === v.id ? tk.accent : "transparent"}`,
              color: view === v.id ? tk.ink : tk.ink3,
              padding: "6px 10px 8px",
              fontSize: 12.5, fontWeight: 510, cursor: "pointer",
              fontFamily: tk.fontUi, textTransform: "capitalize",
            }}
          >
            {v.label}
          </button>
        ))}
        {extensionViews.map(ev => (
          <button
            key={ev.id}
            onClick={() => setView(ev.id)}
            aria-pressed={view === ev.id}
            style={{
              background: "transparent", border: "none",
              borderBottom: `2px solid ${view === ev.id ? tk.accent : "transparent"}`,
              color: view === ev.id ? tk.ink : tk.ink3,
              padding: "6px 10px 8px",
              fontSize: 12.5, fontWeight: 510, cursor: "pointer",
              fontFamily: tk.fontUi,
            }}
          >
            {ev.label}
          </button>
        ))}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Body: Contexts list or Ops (events & pulses) or extension view       */}
      {/* ------------------------------------------------------------------ */}
      {view === "ops" ? (
        <Ops workspaceId={workspaceId} scopeId={scope.scope_id} />
      ) : (() => {
        // Check if current view is an extension view
        const extView = extensionViews.find(ev => ev.id === view);
        if (extView) {
          const ExtComponent = extView.component;
          return (
            <div style={{ flex: 1, overflow: "auto" }}>
              <ExtComponent
                workspaceId={workspaceId}
                scopeId={scope.scope_id}
                busBaseUrl={BUS_BASE}
                extensionName={extView.extensionName}
              />
            </div>
          );
        }
        // Default: Contexts view
        return (
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
      );
      })()
      }
    </div>
  );
}
