/**
 * ContextConversation — main-area conversation view for a selected context.
 *
 * Header: context human label + participant pills (by NAME).
 * Body: scrollable chronological message stream — lifecycle events
 * (e.g. context.created) are hidden by default; only `type === "message"`
 * events render as chat bubbles, author resolved to actor name.
 * Footer: composer dock — text input + "Speaking as [actor]" selector.
 * Sending posts the message into this context as the selected actor's
 * endpoint; on success it appears in the stream and the input clears;
 * on failure an inline error is shown.
 */
import React, { useCallback, useEffect, useState } from "react";
import type { ContextRef, EndpointRef, EventEnvelope } from "../bus-client/types.ts";
import { getContext, listContextEvents, emit } from "../bus-client/client.ts";
import { subscribeEvents } from "../bus-client/stream.ts";
import { contextLabel } from "./ScopeDetail.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk)
// ---------------------------------------------------------------------------

const tk = {
  canvas:      "#08090a",
  surface:     "#0f1011",
  surfaceHov:  "#191a1b",
  border:      "rgba(255,255,255,0.08)",
  border2:     "rgba(255,255,255,0.05)",
  ink:         "#f7f8f8",
  ink2:        "#d0d6e0",
  ink3:        "#8a8f98",
  ink4:        "#62666d",
  accent:      "#8aa89c",
  accentHov:   "#a1bcb1",
  accentSoft:  "#16201d",
  accentSoft2: "#1f2c28",
  danger:      "#b85a5a",
  fontUi:      '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3, r2: 5, r3: 8,
} as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve an endpoint id to its human name, falling back to the raw id only if unresolved. */
function endpointName(endpointId: string | null, endpoints: EndpointRef[]): string {
  if (!endpointId) return "Unknown";
  const ep = endpoints.find(e => e.endpoint_id === endpointId);
  return ep?.name?.trim() || endpointId;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Message-vs-lifecycle filter: only `type === "message"` events render in the stream. */
function isVisibleMessage(event: EventEnvelope): boolean {
  return event.type === "message";
}

function messageText(event: EventEnvelope): string {
  const t = event.content?.["text"];
  return typeof t === "string" ? t : JSON.stringify(event.content ?? {});
}

// ---------------------------------------------------------------------------
// Participant pills
// ---------------------------------------------------------------------------

function ParticipantPill({ name }: { name: string }): React.ReactElement {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "3px 9px", borderRadius: 999,
      background: tk.accentSoft2, color: tk.accentHov,
      fontSize: 11.5, fontWeight: 510, fontFamily: tk.fontUi,
      border: `1px solid rgba(138,168,156,0.25)`,
    }}>
      {name}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Message stream
// ---------------------------------------------------------------------------

