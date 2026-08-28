# The Scope view

An active [[Scope]] appears under **Organised work** on the Conversations workspace index. Opening it shows the current plan Floe composed for that work.

## What it shows

- Persistent Actor and deterministic Command responsibilities.
- Planned routes phrased as “when this Event lands → these participants act,” derived from declared Event subscriptions.
- Live endpoint state such as Working, Ready, Waiting, Error, or Not configured.
- An execution count on each planned node. Selecting a node reveals its authored responsibility and the actual Event or delivery records that reached it.
- The shared scoped [[Context]] behind **Context history**, opening at its newest page and progressively retrieving earlier Events as the operator scrolls upward, so execution traffic does not obscure the plan or make the initial view grow with history.

The view reads the Bus-owned Scope composition and endpoint state. It does not persist another graph, infer workflow policy, or turn the app into a graph editor.

## Current boundaries

The plan map shows declared routing and current participant availability. It does not infer a sequential workflow or claim that an Actor will emit a particular next Event unless that relationship is present in substrate state. Node executions and Context history remain projections of what actually happened.

Re-composing the same Scope replaces its current nodes and subscriptions in place while preserving that history. A retired Scope is inert and hidden from the normal operator index, but remains available under Developer tools for historical inspection.

The developer Scope detail view still provides Contexts, Ops, and extension tabs. It is a secondary observatory rather than the operator's route to understanding organised work.

## Implementation

- `floe-app/src/features/work/ScopeWorkView.tsx` renders the read-only operator representation.
- `floe-bus/src/scope-graphs.ts` stores the current node composition behind an internal stable routing handle.
- `floe-bus/src/actor-capabilities.ts` owns actor-safe inspection, in-place composition, Event activation, and retirement contracts.
