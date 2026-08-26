/**
 * ScopeDetail — main-area view shown when a scope is selected.
 *
 * Header: scope name + description.
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
  deleteContext,
} from "../bus-client/client.ts";
import { subscribeEvents } from "../bus-client/stream.ts";
import { Ops } from "./Ops.tsx";

export interface ExtensionViewProps {
  workspaceId: string;
  scopeId: string;
  busBaseUrl: string;
  extensionName: string;
}

/** A registered extension view (one tab slot: "scope-detail-tab") */
export interface ExtensionViewEntry {
  id: string;         // unique key: extension name (e.g. "acme")
  label: string;      // tab label (e.g. "Board")
  extensionName: string;
  component: React.ComponentType<ExtensionViewProps>;
}

function PlaceholderExtensionView({ extensionName, scopeId }: ExtensionViewProps): React.ReactElement {
  return (
    <div style={{ padding: 28, color: "#8a8f98", fontSize: 13, fontFamily: '"Inter Variable","Inter",-apple-system,system-ui,sans-serif' }}>
      <strong style={{ color: "#d0d6e0" }}>{extensionName}</strong> view — {scopeId}
      <br />
      <span style={{ fontSize: 11, color: "#62666d", marginTop: 8, display: "block" }}>
        Extension view not registered in the app build.
      </span>
    </div>
  );
}

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

    function doFetch() {
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
                  // External extension views are not loaded yet; runtime loading is not implemented.
                  // Declared views therefore render a placeholder.
                  component: PlaceholderExtensionView,
                });
              }
            }
          }
          setViews(entries);
        })
        .catch(() => { /* extension views unavailable — degrade gracefully */ })
        .finally(() => clearTimeout(timeout));
    }

    // Initial fetch (bridge may not be attached yet — that's OK; the WS push fixes it)
    doFetch();

    // Re-fetch when the bridge finishes attaching and reports extensions to the bus.
    // This closes the boot-race: if the app opens before the bridge is ready, the
    // push causes a second fetch without any manual refresh.
    const unsubscribe = subscribeEvents((msg) => {
      if (msg.type === "extensions_updated" &&
          (!msg.payload?.workspace_id || msg.payload.workspace_id === workspaceId)) {
        doFetch();
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
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

  // Auto-refresh contexts list on push: context_created (new context in this scope)
  // or event_submitted (updates last_event_at on a context, changing sort order).
  useEffect(() => {
    const unsub = subscribeEvents((msg) => {
      if (msg.type === "context_created") {
        const ctx = (msg.payload as { context?: { scope_id?: string; workspace_id?: string } }).context;
        if (ctx?.workspace_id === workspaceId && ctx?.scope_id === scope.scope_id) {
          loadContexts();
        }
      } else if (msg.type === "event_submitted") {
        const event = (msg.payload as { event?: { scope_id?: string; workspace_id?: string } }).event;
        if (event?.workspace_id === workspaceId && event?.scope_id === scope.scope_id) {
          loadContexts();
        }
      }
    });
    return unsub;
  }, [workspaceId, scope.scope_id, loadContexts]);

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
