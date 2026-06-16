/**
 * ContextView — full-page view of a single Context.
 *
 * Loads context metadata + events via bus-client on mount.
 * Renders: EventStream (the surface), Composer (reply).
 * TraceDrawer is embedded inside EventStream rows (the descend).
 */
import React, { useEffect, useState } from "react";
import type { ContextRef, EventEnvelope, EmitInput } from "../bus-client/types.ts";
import { getContext, listContextEvents, emit } from "../bus-client/client.ts";
import { EventStream } from "./EventStream.tsx";
import { Composer } from "./Composer.tsx";

export type ContextViewProps = {
  contextId: string;
  sourceEndpointId: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "loaded"; context: ContextRef; events: EventEnvelope[] }
  | { status: "error"; message: string };

export function ContextView({ contextId, sourceEndpointId }: ContextViewProps): React.ReactElement {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [context, events] = await Promise.all([
          getContext(contextId),
          listContextEvents(contextId),
        ]);
        if (!cancelled) {
          setState({ status: "loaded", context, events });
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Unknown error";
          setState({ status: "error", message });
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [contextId]);

  async function handleEmit(event: EmitInput): Promise<void> {
    const emitted = await emit(event);
    // Append the emitted event to the stream optimistically
    setState((prev) => {
      if (prev.status !== "loaded") return prev;
      return {
        ...prev,
        events: [...prev.events, emitted],
      };
    });
  }

  if (state.status === "loading") {
    return (
      <div data-testid="context-view" role="status" aria-live="polite">
        Loading context…
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div data-testid="context-view" role="alert">
        Error loading context: {state.message}
      </div>
    );
  }

  const { context, events } = state;

  return (
    <div data-testid="context-view">
      <header>
        <h1>Context</h1>
        <dl>
          <dt>ID</dt>
          <dd data-testid="context-id">{context.context_id}</dd>
          {context.scope_id && (
            <>
              <dt>Scope</dt>
              <dd data-testid="context-scope">{context.scope_id}</dd>
            </>
          )}
        </dl>
      </header>

      <main>
        <section aria-label="Event stream" data-section="event-stream">
          <EventStream events={events} />
        </section>

        <section aria-label="Compose reply" data-section="composer">
          <Composer
            workspaceId={context.workspace_id}
            contextId={contextId}
            sourceEndpointId={sourceEndpointId}
            onEmit={handleEmit}
          />
        </section>
      </main>
    </div>
  );
}
