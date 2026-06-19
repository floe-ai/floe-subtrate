import React, { useState, useEffect, useCallback } from "react";
import type { ScopeRef, WorkspaceRef } from "../bus-client/types.ts";
import { deleteScope, ScopeNotEmptyError } from "../bus-client/client.ts";
import { useScopeStats } from "../features/home/HomeView.tsx";
import { tk } from "../theme.ts";

export const RINSP_KEY = "floe.rinspW";
export const RINSP_MIN = 260;
export const RINSP_MAX = 720;
export const RINSP_DEFAULT = 320;

export function readRinspWidth(): number {
  try {
    const v = parseInt(localStorage.getItem(RINSP_KEY) ?? "", 10);
    if (Number.isFinite(v) && v >= RINSP_MIN && v <= RINSP_MAX) return v;
  } catch { /* ignore */ }
  return RINSP_DEFAULT;
}

export type DeleteState =
  | { phase: "idle" }
  | { phase: "confirming" }
  | { phase: "deleting" }
  | { phase: "error"; message: string }
  | { phase: "notEmpty"; context_count: number; pulse_count: number };

export function ScopeInspector({
  scope,
  workspaceId,
  onDeleted,
}: {
  scope: ScopeRef;
  workspaceId: string;
  onDeleted: () => void;
}): React.ReactElement {
  const [deleteState, setDeleteState] = useState<DeleteState>({ phase: "idle" });
  const stats = useScopeStats(workspaceId, scope.scope_id);

  async function handleDelete() {
    setDeleteState({ phase: "deleting" });
    try {
      await deleteScope(workspaceId, scope.scope_id);
      onDeleted();
    } catch (err) {
      if (err instanceof ScopeNotEmptyError) {
        setDeleteState({ phase: "notEmpty", context_count: err.context_count, pulse_count: err.pulse_count });
      } else {
        setDeleteState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "auto" }}>
      {/* Head */}
      <div style={{ padding: "14px 16px 12px", borderBottom: `1px solid ${tk.border}` }}>
        <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
          Scope
        </div>
        <div style={{ fontSize: 17, fontWeight: 510, color: tk.ink, marginTop: 4, letterSpacing: "-0.01em" }}>
          {scope.title || scope.scope_id}
        </div>
        {scope.description && (
          <div style={{ fontSize: 12, color: tk.ink3, marginTop: 4, lineHeight: 1.45 }}>
            {scope.description}
          </div>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ padding: "12px 16px", borderBottom: `1px solid ${tk.border2}` }}>
          <StatRow label="Contexts" value={stats.contexts} />
          <StatRow label="Pulses" value={stats.pulses} />
        </div>
      )}

      {/* Delete action */}
      <div style={{ padding: "12px 16px" }}>
        {deleteState.phase === "idle" && (
          <button
            onClick={() => setDeleteState({ phase: "confirming" })}
            style={{
              background: "transparent", border: `1px solid ${tk.danger}`,
              color: tk.danger, borderRadius: tk.r2, padding: "5px 12px",
              fontSize: 12, cursor: "pointer", fontWeight: 510,
            }}
          >
            Delete scope
          </button>
        )}

        {deleteState.phase === "confirming" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <p style={{ fontSize: 12, color: tk.ink2, lineHeight: 1.45 }}>
              Delete "{scope.title || scope.scope_id}"? This cannot be undone.
            </p>
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => void handleDelete()}
                style={{
                  background: tk.danger, color: "#fff", border: "none",
                  borderRadius: tk.r2, padding: "5px 12px", fontSize: 12, cursor: "pointer",
                }}
              >
                Confirm delete
              </button>
              <button
                onClick={() => setDeleteState({ phase: "idle" })}
                style={{
                  background: "transparent", border: `1px solid ${tk.border}`,
                  color: tk.ink3, borderRadius: tk.r2, padding: "5px 12px", fontSize: 12,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {deleteState.phase === "deleting" && (
          <p style={{ fontSize: 12, color: tk.ink3 }}>Deleting…</p>
        )}

        {deleteState.phase === "error" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p role="alert" style={{ fontSize: 12, color: tk.danger }}>{deleteState.message}</p>
            <button
              onClick={() => setDeleteState({ phase: "idle" })}
              style={{
                background: "transparent", border: `1px solid ${tk.border}`,
                color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
                alignSelf: "flex-start",
              }}
            >
              Dismiss
            </button>
          </div>
        )}

        {deleteState.phase === "notEmpty" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <p role="alert" style={{ fontSize: 12, color: tk.ink2, lineHeight: 1.5 }}>
              Can't delete — scope has{" "}
              <strong style={{ color: tk.ink }}>{deleteState.context_count} context{deleteState.context_count !== 1 ? "s" : ""}</strong>
              {deleteState.pulse_count > 0 && (
                <> and{" "}
                  <strong style={{ color: tk.ink }}>{deleteState.pulse_count} pulse{deleteState.pulse_count !== 1 ? "s" : ""}</strong>
                </>
              )}.
              {" "}Remove them first.
            </p>
            <button
              onClick={() => setDeleteState({ phase: "idle" })}
              style={{
                background: "transparent", border: `1px solid ${tk.border}`,
                color: tk.ink3, borderRadius: tk.r2, padding: "4px 10px", fontSize: 12,
                alignSelf: "flex-start",
              }}
            >
              Dismiss
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Shown in the inspector when a scope is selected but no context row has been clicked. */
export function ScopeInspectorEmpty({ scope }: { scope: ScopeRef }): React.ReactElement {
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
        Scope
      </div>
      <div style={{ fontSize: 17, fontWeight: 510, color: tk.ink, marginTop: 4, letterSpacing: "-0.01em" }}>
        {scope.title || scope.scope_id}
      </div>
      <p style={{ marginTop: 14, fontSize: 12.5, color: tk.ink3, lineHeight: 1.5 }}>
        Click a context row to see its details.
      </p>
    </div>
  );
}

export function StatRow({ label, value }: { label: string; value: number | string }): React.ReactElement {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      padding: "4px 0", fontSize: 13, borderBottom: `1px solid ${tk.border2}`,
    }}>
      <span style={{ color: tk.ink3 }}>{label}</span>
      <span style={{ color: tk.ink, fontVariantNumeric: "tabular-nums", fontWeight: 510 }}>{value}</span>
    </div>
  );
}

