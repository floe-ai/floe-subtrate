/**
 * FolderPicker — browsable directory picker for the register-workspace flow.
 *
 * The console is usually NOT co-located with workspace files (e.g. a Windows
 * console tunneled into a Linux substrate), so a native file dialog or
 * `<input type="file">` can't see the box's filesystem. Instead this browses
 * directories via the bus's `/v1/fs/browse` HTTP surface (gated on
 * `workspace_access.local_paths`) — the bus runs on the box and can see
 * what's actually there.
 *
 * Used by both the topbar "Register workspace…" inline form and the
 * full-page RegisterWorkspaceScreen (no-workspaces bootstrap). The manual
 * text input stays as a fallback in both places — this component just sets
 * the value when the user clicks "Select this folder".
 */
import React, { useEffect, useState } from "react";
import { busBrowseDir } from "../bus-client/client.ts";

const tk = {
  surface: "#0f1011",
  surfaceSunk: "#0b0c0d",
  border: "rgba(255,255,255,0.08)",
  border2: "rgba(255,255,255,0.05)",
  ink: "#f7f8f8",
  ink3: "#8a8f98",
  ink4: "#62666d",
  accent: "#8aa89c",
  danger: "#b85a5a",
  fontUi: '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  r1: 3,
  r2: 5,
} as const;

export type FolderPickerProps = {
  /** Called with the chosen directory's absolute path when the user confirms. */
  onSelect: (path: string) => void;
  /** Called when the user dismisses the picker without selecting. */
  onCancel?: () => void;
};

type BrowseState =
  | { phase: "loading" }
  | { phase: "ready"; path: string; parent: string | null; entries: { name: string; is_dir: boolean }[] }
  | { phase: "error"; message: string };

export function FolderPicker({ onSelect, onCancel }: FolderPickerProps): React.ReactElement {
  const [state, setState] = useState<BrowseState>({ phase: "loading" });

  function load(path?: string) {
    setState({ phase: "loading" });
    busBrowseDir(path)
      .then((res) => setState({ phase: "ready", ...res }))
      .catch((err) =>
        setState({ phase: "error", message: err instanceof Error ? err.message : "Failed to browse directory" })
      );
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      data-testid="folder-picker"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        border: `1px solid ${tk.border}`,
        borderRadius: tk.r2,
        background: tk.surfaceSunk,
        padding: 8,
      }}
    >
      {state.phase === "loading" && (
        <span style={{ fontSize: 12, color: tk.ink3, padding: "4px 2px" }}>Loading…</span>
      )}

      {state.phase === "error" && (
        <span role="alert" style={{ fontSize: 12, color: tk.danger, padding: "4px 2px" }}>
          {state.message}
        </span>
      )}

      {state.phase === "ready" && (
        <>
          <div
            data-testid="folder-picker-current-path"
            style={{
              fontSize: 11.5,
              fontFamily: "monospace",
              color: tk.ink,
              padding: "4px 2px",
              wordBreak: "break-all",
            }}
            title={state.path}
          >
            {state.path}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 220, overflowY: "auto" }}>
            {state.parent && (
              <button
                onClick={() => load(state.parent!)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", padding: "5px 6px", borderRadius: tk.r1,
                  background: "transparent", border: "none",
                  textAlign: "left", fontSize: 12.5, color: tk.ink3, cursor: "pointer",
                  fontFamily: tk.fontUi,
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
              >
                <span style={{ width: 14, textAlign: "center" }}>↑</span>
                <span>..</span>
              </button>
            )}

            {state.entries.length === 0 && !state.parent && (
              <span style={{ fontSize: 12, color: tk.ink4, padding: "5px 6px", fontStyle: "italic" }}>
                No subdirectories
              </span>
            )}

            {state.entries.map((entry) => (
              <button
                key={entry.name}
                onClick={() => load(`${state.path.replace(/[/\\]+$/, "")}/${entry.name}`)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  width: "100%", padding: "5px 6px", borderRadius: tk.r1,
                  background: "transparent", border: "none",
                  textAlign: "left", fontSize: 12.5, color: tk.ink, cursor: "pointer",
                  fontFamily: tk.fontUi,
                }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.05)")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "transparent")}
              >
                <span style={{ width: 14, textAlign: "center", color: tk.ink4 }}>▸</span>
                <span>{entry.name}</span>
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <button
              onClick={() => onSelect(state.path)}
              style={{
                background: tk.accent, color: "#0c1714", border: "none",
                borderRadius: tk.r1, padding: "5px 10px", fontSize: 12, cursor: "pointer", fontWeight: 510,
                fontFamily: tk.fontUi,
              }}
            >
              Select this folder
            </button>
            {onCancel && (
              <button
                onClick={onCancel}
                style={{
                  background: "transparent", border: `1px solid ${tk.border2}`,
                  color: tk.ink3, borderRadius: tk.r1, padding: "5px 10px", fontSize: 12,
                  cursor: "pointer", fontFamily: tk.fontUi,
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
