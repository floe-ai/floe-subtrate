/**
 * FloeCommand — persistent command bar for emitting operator instructions
 * to the substrate via the event bus.
 *
 * Submitting emits a "floe.command" event routed as a workspace broadcast.
 * Keyboard submit: Enter (without Shift).
 */
import React, { useCallback, useRef, useState } from "react";
import { emit } from "../bus-client/client.ts";
import type { EmitInput } from "../bus-client/types.ts";

export type FloeCommandProps = {
  workspaceId: string;
  sourceEndpointId: string;
  contextId?: string | null;
  placeholder?: string;
};

export function FloeCommand({
  workspaceId,
  sourceEndpointId,
  contextId,
  placeholder = "Enter a command…",
}: FloeCommandProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async () => {
    const text = value.trim();
    if (!text || submitting) return;

    const input: EmitInput = {
      type: "floe.command",
      workspace_id: workspaceId,
      source_endpoint_id: sourceEndpointId,
      destination: {
        kind: "broadcast",
        scope: "workspace",
        target: workspaceId,
        exclude_source: false,
      },
      context_id: contextId ?? null,
      scope_id: null,
      content: { command: text },
      response: { expected: false },
    };

    setSubmitting(true);
    setError(null);
    try {
      await emit(input);
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to emit command");
    } finally {
      setSubmitting(false);
      inputRef.current?.focus();
    }
  }, [value, submitting, workspaceId, sourceEndpointId, contextId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <div data-testid="floe-command">
      <label htmlFor="floe-command-input" style={{ display: "none" }}>
        Floe command
      </label>
      <input
        id="floe-command-input"
        ref={inputRef}
        type="text"
        data-section="input"
        placeholder={placeholder}
        value={value}
        disabled={submitting}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        aria-label="Floe command input"
        aria-disabled={submitting}
        autoComplete="off"
      />
      <button
        data-section="submit"
        onClick={() => void handleSubmit()}
        disabled={submitting || !value.trim()}
        aria-label="Submit command"
      >
        {submitting ? "Running…" : "Run"}
      </button>
      {error && (
        <p role="alert" style={{ color: "#c00", marginTop: "4px" }}>
          {error}
        </p>
      )}
    </div>
  );
}
