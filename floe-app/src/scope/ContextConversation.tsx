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
 *
 * Features:
 *   B1 — Working/thinking indicator: shows "<actor> is working…" driven by
 *        WS delivery_bundle_available / turn_end_observed signals. Zero polling.
 *   B2 — Auto-scroll to bottom: sticks to bottom as new messages arrive;
 *        respects user scroll-up (no yank).
 *   B3 — Speaking-as selector always accessible: even when selected actor is
 *        not a context participant, the selector is visible; a "Join context"
 *        button lets the user add themselves.
 *   A  — Side-thread sidebar: real events grouped by thread_id from the substrate.
 *        Side threads appear in a tabbed right panel (one tab per side thread).
 *        Zero side threads → no sidebar. Live-refreshed via WS event_submitted.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContextRef,
  EndpointRef,
  EventEnvelope,
  DeliveryBundle,
  ThreadRecord,
} from "../bus-client/types.ts";
import {
  getContext,
  listContextEvents,
  listThreadsForContext,
  emit,
  addContextParticipant,
} from "../bus-client/client.ts";
import { subscribeEvents } from "../bus-client/stream.ts";
import { contextLabel } from "./ScopeDetail.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk)
// ---------------------------------------------------------------------------

const tk = {
  canvas:      "#08090a",
  surface:     "#0f1011",
  surfaceHov:  "#191a1b",
  surfaceSunk: "#090a0b",
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
  warn:        "#c9a14a",
  warnSoft:    "#1e1a0e",
  fontUi:      '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3, r2: 5, r3: 8,
} as const;

// ---------------------------------------------------------------------------
// A. SIDE-THREAD DATA MODEL
// ---------------------------------------------------------------------------
// Side threads are derived from real substrate data:
//   - threads fetched via GET /v1/contexts/:id/threads
//   - events grouped by thread_id (main = thread_id === context_id)
// ---------------------------------------------------------------------------

type SideThread = {
  thread: ThreadRecord;
  events: EventEnvelope[];
};

/** Derive a useful display label for a side thread. */
function sideThreadLabel(
  thread: ThreadRecord,
  events: EventEnvelope[],
  endpoints: EndpointRef[],
): string {
  if (thread.title) return thread.title;
  // Derive from unique actors in this thread's events
  const seen = new Set<string>();
  const names: string[] = [];
  for (const e of events) {
    if (e.source_endpoint_id && !seen.has(e.source_endpoint_id)) {
      seen.add(e.source_endpoint_id);
      names.push(endpointName(e.source_endpoint_id, endpoints));
    }
  }
  if (names.length > 0) return names.join(" ↔ ");
  // Fallback: short thread id
  return `Thread …${thread.thread_id.slice(-8)}`;
}

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
// Message stream row
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
// B1 — Working / thinking indicator
// ---------------------------------------------------------------------------

function WorkingIndicator({ actorName: name }: { actorName: string }): React.ReactElement {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "8px 0",
      color: tk.ink3, fontSize: 12.5, fontStyle: "italic",
    }}>
      <span style={{
        display: "inline-flex", gap: 3, alignItems: "center",
      }}>
        {[0, 1, 2].map(i => (
          <span
            key={i}
            style={{
              width: 5, height: 5, borderRadius: "50%",
              background: tk.ink4,
              animation: "floe-typing-dot 1.1s infinite ease-in-out",
              animationDelay: `${i * 0.22}s`,
            }}
          />
        ))}
      </span>
      <span>{name} is working…</span>
    </div>
  );
}

