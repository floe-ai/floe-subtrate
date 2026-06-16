/**
 * ContextTile — a custom @xyflow/react node representing a Context
 * in the Field lens.
 *
 * Renders: scope-tinted header, participant count, first_message_preview,
 * relative last_event_at, and an activity status badge.
 * Keyboard-focusable. WCAG AA contrast; reduced-motion respected.
 */
import React from "react";
import type { NodeProps, Node } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import type { ContextNodeData } from "./projectionToFlow.ts";

// ---------------------------------------------------------------------------
// Activity status derivation
// ---------------------------------------------------------------------------

type ActivityStatus = "active" | "waiting" | "idle";

function deriveStatus(lastEventAt: string | null): ActivityStatus {
  if (!lastEventAt) return "idle";
  const age = Date.now() - new Date(lastEventAt).getTime();
  if (age < 5 * 60 * 1000) return "active";   // < 5 min
  if (age < 60 * 60 * 1000) return "waiting"; // < 1 hour
  return "idle";
}

const STATUS_LABEL: Record<ActivityStatus, string> = {
  active: "Active",
  waiting: "Waiting",
  idle: "Idle",
};

const STATUS_COLOR: Record<ActivityStatus, string> = {
  active: "#22c55e",  // green-500 — passes AA on dark bg
  waiting: "#f59e0b", // amber-500
  idle: "#6b7280",    // gray-500
};

// ---------------------------------------------------------------------------
// Relative time helper
// ---------------------------------------------------------------------------

function relativeTime(isoDate: string | null): string {
  if (!isoDate) return "no activity";
  const diff = Date.now() - new Date(isoDate).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Styles — inline, no external CSS dependency beyond xyflow base.css
// ---------------------------------------------------------------------------

const TILE_WIDTH = 300;

const styles = {
  tile: {
    width: TILE_WIDTH,
    borderRadius: 8,
    border: "1.5px solid #334155",
    background: "#0f172a",
    boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
    fontFamily: "inherit",
    overflow: "hidden",
    cursor: "pointer",
  } as React.CSSProperties,
  header: {
    padding: "8px 12px",
    background: "#1e3a5f",
    borderBottom: "1px solid #334155",
    display: "flex",
    alignItems: "center",
    gap: 8,
  } as React.CSSProperties,
  scopeDot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#38bdf8",
    flexShrink: 0,
  } as React.CSSProperties,
  headerLabel: {
    flex: 1,
    fontSize: 11,
    fontWeight: 600,
    color: "#e2e8f0",
    letterSpacing: "0.04em",
    textTransform: "uppercase" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  statusBadge: (status: ActivityStatus): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: 10,
    fontWeight: 600,
    color: STATUS_COLOR[status],
    letterSpacing: "0.05em",
    textTransform: "uppercase" as const,
  }),
  statusDot: (status: ActivityStatus): React.CSSProperties => ({
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: STATUS_COLOR[status],
    // Reduced-motion: no animation on the dot by default
    // Pulsing is opt-in via CSS animation class if motion is allowed
  }),
  body: {
    padding: "10px 12px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 6,
  } as React.CSSProperties,
  preview: {
    fontSize: 13,
    color: "#cbd5e1",
    lineHeight: 1.5,
    overflow: "hidden",
    display: "-webkit-box",
    WebkitBoxOrient: "vertical" as const,
    WebkitLineClamp: 2,
  } as React.CSSProperties,
  meta: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 11,
    color: "#64748b",
  } as React.CSSProperties,
  participants: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    fontSize: 11,
    color: "#64748b",
  } as React.CSSProperties,
} as const;

// ---------------------------------------------------------------------------
// ContextTile node component
// ---------------------------------------------------------------------------

export type ContextTileNode = Node<ContextNodeData, "contextTile">;

export function ContextTile({ data, selected }: NodeProps<ContextTileNode>) {
  const { contextRef } = data;
  const status = deriveStatus(contextRef.last_event_at);
  // ScopeProjectionContextRef does not carry participants; show placeholder
  const participantCount: number = 0;

  const shortId = contextRef.context_id.slice(0, 8);
  const preview = contextRef.first_message_preview ?? "(no messages yet)";
  const timeAgo = relativeTime(contextRef.last_event_at);

  return (
    <div
      data-testid="context-tile"
      data-context-id={contextRef.context_id}
      tabIndex={0}
      role="button"
      aria-label={`Context ${shortId} — ${status}`}
      style={{
        ...styles.tile,
        outline: selected ? "2px solid #38bdf8" : "none",
        outlineOffset: 2,
      }}
    >
      {/* Handles for React Flow connections */}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />

      {/* Header */}
      <div style={styles.header} data-section="header">
        <div style={styles.scopeDot} aria-hidden="true" />
        <span style={styles.headerLabel}>ctx / {shortId}</span>
        <div style={styles.statusBadge(status)} aria-label={`Status: ${STATUS_LABEL[status]}`}>
          <div style={styles.statusDot(status)} aria-hidden="true" />
          {STATUS_LABEL[status]}
        </div>
      </div>

      {/* Body */}
      <div style={styles.body}>
        {/* First message preview */}
        <div style={styles.preview} data-section="preview">
          {preview}
        </div>

        {/* Meta row */}
        <div style={styles.meta}>
          <div style={styles.participants} data-section="participants">
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="8" cy="5" r="3" fill="#64748b" />
              <path
                d="M2 14c0-3.3 2.7-6 6-6s6 2.7 6 6"
                stroke="#64748b"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <span>{participantCount} participant{participantCount !== 1 ? "s" : ""}</span>
          </div>
          <span aria-label={`Last activity ${timeAgo}`}>{timeAgo}</span>
        </div>
      </div>
    </div>
  );
}
