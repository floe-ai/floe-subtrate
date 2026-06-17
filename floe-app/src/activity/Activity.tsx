/**
 * Activity — workspace-wide observatory.
 *
 * A reverse-chronological stream of every Event emitted in the active
 * workspace (GET /v1/events?workspace_id=...). The bus only supports
 * server-side filtering by workspace/scope/context/thread/since — Actor,
 * Kind, and Context chip filters here are client-side over the fetched page,
 * matching the read-only-list pattern already used by scope/Ops.tsx.
 *
 * Lifecycle/bookkeeping events (e.g. "context.scope_assigned") are hidden by
 * default — a chip reveals them. Each row shows a left-border category
 * ribbon (message / tool / event / delivery), the actor NAME (never a raw
 * endpoint id), a kind/description, the context NAME, and a relative time.
 */
import React, { useEffect, useMemo, useState } from "react";
import type { ContextRef, EndpointRef, EventEnvelope, ScopeRef } from "../bus-client/types.ts";
import { listContexts, listEvents } from "../bus-client/client.ts";
import { contextLabel } from "../scope/ScopeDetail.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx / ScopeDetail.tsx / Ops.tsx tk object)
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
  warn:         "#c9a14a",
  info:         "#6f9bd6",
  fontUi:       '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3, r2: 5, r3: 8,
} as const;

// ---------------------------------------------------------------------------
// Category model — left-border ribbon color keyed to category
// ---------------------------------------------------------------------------

export type EventCategory = "message" | "tool" | "event" | "delivery";

/** Lifecycle/bookkeeping event types hidden by default (toggle reveals them). */
const LIFECYCLE_TYPES = new Set<string>([
  "context.created",
  "context.scope_assigned",
]);

function isLifecycleEvent(ev: EventEnvelope): boolean {
  return LIFECYCLE_TYPES.has(ev.type);
}

/** Category derived from the event's `type`. Mirrors the v6 ribbon taxonomy. */
export function categoryOf(ev: EventEnvelope): EventCategory {
  if (ev.type === "message") return "message";
  if (ev.type.startsWith("tool.") || ev.type.startsWith("runtime_")) return "tool";
  if (ev.type === "webhook_received" || ev.type.startsWith("delivery.")) return "delivery";
  return "event";
}

const CATEGORY_COLOR: Record<EventCategory, string> = {
  message:  tk.accent,
  tool:     tk.info,
  event:    tk.ink4,
  delivery: tk.warn,
};

/** Short, human kind/description for the row's second segment. */
function kindLabel(ev: EventEnvelope): string {
  return ev.type;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function actorName(endpoints: EndpointRef[], endpointId: string | null): string {
  if (!endpointId) return "System";
  const ep = endpoints.find(e => e.endpoint_id === endpointId);
  return ep?.name || endpointId;
}

function contextLabelById(contexts: ContextRef[], contextId: string | null): string {
  if (!contextId) return "—";
  const ctx = contexts.find(c => c.context_id === contextId);
  return ctx ? contextLabel(ctx) : contextId;
}

function scopeTitleById(scopes: ScopeRef[], scopeId: string | null): string | null {
  if (!scopeId) return null;
  const s = scopes.find(sc => sc.scope_id === scopeId);
  return s?.title || scopeId;
}

// ---------------------------------------------------------------------------
// Chip filter bar
// ---------------------------------------------------------------------------

type FilterState = {
  actor: string | null;     // endpoint_id
  kind: string | null;      // event type
  scope: string | null;     // scope_id ("none" sentinel for unscoped)
  context: string | null;   // context_id
  showLifecycle: boolean;
};

const NO_SCOPE = "__none__";

function Chip({
  label,
  active,
  onClick,
  onClear,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  onClear?: () => void;
}): React.ReactElement {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "4px 10px", borderRadius: 999,
        background: active ? tk.accentSoft2 : hov ? "rgba(255,255,255,0.06)" : "transparent",
        border: `1px solid ${active ? "rgba(138,168,156,0.4)" : tk.border}`,
        color: active ? tk.accentHov : tk.ink2,
        fontSize: 12, cursor: "pointer", whiteSpace: "nowrap",
      }}
    >
      <span>{label}</span>
      {active && onClear && (
        <span
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          style={{ color: tk.ink4, fontSize: 11 }}
        >
          ×
        </span>
      )}
    </button>
  );
}

