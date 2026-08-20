# Concepts

**Floe is built from a small set of primitives, not a workflow engine.**

A [[Workspace]] contains exactly four substrate citizens: [[Actor]], [[Command]], [[Context]] and [[Scope]]. A [[Node]] is one of those citizens placed on a scope — the work to be done — and a context is one run of it. An [[Event]] lands in a context and wakes things; it is not a citizen. That's the whole shape — everything else is detail.

## Primitives at a glance

| Primitive | One-line definition |
|---|---|
| [[Workspace]] | The outer boundary of all work for a product. |
| [[Actor]] | One of the four citizens: a non-deterministic participant, backed by a model or a person. |
| [[Command]] | One of the four citizens: deterministic work backed by a file meeting the command contract. |
| [[Context]] | One of the four citizens: a bounded event stream with participants — where work happens and outcomes appear. |
| [[Scope]] | One of the four citizens: an organising boundary for related work. |
| [[Event]] | Something that lands and wakes the system, carrying a source. |
| [[Node]] | A citizen placed on a scope — the work to be done, not a separate primitive. |
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
