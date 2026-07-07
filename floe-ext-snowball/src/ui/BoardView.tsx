/**
 * SnowballBoard — the extension view component.
 *
 * Exported as the "BoardView" entry point (package.json exports["./BoardView"]).
 * Imported by floe-app/src/scope/ScopeDetail.tsx at build time (Track S adds
 * the static import; see contract §1.5).
 *
 * Props: ExtensionViewProps (contract §1.4)
 *  - workspaceId: string
 *  - scopeId: string
 *  - busBaseUrl: string   — base URL of the bus HTTP server
 *  - extensionName: string — "snowball"
 *
 * Data flow:
 *  1. Fetch board state from GET /v1/extensions/snowball/board?scope_id=<id>
 *  2. Render columns + cards using Board + Column + Card components
 *  3. Move: POST /v1/extensions/snowball/move  → refresh board
 *
 * TODO(Phase-3): replace build-time static import with runtime registry
 * when external (out-of-monorepo) extensions are needed.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Board } from "./Board.tsx";
import type {
  ExtensionViewProps,
  UiBoardState,
  UiCard,
  UiColumn,
} from "./types.ts";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchBoardState(
  busBaseUrl: string,
  extensionName: string,
  scopeId: string
): Promise<UiBoardState> {
  const url = `${busBaseUrl}/v1/extensions/${extensionName}/board?scope_id=${encodeURIComponent(scopeId)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch board state: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<UiBoardState>;
}

async function postMove(
  busBaseUrl: string,
  extensionName: string,
  payload: {
    scope_id: string;
    card_id: string;
    to_column_id: string;
    force: boolean;
  }
): Promise<{ ok: boolean; error?: string }> {
  const url = `${busBaseUrl}/v1/extensions/${extensionName}/move`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  return data;
}

// ---------------------------------------------------------------------------
// SnowballBoard
// ---------------------------------------------------------------------------

export function SnowballBoard({
  workspaceId,
  scopeId,
  busBaseUrl,
  extensionName,
}: ExtensionViewProps) {
  const [board, setBoard] = useState<UiBoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCard, setSelectedCard] = useState<UiCard | null>(null);

  const reload = useCallback(async () => {
    try {
      const state = await fetchBoardState(busBaseUrl, extensionName, scopeId);
      setBoard(state);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [busBaseUrl, extensionName, scopeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function handleMove(
    cardId: string,
    toColumnId: string,
    force: boolean
  ): Promise<boolean> {
    if (!board) return false;
    try {
      const result = await postMove(busBaseUrl, extensionName, {
        scope_id: scopeId,
        card_id: cardId,
        to_column_id: toColumnId,
        force,
      });
      if (result.ok) {
        await reload();
        return true;
      } else {
        setError(result.error ?? "Move failed");
        return false;
      }
    } catch (e) {
      setError(String(e));
      return false;
    }
  }

  function handleConfigColumn(_column: UiColumn) {
    // TODO(Phase-2): open column config panel (port ColumnConfig.tsx)
    // For Phase 1, column config is managed via the overseer or directly
    // editing the sidecar YAML.
    console.info("[snowball] Column config UI not yet implemented");
  }

  const containerStyle: React.CSSProperties = {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: "#08090a",
    fontFamily:
      '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  };

  if (loading) {
    return (
      <div style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#62666d", fontSize: 13 }}>Loading board…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ ...containerStyle, alignItems: "center", justifyContent: "center", gap: 8 }}>
        <p style={{ color: "#b85a5a", fontSize: 13 }}>{error}</p>
        <button
          type="button"
          onClick={() => { setError(null); setLoading(true); reload(); }}
          style={{
            background: "none",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 6,
            color: "#8a8f98",
            cursor: "pointer",
            fontSize: 12,
            padding: "6px 12px",
          }}
        >
          Retry
        </button>
        {!busBaseUrl.includes("localhost") && (
          <p style={{ color: "#62666d", fontSize: 11, marginTop: 4 }}>
            Note: board data requires the Track S extension relay to be running.
          </p>
        )}
      </div>
    );
  }

  if (!board) {
    return (
      <div style={{ ...containerStyle, alignItems: "center", justifyContent: "center" }}>
        <p style={{ color: "#62666d", fontSize: 13 }}>No board data</p>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          flexShrink: 0,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 600, color: "#d0d6e0" }}>
          Board
        </span>
        <span style={{ fontSize: 11, color: "#62666d" }}>
          {board.cards.length} card{board.cards.length !== 1 ? "s" : ""}
          {" · "}
          {board.columns.filter((c) => c.wip_exceeded).length > 0 && (
            <span style={{ color: "#b85a5a" }}>
              {board.columns.filter((c) => c.wip_exceeded).length} WIP violation
              {board.columns.filter((c) => c.wip_exceeded).length !== 1 ? "s" : ""}
              {" · "}
            </span>
          )}
          {scopeId}
        </span>
      </div>

      {/* Board */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Board
          board={board}
          onMove={handleMove}
          onSelectCard={setSelectedCard}
          onConfigColumn={handleConfigColumn}
        />
      </div>

      {/* Card detail (minimal for Phase 1) */}
      {selectedCard && (
        <div
          style={{
            position: "fixed",
            right: 0,
            top: 0,
            bottom: 0,
            width: 340,
            background: "#0f1011",
            borderLeft: "1px solid rgba(255,255,255,0.08)",
            padding: "24px 20px",
            overflowY: "auto",
            zIndex: 500,
            color: "#f7f8f8",
            fontFamily:
              '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {selectedCard.title}
            </h3>
            <button
              type="button"
              onClick={() => setSelectedCard(null)}
              style={{
                background: "none",
                border: "none",
                color: "#8a8f98",
                cursor: "pointer",
                fontSize: 16,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#8a8f98" }}>
            ID: <code style={{ fontFamily: "monospace", color: "#62666d" }}>{selectedCard.card_id}</code>
          </p>
          <p style={{ margin: "0 0 8px", fontSize: 12, color: "#8a8f98" }}>
            Column:{" "}
            <strong style={{ color: "#d0d6e0" }}>
              {board.columns.find((c) => c.id === selectedCard.column_id)?.name ??
                selectedCard.column_id}
            </strong>
          </p>
          <p style={{ margin: "0 0 16px", fontSize: 11, color: "#62666d" }}>
            Created: {new Date(selectedCard.created_at).toLocaleString()}
          </p>
          {selectedCard.criteria_checks.length > 0 && (
            <>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 600, color: "#8a8f98", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Criteria
              </h4>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {selectedCard.criteria_checks.map((check) => (
                  <li
                    key={check.criterionId}
                    style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 99,
                        background: check.checked ? "#87b894" : "#3a3d42",
                        flexShrink: 0,
                      }}
                    />
                    <span style={{ color: check.checked ? "#d0d6e0" : "#8a8f98" }}>
                      {check.criterionId}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Re-export ExtensionViewProps for host-app convenience
export type { ExtensionViewProps } from "./types.ts";
