/**
 * ActorBodyEditor — editable markdown source textarea with a rendered
 * preview and a source/rendered toggle. Shared by NewActorForm (create) and
 * ActorInspector (edit), so both forms render actor instructions the same
 * way.
 */
import React, { useState } from "react";
import { MiniMarkdown } from "./markdown.tsx";

const tk = {
  surface: "#0f1011",
  border: "rgba(255,255,255,0.08)",
  ink: "#f7f8f8",
  ink3: "#8a8f98",
  accent: "#8aa89c",
  r2: 5,
  r3: 8,
  fontUi: '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
} as const;

export type ActorBodyEditorProps = {
  value: string;
  onChange: (next: string) => void;
  readOnly?: boolean;
  minHeight?: number;
};

export function ActorBodyEditor({ value, onChange, readOnly, minHeight = 220 }: ActorBodyEditorProps): React.ReactElement {
  const [mode, setMode] = useState<"source" | "rendered">("source");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div role="tablist" aria-label="Body view" style={{ display: "flex", gap: 4 }}>
        <button
          role="tab"
          aria-selected={mode === "source"}
          onClick={() => setMode("source")}
          style={{
            background: mode === "source" ? "rgba(255,255,255,0.06)" : "transparent",
            border: `1px solid ${mode === "source" ? tk.accent : tk.border}`,
            color: mode === "source" ? tk.accent : tk.ink3,
            borderRadius: tk.r2, padding: "4px 10px", fontSize: 11.5, cursor: "pointer",
            fontFamily: tk.fontUi,
          }}
        >
          Source
        </button>
        <button
          role="tab"
          aria-selected={mode === "rendered"}
          onClick={() => setMode("rendered")}
          style={{
            background: mode === "rendered" ? "rgba(255,255,255,0.06)" : "transparent",
            border: `1px solid ${mode === "rendered" ? tk.accent : tk.border}`,
            color: mode === "rendered" ? tk.accent : tk.ink3,
            borderRadius: tk.r2, padding: "4px 10px", fontSize: 11.5, cursor: "pointer",
            fontFamily: tk.fontUi,
          }}
        >
          Rendered
        </button>
      </div>

      {mode === "source" ? (
        <textarea
          aria-label="Actor instructions (markdown source)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          readOnly={readOnly}
          spellCheck={false}
          style={{
            minHeight,
            resize: "vertical",
            background: "rgba(255,255,255,0.04)",
            color: tk.ink,
            border: `1px solid ${tk.border}`,
            borderRadius: tk.r2,
            padding: "10px 12px",
            fontSize: 13,
            lineHeight: 1.55,
            fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
            outline: "none",
          }}
        />
      ) : (
        <div
          data-testid="actor-body-rendered"
          style={{
            minHeight,
            background: tk.surface,
            border: `1px solid ${tk.border}`,
            borderRadius: tk.r2,
            padding: "12px 14px",
            overflow: "auto",
          }}
        >
          <MiniMarkdown source={value} />
        </div>
      )}
    </div>
  );
}
