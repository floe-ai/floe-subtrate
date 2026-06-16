/**
 * EventStream — the readable spine of a Context.
 *
 * Neutral rendering: events from the acting actor align right (bubbleOwn),
 * others left (bubbleOther). Non-"message" events render as centered system notes.
 * Each event with a producing delivery gets a "Show work" disclosure → getEventTrace.
 */
import React, { useState } from "react";
import type { EventEnvelope, EventTrace } from "../bus-client/types.ts";
import { getEventTrace } from "../bus-client/client.ts";
import { TraceDrawer } from "./TraceDrawer.tsx";
import { colors, space, font } from "../theme.ts";

export type EventStreamProps = {
  events: EventEnvelope[];
  actingAsEndpointId?: string;
  onEventSelect?: (eventId: string) => void;
};

type TraceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; trace: EventTrace }
  | { status: "error"; message: string };

function formatTime(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

export function EventStream({
  events,
  actingAsEndpointId,
  onEventSelect,
}: EventStreamProps): React.ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [traceCache, setTraceCache] = useState<Record<string, TraceState>>({});

  async function toggleEvent(eventId: string) {
    if (expanded === eventId) {
      setExpanded(null);
      return;
    }
    setExpanded(eventId);
    onEventSelect?.(eventId);

    if (!traceCache[eventId] || traceCache[eventId].status === "idle") {
      setTraceCache((prev) => ({ ...prev, [eventId]: { status: "loading" } }));
      try {
        const trace = await getEventTrace(eventId);
        setTraceCache((prev) => ({ ...prev, [eventId]: { status: "loaded", trace } }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setTraceCache((prev) => ({ ...prev, [eventId]: { status: "error", message } }));
      }
    }
  }

  function handleKeyDown(e: React.KeyboardEvent, eventId: string) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void toggleEvent(eventId);
    }
  }

  return (
    <div data-testid="event-stream" role="list" aria-label="Context events">
      {events.length === 0 && (
        <p style={{ color: colors.muted, fontStyle: "italic", font: font.body }}>
          No events in this context yet.
        </p>
      )}

      {events.map((event) => {
        const isOwn = event.source_endpoint_id === actingAsEndpointId;
        const isMessage = event.type === "message";
        const isOpen = expanded === event.event_id;
        const traceState = traceCache[event.event_id] ?? { status: "idle" };
        const traceForDrawer =
          traceState.status === "loaded" ? traceState.trace : null;

        // System note: non-message events (no source or non-message type)
        const isSystemNote = !isMessage || !event.source_endpoint_id;

        if (isSystemNote) {
          return (
            <div
              key={event.event_id}
              role="listitem"
              data-testid={`event-row-${event.event_id}`}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                margin: `${space.sm}px 0`,
              }}
            >
              <div
                style={{
                  fontSize: font.meta,
                  color: colors.muted,
                  background: colors.canvas,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 12,
                  padding: `2px ${space.md}px`,
                  textAlign: "center",
                }}
              >
                <span data-testid="event-type">{event.type}</span>
                {" · "}
                <time dateTime={event.created_at}>{formatTime(event.created_at)}</time>
              </div>
            </div>
          );
        }

        // Message bubble
        return (
          <div
            key={event.event_id}
            role="listitem"
            data-testid={`event-row-${event.event_id}`}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: isOwn ? "flex-end" : "flex-start",
              margin: `${space.sm}px 0`,
            }}
          >
            {/* Author + time */}
            <div
              style={{
                fontSize: font.meta,
                color: colors.muted,
                marginBottom: 2,
                display: "flex",
                gap: space.xs,
              }}
            >
              {!isOwn && (
                <span>{event.source_endpoint_id}</span>
              )}
              <time dateTime={event.created_at}>{formatTime(event.created_at)}</time>
              {isOwn && (
                <span>{event.source_endpoint_id}</span>
              )}
            </div>

            {/* Bubble */}
            <div
              style={{
                background: isOwn ? colors.bubbleOwn : colors.bubbleOther,
                borderRadius: 12,
                padding: `${space.sm}px ${space.md}px`,
                maxWidth: "70%",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 14,
                color: colors.text,
              }}
            >
              {typeof event.content["text"] === "string"
                ? event.content["text"]
                : JSON.stringify(event.content)}
            </div>

            {/* "Show work" disclosure */}
            <div style={{ marginTop: 2 }}>
              <button
                data-testid={`show-work-${event.event_id}`}
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                aria-controls={`trace-${event.event_id}`}
                onClick={() => void toggleEvent(event.event_id)}
                onKeyDown={(e) => handleKeyDown(e, event.event_id)}
                style={{
                  background: "none",
                  border: "none",
                  color: colors.muted,
                  cursor: "pointer",
                  fontSize: font.meta,
                  padding: 0,
                  textDecoration: "underline",
                }}
                onFocus={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.outline = `2px solid ${colors.accent}`;
                  (e.currentTarget as HTMLButtonElement).style.outlineOffset = "2px";
                }}
                onBlur={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.outline = "none";
                }}
              >
                <span data-testid="event-status">
                  {isOpen ? "Hide work" : "Show work"}
                </span>
              </button>
            </div>

            {/* Trace panel */}
            {isOpen && (
              <div
                id={`trace-${event.event_id}`}
                data-testid={`trace-panel-${event.event_id}`}
                style={{
                  marginTop: space.xs,
                  width: "70%",
                  background: colors.surface,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 8,
                  padding: space.md,
                }}
              >
                {traceState.status === "loading" && (
                  <p role="status" style={{ color: colors.muted, fontSize: font.meta }}>
                    Loading trace…
                  </p>
                )}
                {traceState.status === "error" && (
                  <p role="alert" style={{ color: colors.danger, fontSize: font.meta }}>
                    Error loading trace: {traceState.message}
                  </p>
                )}
                {(traceState.status === "loaded" || traceState.status === "idle") && (
                  <TraceDrawer event={event} trace={traceForDrawer} />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