// Global keyframe for the typing dots — injected once.
if (typeof document !== "undefined") {
  const id = "__floe_typing_kf__";
  if (!document.getElementById(id)) {
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      @keyframes floe-typing-dot {
        0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
        30%            { opacity: 1;    transform: translateY(-3px); }
      }
    `;
    document.head.appendChild(style);
  }
}

// ---------------------------------------------------------------------------
// A — Multi-side-thread sidebar (tabbed) — REAL DATA
//
// Design: one fixed-width sidebar with a tab row across the top — one tab
// per side thread, labelled by the actors involved or the thread title.
// Selecting a tab shows that thread's message log (reuses MessageRow).
// Collapsed to a 36px strip with a chevron when ≥1 side thread exists.
//
// Closed threads (status="closed") render with muted tab styling.
// ---------------------------------------------------------------------------

function SideThreadsPanel({
  threads,
  endpoints,
}: {
  threads: SideThread[];
  endpoints: EndpointRef[];
}): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);

  // Clamp activeIdx when thread list changes (e.g. new thread appears)
  const clampedIdx = Math.min(activeIdx, threads.length - 1);
  const active = threads[clampedIdx];

  return (
    <div style={{
      width: collapsed ? 36 : 300,
      flexShrink: 0,
      borderLeft: `2px solid ${tk.warn}`,
      background: tk.surfaceSunk,
      display: "flex",
      flexDirection: "column",
      transition: "width 0.18s ease",
      overflow: "hidden",
    }}>
      {/* ── Panel header ── */}
      <div style={{
        flexShrink: 0,
        display: "flex", alignItems: "center",
        padding: collapsed ? "10px 6px" : "8px 10px 0",
        gap: 4,
        justifyContent: collapsed ? "center" : "space-between",
        borderBottom: collapsed ? `1px solid ${tk.border2}` : "none",
      }}>
        {!collapsed && (
          <div style={{
            fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase",
            color: tk.warn, fontWeight: 600, paddingBottom: 6,
          }}>
            Side threads
          </div>
        )}
        <button
          onClick={() => setCollapsed(v => !v)}
          title={collapsed ? "Expand side threads" : "Collapse side threads"}
          aria-label={collapsed ? "Expand side threads" : "Collapse side threads"}
          style={{
            background: "transparent", border: "none",
            color: tk.ink4, cursor: "pointer",
            fontSize: 13, lineHeight: 1, padding: 2,
            flexShrink: 0, marginBottom: collapsed ? 0 : 6,
          }}
        >
          {collapsed ? "⟩" : "⟨"}
        </button>
      </div>

      {/* ── Tab bar (one tab per side thread) ── */}
      {!collapsed && (
        <div style={{
          flexShrink: 0,
          display: "flex",
          borderBottom: `1px solid ${tk.border2}`,
          overflowX: "auto",
        }}>
          {threads.map((st, i) => {
            const isActive = i === clampedIdx;
            const isClosed = st.thread.status === "closed";
            const label = sideThreadLabel(st.thread, st.events, endpoints);
            return (
              <button
                key={st.thread.thread_id}
                onClick={() => setActiveIdx(i)}
                title={isClosed ? `${label} (closed)` : label}
                style={{
                  flexShrink: 0,
                  background: "transparent", border: "none",
                  borderBottom: isActive
                    ? `2px solid ${tk.warn}`
                    : "2px solid transparent",
                  color: isActive ? tk.warn : isClosed ? tk.ink4 : tk.ink3,
                  opacity: isClosed ? 0.55 : 1,
                  fontSize: 11.5, fontWeight: isActive ? 580 : 400,
                  fontFamily: tk.fontUi,
                  padding: "6px 10px",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: 140,
                  transition: "color 0.12s",
                }}
              >
                {isClosed ? `${label} ✕` : label}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Thread message log ── */}
      {!collapsed && active && (
        <div style={{
          flex: 1, overflow: "auto",
          padding: "8px 12px",
        }}>
          {active.thread.status === "closed" && (
            <div style={{
              fontSize: 10.5, color: tk.ink4, fontStyle: "italic",
              marginBottom: 6, paddingBottom: 6,
              borderBottom: `1px solid ${tk.border2}`,
            }}>
              This thread is closed.
            </div>
          )}
          {active.events.filter(isVisibleMessage).length === 0 ? (
            <div style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic", padding: "12px 0" }}>
              No messages in this thread yet.
            </div>
          ) : (
            active.events.filter(isVisibleMessage).map(event => (
              <MessageRow key={event.event_id} event={event} endpoints={endpoints} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speaking-as selector (shared between participant and non-participant states)
// ---------------------------------------------------------------------------

function SpeakingAsSelector({
  endpoints,
  speakingAsId,
  onSpeakingAsChange,
}: {
  endpoints: EndpointRef[];
  speakingAsId: string;
  onSpeakingAsChange: (id: string) => void;
}): React.ReactElement {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
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
  );
}

// ---------------------------------------------------------------------------
// Composer dock (participant state)
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
      <div style={{ marginBottom: 8 }}>
        <SpeakingAsSelector
          endpoints={endpoints}
          speakingAsId={speakingAsId}
          onSpeakingAsChange={onSpeakingAsChange}
        />
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
// B3 — Non-participant footer (speaker selector + join option)
// ---------------------------------------------------------------------------

function NonParticipantFooter({
  endpoints,
  speakingAsId,
  onSpeakingAsChange,
  onJoin,
}: {
  endpoints: EndpointRef[];
  speakingAsId: string;
  onSpeakingAsChange: (id: string) => void;
  onJoin: () => Promise<void>;
}): React.ReactElement {
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const actorLabel = endpoints.find(e => e.endpoint_id === speakingAsId)?.name ?? speakingAsId;

  async function handleJoin() {
    setJoining(true);
    setJoinError(null);
    try {
      await onJoin();
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : "Failed to join context");
    } finally {
      setJoining(false);
    }
  }

  return (
    <div
      aria-label="Not a participant"
      style={{
        flexShrink: 0,
        borderTop: `1px solid ${tk.border}`,
        background: tk.surface,
        padding: "12px 24px 14px",
        fontFamily: tk.fontUi,
      }}
    >
      {/* Always-visible speaker selector */}
      <div style={{ marginBottom: 10 }}>
        <SpeakingAsSelector
          endpoints={endpoints}
          speakingAsId={speakingAsId}
          onSpeakingAsChange={onSpeakingAsChange}
        />
      </div>

      {/* Not-a-participant notice + join button */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
      }}>
        <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>
          {actorLabel} is not a participant of this context.
        </span>
        <button
          onClick={() => void handleJoin()}
          disabled={joining}
          aria-label="Join context"
          style={{
            background: tk.accentSoft2, color: tk.accentHov,
            border: `1px solid rgba(138,168,156,0.3)`,
            borderRadius: tk.r2, padding: "4px 12px", fontSize: 12,
            fontFamily: tk.fontUi, cursor: joining ? "not-allowed" : "pointer",
            opacity: joining ? 0.6 : 1,
          }}
        >
          {joining ? "Joining…" : "Join context"}
        </button>
      </div>
      {joinError && (
        <div role="alert" style={{ marginTop: 6, fontSize: 11.5, color: tk.danger }}>
          {joinError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ContextConversation
// ---------------------------------------------------------------------------

const SPEAKING_AS_KEY = "floe.speakingAsEndpointId";
const SCROLL_BOTTOM_THRESHOLD = 80; // px from bottom — within this, considered "at bottom"

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
  const [threads, setThreads] = useState<ThreadRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [speakingAsId, setSpeakingAsId] = useState<string>("");

  // B1 — working endpoints: map endpoint_id → delivery_id (tracks in-flight turns)
  const [workingEndpoints, setWorkingEndpoints] = useState<Map<string, string>>(new Map());

  // B2 — scroll-to-bottom refs
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      getContext(contextId),
      listContextEvents(contextId),
      listThreadsForContext(contextId),
    ])
      .then(([ctx, evts, thrs]) => {
        setContext(ctx);
        setEvents(evts);
        setThreads(thrs);
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
  // B1: also track delivery_bundle_available / turn_end_observed for working indicator.
  useEffect(() => {
    const unsub = subscribeEvents((msg) => {
      if (msg.type === "event_submitted") {
        const event = (msg.payload as { event?: { context_id?: string } }).event;
        if (event?.context_id === contextId) {
          load();
        }
      }

      // B1 — delivery started → mark endpoint as working if relevant to this context
      if (msg.type === "delivery_bundle_available") {
        const { delivery } = msg.payload as { delivery: DeliveryBundle };
        const isForThisContext = delivery.events.some(e => e.context_id === contextId);
        if (isForThisContext) {
          setWorkingEndpoints(prev => {
            const next = new Map(prev);
            next.set(delivery.endpoint_id, delivery.delivery_id);
            return next;
          });
        }
      }

      // B1 — turn ended → clear working state for that endpoint
      if (msg.type === "turn_end_observed") {
        const { endpoint_id } = msg.payload as { endpoint_id: string };
        setWorkingEndpoints(prev => {
          if (!prev.has(endpoint_id)) return prev;
          const next = new Map(prev);
          next.delete(endpoint_id);
          return next;
        });
      }
    });
    return unsub;
  }, [contextId, load]);

  // Default "speaking as" to the last saved choice, else the first endpoint.
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

  // B2 — track whether the user is near the bottom
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distFromBottom < SCROLL_BOTTOM_THRESHOLD;
  }

  // B2 — auto-scroll to bottom when messages or working state changes (if user is at bottom)
  // Uses total event count (all threads) so new side-thread events also trigger scroll-check.
  const totalVisibleCount = events.filter(isVisibleMessage).length;
  const workingCount = workingEndpoints.size;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [totalVisibleCount, workingCount]);

  // B2 — initial scroll to bottom after first load
  useEffect(() => {
    if (!loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      isAtBottomRef.current = true;
    }
  }, [loading]);

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

  // B3 — join context as selected actor
  async function handleJoin() {
    await addContextParticipant(contextId, speakingAsId);
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

  const isParticipant = context.participants.includes(speakingAsId);

  // A — side threads: group events by thread_id; main thread = thread_id === contextId
  const mainEvents = events.filter(e => e.thread_id === contextId);
  const sideThreadRecords = threads.filter(t => t.parent_thread_id !== null);

  // Map thread_id → events for side threads
  const sideEventMap = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    if (event.thread_id !== contextId) {
      const bucket = sideEventMap.get(event.thread_id) ?? [];
      bucket.push(event);
      sideEventMap.set(event.thread_id, bucket);
    }
  }

  const sideThreads: SideThread[] = sideThreadRecords.map(t => ({
    thread: t,
    events: sideEventMap.get(t.thread_id) ?? [],
  }));

  // Also capture any side-thread events whose ThreadRecord wasn't returned yet
  // (shouldn't happen, but keeps the display consistent under race conditions).
  for (const [threadId, evts] of sideEventMap.entries()) {
    if (!sideThreads.some(st => st.thread.thread_id === threadId)) {
      sideThreads.push({
        thread: {
          thread_id: threadId,
          context_id: contextId,
          parent_thread_id: contextId,
          created_by_endpoint_id: null,
          status: "open",
          created_at: evts[0]?.created_at ?? "",
          title: null,
        },
        events: evts,
      });
    }
  }

  // A — derive working actors names for indicator (from working endpoints)
  const workingActorNames = Array.from(workingEndpoints.keys())
    .map(id => endpointName(id, endpoints));

  // Use mainEvents for the main pane (falls back to all events if side-thread
  // feature is not yet fully reflected, e.g. legacy events where thread_id === context_id)
  const mainVisibleMessages = mainEvents.filter(isVisibleMessage);
  // For backwards compat: if ALL events are on the main thread (no side threads),
  // this naturally renders exactly as before.
  const visibleMessages = mainVisibleMessages;

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

      {/* Body: message stream + optional side-thread panel */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>

        {/* Main message stream */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          style={{ flex: 1, overflow: "auto", padding: "8px 24px" }}
          aria-label="Message stream"
        >
          {visibleMessages.length === 0 && workingActorNames.length === 0 ? (
            <div style={{ padding: "32px 0", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
              No messages in this context yet.
            </div>
          ) : (
            visibleMessages.map(event => (
              <MessageRow key={event.event_id} event={event} endpoints={endpoints} />
            ))
          )}

          {/* B1 — Typing / working indicators at bottom of stream */}
          {workingActorNames.map(name => (
            <WorkingIndicator key={name} actorName={name} />
          ))}
        </div>

        {/* A — Multi-side-thread tabbed sidebar (real data; hidden when no side threads) */}
        {sideThreads.length > 0 && (
          <SideThreadsPanel threads={sideThreads} endpoints={endpoints} />
        )}
      </div>

      {/* Footer: composer dock (participant) or non-participant selector + join */}
      {isParticipant ? (
        <ComposerDock
          endpoints={endpoints}
          speakingAsId={speakingAsId}
          onSpeakingAsChange={handleSpeakingAsChange}
          onSend={handleSend}
        />
      ) : (
        <NonParticipantFooter
          endpoints={endpoints}
          speakingAsId={speakingAsId}
          onSpeakingAsChange={handleSpeakingAsChange}
          onJoin={handleJoin}
        />
      )}
    </div>
  );
}
