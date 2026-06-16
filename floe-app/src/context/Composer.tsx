/**
 * Composer — neutral message composer.
 *
 * "As [acting actor] → To [destination]" pattern.
 * Destination is any endpoint in the workspace OR a workspace broadcast.
 * Type "message". source = actingAsEndpointId.
 *
 * Keyboard: Enter sends, Shift+Enter inserts newline.
 */
import React, { useState } from "react";
import type { EmitInput, EndpointRef } from "../bus-client/types.ts";
import { colors, space, font } from "../theme.ts";

// Valid broadcast targets (mirrors floe-bus/src/store.ts BROADCAST_TARGETS)
const BROADCAST_TARGETS = [
  "all",
  "active",
  "with_delivery_processor",
  "without_delivery_processor",
  "active_with_delivery_processor",
  "active_without_delivery_processor",
] as const;

type BroadcastTarget = typeof BROADCAST_TARGETS[number];

const BROADCAST_PREFIX = "broadcast:";

export type ComposerProps = {
  workspaceId: string;
  actingAsEndpointId: string;
  contextId: string;
  endpoints: EndpointRef[];
  participantEndpointIds: string[];
  onEmit?: (event: EmitInput) => Promise<void>;
  disabled?: boolean;
};

export function Composer({
  workspaceId,
  actingAsEndpointId,
  contextId,
  endpoints,
  participantEndpointIds,
  onEmit,
  disabled = false,
}: ComposerProps): React.ReactElement {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [responseExpected, setResponseExpected] = useState(true);

  // Determine default destination: the first other participant, or broadcast:all
  const otherParticipants = participantEndpointIds.filter(
    (id) => id !== actingAsEndpointId
  );
  const defaultDest =
    otherParticipants[0]
      ? otherParticipants[0]
      : `${BROADCAST_PREFIX}all`;

  const [destinationValue, setDestinationValue] = useState<string>(defaultDest);

  // Build destination selector from the value
  function buildDestination(val: string): EmitInput["destination"] {
    if (val.startsWith(BROADCAST_PREFIX)) {
      const target = val.slice(BROADCAST_PREFIX.length) as BroadcastTarget;
      return { kind: "broadcast", scope: "workspace", target };
    }
    return { kind: "endpoint", endpoint_id: val };
  }

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || submitting || disabled || !actingAsEndpointId) return;

    const event: EmitInput = {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: actingAsEndpointId,
      destination: buildDestination(destinationValue),
      context_id: contextId,
      content: { text: trimmed },
      response: { expected: responseExpected, mode: "open" },
      metadata: { submitted_by: "floe-app" },
    };

    setSubmitting(true);
    try {
      await onEmit?.(event);
      setText("");
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  const inputStyle: React.CSSProperties = {
    background: colors.canvas,
    color: colors.text,
    border: `1px solid ${colors.border}`,
    borderRadius: 4,
    padding: "4px 8px",
    fontSize: 13,
    fontFamily: "system-ui, sans-serif",
    cursor: "pointer",
  };

  return (
    <div data-testid="composer">
      {/* Destination row */}
      <div
        style={{
          display: "flex",
          gap: space.sm,
          alignItems: "center",
          marginBottom: space.sm,
          flexWrap: "wrap",
          fontSize: font.meta,
          color: colors.muted,
        }}
      >
        <span>
          As{" "}
          <strong style={{ color: colors.text }}>
            {endpoints.find((e) => e.endpoint_id === actingAsEndpointId)?.name ||
              actingAsEndpointId ||
              "—"}
          </strong>
        </span>
        <span>→</span>
        <label htmlFor="composer-dest" style={{ color: colors.muted }}>
          To
        </label>
        <select
          id="composer-dest"
          data-testid="composer-dest"
          style={inputStyle}
          value={destinationValue}
          onChange={(e) => setDestinationValue(e.target.value)}
          aria-label="Destination endpoint or broadcast"
        >
          {/* Individual endpoints */}
          <optgroup label="Endpoints">
            {endpoints.map((ep) => (
              <option key={ep.endpoint_id} value={ep.endpoint_id}>
                {ep.name || ep.endpoint_id}
              </option>
            ))}
          </optgroup>
          {/* Broadcast options */}
          <optgroup label="Broadcast → workspace">
            {BROADCAST_TARGETS.map((t) => (
              <option key={t} value={`${BROADCAST_PREFIX}${t}`}>
                Broadcast · {t}
              </option>
            ))}
          </optgroup>
        </select>

        {/* Response expected */}
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input
            type="checkbox"
            data-testid="composer-response-expected"
            checked={responseExpected}
            onChange={(e) => setResponseExpected(e.target.checked)}
          />
          Response expected
        </label>
      </div>

      {/* Textarea */}
      <div style={{ display: "flex", gap: space.sm, alignItems: "flex-end" }}>
        <label htmlFor="composer-input" className="sr-only">
          Compose message
        </label>
        <textarea
          id="composer-input"
          data-testid="composer-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Compose a message… (Enter to send, Shift+Enter for newline)"
          disabled={disabled || submitting}
          aria-label="Compose message"
          rows={3}
          style={{
            flex: 1,
            resize: "vertical",
            background: colors.surface,
            color: colors.text,
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            padding: `${space.sm}px`,
            fontSize: 14,
            fontFamily: "system-ui, sans-serif",
            lineHeight: 1.5,
          }}
          onFocus={(e) => {
            (e.currentTarget as HTMLTextAreaElement).style.outline = `2px solid ${colors.accent}`;
            (e.currentTarget as HTMLTextAreaElement).style.outlineOffset = "0px";
          }}
          onBlur={(e) => {
            (e.currentTarget as HTMLTextAreaElement).style.outline = "none";
          }}
        />
        <button
          data-testid="composer-send"
          onClick={() => void submit()}
          disabled={disabled || submitting || !text.trim()}
          aria-label="Send message"
          style={{
            background: colors.accent,
            color: colors.accentText,
            border: "none",
            borderRadius: 4,
            padding: `${space.sm}px ${space.lg}px`,
            cursor: disabled || submitting || !text.trim() ? "not-allowed" : "pointer",
            opacity: disabled || submitting || !text.trim() ? 0.5 : 1,
            fontSize: 14,
            fontFamily: "system-ui, sans-serif",
            alignSelf: "flex-end",
          }}
        >
          {submitting ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
