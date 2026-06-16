/**
 * ContextsList — lists ALL contexts in a workspace (scoped and unscoped),
 * newest first. Each row shows participants, scope tag, preview, and last activity.
 */
import React, { useEffect, useState } from "react";
import type { ContextRef } from "../bus-client/types.ts";
import { listContexts } from "../bus-client/client.ts";
import { colors, space, font } from "../theme.ts";

export type ContextsListProps = {
  workspaceId: string;
  onOpen: (contextId: string) => void;
};

function relativeTime(dateStr: string | null): string {
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

export function ContextsList({ workspaceId, onOpen }: ContextsListProps): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listContexts(workspaceId, { scope: "all" })
      .then((rows) => {
        if (cancelled) return;
        // Sort newest first by last_event_at, then created_at
        const sorted = [...rows].sort((a, b) => {
          const ta = a.last_event_at ?? a.created_at;
          const tb = b.last_event_at ?? b.created_at;
          return tb.localeCompare(ta);
        });
        setContexts(sorted);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load contexts");
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId]);

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        style={{ padding: space.xl, color: colors.muted, font: font.body }}
      >
        Loading contexts…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: space.xl, color: colors.danger, font: font.body }}>
        Error: {error}
      </div>
    );
  }

  if (contexts.length === 0) {
    return (
      <div role="status" style={{ padding: space.xl, color: colors.muted, font: font.body }}>
        No contexts yet in this workspace.
      </div>
    );
  }

  return (
    <div
      data-testid="contexts-list"
      role="list"
      aria-label="Contexts"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 0,
        font: font.body,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 2fr 1fr",
          padding: `${space.sm}px ${space.lg}px`,
          borderBottom: `1px solid ${colors.border}`,
          background: colors.surface,
          fontSize: font.meta,
          color: colors.muted,
          fontWeight: font.h,
          gap: space.sm,
        }}
      >
        <span>Participants</span>
        <span>Scope</span>
        <span>Preview</span>
        <span>Last activity</span>
      </div>

      {contexts.map((ctx) => (
        <div
          key={ctx.context_id}
          role="listitem"
          data-testid={`context-row-${ctx.context_id}`}
          onClick={() => onOpen(ctx.context_id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(ctx.context_id);
            }
          }}
          tabIndex={0}
          aria-label={`Context ${ctx.context_id}`}
          style={{
            display: "grid",
            gridTemplateColumns: "2fr 1fr 2fr 1fr",
            padding: `${space.md}px ${space.lg}px`,
            borderBottom: `1px solid ${colors.border}`,
            cursor: "pointer",
            gap: space.sm,
            alignItems: "center",
            background: colors.surface,
            transition: "background 0.08s",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = colors.canvas;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = colors.surface;
          }}
          onFocus={(e) => {
            (e.currentTarget as HTMLDivElement).style.outline = `2px solid ${colors.accent}`;
            (e.currentTarget as HTMLDivElement).style.outlineOffset = "-2px";
          }}
          onBlur={(e) => {
            (e.currentTarget as HTMLDivElement).style.outline = "none";
          }}
        >
          {/* Participants */}
          <div
            style={{
              fontSize: 13,
              color: colors.text,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {ctx.participants.length > 0
              ? ctx.participants.join(", ")
              : <span style={{ color: colors.muted }}>—</span>}
          </div>

          {/* Scope tag */}
          <div>
            {ctx.scope_id ? (
              <span
                style={{
                  display: "inline-block",
                  background: colors.bubbleOther,
                  borderRadius: 3,
                  padding: "1px 6px",
                  fontSize: font.meta,
                  color: colors.muted,
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {ctx.scope_id}
              </span>
            ) : (
              <span style={{ fontSize: font.meta, color: colors.muted }}>unscoped</span>
            )}
          </div>

          {/* Preview */}
          <div
            style={{
              fontSize: 13,
              color: ctx.first_message_preview ? colors.text : colors.muted,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontStyle: ctx.first_message_preview ? "normal" : "italic",
            }}
          >
            {ctx.first_message_preview ?? "No messages yet"}
          </div>

          {/* Last activity */}
          <div style={{ fontSize: font.meta, color: colors.muted }}>
            {relativeTime(ctx.last_event_at)}
          </div>
        </div>
      ))}
    </div>
  );
}
