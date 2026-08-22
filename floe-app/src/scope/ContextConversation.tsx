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
 *   B1 — Working indicator: shows safe, concise runtime actions from existing
 *        telemetry while a delivery is active. Scratch reasoning and raw tool
 *        arguments remain private. Driven entirely by the live stream.
 *   B2 — Auto-scroll to bottom: sticks to bottom as new messages arrive;
 *        respects user scroll-up (no yank).
 *   B3 — Speaking-as selector always accessible: even when selected actor is
 *        not a context participant, the selector is visible; a "Join context"
 *        button lets the user add themselves.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContextRef,
  EndpointRef,
  EventEnvelope,
  DeliveryBundle,
  DeliveryRow,
  TelemetryRow,
} from "../bus-client/types.ts";
import {
  getContext,
  listContextEvents,
  emit,
  addContextParticipant,
  listDeliveries,
  listRuntimeTelemetry,
} from "../bus-client/client.ts";
import { subscribeEvents } from "../bus-client/stream.ts";
import { FloeModelControl } from "../workspace/FloeModelControl.tsx";
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

const ACTIVE_DELIVERY_STATES = new Set(["reserved", "delivered_to_bridge", "injected_to_runtime"]);
const FAILED_DELIVERY_STATES = new Set(["failed", "dead_lettered", "deferred"]);

