import React, { useCallback } from "react";
import type { ScopeRef, WorkspaceRef } from "../bus-client/types.ts";
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
