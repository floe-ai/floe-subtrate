export type ActiveDialog<TRequest, TRestoreTarget = unknown> = {
  id: number;
  request: TRequest;
  restoreFocusTo: TRestoreTarget | null;
};

type InternalDialog<TRequest, TRestoreTarget, TResult> = ActiveDialog<TRequest, TRestoreTarget> & {
  resolve: (result: TResult) => void;
};

type DialogListener<TRequest, TRestoreTarget, TResult> = (dialog: InternalDialog<TRequest, TRestoreTarget, TResult> | null) => void;

export function createDialogController<TRequest, TRestoreTarget = unknown, TResult = boolean>() {
  let nextDialogId = 1;
  let activeDialog: InternalDialog<TRequest, TRestoreTarget, TResult> | null = null;
  const listeners = new Set<DialogListener<TRequest, TRestoreTarget, TResult>>();

  function notify(): void {
    for (const listener of listeners) listener(activeDialog);
  }

  function open(request: TRequest, restoreFocusTo: TRestoreTarget | null = null, cancelResult: TResult): Promise<TResult> {
    if (activeDialog) activeDialog.resolve(cancelResult);
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

  function close(result: TResult): InternalDialog<TRequest, TRestoreTarget, TResult> | null {
    const current = activeDialog;
    if (!current) return null;
    activeDialog = null;
    current.resolve(result);
    notify();
    return current;
  }

  function subscribe(listener: DialogListener<TRequest, TRestoreTarget, TResult>): () => void {
    listeners.add(listener);
    listener(activeDialog);
    return () => {
      listeners.delete(listener);
    };
  }

  function current(): InternalDialog<TRequest, TRestoreTarget, TResult> | null {
    return activeDialog;
  }

  return { open, close, subscribe, current };
}