function MessageRow({
  event,
  endpoints,
}: {
  event: EventEnvelope;
  endpoints: EndpointRef[];
}): React.ReactElement {
  const author = endpointName(event.source_endpoint_id, endpoints);
  return (
    <div style={{ padding: "10px 0", borderBottom: `1px solid ${tk.border2}` }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 3,
      }}>
        <span style={{ fontSize: 12.5, fontWeight: 590, color: tk.ink }}>{author}</span>
        <span style={{ fontSize: 11, color: tk.ink4 }}>{formatTime(event.created_at)}</span>
      </div>
      <div style={{
        fontSize: 13.5, color: tk.ink2, lineHeight: 1.5, whiteSpace: "pre-wrap",
      }}>
        {messageText(event)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer dock
// ---------------------------------------------------------------------------

function ComposerDock({
  endpoints,
  speakingAsId,
  onSpeakingAsChange,
  onSend,
}: {
  endpoints: EndpointRef[];
  speakingAsId: string;
  onSpeakingAsChange: (id: string) => void;
  onSend: (text: string) => Promise<void>;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending || !speakingAsId) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  return (
    <div style={{
      flexShrink: 0,
      borderTop: `1px solid ${tk.border}`,
      background: tk.surface,
      padding: "12px 24px 16px",
    }}>
      {error && (
        <div role="alert" style={{
          marginBottom: 8, fontSize: 12, color: tk.danger,
        }}>
          {error}
        </div>
      )}

      {/* Speaking-as row */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8,
        fontSize: 12, color: tk.ink3,
      }}>
        <label htmlFor="speaking-as-select">Speaking as</label>
        <select
          id="speaking-as-select"
          aria-label="Speaking as"
          value={speakingAsId}
          onChange={e => onSpeakingAsChange(e.target.value)}
          style={{
            background: tk.canvas, color: tk.ink, border: `1px solid ${tk.border}`,
            borderRadius: tk.r2, padding: "4px 8px", fontSize: 12.5,
            fontFamily: tk.fontUi, cursor: "pointer",
          }}
        >
          {endpoints.length === 0 && <option value="">No actors available</option>}
          {endpoints.map(ep => (
            <option key={ep.endpoint_id} value={ep.endpoint_id}>
              {ep.name || ep.endpoint_id}
            </option>
          ))}
        </select>
      </div>

      {/* Input row */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          aria-label="Compose message"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a message… (Enter to send, Shift+Enter for newline)"
          disabled={sending || !speakingAsId}
          rows={2}
          style={{
            flex: 1, resize: "vertical",
            background: tk.canvas, color: tk.ink,
            border: `1px solid ${tk.border}`, borderRadius: tk.r2,
            padding: "8px 10px", fontSize: 13.5, fontFamily: tk.fontUi,
            lineHeight: 1.5, outline: "none",
          }}
        />
        <button
          onClick={() => void handleSend()}
          disabled={sending || !text.trim() || !speakingAsId}
          aria-label="Send message"
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "8px 18px", fontSize: 13,
            fontWeight: 510, fontFamily: tk.fontUi,
            cursor: sending || !text.trim() || !speakingAsId ? "not-allowed" : "pointer",
            opacity: sending || !text.trim() || !speakingAsId ? 0.5 : 1,
            flexShrink: 0,
          }}
        >
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContextConversation
// ---------------------------------------------------------------------------

const SPEAKING_AS_KEY = "floe.speakingAsEndpointId";

export type ContextConversationProps = {
  contextId: string;
  workspaceId: string;
  endpoints: EndpointRef[];
  /** Called once the context's human label is known, for the shell breadcrumb. */
  onLabelResolved?: (label: string) => void;
};

export function ContextConversation({
  contextId,
  workspaceId,
  endpoints,
  onLabelResolved,
}: ContextConversationProps): React.ReactElement {
  const [context, setContext] = useState<ContextRef | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [speakingAsId, setSpeakingAsId] = useState<string>("");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([getContext(contextId), listContextEvents(contextId)])
      .then(([ctx, evts]) => {
        setContext(ctx);
        setEvents(evts);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Failed to load context");
        setLoading(false);
      });
  }, [contextId]);

  useEffect(() => {
    load();
  }, [load]);

  // Live push refresh: reload whenever a new event lands in this context.
  useEffect(() => {
    const unsub = subscribeEvents((msg) => {
      if (msg.type === "event_submitted") {
        const event = (msg.payload as { event?: { context_id?: string } }).event;
        if (event?.context_id === contextId) {
          load();
        }
      }
    });
    return unsub;
  }, [contextId, load]);

  // Default "speaking as" to the last saved choice, else the first non-participant
  // actor if available, else the first actor in the workspace.
  useEffect(() => {
    if (endpoints.length === 0) {
      setSpeakingAsId("");
      return;
    }
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(SPEAKING_AS_KEY);
    } catch { /* ignore */ }
    if (saved && endpoints.some(e => e.endpoint_id === saved)) {
      setSpeakingAsId(saved);
      return;
    }
    setSpeakingAsId(prev =>
      prev && endpoints.some(e => e.endpoint_id === prev) ? prev : endpoints[0]!.endpoint_id
    );
  }, [endpoints]);

  function handleSpeakingAsChange(id: string) {
    setSpeakingAsId(id);
    try { localStorage.setItem(SPEAKING_AS_KEY, id); } catch { /* ignore */ }
  }

  async function handleSend(text: string) {
    if (!context) return;
    const others = context.participants.filter(p => p !== speakingAsId);
    const destination = others[0]
      ? { kind: "endpoint" as const, endpoint_id: others[0] }
      : { kind: "broadcast" as const, scope: "workspace" as const, target: "all" };

    await emit({
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: speakingAsId,
      destination,
      context_id: contextId,
      content: { text },
      response: { expected: false },
      metadata: {},
    });
    await load();
  }

  const label = context ? contextLabel(context) : null;

  useEffect(() => {
    if (label) onLabelResolved?.(label);
  }, [label, onLabelResolved]);

  if (loading) {
    return (
      <div style={{ padding: 32, color: tk.ink3, fontSize: 13, fontFamily: tk.fontUi }}>
        Loading conversation…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" style={{ padding: 32, color: tk.danger, fontSize: 13, fontFamily: tk.fontUi }}>
        {error}
      </div>
    );
  }

  if (!context) return <></>;

  const visibleMessages = events.filter(isVisibleMessage);

  return (
    <div style={{
      display: "flex", flexDirection: "column", height: "100%",
      overflow: "hidden", fontFamily: tk.fontUi,
    }}>
      {/* Header */}
      <div style={{
        flexShrink: 0,
        padding: "18px 24px 14px",
        borderBottom: `1px solid ${tk.border}`,
        background: tk.surface,
      }}>
        <div style={{
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510, marginBottom: 4,
        }}>
          Context
        </div>
        <h2 style={{
          margin: "0 0 10px", fontSize: 19, fontWeight: 510, color: tk.ink,
          letterSpacing: "-0.01em", lineHeight: 1.25,
        }}>
          {label}
        </h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {context.participants.length > 0 ? (
            context.participants.map(p => (
              <ParticipantPill key={p} name={endpointName(p, endpoints)} />
            ))
          ) : (
            <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>No participants</span>
          )}
        </div>
      </div>

      {/* Message stream */}
      <div style={{ flex: 1, overflow: "auto", padding: "8px 24px" }} aria-label="Message stream">
        {visibleMessages.length === 0 ? (
          <div style={{ padding: "32px 0", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
            No messages in this context yet.
          </div>
        ) : (
          visibleMessages.map(event => (
            <MessageRow key={event.event_id} event={event} endpoints={endpoints} />
          ))
        )}
      </div>

      {/* Composer dock — only rendered when the acting actor is a participant */}
      {context.participants.includes(speakingAsId) ? (
        <ComposerDock
          endpoints={endpoints}
          speakingAsId={speakingAsId}
          onSpeakingAsChange={handleSpeakingAsChange}
          onSend={handleSend}
        />
      ) : (
        <div
          aria-label="Not a participant"
          style={{
            flexShrink: 0,
            borderTop: `1px solid ${tk.border}`,
            background: tk.surface,
            padding: "12px 24px",
            fontSize: 12,
            color: tk.ink4,
            fontStyle: "italic",
            fontFamily: tk.fontUi,
          }}
        >
          You are not a participant of this context.
        </div>
      )}
    </div>
  );
}
