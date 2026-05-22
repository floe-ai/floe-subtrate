import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createDialogController } from "./dialog-controller";

type DialogVariant = "default" | "danger";

export type ConfirmDialogRequest = {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: DialogVariant;
  onConfirm?: () => Promise<void>;
};

const dialogController = createDialogController<ConfirmDialogRequest, HTMLElement>();
type ActiveConfirmDialog = NonNullable<ReturnType<typeof dialogController.current>>;

export function confirm(request: ConfirmDialogRequest): Promise<boolean> {
  const restoreFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return dialogController.open(request, restoreFocusTo);
}

export function DialogHost(): React.ReactElement | null {
  const [dialog, setDialog] = useState<ActiveConfirmDialog | null>(dialogController.current());
  const [loading, setLoading] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const errorId = useId();

  useEffect(() => {
    return dialogController.subscribe(setDialog);
  }, []);

  useEffect(() => {
    setLoading(false);
    setInlineError(null);
    if (!dialog) return;
    window.setTimeout(() => {
      cancelRef.current?.focus();
    }, 0);
  }, [dialog?.id]);

  useEffect(() => {
    if (loading) dialogRef.current?.focus();
  }, [loading]);

  const isCurrentDialog = useCallback((candidate: ActiveConfirmDialog) => {
    return dialogController.current()?.id === candidate.id;
  }, []);

  const close = useCallback((confirmed: boolean) => {
    if (!dialog) return;
    if (!isCurrentDialog(dialog)) return;
    const restoreFocusTo = dialog.restoreFocusTo;
    dialogController.close(confirmed);
    window.setTimeout(() => {
      if (restoreFocusTo?.isConnected) restoreFocusTo.focus();
    }, 0);
  }, [dialog, isCurrentDialog]);

  const cancel = useCallback(() => {
    if (loading) return;
    close(false);
  }, [close, loading]);

  const confirmActive = useCallback(async () => {
    if (!dialog || loading) return;
    if (!dialog.request.onConfirm) {
      close(true);
      return;
    }
    setLoading(true);
    setInlineError(null);
    try {
      await dialog.request.onConfirm();
      close(true);
    } catch (caught) {
      if (!isCurrentDialog(dialog)) return;
      setInlineError(caught instanceof Error ? caught.message : String(caught));
      setLoading(false);
    }
  }, [close, dialog, isCurrentDialog, loading]);

  const trapFocus = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((element) => element.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [cancel, dialog]);

  if (!dialog) return null;

  const describedBy = inlineError ? `${bodyId} ${errorId}` : bodyId;
  const variant = dialog.request.variant ?? "default";

  return createPortal(
    <div className="dialog-layer" data-testid="dialog-layer">
      <button
        className="dialog-backdrop"
        type="button"
        aria-label="Cancel dialog"
        data-testid="dialog-backdrop"
        onClick={cancel}
        disabled={loading}
        tabIndex={-1}
      />
      <div
        className={`app-dialog ${variant === "danger" ? "danger" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        ref={dialogRef}
        tabIndex={loading ? 0 : -1}
        onKeyDown={trapFocus}
      >
        <div className="app-dialog-header">
          <h2 id={titleId}>{dialog.request.title}</h2>
        </div>
        <div className="app-dialog-body" id={bodyId}>{dialog.request.body}</div>
        {inlineError && (
          <div className="app-dialog-error" id={errorId} role="alert">
            {inlineError}
          </div>
        )}
        <div className="app-dialog-actions">
          <button
            className="ghost-action"
            type="button"
            onClick={cancel}
            disabled={loading}
            ref={cancelRef}
          >
            {dialog.request.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={`primary-action ${variant === "danger" ? "danger" : ""}`}
            type="button"
            onClick={() => void confirmActive()}
            disabled={loading}
          >
            {loading ? "Working..." : dialog.request.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
