/**
 * FeedbackAffordance — contextual feedback widget.
 *
 * Lets the operator attach free-text feedback to any substrate element
 * (event, context, endpoint, pulse, etc.). On submit, emits a
 * "floe.feedback" event whose content references the target element.
 * Keyboard-accessible (Enter to submit, Escape to cancel).
 */
import React, { useCallback, useRef, useState } from "react";
import { emit } from "../bus-client/client.ts";
import type { EmitInput } from "../bus-client/types.ts";

export type FeedbackTarget = {
  kind: string;
  id: string;
};

export type FeedbackAffordanceProps = {
  workspaceId: string;
  sourceEndpointId: string;
  target: FeedbackTarget;
};

export function FeedbackAffordance({
  workspaceId,
  sourceEndpointId,
  target,
}: FeedbackAffordanceProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleOpen = useCallback(() => {
    setOpen(true);
    setSubmitted(false);
    setError(null);
    // Allow DOM to settle before focusing
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const handleCancel = useCallback(() => {
    setOpen(false);
    setText("");
    setError(null);
  }, []);

  const handleSubmit = useCallback(async () => {
    const body = text.trim();
    if (!body || submitting) return;

    const input: EmitInput = {
      type: "floe.feedback",
      workspace_id: workspaceId,
      source_endpoint_id: sourceEndpointId,
      destination: {
        kind: "broadcast",
        scope: "workspace",
        target: workspaceId,
        exclude_source: false,
      },
      content: {
        body,
        target_kind: target.kind,
        target_id: target.id,
      },
      response: { expected: false },
    };

    setSubmitting(true);
    setError(null);
    try {
      await emit(input);
      setSubmitted(true);
      setText("");
      setOpen(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to submit feedback"
      );
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, workspaceId, sourceEndpointId, target]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      } else if (e.key === "Escape") {
        handleCancel();
      }
    },
    [handleSubmit, handleCancel]
  );

  return (
    <div data-testid="feedback-affordance">
      {!open && (
        <button
          data-section="open"
          onClick={handleOpen}
          aria-label={`Add feedback for ${target.kind} ${target.id}`}
        >
          Feedback
        </button>
      )}

      {submitted && !open && (
        <span
          role="status"
          aria-live="polite"
          style={{ marginLeft: "8px", color: "#090" }}
        >
          Feedback submitted
        </span>
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label={`Feedback for ${target.kind} ${target.id}`}
        >
          <p style={{ margin: "0 0 4px", fontSize: "0.875rem", color: "#555" }}>
            Feedback on{" "}
            <strong>
              {target.kind} {target.id}
            </strong>
          </p>

          <label htmlFor="feedback-text" style={{ display: "none" }}>
            Feedback text
          </label>
          <textarea
            id="feedback-text"
            ref={textareaRef}
            data-section="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            placeholder="Your feedback…"
            rows={3}
            aria-label="Feedback text"
            style={{ display: "block", width: "100%", resize: "vertical" }}
          />

          <div
            style={{ display: "flex", gap: "8px", marginTop: "6px" }}
          >
            <button
              data-section="submit"
              onClick={() => void handleSubmit()}
              disabled={submitting || !text.trim()}
              aria-label="Submit feedback"
            >
              {submitting ? "Submitting…" : "Submit"}
            </button>
            <button
              data-section="cancel"
              onClick={handleCancel}
              disabled={submitting}
              aria-label="Cancel feedback"
            >
              Cancel
            </button>
          </div>

          {error && (
            <p role="alert" style={{ color: "#c00", marginTop: "4px" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
