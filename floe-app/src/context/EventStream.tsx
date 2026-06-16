/**
 * EventStream — the readable spine of a Context.
 *
 * Surface-vs-descend model:
 *   - The stream shows emitted events in chronological order (the "surface").
 *   - Each row is expandable/collapsible to reveal its TraceDrawer (the "descend").
 *   - Keyboard-accessible: Enter/Space toggles the drawer.
 *   - Status is conveyed via text label, not color alone (WCAG AA).
 */
import React, { useState } from "react";
import type { EventEnvelope, EventTrace } from "../bus-client/types.ts";
import { getEventTrace } from "../bus-client/client.ts";
import { TraceDrawer } from "./TraceDrawer.tsx";

export type EventStreamProps = {
  events: EventEnvelope[];
  onEventSelect?: (eventId: string) => void;
};

type TraceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; trace: EventTrace }
  | { status: "error"; message: string };

export function EventStream({ events, onEventSelect }: EventStreamProps): React.ReactElement {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [traceCache, setTraceCache] = useState<Record<string, TraceState>>({});

  async function toggleEvent(eventId: string) {
    if (expanded === eventId) {
      setExpanded(null);
      return;
    }
    setExpanded(eventId);
    onEventSelect?.(eventId);

    // Load trace if not already cached
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
        <p>No events in this context yet.</p>
      )}
      {events.map((event) => {
        const isOpen = expanded === event.event_id;
        const traceState = traceCache[event.event_id] ?? { status: "idle" };

        let traceForDrawer: EventTrace | null = null;
        if (traceState.status === "loaded") {
          traceForDrawer = traceState.trace;
        }

        return (
          <div
            key={event.event_id}
            role="listitem"
            data-testid={`event-row-${event.event_id}`}
          >
            <div
              role="button"
              tabIndex={0}
              aria-expanded={isOpen}
              aria-controls={`trace-${event.event_id}`}
              onClick={() => void toggleEvent(event.event_id)}
              onKeyDown={(e) => handleKeyDown(e, event.event_id)}
              style={{ cursor: "pointer" }}
            >
              <span data-testid="event-type">{event.type}</span>
              <span data-testid="event-status">
                {isOpen ? " [expanded]" : " [collapsed]"}
              </span>
              <time dateTime={event.created_at}>{event.created_at}</time>
            </div>

            {isOpen && (
              <div id={`trace-${event.event_id}`} data-testid={`trace-panel-${event.event_id}`}>
                {traceState.status === "loading" && (
                  <p role="status">Loading trace…</p>
                )}
                {traceState.status === "error" && (
                  <p role="alert">Error loading trace: {traceState.message}</p>
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
