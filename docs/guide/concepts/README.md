# Concepts

**Floe is built from a small set of primitives, not a workflow engine.**

A [[Workspace]] contains [[Scope]]s. A scope is a canvas holding [[Node]]s. A node is
work to be done; a [[Context]] on that scope is one run of it — though a context can
also stand on its own, off any canvas, as a conversation between [[Actor]]s. Actors
live at workspace level and are assigned into working spaces. An [[Event]] lands in a
context and wakes things. That's the whole shape — everything else is detail.

## Primitives at a glance

| Primitive | One-line definition |
|---|---|
| [[Workspace]] | The outer boundary of all work for a product. |
| [[Scope]] | An organising boundary and canvas; nodes are placed and connected in it. |
| [[Node]] | A citizen placed on a scope's canvas — the work to be done. |
| [[Actor]] | A non-deterministic participant, backed by a model or a person. |
| [[Context]] | A bounded event stream with participants — where work happens and outcomes appear. On a scope it is one run of a node; off any scope it is a conversation. |
| [[Event]] | Something that lands and wakes the system, carrying a source. |
| [[Command]] | A deterministic node backed by a file meeting the command contract. |
| [[Artifact]] | What travels between nodes — by wire or by file. |
| [[Binding]] | Typed configuration attached to an actor or a node. |
| [[Endpoint]] | The substrate's addressable identity for an actor. |
| [[Hook]] | An extension-supplied handler fired at a runtime lifecycle point. |
| [[Extension]] | An independent repository built against the substrate contract. |
| [[Delivery and Turn]] | How work reaches a runtime, and one agent run built from it. |

## Implementation

- `floe-bus/src/scope-graphs.ts` — node kinds (`trigger`, `actor`, `command`) and their wiring
- `floe-bus/src/contexts/store.ts` — context storage
- `floe-bus/src/server.ts` — all bus HTTP/WebSocket routes

See [[Glossary]].
