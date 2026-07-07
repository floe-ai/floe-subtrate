import React, { useState } from "react";
import { BotIcon, UserIcon, CheckIcon, XIcon } from "lucide-react";
import type { UiCard, UiColumn, UiCriterionCheck } from "./types.ts";

interface ExitCriteriaGateProps {
  open: boolean;
  sourceColumn: UiColumn;
  card: UiCard;
  onConfirm: (checks: UiCriterionCheck[], force: boolean) => Promise<void>;
  onCancel: () => void;
}

/**
 * ExitCriteriaGate — shown when a human drags a card out of a column with
 * exit criteria.
 *
 * Human is NOT hard-blocked: they may tick items, "Confirm All", or
 * "Move Anyway" (sets force=true).
 *
 * Per contract §5.2 asymmetric gating:
 *  - Human: soft gate — can proceed with partial/no checks via force=true
 *  - AI: hard block — handled server-side by move_card tool (not here)
 */
export function ExitCriteriaGate({
  open,
  sourceColumn,
  card,
  onConfirm,
  onCancel,
}: ExitCriteriaGateProps) {
  const [checks, setChecks] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const ec of sourceColumn.exitCriteria) {
      const existing = card.criteria_checks.find(
        (c) => c.columnId === sourceColumn.id && c.criterionId === ec.id
      );
      initial[ec.id] = existing?.checked ?? false;
    }
    return initial;
  });
  const [confirming, setConfirming] = useState(false);

  const criteria = sourceColumn.exitCriteria;
  const allChecked =
    criteria.length > 0 && criteria.every((ec) => checks[ec.id]);

  function toggleCheck(id: string, value: boolean) {
    setChecks((prev) => ({ ...prev, [id]: value }));
  }

  async function handleConfirm(checkAll: boolean, force: boolean) {
    setConfirming(true);
    try {
      const now = new Date().toISOString();
      const finalChecks: UiCriterionCheck[] = criteria.map((ec) => ({
        columnId: sourceColumn.id,
        criterionId: ec.id,
        checked: checkAll ? true : (checks[ec.id] ?? false),
        checkedAt:
          checkAll || checks[ec.id] ? now : undefined,
      }));
      await onConfirm(finalChecks, force);
    } finally {
      setConfirming(false);
    }
  }

  if (!open) return null;

  const overlay: React.CSSProperties = {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  };

  const dialog: React.CSSProperties = {
    background: "#0f1011",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 10,
    padding: "24px 28px",
    minWidth: 380,
    maxWidth: 480,
    boxShadow: "0 16px 48px rgba(0,0,0,0.6)",
    color: "#f7f8f8",
    fontFamily:
      '"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,system-ui,sans-serif',
  };

  const btnBase: React.CSSProperties = {
    borderRadius: 6,
    padding: "7px 14px",
    fontSize: 13,
    fontWeight: 500,
    cursor: confirming ? "not-allowed" : "pointer",
    opacity: confirming ? 0.5 : 1,
    border: "1px solid rgba(255,255,255,0.1)",
    transition: "background 0.12s",
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 4px", fontSize: 15, fontWeight: 600 }}>
          Move: {card.title}
        </h2>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: "#8a8f98" }}>
          Exit criteria for <strong style={{ color: "#d0d6e0" }}>{sourceColumn.name}</strong> —
          tick what is satisfied, or proceed anyway.
        </p>

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: "0 0 16px" }} />

        {criteria.length === 0 ? (
          <p style={{ fontSize: 13, color: "#8a8f98" }}>No exit criteria defined.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "0 0 16px", display: "flex", flexDirection: "column", gap: 12 }}>
            {criteria.map((ec) => (
              <li
                key={ec.id}
                style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
              >
                <input
                  type="checkbox"
                  id={`gate-${ec.id}`}
                  checked={checks[ec.id] ?? false}
                  onChange={(e) => toggleCheck(ec.id, e.target.checked)}
                  style={{ marginTop: 2, accentColor: "#8aa89c", cursor: "pointer" }}
                />
                <label
                  htmlFor={`gate-${ec.id}`}
                  style={{ flex: 1, cursor: "pointer", fontSize: 13 }}
                >
                  <span style={{ display: "block", fontWeight: 500, color: "#d0d6e0" }}>
                    {ec.description}
                  </span>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      marginTop: 3,
                      fontSize: 11,
                      color: ec.kind === "machine" ? "#7ba4d4" : "#d2a050",
                    }}
                  >
                    {ec.kind === "machine" ? (
                      <><BotIcon size={10} /> machine</>
                    ) : (
                      <><UserIcon size={10} /> human</>
                    )}
                  </span>
                </label>
                {checks[ec.id] && (
                  <CheckIcon size={14} style={{ marginTop: 2, color: "#87b894", flexShrink: 0 }} />
                )}
              </li>
            ))}
          </ul>
        )}

        <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.06)", margin: "0 0 16px" }} />

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <button
            type="button"
            style={{ ...btnBase, background: "transparent", color: "#8a8f98" }}
            onClick={onCancel}
            disabled={confirming}
          >
            Cancel
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            {!allChecked && criteria.length > 0 && (
              <button
                type="button"
                style={{ ...btnBase, background: "rgba(255,255,255,0.05)", color: "#d0d6e0" }}
                onClick={() => handleConfirm(true, true)}
                disabled={confirming}
              >
                Confirm All
              </button>
            )}
            <button
              type="button"
              style={{
                ...btnBase,
                background: allChecked ? "#8aa89c" : "rgba(255,255,255,0.08)",
                color: allChecked ? "#0f1011" : "#d0d6e0",
                borderColor: allChecked ? "#8aa89c" : "rgba(255,255,255,0.1)",
                fontWeight: 600,
              }}
              onClick={() => handleConfirm(false, allChecked ? false : true)}
              disabled={confirming}
            >
              {allChecked ? "Move" : "Move Anyway"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
