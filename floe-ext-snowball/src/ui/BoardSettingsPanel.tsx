/**
 * BoardSettingsPanel — slide-in panel for editing board-level settings.
 *
 * Currently exposes the board-wide done protocol (stored in board.md body).
 * The done protocol is injected into every column worker's BeforeTurn prompt
 * and drives the advance-on-conclusion behavior.
 *
 * Styled to match the dark Snowball board theme and mirrors the
 * ColumnConfigPanel editing UX.
 */

import React, { useState, useEffect } from "react";
import { XIcon, BookOpenIcon } from "lucide-react";

interface BoardSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  /** Current done protocol text, loaded from GET /board/instructions. */
  doneProtocol: string;
  onSave: (doneProtocol: string) => Promise<void>;
}

export function BoardSettingsPanel({
  open,
  onClose,
  doneProtocol,
  onSave,
}: BoardSettingsPanelProps) {
  const [draft, setDraft] = useState(doneProtocol);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync draft when the prop changes (panel re-opened, external reload)
  useEffect(() => {
    setDraft(doneProtocol);
    setError(null);
  }, [doneProtocol, open]);

  if (!open) return null;

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  // ── Styles ────────────────────────────────────────────────────────────

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.5)",
    zIndex: 400,
  };

  const panel: React.CSSProperties = {
    position: "fixed",
    right: 0,
    top: 0,
    bottom: 0,
    width: 420,
    background: "#0f1011",
    borderLeft: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    flexDirection: "column",
    zIndex: 401,
    fontFamily:
      '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
    color: "#f7f8f8",
    overflow: "hidden",
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#62666d",
    marginBottom: 6,
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "#1a1c1e",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 6,
    color: "#f7f8f8",
    fontSize: 13,
    padding: "7px 10px",
    outline: "none",
    boxSizing: "border-box",
  };

  const btnBase: React.CSSProperties = {
    borderRadius: 6,
    padding: "7px 14px",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    border: "1px solid rgba(255,255,255,0.1)",
  };

  return (
    <>
      {/* Overlay — click to close */}
      <div style={overlay} onClick={onClose} />

      {/* Panel */}
      <div style={panel}>
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            flexShrink: 0,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BookOpenIcon size={14} style={{ color: "#8aa89c" }} />
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              Board Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: "#8a8f98",
              cursor: "pointer",
              padding: 2,
            }}
            aria-label="Close"
          >
            <XIcon size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            gap: 16,
          }}
        >
          {/* ── Done Protocol ───────────────────────────────── */}
          <section>
            <p style={sectionLabel}>Done Protocol</p>
            <p
              style={{
                margin: "0 0 8px",
                fontSize: 11,
                color: "#62666d",
                lineHeight: 1.5,
              }}
            >
              Board-wide instructions injected into every column worker&apos;s
              BeforeTurn prompt. Defines how agents complete work and advance
              cards. Stored in{" "}
              <code
                style={{
                  fontFamily: "monospace",
                  fontSize: 10,
                  color: "#8a8f98",
                }}
              >
                .floe/extensions/snowball/boards/&lt;slug&gt;/board.md
              </code>
              .
            </p>
            <textarea
              rows={18}
              style={{
                ...inputStyle,
                resize: "vertical",
                fontFamily: '"JetBrains Mono",monospace',
                fontSize: 12,
                lineHeight: 1.5,
              }}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Describe how agents should complete work and advance cards…"
              disabled={saving}
            />
          </section>
        </div>

        {/* Footer: error + save/cancel */}
        <div
          style={{
            padding: "14px 20px",
            borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
            flexShrink: 0,
          }}
        >
          {error && (
            <p style={{ margin: 0, fontSize: 12, color: "#b85a5a" }}>{error}</p>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              style={{
                ...btnBase,
                background: "transparent",
                color: "#8a8f98",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={{
                ...btnBase,
                background: "rgba(138,168,156,0.2)",
                borderColor: "rgba(138,168,156,0.4)",
                color: "#8aa89c",
                fontWeight: 600,
                cursor: saving ? "not-allowed" : "pointer",
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
