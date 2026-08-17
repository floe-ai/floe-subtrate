/**
 * PROTOTYPE — throwaway selection bridge.
 *
 * The operator's finding on revision 1: in a real environment the run should
 * render in the app's SECOND ASIDE (the right inspector), not in a panel the
 * prototype invented for itself. The inspector lives in App.tsx, far above
 * ScopeDetail, and is driven by nav.selectedContextId — which only accepts a
 * real bus context id, so fixture runs cannot go through it.
 *
 * Rather than reshape the app's navigation for a throwaway, this is a tiny
 * module-level store the prototype writes to and the inspector reads from.
 * One file to delete.
 */

export type ProtoSelection = {
  nodeId: string | null;
  runId: string | null;
};

let selection: ProtoSelection = { nodeId: null, runId: null };
const listeners = new Set<(s: ProtoSelection) => void>();

export function getProtoSelection(): ProtoSelection {
  return selection;
}

export function setProtoSelection(next: ProtoSelection): void {
  selection = next;
  for (const l of listeners) l(selection);
}

export function subscribeProtoSelection(fn: (s: ProtoSelection) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
