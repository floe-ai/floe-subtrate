/**
 * PROTOTYPE — throwaway. The conversation, rendered INSIDE the canvas.
 *
 * Only Variant B uses this: its whole bet is that there is no second panel, so
 * it cannot borrow the app's inspector the way A and C now do. A and C render
 * their detail in PrototypeInspector instead.
 */
import React from "react";
import { tk } from "../../theme.ts";
import { type Run, STATE_COLOR, STATE_LABEL, ago } from "./fixture.ts";

export function RunConversation({
  run, nodeLabel, onBack, backLabel,
}: {
  run: Run;
  nodeLabel: string;
  onBack: () => void;
  backLabel: string;
}): React.ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
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

      <div style={{ flex: 1, overflow: "auto", padding: "16px 20px", minHeight: 0 }}>
        {(run.passes ?? 1) > 1 && (
          <div style={{
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r2, padding: "8px 10px", marginBottom: 14,
            fontSize: 11.5, color: tk.ink3, lineHeight: 1.5,
          }}>
            <strong style={{ color: tk.ink2, fontWeight: 510 }}>Pass {run.passes}.</strong>{" "}
            Review and rework happened here, inside this run — no second node, no
            arrow pointing backwards.
          </div>
        )}
        {run.gathers && (
          <div style={{
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r2, padding: "8px 10px", marginBottom: 14,
            fontSize: 11.5, color: tk.ink3, lineHeight: 1.5,
          }}>
            This run reads {run.gathers} upstream artifacts. Fan-in is a run that
            takes in many things — not a shape on the canvas.
          </div>
        )}

        {[
          { who: run.actors[0], text: run.last },
          { who: "you", text: "Looks close. Push the silhouette 10% wider and go again." },
          { who: run.actors[run.actors.length - 1], text: "Re-rendering — will write to assets/concepts/." },
        ].map((m, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: tk.ink4, marginBottom: 3 }}>{m.who}</div>
            <div style={{ fontSize: 13, color: tk.ink2, lineHeight: 1.5 }}>{m.text}</div>
          </div>
        ))}
      </div>

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