export function DefaultInspector({ workspace }: { workspace: WorkspaceRef }): React.ReactElement {
  return (
    <div style={{ padding: "14px 16px" }}>
      <div style={{ fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase", color: tk.ink3, fontWeight: 510 }}>
        Workspace
      </div>
      <div style={{ fontSize: 17, fontWeight: 510, color: tk.ink, marginTop: 4, letterSpacing: "-0.01em" }}>
        {workspace.name || workspace.workspace_id}
      </div>
      <div style={{ fontSize: 12, color: tk.ink4, marginTop: 2 }}>
        {workspace.locator}
      </div>
      <p style={{ marginTop: 14, fontSize: 12.5, color: tk.ink3, lineHeight: 1.5 }}>
        Select a scope card to see its details and actions.
      </p>
    </div>
  );
}

export function useInspectorResize(
  onWidthChange: (w: number) => void
): React.RefCallback<HTMLDivElement> {
  return useCallback((handle: HTMLDivElement | null) => {
    if (!handle) return;
    let dragging = false;

    function setWidth(clientX: number) {
      const next = Math.max(RINSP_MIN, Math.min(RINSP_MAX, window.innerWidth - clientX));
      onWidthChange(next);
      try { localStorage.setItem(RINSP_KEY, String(next)); } catch { /* ignore */ }
    }

    handle.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      dragging = true;
      try { handle.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      setWidth(ev.clientX);
    });

    function end(ev: PointerEvent) {
      if (!dragging) return;
      dragging = false;
      try { (handle as HTMLDivElement).releasePointerCapture(ev.pointerId); } catch { /* ignore */ }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }

    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  }, [onWidthChange]);
}
