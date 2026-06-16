/**
 * WaitingItem — renders a single pending-response item.
 *
 * Shows the source event content as-is. The operator judges whether
 * there is enough context to act. No prescribed content schema.
 *
 * The operator replies in their own words (emitting a normal message event),
 * or jumps to the context. No invented action verbs.
 */
import React, { useState } from "react";
import type { WaitingItem as WaitingItemType } from "../bus-client/types.ts";

export type WaitingItemProps = {
  item: WaitingItemType;
  onReply: (text: string) => void;
  onOpenContext: () => void;
};

const STYLES = {
  card: {
    border: "1px solid #ccc",
    borderRadius: 6,
    padding: "1rem",
    marginBottom: "1rem",
    background: "#fff",
  } as React.CSSProperties,
  actorLine: {
    fontSize: "0.85rem",
    color: "#555",
    marginBottom: "0.5rem",
  } as React.CSSProperties,
  contentBlock: {
    background: "#f6f6f6",
    border: "1px solid #ddd",
    borderRadius: 4,
    padding: "0.5rem 0.75rem",
    fontSize: "0.85rem",
    fontFamily: "monospace",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    margin: "0.5rem 0",
    maxHeight: 240,
    overflow: "auto",
  } as React.CSSProperties,
  replyArea: {
    marginTop: "0.75rem",
  } as React.CSSProperties,
  textarea: {
    width: "100%",
    resize: "vertical" as const,
    fontFamily: "system-ui, sans-serif",
    fontSize: "0.9rem",
    padding: "0.4rem 0.6rem",
    borderRadius: 4,
    border: "1px solid #ccc",
    boxSizing: "border-box" as const,
    minHeight: 64,
  } as React.CSSProperties,
  replyActions: {
    display: "flex",
    gap: "0.5rem",
    marginTop: "0.4rem",
    alignItems: "center",
  } as React.CSSProperties,
};

/** Render event content readably: strings inline, objects as JSON. */
function renderContent(content: Record<string, unknown>): string {
  if (Object.keys(content).length === 0) return "(empty)";
  return JSON.stringify(content, null, 2);
}

export function WaitingItem({ item, onReply, onOpenContext }: WaitingItemProps): React.ReactElement {
  const { source, eventContent, askingActor } = item;
  const [replyText, setReplyText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  async function handleSend() {
    const trimmed = replyText.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      onReply(trimmed);
      setReplyText("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article
      data-testid="waiting-item"
      data-pending-id={source.pending_id}
      style={STYLES.card}
      aria-label={`Waiting on reply from ${askingActor.name}`}
    >
      <p style={STYLES.actorLine} data-section="actor">
        <strong>{askingActor.name}</strong>
        {askingActor.agent_id ? ` · agent ${askingActor.agent_id}` : ""}
        {" is waiting for a response"}
      </p>

      <pre data-section="content" style={STYLES.contentBlock}>
        {renderContent(eventContent)}
      </pre>

      <p style={{ fontSize: "0.8rem", color: "#666", margin: "0.25rem 0" }}>
        <span className="sr-only">Status: </span>
        <span data-section="status">[{source.status}]</span>
        {source.timeout_at && (
          <span> · Expires {new Date(source.timeout_at).toLocaleString()}</span>
        )}
      </p>

      <div style={STYLES.replyArea} data-section="reply">
        <label
          htmlFor={`reply-${source.pending_id}`}
          style={{ fontSize: "0.8rem", color: "#555", display: "block", marginBottom: "0.25rem" }}
        >
          Reply
        </label>
        <textarea
          id={`reply-${source.pending_id}`}
          data-testid="reply-textarea"
          value={replyText}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your reply… (Enter to send, Shift+Enter for newline)"
          disabled={submitting}
          style={STYLES.textarea}
          aria-label="Reply to waiting actor"
        />
        <div style={STYLES.replyActions}>
          <button
            type="button"
            data-testid="reply-send"
            onClick={() => void handleSend()}
            disabled={submitting || !replyText.trim()}
            aria-label="Send reply"
          >
            {submitting ? "Sending…" : "Send"}
          </button>
          <button
            type="button"
            data-testid="open-context"
            onClick={onOpenContext}
            aria-label="Open in context"
          >
            Open in context →
          </button>
        </div>
      </div>
    </article>
  );
}
