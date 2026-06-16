/**
 * Timeline — horizontal scrubber across the workspace event stream.
 *
 * Paginates events via listEvents(since / next_cursor). Selecting an event
 * fetches its trace (getEventTrace) and displays the trace-back. Fully
 * keyboard-navigable; respects prefers-reduced-motion.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { listEvents, getEventTrace } from "../bus-client/client.ts";
import type { EventEnvelope, EventTrace } from "../bus-client/types.ts";
import { traceBack } from "./traceBack.ts";

export type TimelineProps = {
  workspaceId: string;
};

const PAGE_SIZE = 20;

export function Timeline({ workspaceId }: TimelineProps): React.ReactElement {
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [trace, setTrace] = useState<EventTrace | null>(null);
  const [traceLoading, setTraceLoading] = useState(false);

  const listRef = useRef<HTMLOListElement>(null);

  // Reduced-motion preference
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const load = useCallback(
    async (since?: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await listEvents({
          workspace_id: workspaceId,
          limit: PAGE_SIZE,
          since,
        });
        setEvents((prev) =>
          since ? [...prev, ...result.events] : result.events
        );
        setNextCursor(result.next_cursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load events");
      } finally {
        setLoading(false);
      }
    },
    [workspaceId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const selectEvent = useCallback(async (index: number) => {
    setSelectedIndex(index);
    setTrace(null);
    const ev = events[index];
    if (!ev) return;
    setTraceLoading(true);
    try {
      const t = await getEventTrace(ev.event_id);
      setTrace(t);
    } catch {
      setTrace(null);
    } finally {
      setTraceLoading(false);
    }
  }, [events]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (events.length === 0) return;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev === null ? 0 : Math.min(prev + 1, events.length - 1);
          void selectEvent(next);
          return next;
        });
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((prev) => {
          const next = prev === null ? 0 : Math.max(prev - 1, 0);
          void selectEvent(next);
          return next;
        });
      }
    },
    [events, selectEvent]
  );

  const selectedEvent =
    selectedIndex !== null ? events[selectedIndex] ?? null : null;
  const traceSummary = selectedEvent ? traceBack(selectedEvent) : null;

  return (
    <div
      data-testid="timeline"
      role="region"
      aria-label="Event timeline"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      style={{ outline: "none" }}
    >
      <div
        data-section="scrubber"
        role="scrollbar"
        aria-label="Event scrubber"
        aria-valuenow={selectedIndex ?? 0}
        aria-valuemin={0}
        aria-valuemax={Math.max(events.length - 1, 0)}
        style={{
          overflowX: "auto",
          display: "flex",
          gap: prefersReducedMotion ? "0" : "4px",
          padding: "8px 0",
          minHeight: "48px",
          alignItems: "center",
        }}
      >
        {events.map((ev, i) => (
          <button
            key={ev.event_id}
            data-event-id={ev.event_id}
            aria-label={`Event ${ev.type} at ${ev.created_at}`}
            aria-pressed={selectedIndex === i}
            onClick={() => void selectEvent(i)}
            style={{
              width: "12px",
              height: "32px",
              flexShrink: 0,
              cursor: "pointer",
              border: selectedIndex === i ? "2px solid #0070f3" : "1px solid #ccc",
              borderRadius: "2px",
              background: selectedIndex === i ? "#0070f3" : "#e0e0e0",
              padding: 0,
              transition: prefersReducedMotion ? "none" : "background 0.15s",
            }}
          />
        ))}
        {events.length === 0 && !loading && (
          <span style={{ color: "#888", fontSize: "0.875rem" }}>
            No events
          </span>
        )}
      </div>

      <div data-section="markers" aria-live="polite" aria-atomic="false">
        {loading && (
          <p role="status" aria-label="Loading events">
            Loading…
          </p>
        )}
        {error && (
          <p role="alert" style={{ color: "#c00" }}>
            {error}
          </p>
        )}
      </div>

      {nextCursor && (
        <button
          onClick={() => void load(nextCursor)}
          disabled={loading}
          aria-label="Load more events"
          style={{ marginTop: "4px" }}
        >
          {loading ? "Loading…" : "Load more"}
        </button>
      )}

      <div data-section="detail" aria-live="polite">
        {selectedEvent && (
          <section aria-label="Selected event detail">
            <dl>
              <dt>Event</dt>
              <dd>{selectedEvent.event_id}</dd>
              <dt>Type</dt>
              <dd>{selectedEvent.type}</dd>
              <dt>Created</dt>
              <dd>{selectedEvent.created_at}</dd>
            </dl>

            {traceSummary && (
              <section aria-label="Trace-back">
                {traceSummary.deliveryId && (
                  <p>Delivery: {traceSummary.deliveryId}</p>
                )}
                {traceSummary.correlationId && (
                  <p>Correlation: {traceSummary.correlationId}</p>
                )}
              </section>
            )}

            {traceLoading && (
              <p role="status" aria-label="Loading trace">
                Loading trace…
              </p>
            )}

            {trace && !traceLoading && (
              <section aria-label="Event trace">
                <p>Delivery ID: {trace.delivery_id ?? "none"}</p>
                <p>Telemetry entries: {trace.telemetry.length}</p>
              </section>
            )}
          </section>
        )}
      </div>

      <ol
        ref={listRef}
        data-section="event-list"
        aria-label="Event list"
        style={{ listStyle: "none", padding: 0, margin: 0 }}
      >
        {events.map((ev, i) => (
          <li
            key={ev.event_id}
            aria-selected={selectedIndex === i}
            style={{
              padding: "4px 8px",
              background: selectedIndex === i ? "#f0f7ff" : "transparent",
              cursor: "pointer",
            }}
            onClick={() => void selectEvent(i)}
          >
            <span style={{ fontWeight: 500 }}>{ev.type}</span>{" "}
            <span style={{ color: "#888", fontSize: "0.8rem" }}>
              {ev.created_at}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
