export type ActiveDialog<TRequest, TRestoreTarget = unknown> = {
  id: number;
  request: TRequest;
  restoreFocusTo: TRestoreTarget | null;
};

type InternalDialog<TRequest, TRestoreTarget> = ActiveDialog<TRequest, TRestoreTarget> & {
  resolve: (confirmed: boolean) => void;
};

type DialogListener<TRequest, TRestoreTarget> = (dialog: InternalDialog<TRequest, TRestoreTarget> | null) => void;

export function createDialogController<TRequest, TRestoreTarget = unknown>() {
  let nextDialogId = 1;
  let activeDialog: InternalDialog<TRequest, TRestoreTarget> | null = null;
  const listeners = new Set<DialogListener<TRequest, TRestoreTarget>>();

  function notify(): void {
    for (const listener of listeners) listener(activeDialog);
  }

  function open(request: TRequest, restoreFocusTo: TRestoreTarget | null = null): Promise<boolean> {
    if (activeDialog) activeDialog.resolve(false);
    return new Promise((resolve) => {
      activeDialog = {
        id: nextDialogId,
        request,
        restoreFocusTo,
        resolve
      };
      nextDialogId += 1;
      notify();
    });
  }

  function close(confirmed: boolean): InternalDialog<TRequest, TRestoreTarget> | null {
    const current = activeDialog;
    if (!current) return null;
    activeDialog = null;
    current.resolve(confirmed);
    notify();
    return current;
  }

  function subscribe(listener: DialogListener<TRequest, TRestoreTarget>): () => void {
    listeners.add(listener);
    listener(activeDialog);
    return () => {
      listeners.delete(listener);
    };
  }

  function current(): InternalDialog<TRequest, TRestoreTarget> | null {
    return activeDialog;
  }

  return { open, close, subscribe, current };
}
