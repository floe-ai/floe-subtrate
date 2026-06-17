/**
 * DirectContexts — main-area view listing contexts with no scope ("Direct").
 *
 * Matches v6's treatment of contexts that aren't inside a scope (v6 labels
 * these "workspace context" in the inspector / "— workspace —" for the scope
 * field). Home's hero already promises "Direct work can live in contexts
 * without a scope" — this view makes that real: a place to actually see and
 * open them.
 *
 * Reuses the exact same context-row UI as ScopeDetail's context list
 * (ContextRow, contextLabel) so there's no new visual language. Read-only:
 * no delete affordance here (out of scope for this slice — context deletion
 * lives in ContextInspector once a context is opened).
 */
import React, { useEffect, useState, useCallback } from "react";
import type { ContextRef } from "../bus-client/types.ts";
import { listContexts } from "../bus-client/client.ts";
import { ContextRow } from "./ScopeDetail.tsx";

// ---------------------------------------------------------------------------
// Design tokens (matches App.tsx tk object)
// ---------------------------------------------------------------------------

const tk = {
  canvas:       "#08090a",
  surface:      "#0f1011",
  border:       "rgba(255,255,255,0.08)",
  ink:          "#f7f8f8",
  ink3:         "#8a8f98",
  ink4:         "#62666d",
  fontUi:       '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
} as const;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type DirectContextsProps = {
  workspaceId: string;
  selectedContextId: string | null;
  onSelectContext: (id: string) => void;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DirectContexts({
  workspaceId,
  selectedContextId,
  onSelectContext,
}: DirectContextsProps): React.ReactElement {
  const [contexts, setContexts] = useState<ContextRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadContexts = useCallback(() => {
    setLoading(true);
    setError(null);
    listContexts(workspaceId, { scope: "unscoped" })
      .then(rows => {
        const sorted = [...rows].sort((a, b) => {
          const ta = a.last_event_at ?? a.created_at;
          const tb = b.last_event_at ?? b.created_at;
          return tb.localeCompare(ta);
        });
        setContexts(sorted);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : "Failed to load contexts");
        setLoading(false);
      });
  }, [workspaceId]);

  useEffect(() => {
    loadContexts();
  }, [loadContexts]);

  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      height: "100%",
      overflow: "hidden",
      fontFamily: tk.fontUi,
    }}>
      {/* Header */}
      <div style={{
        padding: "20px 28px 16px",
        borderBottom: `1px solid ${tk.border}`,
        background: tk.surface,
        flexShrink: 0,
      }}>
        <div style={{
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510, marginBottom: 4,
        }}>
          Direct
        </div>
        <h2 style={{
          margin: "0 0 4px", fontSize: 22, fontWeight: 510, color: tk.ink,
          letterSpacing: "-0.015em", lineHeight: 1.1,
        }}>
          Direct contexts
        </h2>
        <p style={{ margin: 0, fontSize: 13, color: tk.ink3, lineHeight: 1.45 }}>
          Contexts with no scope. Direct work that doesn't (yet) belong to an organizing boundary.
        </p>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "12px 28px 8px",
          fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink3, fontWeight: 510,
        }}>
          <span>Contexts</span>
          {!loading && (
            <span style={{ color: tk.ink4, fontWeight: 400, letterSpacing: 0, textTransform: "none", fontSize: 11 }}>
              {contexts.length}
            </span>
          )}
        </div>

        {loading && (
          <div style={{ padding: "20px 28px", color: tk.ink3, fontSize: 13 }}>
            Loading contexts…
          </div>
        )}

        {error && (
          <div role="alert" style={{ padding: "16px 28px", color: "#b85a5a", fontSize: 13 }}>
            {error}
          </div>
        )}

        {!loading && !error && contexts.length === 0 && (
          <div style={{ padding: "32px 28px", color: tk.ink4, fontSize: 13, fontStyle: "italic" }}>
            No direct contexts yet.
          </div>
        )}

        {!loading && !error && contexts.length > 0 && (
          <div role="list" aria-label="Direct contexts (no scope)">
            {contexts.map(ctx => (
              <ContextRow
                key={ctx.context_id}
                ctx={ctx}
                isSelected={selectedContextId === ctx.context_id}
                onClick={() => onSelectContext(ctx.context_id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
