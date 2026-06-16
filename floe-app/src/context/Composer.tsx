/**
 * Composer — text input for emitting reply events into a Context.
 *
 * Builds an EmitInput with destination { kind: "context", context_id } and
 * calls onEmit. Keyboard submit: Enter (without Shift) sends; Shift+Enter inserts newline.
 */
import React, { useState } from "react";
import type { EmitInput } from "../bus-client/types.ts";

export type ComposerProps = {
  workspaceId: string;
  contextId: string;
  sourceEndpointId: string;
  onEmit?: (event: EmitInput) => Promise<void>;
  disabled?: boolean;
};

export function Composer({
  workspaceId,
  contextId,
  sourceEndpointId,
  onEmit,
  disabled = false,
}: ComposerProps): React.ReactElement {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || submitting || disabled) return;

    const event: EmitInput = {
      type: "floe.context.reply",
      workspace_id: workspaceId,
      source_endpoint_id: sourceEndpointId,
      destination: { kind: "context", context_id: contextId },
      context_id: contextId,
      content: { text: trimmed },
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

  return (
    <div data-testid="composer">
      <label htmlFor="composer-input" className="sr-only">
        Compose event
      </label>
      <textarea
        id="composer-input"
        data-testid="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Compose an event… (Enter to send, Shift+Enter for newline)"
        disabled={disabled || submitting}
        aria-label="Compose event"
        rows={3}
      />
      <button
        data-testid="composer-send"
        onClick={() => void submit()}
        disabled={disabled || submitting || !text.trim()}
        aria-label="Send event"
      >
        Send
      </button>
    </div>
  );
}
