# Node

**A node is a citizen placed on a scope's canvas.**

A node is the work to be done. A [[Context]] is one run of it. One node spawns as
many contexts as the work needs — a three-node pipeline and fifty documents don't
disagree, because the pipeline is three nodes and the run is fifty contexts, one
per document moving through it.

## The three kinds

| Kind | What it is | Notes |
|---|---|---|
| Event node | Something that lands and wakes the system | Carries a source: schedule, folder, webhook, or manual |
| Working space node | Where work happens | Not an [[Actor]] itself — actors are assigned into it |
| [[Command]] node | Deterministic, backed by a file meeting the command contract | The only kind that declares a shape (named inputs/outputs) |

A working space node has no identity of its own. It's a place on the canvas that
one or more actors are assigned into; the actor brings the judgement, the node
just says where.

Only a command node declares a shape. A conversation — a working space node's
context — has none.

## Two connection kinds

There are exactly two ways a node connects into a context:

1. An [[Event]] **lands in** a context.
2. An [[Actor]] or a command **takes part in** a context.

Both are ordinary context membership and subscription — nothing new is stored for
"the connection."

## Branch and converge are just edges

There's no special node kind for branching or converging work. If two nodes both
connect into the same context, that's a converge. If one node's output lands in
two different contexts, that's a branch. It's the same two connection kinds,
used more than once.

## Iteration is inside a run

Running a node more than once over the same input isn't a separate node kind
either — it's a pass count inside a single run. The node stays one thing; a
context can be re-entered for another pass.

## Implementation

- `floe-bus/src/scope-graphs.ts` — `ScopeGraphTriggerNode` (event node), `ScopeGraphActorNode`, command input/output types
- `floe-bus/src/contexts/store.ts` — `applyContextSubscriptions` — how a node's connection to a context is realised as participation + subscription

See [[Glossary]].
