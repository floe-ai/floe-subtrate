/**
 * ColumnConfigPanel — slide-in panel for editing a board column.
 *
 * Supports: rename, owner (human/agent + agent_id), WIP limit, exit criteria,
 * reorder (up/down), and delete.
 *
 * Styled to match the dark Snowball board theme (no shadcn dependency).
 */

import React, { useState, useEffect } from "react";
import {
  Trash2Icon,
  PlusIcon,
  XIcon,
  ChevronUpIcon,
  ChevronDownIcon,
  BotIcon,
  UserIcon,
} from "lucide-react";
import type { UiColumn, UiExitCriterion } from "./types.ts";

export interface ColumnConfigPayload {
  name: string;
  wip_limit: number | null;
  /**
   * Uniform actor assignments. An empty array = no assigned actors (was: owner.kind="human").
   * A single-element array with event_types=["*"] = primary actor (was: owner.kind="agent").
   */
  assigned_actors: Array<{ actor_ref: string; event_types: string[] }>;
  exit_criteria: UiExitCriterion[];
}

interface ColumnConfigPanelProps {
  /** null → "Add Column" mode; UiColumn → "Edit Column" mode */
  column: UiColumn | null;
  totalColumns: number;
  columnIndex: number;
  open: boolean;
  onClose: () => void;
  onSave: (columnId: string | null, payload: ColumnConfigPayload) => Promise<void>;
  onDelete: (columnId: string) => Promise<void>;
  onMoveUp: (columnId: string) => Promise<void>;
  onMoveDown: (columnId: string) => Promise<void>;
  onSaveInstructions?: (columnId: string, instructions: string) => Promise<void>;
}

let _ecSeq = Date.now();
function newEcId() {
  return `ec-${(++_ecSeq).toString(36)}`;
}

