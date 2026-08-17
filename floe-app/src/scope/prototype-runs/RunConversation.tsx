/**
 * PROTOTYPE — throwaway. Shared stub for "you have opened one run".
 *
 * Every variant disagrees about HOW you get here and how you get back out —
 * that is the thing being judged. What you see once you are inside is the same
 * in all three, so it is shared, the way a header would be.
 */
import React from "react";
import { tk } from "../../theme.ts";
import { type Run, STATE_COLOR, STATE_LABEL, ago } from "./fixture.ts";

export function RunConversation({
  run,
  nodeLabel,
  onBack,
  backLabel,
}: {
  run: Run;
  nodeLabel: string;
  onBack: () => void;
  backLabel: string;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* Where am I, and how do I leave */}
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 20px", borderBottom: `1px solid ${tk.border}`, flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{
            background: "transparent", border: `1px solid ${tk.border}`, color: tk.ink2,
            borderRadius: tk.r2, padding: "4px 10px", fontSize: 11.5, cursor: "pointer",
            fontFamily: tk.fontUi,
          }}
        >
          ← {backLabel}
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, color: tk.ink, fontWeight: 510 }}>{run.label}</div>
          <div style={{ fontSize: 11, color: tk.ink4 }}>
            one run of “{nodeLabel}” · {STATE_LABEL[run.state]} · {ago(run.age_min)} ago
          </div>
        </div>
        <span style={{
          marginLeft: "auto", width: 8, height: 8, borderRadius: 8,
          background: STATE_COLOR[run.state], flexShrink: 0,
        }} />
      </div>

      {/* The conversation */}
      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", minHeight: 0 }}>
        {run.reworked_from && (
          <div style={{
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r2, padding: "8px 10px", marginBottom: 14,
            fontSize: 11.5, color: tk.ink3,
          }}>
            Re-opened from an earlier run. It never became an arrow on the canvas —
            it is just this conversation, still going.
          </div>
        )}
        {run.gathers && (
          <div style={{
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r2, padding: "8px 10px", marginBottom: 14,
            fontSize: 11.5, color: tk.ink3,
          }}>
            This run is taking in {run.gathers} upstream artifacts. Fan-in is a run
            that reads many things — not a shape on the canvas.
          </div>
        )}

        {[
          { who: run.actors[0], text: run.last },
          { who: "you", text: "Looks close. Push the silhouette 10% wider and re-render." },
          { who: run.actors[0], text: "Re-rendering now — will write to assets/concepts/." },
        ].map((m, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: tk.ink4, marginBottom: 3 }}>{m.who}</div>
            <div style={{ fontSize: 13, color: tk.ink2, lineHeight: 1.5 }}>{m.text}</div>
          </div>
        ))}
      </div>

      {/* Composer — a person joins a run as just another actor */}
      <div style={{ padding: "10px 20px 14px", borderTop: `1px solid ${tk.border}`, flexShrink: 0 }}>
        <div style={{
          border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: tk.surfaceSunk,
          padding: "9px 12px", fontSize: 12.5, color: tk.ink4,
        }}>
          Say something in this run…
        </div>
      </div>
    </div>
  );
}