function ChipDropdown({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Array<{ id: string; label: string }>;
  value: string | null;
  onChange: (v: string | null) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const selected = value ? options.find(o => o.id === value) : null;

  return (
    <div style={{ position: "relative" }}>
      <Chip
        label={selected ? `${label}: ${selected.label}` : label}
        active={!!selected}
        onClick={() => setOpen(v => !v)}
        onClear={selected ? () => onChange(null) : undefined}
      />
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0,
            minWidth: 180, maxHeight: 280, overflowY: "auto",
            background: tk.surfaceHov, border: `1px solid ${tk.border}`,
            borderRadius: tk.r3, padding: 4, zIndex: 30,
            boxShadow: "0 16px 40px rgba(0,0,0,0.5)",
          }}
          onMouseLeave={() => setOpen(false)}
        >
          {options.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
              No options
            </div>
          )}
          {options.map(o => (
            <button
              key={o.id}
              onClick={() => { onChange(o.id); setOpen(false); }}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 10px", borderRadius: tk.r2,
                background: value === o.id ? "rgba(255,255,255,0.06)" : "transparent",
                border: "none", color: tk.ink, fontSize: 12.5, cursor: "pointer",
              }}
              onMouseEnter={e => (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.08)"}
              onMouseLeave={e => (e.currentTarget as HTMLButtonElement).style.background = value === o.id ? "rgba(255,255,255,0.06)" : "transparent"}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ActivityRow({
  event,
  endpoints,
  contexts,
  scopes,
}: {
  event: EventEnvelope;
  endpoints: EndpointRef[];
  contexts: ContextRef[];
  scopes: ScopeRef[];
}): React.ReactElement {
  const category = categoryOf(event);
  const scopeTitle = scopeTitleById(scopes, event.scope_id);

  return (
    <div
      data-testid={`activity-row-${event.event_id}`}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "9px 16px 9px 12px",
        borderLeft: `3px solid ${CATEGORY_COLOR[category]}`,
        borderBottom: `1px solid ${tk.border2}`,
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 510, color: tk.ink, flexShrink: 0 }}>
          {actorName(endpoints, event.source_endpoint_id)}
        </span>
        <span style={{ fontSize: 12, color: tk.ink3, overflow: "hidden", textOverflow: "ellipsis" }}>
          {kindLabel(event)}
        </span>
        <span style={{ fontSize: 11.5, color: tk.ink4 }}>
          in {contextLabelById(contexts, event.context_id)}
          {scopeTitle ? ` · ${scopeTitle}` : ""}
        </span>
      </div>
      <span style={{ fontSize: 11, color: tk.ink4, flexShrink: 0 }}>
        {relativeTime(event.created_at)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity — top-level export
// ---------------------------------------------------------------------------

export type ActivityProps = {
  workspaceId: string;
  endpoints: EndpointRef[];
  scopes: ScopeRef[];
};

const FETCH_LIMIT = 500;

export function Activity({ workspaceId, endpoints, scopes }: ActivityProps): React.ReactElement {
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>({
    actor: null, kind: null, scope: null, context: null, showLifecycle: false,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      listEvents({ workspace_id: workspaceId, limit: FETCH_LIMIT }),
      listContexts(workspaceId, { scope: "all" }).catch(() => [] as ContextRef[]),
    ])
      .then(([evRes, ctxs]) => {
        if (cancelled) return;
        setEvents(evRes.events);
        setContexts(ctxs);
        setLoading(false);
      })
      .catch(err => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load activity");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Reverse-chronological: bus returns ASC by (created_at, event_id); flip for display.
  const reversed = useMemo(() => [...events].reverse(), [events]);

  // Client-side filtering — the bus has no actor/kind filter on /v1/events.
  const filtered = useMemo(() => {
    return reversed.filter(ev => {
      if (!filter.showLifecycle && isLifecycleEvent(ev)) return false;
      if (filter.actor && ev.source_endpoint_id !== filter.actor) return false;
      if (filter.kind && ev.type !== filter.kind) return false;
      if (filter.context && ev.context_id !== filter.context) return false;
      if (filter.scope) {
        if (filter.scope === NO_SCOPE) {
          if (ev.scope_id !== null) return false;
        } else if (ev.scope_id !== filter.scope) {
          return false;
        }
      }
      return true;
    });
  }, [reversed, filter]);

  const actorOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) if (ev.source_endpoint_id) ids.add(ev.source_endpoint_id);
    return Array.from(ids).map(id => ({ id, label: actorName(endpoints, id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [events, endpoints]);

  const kindOptions = useMemo(() => {
    const kinds = new Set<string>();
    for (const ev of events) kinds.add(ev.type);
    return Array.from(kinds).sort().map(k => ({ id: k, label: k }));
  }, [events]);

  const scopeOptions = useMemo(() => {
    const present = new Set<string | null>();
    for (const ev of events) present.add(ev.scope_id);
    const opts: Array<{ id: string; label: string }> = [];
    for (const sc of scopes) {
      if (present.has(sc.scope_id)) opts.push({ id: sc.scope_id, label: sc.title || sc.scope_id });
    }
    if (present.has(null)) opts.push({ id: NO_SCOPE, label: "(unscoped)" });
    return opts;
  }, [events, scopes]);

  const contextOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) if (ev.context_id) ids.add(ev.context_id);
    return Array.from(ids).map(id => ({ id, label: contextLabelById(contexts, id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [events, contexts]);

  const hiddenLifecycleCount = useMemo(
    () => events.filter(isLifecycleEvent).length,
    [events]
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* Header */}
      <div style={{ padding: "20px 24px 12px", flexShrink: 0 }}>
        <div style={{
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510, marginBottom: 6,
        }}>
          Workspace
        </div>
        <h1 style={{
          fontWeight: 510, fontSize: 28, lineHeight: 1.1,
          letterSpacing: "-0.02em", color: tk.ink, margin: "0 0 4px",
        }}>
          Activity
        </h1>
        <p style={{ color: tk.ink3, fontSize: 13, margin: 0 }}>
          Every emit and event across the workspace, newest first.
        </p>
      </div>

      {/* Filter bar */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "0 24px 12px", flexShrink: 0,
      }}>
        <ChipDropdown
          label="Actor"
          options={actorOptions}
          value={filter.actor}
          onChange={v => setFilter(f => ({ ...f, actor: v }))}
        />
        <ChipDropdown
          label="Kind"
          options={kindOptions}
          value={filter.kind}
          onChange={v => setFilter(f => ({ ...f, kind: v }))}
        />
        <ChipDropdown
          label="Scope"
          options={scopeOptions}
          value={filter.scope}
          onChange={v => setFilter(f => ({ ...f, scope: v }))}
        />
        <ChipDropdown
          label="Context"
          options={contextOptions}
          value={filter.context}
          onChange={v => setFilter(f => ({ ...f, context: v }))}
        />

        <div style={{ width: 1, height: 18, background: tk.border, margin: "0 4px" }} />

        <Chip
          label={`Lifecycle ${filter.showLifecycle ? "shown" : `hidden${hiddenLifecycleCount > 0 ? ` (${hiddenLifecycleCount})` : ""}`}`}
          active={filter.showLifecycle}
          onClick={() => setFilter(f => ({ ...f, showLifecycle: !f.showLifecycle }))}
        />

        {(filter.actor || filter.kind || filter.scope || filter.context) && (
          <button
            onClick={() => setFilter({ actor: null, kind: null, scope: null, context: null, showLifecycle: filter.showLifecycle })}
            style={{
              background: "transparent", border: "none", color: tk.ink4,
              fontSize: 12, cursor: "pointer", textDecoration: "underline", padding: "4px 4px",
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Count bar */}
      <div style={{
        padding: "8px 24px", borderTop: `1px solid ${tk.border2}`,
        borderBottom: `1px solid ${tk.border}`,
        fontSize: 11.5, color: tk.ink3, flexShrink: 0,
        fontVariantNumeric: "tabular-nums",
      }}>
        {loading ? "Loading…" : `${filtered.length} emit${filtered.length !== 1 ? "s" : ""}`}
        {!loading && filtered.length !== events.length && (
          <span style={{ color: tk.ink4 }}> (of {events.length} total)</span>
        )}
      </div>

      {/* Stream */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {loading && <div style={{ padding: "16px 24px", color: tk.ink3, fontSize: 13 }}>Loading activity…</div>}
        {error && <div role="alert" style={{ padding: "16px 24px", color: tk.danger, fontSize: 13 }}>{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div style={{ padding: "24px", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
            {events.length === 0 ? "No activity in this workspace yet." : "No activity matches the current filters."}
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <div role="list" aria-label="Workspace activity">
            {filtered.map(ev => (
              <ActivityRow
                key={ev.event_id}
                event={ev}
                endpoints={endpoints}
                contexts={contexts}
                scopes={scopes}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
