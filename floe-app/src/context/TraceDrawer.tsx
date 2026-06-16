/**
 * TraceDrawer — side panel showing structured trace data for a selected event.
 * Loads synchronously from cached trace; offers on-demand work-log fetch via actor.
 *
 * Surface-vs-descend model:
 *   - The structured trace (telemetry rows + cost) is shown synchronously on expand.
 *   - Prose work-log is NOT auto-fetched; it is requested on demand via an explicit button,
 *     which emits an event asking the source actor to commit its work-log.
 *   - System-originated events (delivery_id === null) render a clear fallback instead of
 *     an empty drawer.
 */
import React from "react";
import type { EventEnvelope, EventTrace } from "../bus-client/types.ts";

export type TraceDrawerProps = {
  event: EventEnvelope;
  trace: EventTrace | null;
  onRequestWorklog?: (eventId: string, actorEndpointId: string) => void;
};

export function TraceDrawer({ event, trace, onRequestWorklog }: TraceDrawerProps): React.ReactElement {
  // System-originated: no delivery, no runtime trace
  const isSystemOriginated = trace !== null && trace.delivery_id === null;

  const actorId = event.source_endpoint_id;

  function handleRequestWorklog() {
    if (actorId && onRequestWorklog) {
      onRequestWorklog(event.event_id, actorId);
    }
  }

  return (
    <div data-testid="trace-drawer" role="region" aria-label="Event trace">
      {isSystemOriginated ? (
        <p data-testid="system-originated-notice">
          System-originated — no runtime trace
        </p>
      ) : trace !== null ? (
        <div data-testid="trace-content">
          <section aria-label="Telemetry entries">
            {trace.telemetry.length === 0 ? (
              <p>No telemetry entries recorded.</p>
            ) : (
              <ol>
                {(trace.telemetry as Array<Record<string, unknown>>).map((entry, i) => (
                  <li key={i}>
                    <pre>{JSON.stringify(entry, null, 2)}</pre>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="Delivery">
            <dl>
              <dt>Delivery ID</dt>
              <dd>{trace.delivery_id}</dd>
            </dl>
          </section>
        </div>
      ) : (
        <p>Loading trace…</p>
      )}

      {actorId && (
        <button
          data-testid="request-worklog-btn"
          onClick={handleRequestWorklog}
          aria-label={`Request work-log from ${actorId}`}
        >
          Request work-log from <span data-testid="actor-label">{actorId}</span>
        </button>
      )}
    </div>
  );
}