export function ColumnConfigPanel({
  column,
  totalColumns,
  columnIndex,
  open,
  onClose,
  onSave,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSaveInstructions,
}: ColumnConfigPanelProps) {
  const isAddMode = column === null;

  const [name, setName] = useState(column?.name ?? "");
  // Derive human/agent UI toggle from assigned_actors.
  // Agent = at least one actor with event_types=["*"]; Human = no assigned actors.
  const primaryActor = column?.assignedActors.find((a) => a.event_types.includes("*"));
  const [ownerKind, setOwnerKind] = useState<"human" | "agent">(
    primaryActor ? "agent" : "human"
  );
  const [agentId, setAgentId] = useState(primaryActor?.actor_ref ?? "");
  const [wipLimit, setWipLimit] = useState(
    column?.wipLimit !== null && column?.wipLimit !== undefined
      ? String(column.wipLimit)
      : ""
  );
  const [criteria, setCriteria] = useState<UiExitCriterion[]>(
    column?.exitCriteria ?? []
  );
  const [instructions, setInstructions] = useState(column?.instructions ?? "");
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync state when column prop changes (e.g. switching which column to edit)
  useEffect(() => {
    setName(column?.name ?? "");
    const pa = column?.assignedActors.find((a) => a.event_types.includes("*"));
    setOwnerKind(pa ? "agent" : "human");
    setAgentId(pa?.actor_ref ?? "");
    setWipLimit(
      column?.wipLimit !== null && column?.wipLimit !== undefined
        ? String(column.wipLimit)
        : ""
    );
    setCriteria(column?.exitCriteria ?? []);
    setInstructions(column?.instructions ?? "");
    setError(null);
  }, [column]);

  if (!open) return null;

  const isFirst = columnIndex === 0;
  const isLast = columnIndex === totalColumns - 1;

  function addCriterion() {
    setCriteria((prev) => [
      ...prev,
      { id: newEcId(), description: "", kind: "human" },
    ]);
  }

  function removeCriterion(id: string) {
    setCriteria((prev) => prev.filter((c) => c.id !== id));
  }

  function updateCriterion(
    id: string,
    field: "description" | "kind",
    value: string
  ) {
    setCriteria((prev) =>
      prev.map((c) => (c.id === id ? { ...c, [field]: value } : c))
    );
  }

  async function handleSaveInstructions() {
    if (!column || !onSaveInstructions) return;
    setSavingInstructions(true);
    setError(null);
    try {
      await onSaveInstructions(column.id, instructions);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingInstructions(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Column name required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const parsedWip =
        wipLimit.trim() === "" ? null : parseInt(wipLimit, 10);
      if (wipLimit.trim() !== "" && (isNaN(parsedWip!) || parsedWip! < 1)) {
        setError("WIP limit must be a positive number");
        setSaving(false);
        return;
      }
      const payload: ColumnConfigPayload = {
        name: name.trim(),
        wip_limit: parsedWip ?? null,
        assigned_actors:
          ownerKind === "agent" && agentId.trim()
            ? [{ actor_ref: agentId.trim(), event_types: ["*"] }]
            : [],
        exit_criteria: criteria.filter((c) => c.description.trim() !== ""),
      };
      await onSave(column?.id ?? null, payload);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!column) return;
    if (totalColumns <= 1) {
      setError("Cannot delete the last column");
      return;
    }
    setDeleting(true);
    try {
      await onDelete(column.id);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }

  // ── Styles ──────────────────────────────────────────────────────────────

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
    width: 360,
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

  const toggleBtn = (active: boolean): React.CSSProperties => ({
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 500,
    borderRadius: 6,
    border: `1px solid ${active ? "rgba(138,168,156,0.5)" : "rgba(255,255,255,0.1)"}`,
    background: active ? "rgba(138,168,156,0.15)" : "transparent",
    color: active ? "#8aa89c" : "#8a8f98",
    cursor: "pointer",
  });

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
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            {isAddMode ? "Add Column" : `Edit: ${column!.name}`}
          </h2>
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
            gap: 20,
          }}
        >
          {/* ── Name ──────────────────────────────────────────── */}
          <section>
            <p style={sectionLabel}>Column Name</p>
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. In Review"
              autoFocus
            />
          </section>

          <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: 0 }} />

          {/* ── Owner ─────────────────────────────────────────── */}
          <section>
            <p style={sectionLabel}>Owner</p>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button
                type="button"
                style={toggleBtn(ownerKind === "human")}
                onClick={() => setOwnerKind("human")}
              >
                <UserIcon size={12} style={{ display: "inline", marginRight: 4 }} />
                Human
              </button>
              <button
                type="button"
                style={toggleBtn(ownerKind === "agent")}
                onClick={() => setOwnerKind("agent")}
              >
                <BotIcon size={12} style={{ display: "inline", marginRight: 4 }} />
                Agent
              </button>
            </div>
            {ownerKind === "agent" && (
              <div>
                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    color: "#8a8f98",
                    marginBottom: 4,
                  }}
                >
                  Agent ID{" "}
                  <span style={{ color: "#62666d" }}>
                    (matches .floe/agents/&lt;id&gt;.md)
                  </span>
                </label>
                <input
                  style={inputStyle}
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  placeholder="e.g. snowball-overseer"
                />
              </div>
            )}
          </section>

          <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: 0 }} />

          {/* ── WIP Limit ─────────────────────────────────────── */}
          <section>
            <p style={sectionLabel}>WIP Limit</p>
            <input
              type="number"
              min={1}
              style={inputStyle}
              value={wipLimit}
              onChange={(e) => setWipLimit(e.target.value)}
              placeholder="No limit"
            />
            <p style={{ margin: "4px 0 0", fontSize: 11, color: "#62666d" }}>
              Leave blank for no limit.
            </p>
          </section>

          <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: 0 }} />

          {/* ── Exit Criteria ─────────────────────────────────── */}
          <section>
            <p style={sectionLabel}>Exit Criteria</p>
            {criteria.length === 0 && (
              <p style={{ fontSize: 12, color: "#62666d", marginBottom: 8 }}>
                No criteria yet — cards leave this column freely.
              </p>
            )}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginBottom: 8,
              }}
            >
              {criteria.map((ec, i) => (
                <div
                  key={ec.id}
                  style={{
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 11, color: "#62666d", width: 16, flexShrink: 0 }}>
                      {i + 1}.
                    </span>
                    <input
                      style={{ ...inputStyle, flex: 1 }}
                      value={ec.description}
                      onChange={(e) =>
                        updateCriterion(ec.id, "description", e.target.value)
                      }
                      placeholder="What must be true before a card leaves?"
                    />
                    <button
                      type="button"
                      onClick={() => removeCriterion(ec.id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#8a8f98",
                        cursor: "pointer",
                        padding: 2,
                        flexShrink: 0,
                      }}
                      aria-label="Remove criterion"
                    >
                      <Trash2Icon size={13} />
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 6, paddingLeft: 22 }}>
                    {(["human", "machine"] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => updateCriterion(ec.id, "kind", k)}
                        style={{
                          padding: "2px 8px",
                          fontSize: 11,
                          borderRadius: 4,
                          border: `1px solid ${
                            ec.kind === k
                              ? k === "human"
                                ? "rgba(210,160,80,0.5)"
                                : "rgba(123,164,212,0.5)"
                              : "rgba(255,255,255,0.1)"
                          }`,
                          background:
                            ec.kind === k
                              ? k === "human"
                                ? "rgba(210,160,80,0.15)"
                                : "rgba(123,164,212,0.15)"
                              : "transparent",
                          color:
                            ec.kind === k
                              ? k === "human"
                                ? "#d2a050"
                                : "#7ba4d4"
                              : "#8a8f98",
                          cursor: "pointer",
                        }}
                      >
                        {k}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addCriterion}
              style={{
                ...btnBase,
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "transparent",
                color: "#8a8f98",
                width: "100%",
                justifyContent: "center",
              }}
            >
              <PlusIcon size={13} /> Add criterion
            </button>
          </section>

          {/* ── Instructions (edit mode only) ───────────────────── */}
          {!isAddMode && (
            <>
              <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: 0 }} />
              <section>
                <p style={sectionLabel}>Agent Instructions</p>
                <p style={{ margin: "0 0 6px", fontSize: 11, color: "#62666d" }}>
                  Instructions injected into the column worker’s BeforeTurn prompt.
                  Leave empty if none.
                </p>
                <textarea
                  rows={6}
                  style={{
                    ...inputStyle,
                    resize: "vertical",
                    fontFamily: '"JetBrains Mono",monospace',
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="e.g. When a card enters this column, review its description and verify all checks are accurate before advancing."
                />
                {onSaveInstructions && (
                  <button
                    type="button"
                    onClick={handleSaveInstructions}
                    disabled={savingInstructions}
                    style={{
                      ...btnBase,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: "rgba(138,168,156,0.1)",
                      borderColor: "rgba(138,168,156,0.3)",
                      color: "#8aa89c",
                      width: "100%",
                      justifyContent: "center",
                      marginTop: 8,
                      cursor: savingInstructions ? "not-allowed" : "pointer",
                      opacity: savingInstructions ? 0.6 : 1,
                    }}
                  >
                    {savingInstructions ? "Saving…" : "Save Instructions"}
                  </button>
                )}
              </section>
            </>
          )}

          {/* ── Reorder (edit mode only) ───────────────────────── */}
          {!isAddMode && (
            <>
              <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: 0 }} />
              <section>
                <p style={sectionLabel}>Column Order</p>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    disabled={isFirst}
                    onClick={() => { void onMoveUp(column!.id); }}
                    style={{
                      ...btnBase,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "transparent",
                      color: isFirst ? "#3a3d42" : "#8a8f98",
                      cursor: isFirst ? "not-allowed" : "pointer",
                    }}
                  >
                    <ChevronUpIcon size={13} /> Move Left
                  </button>
                  <button
                    type="button"
                    disabled={isLast}
                    onClick={() => { void onMoveDown(column!.id); }}
                    style={{
                      ...btnBase,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "transparent",
                      color: isLast ? "#3a3d42" : "#8a8f98",
                      cursor: isLast ? "not-allowed" : "pointer",
                    }}
                  >
                    <ChevronDownIcon size={13} /> Move Right
                  </button>
                </div>
              </section>
            </>
          )}

          {/* ── Delete (edit mode only) ────────────────────────── */}
          {!isAddMode && (
            <>
              <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: 0 }} />
              <section>
                <p style={sectionLabel}>Danger Zone</p>
                <button
                  type="button"
                  disabled={totalColumns <= 1 || deleting}
                  onClick={handleDelete}
                  style={{
                    ...btnBase,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    background: "rgba(184,90,90,0.1)",
                    borderColor: "rgba(184,90,90,0.3)",
                    color: totalColumns <= 1 ? "#3a3d42" : "#b85a5a",
                    cursor: totalColumns <= 1 ? "not-allowed" : "pointer",
                    width: "100%",
                    justifyContent: "center",
                  }}
                >
                  <Trash2Icon size={13} />
                  {deleting ? "Deleting…" : "Delete Column"}
                </button>
                {totalColumns <= 1 && (
                  <p style={{ margin: "4px 0 0", fontSize: 11, color: "#62666d" }}>
                    Cannot delete the last column.
                  </p>
                )}
              </section>
            </>
          )}
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
              {saving ? "Saving…" : isAddMode ? "Add Column" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