export function conversationDeliveryState(deliveries: DeliveryRow[], contextId: string): {
  working: Map<string, string>;
  notice: string | null;
} {
  const relevant = deliveries
    .filter(delivery => {
      try {
        const events = JSON.parse(delivery.events_json) as Array<{ context_id?: string }>;
        return events.some(event => event.context_id === contextId);
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  const working = new Map<string, string>();
  for (const delivery of relevant) {
    if (ACTIVE_DELIVERY_STATES.has(delivery.state)) {
      working.set(delivery.endpoint_id, delivery.delivery_id);
    }
  }
  if (working.size > 0) return { working, notice: null };

  const latest = relevant.at(-1);
  return {
    working,
    notice: latest && FAILED_DELIVERY_STATES.has(latest.state)
      ? friendlyDeliveryFailure(latest.last_error)
      : null,
  };
}

function friendlyDeliveryFailure(error: string | null | undefined): string {
  if (error?.includes("auth") || error?.includes("profile") || error?.includes("credential")) {
    return "Floe needs a connected model before it can reply. Open Settings to reconnect it.";
  }
  return "Floe couldn’t complete that message. Your message is safe; check Settings and try again.";
}

export type OperatorProgress = {
  telemetryId: string;
  deliveryId: string;
  endpointId: string;
  toolCallId: string;
  text: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
};

type TelemetryWithPayload = TelemetryRow & { payload?: Record<string, unknown> };

function telemetryPayload(telemetry: TelemetryWithPayload): Record<string, unknown> {
  if (telemetry.payload) return telemetry.payload;
  try {
    return JSON.parse(telemetry.payload_json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safePath(payload: Record<string, unknown>): string | null {
  const files = payload["files_touched"];
  if (Array.isArray(files) && typeof files[0] === "string") return files[0];
  const args = payload["args"];
  if (args && typeof args === "object") {
    const path = (args as Record<string, unknown>)["path"];
    if (typeof path === "string" && path.trim()) return path;
  }
  return null;
}

function capabilityLabel(toolName: string): string {
  return toolName
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, character => character.toUpperCase());
}

/**
 * Convert internal tool telemetry into operator-safe progress. This deliberately
 * excludes model scratch reasoning, tool arguments and command text.
 */
export function operatorProgressFromTelemetry(
  telemetry: TelemetryWithPayload,
): OperatorProgress | null {
  if (!telemetry.delivery_id || !["BeforeToolUse", "AfterToolUse", "ToolUseFailed"].includes(telemetry.kind)) {
    return null;
  }
  const payload = telemetryPayload(telemetry);
  const toolName = typeof payload["toolName"] === "string" ? payload["toolName"] : "capability";
  const toolCallId = typeof payload["toolCallId"] === "string"
    ? payload["toolCallId"]
    : telemetry.telemetry_id;
  const path = safePath(payload);
  const failed = telemetry.kind === "ToolUseFailed" || payload["isError"] === true;
  const completed = telemetry.kind === "AfterToolUse" || telemetry.kind === "ToolUseFailed";
  const summary = typeof payload["summary"] === "string" ? payload["summary"] : "";

  let action: string;
  switch (toolName) {
    case "read": action = path ? `Reading ${path}` : "Reading workspace files"; break;
    case "read_image": action = path ? `Inspecting ${path}` : "Inspecting a workspace image"; break;
    case "ls":
    case "find":
    case "grep": action = "Inspecting the workspace"; break;
    case "write": action = path ? `Writing ${path}` : "Writing a workspace file"; break;
    case "edit": action = path ? `Updating ${path}` : "Updating a workspace file"; break;
    case "bash": action = "Running and verifying workspace automation"; break;
    case "list_actors":
    case "list_endpoints":
    case "resolve_destination": action = "Checking available collaborators"; break;
    case "emit": action = "Preparing a response"; break;
    default: action = `Using ${capabilityLabel(toolName)}`; break;
  }

  let text = action;
  if (failed || /\((?:exit [1-9]\d*|timeout)[,)]/i.test(summary)) {
    text = "A step did not succeed; Floe is adapting";
  } else if (completed) {
    if (toolName === "write" || toolName === "edit") text = path ? `Updated ${path}` : "Updated the workspace";
    else if (toolName === "bash") text = "Verified a workspace step";
    else if (toolName === "emit") text = "Response ready";
  }

  return {
    telemetryId: telemetry.telemetry_id,
    deliveryId: telemetry.delivery_id,
    endpointId: telemetry.endpoint_id,
    toolCallId,
    text,
    status: failed ? "failed" : completed ? "completed" : "running",
    createdAt: telemetry.created_at,
  };
}

export function mergeOperatorProgress(
  current: OperatorProgress[],
  rows: TelemetryWithPayload[],
): OperatorProgress[] {
  const byCall = new Map(current.map(progress => [`${progress.deliveryId}:${progress.toolCallId}`, progress]));
  for (const row of rows) {
    const progress = operatorProgressFromTelemetry(row);
    if (!progress) continue;
    byCall.set(`${progress.deliveryId}:${progress.toolCallId}`, progress);
  }
  return [...byCall.values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-5);
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

function WorkingIndicator({
  actorName: name,
  progress,
}: {
  actorName: string;
  progress: OperatorProgress[];
}): React.ReactElement {
  return (
    <div style={{
      padding: "10px 0",
      color: tk.ink3, fontSize: 12.5,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontStyle: "italic" }}>
        <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
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
        <span>{name} is working</span>
      </div>
      {progress.length > 0 && (
        <div aria-label={`${name} work progress`} style={{ marginTop: 8, display: "grid", gap: 5 }}>
          {progress.map(item => (
            <div key={`${item.deliveryId}:${item.toolCallId}`} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span aria-hidden="true" style={{
                color: item.status === "failed" ? tk.warn : item.status === "completed" ? tk.accent : tk.ink3,
                fontSize: 11,
              }}>
                {item.status === "failed" ? "!" : item.status === "completed" ? "✓" : "•"}
              </span>
              <span style={{ color: item.status === "running" ? tk.ink2 : tk.ink3 }}>
                {item.text}
              </span>
            </div>
          ))}
        </div>
      )}
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
  hideSpeakingAs = false,
  placeholder = "Write a message… (Enter to send, Shift+Enter for newline)",
  disabled = false,
  disabledReason,
}: {
  endpoints: EndpointRef[];
  speakingAsId: string;
  onSpeakingAsChange: (id: string) => void;
  onSend: (text: string) => Promise<void>;
  hideSpeakingAs?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending || !speakingAsId || disabled) return;
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

      {disabled && disabledReason && (
        <div role="status" style={{ marginBottom: 8, fontSize: 12.5, color: tk.ink3 }}>
          {disabledReason}
        </div>
      )}

      {!hideSpeakingAs && (
        <div style={{ marginBottom: 8 }}>
          <SpeakingAsSelector
            endpoints={endpoints}
            speakingAsId={speakingAsId}
            onSpeakingAsChange={onSpeakingAsChange}
          />
        </div>
      )}

      {/* Input row */}
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          aria-label="Compose message"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || sending || !speakingAsId}
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
          disabled={disabled || sending || !text.trim() || !speakingAsId}
          aria-label="Send message"
          style={{
            background: tk.accent, color: "#0c1714", border: "none",
            borderRadius: tk.r2, padding: "8px 18px", fontSize: 13,
            fontWeight: 510, fontFamily: tk.fontUi,
            cursor: disabled || sending || !text.trim() || !speakingAsId ? "not-allowed" : "pointer",
            opacity: disabled || sending || !text.trim() || !speakingAsId ? 0.5 : 1,
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
  /** Neutral operator front door: fixes the human identity and hides substrate-oriented context controls. */
  operatorEntry?: {
    speakingAsEndpointId: string;
    onOpenSettings?: () => void;
    onNewConversation?: () => void;
    onDeleteConversation?: () => void;
    conversationActionsDisabled?: boolean;
    conversationActionError?: string | null;
  };
};

export function ContextConversation({
  contextId,
  workspaceId,
  endpoints,
  onLabelResolved,
  operatorEntry,
}: ContextConversationProps): React.ReactElement {
  const [context, setContext] = useState<ContextRef | null>(null);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deliveryNotice, setDeliveryNotice] = useState<string | null>(null);
  const [speakingAsId, setSpeakingAsId] = useState<string>("");
  const [operatorModelReady, setOperatorModelReady] = useState(false);
  const [workProgress, setWorkProgress] = useState<OperatorProgress[]>([]);

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
      listDeliveries({ workspace_id: workspaceId, limit: 500 }),
    ])
      .then(([ctx, evts, deliveries]) => {
        const deliveryState = conversationDeliveryState(deliveries, contextId);
        const activeDeliveryIds = new Set(deliveryState.working.values());
        setContext(ctx);
        setEvents(evts);
        setWorkingEndpoints(deliveryState.working);
        setWorkProgress(previous => previous.filter(progress => activeDeliveryIds.has(progress.deliveryId)));
        setDeliveryNotice(deliveryState.notice);
        setLoading(false);
        void Promise.all([...activeDeliveryIds].map(deliveryId =>
          listRuntimeTelemetry({ delivery_id: deliveryId, limit: 100 })
        )).then(records => {
          setWorkProgress(previous => mergeOperatorProgress(previous, records.flat()));
        }).catch(() => {
          // Progress is supplementary; a telemetry failure must not hide the conversation.
        });
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Failed to load context");
        setLoading(false);
      });
  }, [contextId, workspaceId]);

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
          setDeliveryNotice(null);
          setWorkingEndpoints(prev => {
            const next = new Map(prev);
            next.set(delivery.endpoint_id, delivery.delivery_id);
            return next;
          });
        }
      }

      if (msg.type === "runtime_telemetry") {
        const telemetry = (msg.payload as { telemetry?: TelemetryWithPayload }).telemetry;
        if (telemetry) {
          const payload = telemetryPayload(telemetry);
          if (payload["context_id"] === contextId) {
            setWorkProgress(previous => mergeOperatorProgress(previous, [telemetry]));
          }
        }
      }

      if (["delivery_deferred", "delivery_failed", "delivery_dead_lettered"].includes(msg.type)) {
        const { delivery_id, error } = msg.payload as { delivery_id: string; error?: string | null };
        setWorkingEndpoints(prev => {
          if (![...prev.values()].includes(delivery_id)) return prev;
          const next = new Map([...prev].filter(([, id]) => id !== delivery_id));
          setDeliveryNotice(friendlyDeliveryFailure(error));
          return next;
        });
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
        setWorkProgress(previous => previous.filter(progress => progress.endpointId !== endpoint_id));
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
    if (operatorEntry) {
      setSpeakingAsId(operatorEntry.speakingAsEndpointId);
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
  }, [endpoints, operatorEntry]);

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
  // Re-check scroll position whenever the visible event stream changes.
  const totalVisibleCount = events.filter(isVisibleMessage).length;
  const workingCount = workingEndpoints.size;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [totalVisibleCount, workingCount, workProgress.length]);

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
      response: { expected: !!operatorEntry },
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

  const workingActorNames = Array.from(workingEndpoints.keys())
    .map(id => endpointName(id, endpoints));

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
        {!operatorEntry && (
          <div style={{
            fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
            color: tk.ink3, fontWeight: 510, marginBottom: 4,
          }}>
            Context
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <h2 style={{
            margin: "0 0 10px", fontSize: 19, fontWeight: 510, color: tk.ink,
            letterSpacing: "-0.01em", lineHeight: 1.25,
          }}>
            {operatorEntry ? "Floe" : label}
          </h2>
          {operatorEntry && (operatorEntry.onNewConversation || operatorEntry.onDeleteConversation) && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {operatorEntry.onNewConversation && (
                <button
                  type="button"
                  onClick={operatorEntry.onNewConversation}
                  disabled={operatorEntry.conversationActionsDisabled || workingEndpoints.size > 0}
                  title={workingEndpoints.size > 0 ? "Wait for Floe to finish before starting another conversation" : undefined}
                  style={{
                    background: "transparent", color: tk.ink2, border: `1px solid ${tk.border}`,
                    borderRadius: tk.r2, padding: "6px 10px", fontSize: 12,
                    cursor: operatorEntry.conversationActionsDisabled || workingEndpoints.size > 0 ? "default" : "pointer",
                    opacity: operatorEntry.conversationActionsDisabled || workingEndpoints.size > 0 ? 0.5 : 1,
                  }}
                >
                  New conversation
                </button>
              )}
              {operatorEntry.onDeleteConversation && (
                <button
                  type="button"
                  onClick={operatorEntry.onDeleteConversation}
                  disabled={operatorEntry.conversationActionsDisabled || workingEndpoints.size > 0}
                  title={workingEndpoints.size > 0 ? "Wait for Floe to finish before deleting this conversation" : undefined}
                  style={{
                    background: "transparent", color: tk.ink3, border: "none",
                    padding: "6px 4px", fontSize: 12,
                    cursor: operatorEntry.conversationActionsDisabled || workingEndpoints.size > 0 ? "default" : "pointer",
                    opacity: operatorEntry.conversationActionsDisabled || workingEndpoints.size > 0 ? 0.5 : 1,
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
        {operatorEntry ? (
          <>
            <p style={{ margin: 0, color: tk.ink3, fontSize: 12.5 }}>Working with you on this workspace.</p>
            {operatorEntry.conversationActionError && (
              <div role="alert" style={{ marginTop: 8, color: tk.danger, fontSize: 12 }}>
                {operatorEntry.conversationActionError}
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <FloeModelControl
                workspaceId={workspaceId}
                onReadyChange={setOperatorModelReady}
                onOpenSettings={operatorEntry.onOpenSettings}
              />
            </div>
          </>
        ) : (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {context.participants.length > 0 ? (
              context.participants.map(p => (
                <ParticipantPill key={p} name={endpointName(p, endpoints)} />
              ))
            ) : (
              <span style={{ fontSize: 12, color: tk.ink4, fontStyle: "italic" }}>No participants</span>
            )}
          </div>
        )}
      </div>

      {/* Body: message stream */}
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
              {operatorEntry ? "Describe the outcome you want Floe to work toward." : "No messages in this context yet."}
            </div>
          ) : (
            visibleMessages.map(event => (
              <MessageRow key={event.event_id} event={event} endpoints={endpoints} />
            ))
          )}

          {/* B1 — Typing / working indicators at bottom of stream */}
          {Array.from(workingEndpoints.keys()).map(endpointId => (
            <WorkingIndicator
              key={endpointId}
              actorName={endpointName(endpointId, endpoints)}
              progress={workProgress.filter(progress => progress.endpointId === endpointId)}
            />
          ))}
          {deliveryNotice && (
            <div role="alert" style={{ padding: "10px 0", color: tk.danger, fontSize: 12.5 }}>
              {deliveryNotice}
            </div>
          )}
        </div>

      </div>

      {/* Footer: composer dock (participant) or non-participant selector + join */}
      {isParticipant ? (
        <ComposerDock
          endpoints={endpoints}
          speakingAsId={speakingAsId}
          onSpeakingAsChange={handleSpeakingAsChange}
          onSend={handleSend}
          hideSpeakingAs={!!operatorEntry}
          placeholder={operatorEntry
            ? operatorModelReady ? "Tell Floe what you want to happen…" : "Choose a provider and model above"
            : undefined}
          disabled={!!operatorEntry && !operatorModelReady}
          disabledReason={operatorEntry && !operatorModelReady ? "Choose a provider and model before talking to Floe." : undefined}
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
