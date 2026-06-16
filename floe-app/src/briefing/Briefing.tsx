/**
 * Briefing — the operator's landing / "lean back" surface.
 *
 * Sections:
 *  1. What's waiting on you — WaitingItems (pending responses addressed to the operator)
 *  2. What's in flight    — endpoints currently active/working
 *  3. What changed since you were here — events after the watermark
 *  4. Tide-line           — upcoming Pulse fires
 *
 * Data is loaded on mount. After the operator views the "since" feed, the
 * watermark is advanced to the latest next_cursor.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  WaitingItem as WaitingItemType,
  EndpointRef,
  EventEnvelope,
  PulseRef,
} from "../bus-client/types.ts";
import {
  emit,
  getWatermark,
  listEndpoints,
  listEvents,
  listPendingResponses,
  listPulses,
  putWatermark,
} from "../bus-client/client.ts";
import { WaitingItem } from "./WaitingItem.tsx";
import { InFlight } from "./InFlight.tsx";
import { TideLine } from "./TideLine.tsx";
import { sinceDiff } from "./sinceDiff.ts";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type BriefingProps = {
  /** The workspace this briefing is scoped to. */
  workspaceId: string;
  /**
   * The endpoint_id of the current operator — used for the watermark seam
   * and for filtering "what's waiting on you" to items addressed to the operator.
   * When absent the watermark feature is disabled (unseen feed always empty)
   * and all pending items are shown.
   */
  operatorEndpointId?: string;
  /**
   * Called when the operator clicks "Open in context →" on a waiting item.
   * Receives the context_id (thread_id from the pending response).
   */
  onOpenContext?: (contextId: string) => void;
};

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------

