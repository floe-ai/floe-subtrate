/**
 * ContextView — full view of a single Context.
 *
 * Loads context + events on mount; subscribes to the live event stream and
 * appends events whose payload context_id matches. Auto-scrolls when at bottom.
 * Renders EventStream + Composer.
 */
import React, { useEffect, useRef, useState } from "react";
import type { ContextRef, EventEnvelope, EmitInput, EndpointRef } from "../bus-client/types.ts";
import {
  getContext,
  listContextEvents,
  emit,
  subscribeEvents,
} from "../bus-client/client.ts";
import { EventStream } from "./EventStream.tsx";
import { Composer } from "./Composer.tsx";
import { colors, space, font } from "../theme.ts";

export type ContextViewProps = {
  contextId: string;
  actingAsEndpointId: string;
  endpoints: EndpointRef[];
};

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; context: ContextRef; events: EventEnvelope[] }
  | { status: "error"; message: string };

export function ContextView({
  contextId,
  actingAsEndpointId,
  endpoints,
}: ContextViewProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [optimisticEvents, setOptimisticEvents] = useState<EventEnvelope[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);

  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll-to-bottom helper: only when already at (or near) the bottom
  function scrollToBottomIfNear() {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (atBottom) {
      scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }

  // Load context + events
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setOptimisticEvents([]);
    setSendError(null);

    async function load() {
      try {
        const [context, events] = await Promise.all([
          getContext(contextId),
          listContextEvents(contextId),
        ]);
        if (cancelled) return;
        setState({ status: "loaded", context, events });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [contextId]);

  // Scroll to bottom after initial load
  useEffect(() => {
    if (state.status === "loaded") {
      scrollAnchorRef.current?.scrollIntoView({ block: "end" });
    }
  }, [state.status]);

  // Subscribe to live stream; append matching events
  useEffect(() => {
    let unsub: (() => void) | null = null;
    try {
      unsub = subscribeEvents((msg) => {
        if (msg.type !== "event.created") return;
        const payload = msg.payload as Record<string, unknown>;
        if (payload["context_id"] !== contextId) return;
        const envelope = payload["event"] as EventEnvelope | undefined;
        if (!envelope) return;
        setState((prev) => {
          if (prev.status !== "loaded") return prev;
          // Avoid duplicates
          const exists = prev.events.some((e) => e.event_id === envelope.event_id);
          if (exists) return prev;
          return { ...prev, events: [...prev.events, envelope] };
        });
        scrollToBottomIfNear();
      });
    } catch {
      // subscribeEvents is a stub in test env — degrade silently
    }
    return () => { unsub?.(); };
  }, [contextId]);

  async function handleEmit(event: EmitInput): Promise<void> {
    setSendError(null);
    // Optimistic append
    const optimistic: EventEnvelope = {
      event_id: `optimistic-${Date.now()}`,
      type: event.type,
      workspace_id: event.workspace_id,
      source_endpoint_id: event.source_endpoint_id,
      thread_id: "",
      context_id: contextId,
      scope_id: null,
      correlation_id: null,
      destination_json: event.destination,
      content: event.content,
      response: event.response ?? { expected: false },
      metadata: event.metadata ?? {},
      created_at: new Date().toISOString(),
    };
    setOptimisticEvents((prev) => [...prev, optimistic]);
    scrollToBottomIfNear();

    try {
      const emitted = await emit(event);
      // Replace optimistic with real
      setOptimisticEvents((prev) => prev.filter((e) => e.event_id !== optimistic.event_id));
      setState((prev) => {
        if (prev.status !== "loaded") return prev;
        const exists = prev.events.some((e) => e.event_id === emitted.event_id);
        if (exists) return prev;
        return { ...prev, events: [...prev.events, emitted] };
      });
    } catch (err) {
      setOptimisticEvents((prev) => prev.filter((e) => e.event_id !== optimistic.event_id));
      setSendError(err instanceof Error ? err.message : "Failed to send");
    }
  }

  if (state.status === "loading") {
    return (
      <div
        data-testid="context-view"
        role="status"
        aria-live="polite"
        style={{ padding: space.xl, color: colors.muted, font: font.body }}
      >
        Loading context…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div
        data-testid="context-view"
        role="alert"
        style={{ padding: space.xl, color: colors.danger, font: font.body }}
      >
        Error loading context: {state.message}
      </div>
    );
  }

  const { context, events } = state;
  const allEvents = [...events, ...optimisticEvents];

  // Derive participant endpoint IDs (excluding acting actor for default To selection)
  const participantIds = context.participants ?? [];

  return (
    <div
      data-testid="context-view"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        font: font.body,
        color: colors.text,
      }}
    >
      {/* Context header */}
      <div
        style={{
          padding: `${space.md}px ${space.lg}px`,
          borderBottom: `1px solid ${colors.border}`,
          background: colors.surface,
          display: "flex",
          gap: space.lg,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <span style={{ fontSize: font.meta, color: colors.muted }}>
          ID: <code>{context.context_id}</code>
        </span>
        {context.scope_id && (
          <span style={{ fontSize: font.meta, color: colors.muted }}>
            Scope: <code>{context.scope_id}</code>
          </span>
        )}
        {!context.scope_id && (
          <span style={{ fontSize: font.meta, color: colors.muted, fontStyle: "italic" }}>
            unscoped
          </span>
        )}
      </div>

      {/* Event stream */}
      <div
        ref={containerRef}
        style={{ flex: 1, overflowY: "auto", padding: `${space.lg}px` }}
        aria-label="Event stream"
      >
        <EventStream
          events={allEvents}
          actingAsEndpointId={actingAsEndpointId}
        />
        <div ref={scrollAnchorRef} />
      </div>

      {/* Send error */}
      {sendError && (
        <div
          role="alert"
          style={{
            padding: `${space.sm}px ${space.lg}px`,
            background: "#FFF0F0",
            color: colors.danger,
            fontSize: font.meta,
            borderTop: `1px solid ${colors.border}`,
          }}
        >
          Send failed: {sendError}
          <button
            onClick={() => setSendError(null)}
            style={{
              marginLeft: space.sm,
              background: "none",
              border: "none",
              color: colors.danger,
              cursor: "pointer",
              textDecoration: "underline",
              fontSize: font.meta,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Composer */}
      <div
        style={{
          borderTop: `1px solid ${colors.border}`,
          background: colors.surface,
          padding: space.lg,
        }}
        aria-label="Compose message"
      >
        <Composer
          workspaceId={context.workspace_id}
          actingAsEndpointId={actingAsEndpointId}
          contextId={contextId}
          endpoints={endpoints}
          participantEndpointIds={participantIds}
          onEmit={handleEmit}
        />
      </div>
    </div>
  );
}
