# The Scope view

An active [[Scope]] appears under **Organised work** on the Conversations workspace index. Opening it shows the current organisation Floe composed for that work.

## What it shows

- Event nodes on the left.
- Actor and deterministic Command nodes on the right.
- Connections derived from the Event types each participant subscribes to.
- Live endpoint state such as Working, Ready, Waiting, Error, or Not configured.
- The shared scoped [[Context]] beside the diagram, so the operator can inspect the work that actually happened.

The view reads the Bus-owned Scope composition and endpoint state. It does not persist another graph, infer workflow policy, or turn the app into a graph editor.

## Current boundaries

The diagram shows declared routing and current participant availability. It does not claim that an Actor will emit a particular next Event unless that relationship is present in substrate state. Context history remains the source for what happened.

Re-composing the same Scope replaces its current nodes and subscriptions in place while preserving that history. A retired Scope is inert and hidden from the normal operator index, but remains available under Developer tools for historical inspection.

The developer Scope detail view still provides Contexts, Ops, and extension tabs. It is a secondary observatory rather than the operator's route to understanding organised work.

## Implementation

- `floe-app/src/features/work/ScopeWorkView.tsx` renders the read-only operator representation.
- `floe-bus/src/scope-graphs.ts` stores the current node composition behind an internal stable routing handle.
- `floe-bus/src/actor-capabilities.ts` owns actor-safe inspection, in-place composition, Event activation, and retirement contracts.
