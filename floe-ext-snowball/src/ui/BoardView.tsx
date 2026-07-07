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
 *  3. All mutations POST to the relay and refresh on success.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { PlusIcon, BotIcon, UserIcon, CheckCircle2Icon, CircleIcon, Trash2Icon, XIcon } from "lucide-react";
import { Board } from "./Board.tsx";
import { ColumnConfigPanel, type ColumnConfigPayload } from "./ColumnConfigPanel.tsx";
import type {
  ExtensionViewProps,
  UiBoardState,
  UiCard,
  UiColumn,
} from "./types.ts";

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch(url: string, options?: RequestInit): Promise<unknown> {
  const res = await fetch(url, options);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json() as { error?: string };
      if (body.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

function apiBase(busBaseUrl: string, extensionName: string): string {
  return `${busBaseUrl}/v1/extensions/${extensionName}`;
}

async function fetchBoardState(
  busBaseUrl: string,
  extensionName: string,
  scopeId: string
): Promise<UiBoardState> {
  const url = `${apiBase(busBaseUrl, extensionName)}/board?scope_id=${encodeURIComponent(scopeId)}`;
  return apiFetch(url) as Promise<UiBoardState>;
}

async function postJson(
  busBaseUrl: string,
  extensionName: string,
  path: string,
  body: unknown
): Promise<unknown> {
  return apiFetch(`${apiBase(busBaseUrl, extensionName)}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// CardDetailPanel — side panel shown when a card is selected
// ---------------------------------------------------------------------------

interface CardDetailPanelProps {
  card: UiCard;
  board: UiBoardState;
  onClose: () => void;
  onMove: (cardId: string, toColumnId: string, force: boolean) => Promise<boolean>;
  onRename: (cardId: string, title: string) => Promise<void>;
  onDelete: (cardId: string) => Promise<void>;
  onToggleCriterion: (
    cardId: string,
    columnId: string,
    criterionId: string,
    checked: boolean
  ) => Promise<void>;
}

function CardDetailPanel({
  card,
  board,
  onClose,
  onMove,
  onRename,
  onDelete,
  onToggleCriterion,
}: CardDetailPanelProps) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState(card.title);
  const [savingTitle, setSavingTitle] = useState(false);
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const currentCol = board.columns.find((c) => c.id === card.column_id);
  const exitCriteria = currentCol?.exit_criteria ?? [];
  const currentChecks = card.criteria_checks.filter(
    (c) => c.columnId === card.column_id
  );

  useEffect(() => {
    setDraftTitle(card.title);
  }, [card.title]);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  async function handleTitleSave() {
    const t = draftTitle.trim();
    if (!t || t === card.title) {
      setEditingTitle(false);
      setDraftTitle(card.title);
      return;
    }
    setSavingTitle(true);
    try {
      await onRename(card.card_id, t);
      setEditingTitle(false);
    } finally {
      setSavingTitle(false);
    }
  }

  async function handleStatusChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newColId = e.target.value;
    if (newColId === card.column_id) return;
    setMoving(true);
    try {
      await onMove(card.card_id, newColId, true); // force=true for panel move
    } finally {
      setMoving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await onDelete(card.card_id);
      onClose();
    } finally {
      setDeleting(false);
    }
  }

  const panelStyle: React.CSSProperties = {
    position: "fixed",
    right: 0,
    top: 0,
    bottom: 0,
    width: 360,
    background: "#0f1011",
    borderLeft: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    flexDirection: "column",
    zIndex: 500,
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

  return (
    <div style={panelStyle}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          padding: "16px 20px",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1 }}>
          {editingTitle ? (
            <input
              ref={titleInputRef}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleTitleSave();
                if (e.key === "Escape") {
                  setEditingTitle(false);
                  setDraftTitle(card.title);
                }
              }}
              onBlur={handleTitleSave}
              disabled={savingTitle}
              style={{
                width: "100%",
                background: "#1a1c1e",
                border: "1px solid rgba(138,168,156,0.4)",
                borderRadius: 5,
                color: "#f7f8f8",
                fontSize: 14,
                fontWeight: 600,
                padding: "4px 8px",
                outline: "none",
                boxSizing: "border-box",
              }}
            />
          ) : (
            <h3
              style={{
                margin: 0,
                fontSize: 14,
                fontWeight: 600,
                cursor: "text",
                lineHeight: 1.4,
              }}
              onClick={() => setEditingTitle(true)}
              title="Click to rename"
            >
              {card.title}
            </h3>
          )}
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
            flexShrink: 0,
          }}
          aria-label="Close"
        >
          <XIcon size={16} />
        </button>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Status / Move */}
        <section>
          <p style={sectionLabel}>Column</p>
          <select
            value={card.column_id}
            onChange={handleStatusChange}
            disabled={moving}
            style={{
              width: "100%",
              background: "#1a1c1e",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 6,
              color: "#f7f8f8",
              fontSize: 13,
              padding: "6px 10px",
              outline: "none",
              cursor: "pointer",
              opacity: moving ? 0.5 : 1,
            }}
          >
            {board.columns.map((col) => (
              <option key={col.id} value={col.id}>
                {col.name}
              </option>
            ))}
          </select>
          {moving && (
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#62666d" }}>
              Moving…
            </p>
          )}
        </section>

        {/* Exit criteria for current column */}
        {exitCriteria.length > 0 && (
          <section>
            <p style={sectionLabel}>
              Exit Criteria ({currentCol?.name ?? "column"})
            </p>
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {exitCriteria.map((ec) => {
                const check = currentChecks.find(
                  (c) => c.criterionId === ec.id
                );
                const isChecked = check?.checked ?? false;
                return (
                  <li
                    key={ec.id}
                    style={{ display: "flex", alignItems: "flex-start", gap: 8 }}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        void onToggleCriterion(
                          card.card_id,
                          card.column_id,
                          ec.id,
                          !isChecked
                        )
                      }
                      style={{
                        background: "none",
                        border: "none",
                        padding: 0,
                        cursor: "pointer",
                        color: isChecked ? "#87b894" : "#62666d",
                        marginTop: 1,
                        flexShrink: 0,
                      }}
                      aria-label={isChecked ? "Uncheck" : "Check"}
                    >
                      {isChecked ? (
                        <CheckCircle2Icon size={15} />
                      ) : (
                        <CircleIcon size={15} />
                      )}
                    </button>
                    <div style={{ flex: 1 }}>
                      <span
                        style={{
                          display: "block",
                          fontSize: 13,
                          color: isChecked ? "#d0d6e0" : "#8a8f98",
                          textDecoration: isChecked ? "none" : "none",
                        }}
                      >
                        {ec.description}
                      </span>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 3,
                          fontSize: 10,
                          color:
                            ec.kind === "machine" ? "#7ba4d4" : "#d2a050",
                          marginTop: 2,
                        }}
                      >
                        {ec.kind === "machine" ? (
                          <>
                            <BotIcon size={9} /> machine
                          </>
                        ) : (
                          <>
                            <UserIcon size={9} /> human
                          </>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Metadata */}
        <section>
          <p style={sectionLabel}>Info</p>
          <p style={{ margin: "0 0 4px", fontSize: 11, color: "#62666d" }}>
            ID:{" "}
            <code
              style={{
                fontFamily: "monospace",
                color: "#3a3d42",
                fontSize: 10,
              }}
            >
              {card.card_id}
            </code>
          </p>
          <p style={{ margin: 0, fontSize: 11, color: "#62666d" }}>
            Created: {new Date(card.created_at).toLocaleString()}
          </p>
        </section>

        {/* Danger zone */}
        <section style={{ marginTop: "auto" }}>
          <hr
            style={{
              border: "none",
              borderTop: "1px solid rgba(255,255,255,0.06)",
              margin: "0 0 12px",
            }}
          />
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              width: "100%",
              padding: "7px 0",
              fontSize: 12,
              borderRadius: 6,
              border: "1px solid rgba(184,90,90,0.3)",
              background: "rgba(184,90,90,0.08)",
              color: "#b85a5a",
              cursor: deleting ? "not-allowed" : "pointer",
              opacity: deleting ? 0.6 : 1,
            }}
          >
            <Trash2Icon size={12} />
            {deleting ? "Deleting…" : "Delete Card"}
          </button>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SnowballBoard
// ---------------------------------------------------------------------------

export function SnowballBoard({
  workspaceId: _workspaceId,
  scopeId,
  busBaseUrl,
  extensionName,
}: ExtensionViewProps) {
  const [board, setBoard] = useState<UiBoardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Selected card (detail panel)
  const [selectedCard, setSelectedCard] = useState<UiCard | null>(null);

  // Column config panel
  const [configPanelColumn, setConfigPanelColumn] = useState<UiColumn | null | "ADD">(
    undefined as unknown as null
  );
  const [configPanelOpen, setConfigPanelOpen] = useState(false);

  // ── Board fetch ──────────────────────────────────────────────────────────

  const reload = useCallback(async () => {
    try {
      const state = await fetchBoardState(busBaseUrl, extensionName, scopeId);
      setBoard(state);
      setError(null);
      // Keep selectedCard in sync
      setSelectedCard((prev) => {
        if (!prev) return null;
        const updated = state.cards.find((c) => c.card_id === prev.card_id);
        return updated ?? null;
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [busBaseUrl, extensionName, scopeId]);

  useEffect(() => {
    reload();
  }, [reload]);

  // ── Mutation helpers ─────────────────────────────────────────────────────

  async function withReload<T>(
    fn: () => Promise<T>
  ): Promise<T> {
    const result = await fn();
    await reload();
    return result;
  }

  async function handleMove(
    cardId: string,
    toColumnId: string,
    force: boolean
  ): Promise<boolean> {
    if (!board) return false;
    try {
      const result = await postJson(busBaseUrl, extensionName, "/move", {
        scope_id: scopeId,
        card_id: cardId,
        to_column_id: toColumnId,
        force,
      }) as { ok: boolean; error?: string };
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

  async function handleAddCard(columnId: string, title: string): Promise<void> {
    await withReload(async () => {
      await postJson(busBaseUrl, extensionName, "/card", {
        scope_id: scopeId,
        title,
        column_id: columnId,
      });
    });
  }

  async function handleDeleteCard(cardId: string): Promise<void> {
    await withReload(async () => {
      await postJson(busBaseUrl, extensionName, "/card/delete", {
        scope_id: scopeId,
        card_id: cardId,
      });
    });
    setSelectedCard(null);
  }

  async function handleRenameCard(cardId: string, title: string): Promise<void> {
    await withReload(async () => {
      await postJson(busBaseUrl, extensionName, "/card/rename", {
        scope_id: scopeId,
        card_id: cardId,
        title,
      });
    });
  }

  async function handleToggleCriterion(
    cardId: string,
    columnId: string,
    criterionId: string,
    checked: boolean
  ): Promise<void> {
    await withReload(async () => {
      await postJson(busBaseUrl, extensionName, "/card/criteria", {
        scope_id: scopeId,
        card_id: cardId,
        column_id: columnId,
        criterion_id: criterionId,
        checked,
      });
    });
  }

  async function handleSaveColumn(
    columnId: string | null,
    payload: ColumnConfigPayload
  ): Promise<void> {
    if (columnId === null) {
      // Add new column
      await withReload(async () => {
        await postJson(busBaseUrl, extensionName, "/columns", {
          scope_id: scopeId,
          action: "add",
          name: payload.name,
          wip_limit: payload.wip_limit,
          owner: payload.owner,
          exit_criteria: payload.exit_criteria,
        });
      });
    } else {
      // Update existing column
      await withReload(async () => {
        await postJson(busBaseUrl, extensionName, "/columns", {
          scope_id: scopeId,
          action: "update",
          column_id: columnId,
          name: payload.name,
          wip_limit: payload.wip_limit,
          owner: payload.owner,
          exit_criteria: payload.exit_criteria,
        });
      });
    }
  }

  async function handleDeleteColumn(columnId: string): Promise<void> {
    await withReload(async () => {
      await postJson(busBaseUrl, extensionName, "/columns", {
        scope_id: scopeId,
        action: "delete",
        column_id: columnId,
      });
    });
  }

  async function handleMoveColumnUp(columnId: string): Promise<void> {
    if (!board) return;
    const ids = board.columns.map((c) => c.id);
    const idx = ids.indexOf(columnId);
    if (idx <= 0) return;
    [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
    await withReload(async () => {
      await postJson(busBaseUrl, extensionName, "/columns", {
        scope_id: scopeId,
        action: "reorder",
        column_ids: ids,
      });
    });
  }

  async function handleMoveColumnDown(columnId: string): Promise<void> {
    if (!board) return;
    const ids = board.columns.map((c) => c.id);
    const idx = ids.indexOf(columnId);
    if (idx < 0 || idx >= ids.length - 1) return;
    [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
    await withReload(async () => {
      await postJson(busBaseUrl, extensionName, "/columns", {
        scope_id: scopeId,
        action: "reorder",
        column_ids: ids,
      });
    });
  }

  // ── Config panel helpers ─────────────────────────────────────────────────

  function openColumnConfig(column: UiColumn) {
    setConfigPanelColumn(column);
    setConfigPanelOpen(true);
  }

  function openAddColumn() {
    setConfigPanelColumn("ADD");
    setConfigPanelOpen(true);
  }

  function closeColumnConfig() {
    setConfigPanelOpen(false);
    setConfigPanelColumn(null as unknown as null);
  }

  // ── Layout styles ────────────────────────────────────────────────────────

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
      <div
        style={{
          ...containerStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p style={{ color: "#62666d", fontSize: 13 }}>Loading board…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div
        style={{
          ...containerStyle,
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <p style={{ color: "#b85a5a", fontSize: 13 }}>{error}</p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setLoading(true);
            void reload();
          }}
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
      </div>
    );
  }

  if (!board) {
    return (
      <div
        style={{
          ...containerStyle,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <p style={{ color: "#62666d", fontSize: 13 }}>No board data</p>
      </div>
    );
  }

  // Resolve config panel column (either a UiColumn or null for "Add" mode)
  const configColumn: UiColumn | null =
    configPanelColumn === "ADD"
      ? null
      : configPanelColumn ?? null;
  const configColumnIndex = configColumn
    ? board.columns.findIndex((c) => c.id === configColumn.id)
    : -1;

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
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: "#62666d" }}>
            {board.cards.length} card{board.cards.length !== 1 ? "s" : ""}
            {board.columns.filter((c) => c.wip_exceeded).length > 0 && (
              <span style={{ color: "#b85a5a" }}>
                {" · "}
                {board.columns.filter((c) => c.wip_exceeded).length} WIP
                violation
                {board.columns.filter((c) => c.wip_exceeded).length !== 1
                  ? "s"
                  : ""}
              </span>
            )}
          </span>
          {!board.initialized && (
            <span
              style={{
                fontSize: 10,
                color: "#62666d",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 4,
                padding: "2px 6px",
              }}
              title="Board is using default columns — add a card or edit a column to persist"
            >
              unsaved defaults
            </span>
          )}
          <button
            type="button"
            onClick={openAddColumn}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "4px 10px",
              fontSize: 11,
              fontWeight: 500,
              borderRadius: 5,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "transparent",
              color: "#8a8f98",
              cursor: "pointer",
            }}
          >
            <PlusIcon size={11} /> Add Column
          </button>
        </div>
      </div>

      {/* Board */}
      <div style={{ flex: 1, overflow: "hidden" }}>
        <Board
          board={board}
          onMove={handleMove}
          onSelectCard={(card) => {
            setSelectedCard(card);
            // Close column config when opening card detail
            setConfigPanelOpen(false);
          }}
          onConfigColumn={openColumnConfig}
          onAddCard={handleAddCard}
        />
      </div>

      {/* Card detail panel */}
      {selectedCard && (
        <CardDetailPanel
          card={selectedCard}
          board={board}
          onClose={() => setSelectedCard(null)}
          onMove={handleMove}
          onRename={handleRenameCard}
          onDelete={handleDeleteCard}
          onToggleCriterion={handleToggleCriterion}
        />
      )}

      {/* Column config panel */}
      <ColumnConfigPanel
        column={configColumn}
        totalColumns={board.columns.length}
        columnIndex={configColumnIndex}
        open={configPanelOpen}
        onClose={closeColumnConfig}
        onSave={handleSaveColumn}
        onDelete={handleDeleteColumn}
        onMoveUp={handleMoveColumnUp}
        onMoveDown={handleMoveColumnDown}
      />
    </div>
  );
}

// Re-export ExtensionViewProps for host-app convenience
export type { ExtensionViewProps } from "./types.ts";