type BriefingData = {
  items: WaitingItemType[];
  endpoints: EndpointRef[];
  pulses: PulseRef[];
  unseenEvents: EventEnvelope[];
  seenEvents: EventEnvelope[];
  /** next_cursor returned from the unseen-feed listEvents call */
  nextCursor: string | null;
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLES = {
  root: {
    maxWidth: 800,
    margin: "0 auto",
    padding: "1.5rem",
    fontFamily: "system-ui, sans-serif",
    color: "#1a1a1a",
  } as React.CSSProperties,
  header: {
    borderBottom: "2px solid #1a1a1a",
    marginBottom: "1.5rem",
    paddingBottom: "0.5rem",
  } as React.CSSProperties,
  section: {
    marginBottom: "2rem",
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: "1rem",
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: "#555",
    marginBottom: "0.75rem",
  } as React.CSSProperties,
  error: {
    border: "1px solid #b00",
    borderRadius: 4,
    padding: "0.75rem",
    background: "#fff0f0",
    color: "#b00",
  } as React.CSSProperties,
  unseenBanner: {
    background: "#f0f7ff",
    border: "1px solid #99c",
    borderRadius: 4,
    padding: "0.5rem 0.75rem",
    marginBottom: "0.5rem",
  } as React.CSSProperties,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadBriefingData(
  workspaceId: string,
  operatorEndpointId: string | undefined
): Promise<BriefingData> {
  // Fetch in parallel where possible
  const [pending, endpoints, pulses, wm] = await Promise.all([
    listPendingResponses(workspaceId),
    listEndpoints(workspaceId),
    listPulses(workspaceId),
    operatorEndpointId
      ? getWatermark(workspaceId, operatorEndpointId)
      : Promise.resolve(null),
  ]);

  // Workspace events for joining to pending responses — fetch without since
  const { events: allEvents } = await listEvents({ workspace_id: workspaceId });

  // Build a lookup: event_id → EventEnvelope
  const eventById = new Map<string, EventEnvelope>(allEvents.map((ev) => [ev.event_id, ev]));
  const endpointById = new Map<string, EndpointRef>(endpoints.map((ep) => [ep.endpoint_id, ep]));

  // Build WaitingItems — filtered to pending responses addressed to the operator.
  // Filter rule: the source event's destination must be the operator (endpoint match)
  // OR a broadcast. If operatorEndpointId is undefined, show all (fallback).
  const items: WaitingItemType[] = pending.flatMap((pr) => {
    const sourceEvent = eventById.get(pr.source_event_id);
    if (!sourceEvent) return []; // can't build item without source event

    // Filter to events addressed to the operator
    if (operatorEndpointId) {
      const dest = sourceEvent.destination_json;
      const addressedToOperator =
        (dest.kind === "endpoint" && dest.endpoint_id === operatorEndpointId) ||
        dest.kind === "broadcast";
      if (!addressedToOperator) return [];
    }

    const askingActor =
      sourceEvent.source_endpoint_id
        ? endpointById.get(sourceEvent.source_endpoint_id)
        : undefined;
    if (!askingActor) return []; // can't attribute without an actor

    return [{ source: pr, eventContent: sourceEvent.content, askingActor }];
  });

  // Unseen events — events after the watermark boundary
  const boundary = wm
    ? { created_at: wm.cursor, event_id: "" }
    : null;
  const { seen: seenEvents, unseen: unseenEvents } = sinceDiff(allEvents, boundary);

  // Also fetch the dedicated unseen feed to get next_cursor
  let nextCursor: string | null = null;
  if (wm) {
    const unseenFeed = await listEvents({
      workspace_id: workspaceId,
      since: wm.cursor,
    });
    nextCursor = unseenFeed.next_cursor;
  }

  return { items, endpoints, pulses, unseenEvents, seenEvents, nextCursor };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Briefing({ workspaceId, operatorEndpointId, onOpenContext }: BriefingProps): React.ReactElement {
  const [data, setData] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const watermarkAdvanced = useRef(false);

  // Load on mount
  useEffect(() => {
    setLoading(true);
    setError(null);

    loadBriefingData(workspaceId, operatorEndpointId)
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [workspaceId, operatorEndpointId]);

  // Advance watermark once the operator has seen the briefing
  useEffect(() => {
    if (!data || !operatorEndpointId || !data.nextCursor || watermarkAdvanced.current) return;
    watermarkAdvanced.current = true;
    putWatermark(workspaceId, operatorEndpointId, data.nextCursor).catch(() => {
      // best-effort — don't crash the UI on watermark failure
    });
  }, [data, workspaceId, operatorEndpointId]);

  // Wire WaitingItem.onReply → emit a canonical message event
  const handleReply = useCallback(
    (item: WaitingItemType, text: string) => {
      if (!operatorEndpointId) return;
      const { source } = item;

      emit({
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: operatorEndpointId,
        destination: { kind: "endpoint", endpoint_id: source.waiting_endpoint_id },
        context_id: source.thread_id ?? null,
        ...(source.correlation_id ? { correlation_id: source.correlation_id } : {}),
        content: { text },
        response: { expected: true, mode: "open" },
        metadata: { submitted_by: "floe-app" },
      }).catch(() => {
        // best-effort
      });
    },
    [workspaceId, operatorEndpointId]
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (loading) {
    return (
      <div data-testid="briefing" style={STYLES.root}>
        <p aria-live="polite">Loading briefing…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="briefing" style={STYLES.root}>
        <div style={STYLES.error} role="alert">
          Failed to load briefing: {error}
        </div>
      </div>
    );
  }

  if (!data) return <div data-testid="briefing" />;

  const { items, endpoints, pulses, unseenEvents } = data;

  return (
    <div data-testid="briefing" style={STYLES.root}>
      <header style={STYLES.header}>
        <h1 style={{ margin: 0 }}>Briefing</h1>
      </header>

      {/* Section 1: What's waiting on you */}
      <section style={STYLES.section} data-section="decisions" aria-label="What's waiting on you">
        <h2 style={STYLES.sectionTitle}>What&apos;s waiting on you</h2>
        {items.length === 0 ? (
          <p style={{ color: "#888", fontStyle: "italic" }}>Nothing waiting.</p>
        ) : (
          items.map((item) => (
            <WaitingItem
              key={item.source.pending_id}
              item={item}
              onReply={(text) => handleReply(item, text)}
              onOpenContext={() => item.source.thread_id && onOpenContext?.(item.source.thread_id)}
            />
          ))
        )}
      </section>

      {/* Section 2: What's in flight */}
      <section style={STYLES.section} data-section="in-flight">
        <InFlight endpoints={endpoints} />
      </section>

      {/* Section 3: What changed since you were here */}
      <section style={STYLES.section} data-section="activity" aria-label="What changed since you were here">
        <h2 style={STYLES.sectionTitle}>Since you were here</h2>
        {unseenEvents.length === 0 ? (
          <p style={{ color: "#888", fontStyle: "italic" }}>No new events.</p>
        ) : (
          <div style={STYLES.unseenBanner}>
            <strong>{unseenEvents.length}</strong> new event{unseenEvents.length !== 1 ? "s" : ""} since last visit.
            <ul style={{ margin: "0.5rem 0 0", paddingLeft: "1.25rem" }}>
              {unseenEvents.slice(0, 10).map((ev) => (
                <li key={ev.event_id} style={{ fontSize: "0.85rem", color: "#334" }}>
                  <code>{ev.type}</code> · {new Date(ev.created_at).toLocaleString()}
                </li>
              ))}
              {unseenEvents.length > 10 && (
                <li style={{ color: "#668", fontSize: "0.85rem" }}>
                  …and {unseenEvents.length - 10} more
                </li>
              )}
            </ul>
          </div>
        )}
      </section>

      {/* Section 4: Tide-line */}
      <section style={STYLES.section} data-section="tide-line">
        <TideLine pulses={pulses} />
      </section>
    </div>
  );
}
