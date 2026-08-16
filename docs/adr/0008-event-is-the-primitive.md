# ADR-0008: Event is the primitive; trigger, pulse, watcher and webhook are not

**Status:** accepted (2026-08-15)

## Context

The substrate names `trigger`, `actor` and `command` as scope graph node kinds, and separately carries pulse, folder watcher and webhook as their own primitives. The mechanisms behind them are already one mechanism:

- Firing a trigger node calls `BusStore.emitTriggerEvent` — described in `floe-bus/src/scope-graphs.ts` as "the same bus-originated wake primitive pulse firing already uses".
- The folder watcher introduced for #155 has no wake mechanism of its own. It calls `fireScopeGraphTrigger` → `emitTriggerEvent`, the existing trigger path.
- A command node is wired identically to an actor node — an ordinary Context participant whose endpoint is backed by a deterministic runtime rather than a model. The substrate has no `actor_kind` and cannot tell them apart.

So the substrate had already argued that these were the same thing, twice, and stored them as separate kinds anyway. The names had drifted from the model.

The operator raised the mismatch from the user's side while vetting the substrate inventory ([#167](https://github.com/floe-ai/floe-subtrate/issues/167)): a person building a scope thinks of a schedule, a folder landing and a webhook as three shapes of one idea — an event — and will look for them in one place.

A name earns the word *primitive* only if it owns something no existing primitive owns. Trigger, pulse, folder watcher and webhook do not.

## Decision

**A workspace holds four citizens: Actor, Command, Context and Scope.**

- **Actor** — not deterministic. It reasons, acts outside the substrate, and brings the result back; its output requires judgement. Backed by a model or a person, and the substrate remains unable to tell which (no `actor_kind`).
- **Command** — deterministic. Re-runnable, cacheable, trustable without judgement. Backed by a file on the system that satisfies the command contract (named inputs in, named outputs out). The workspace holds the reference; the code lives wherever it lives.
- **Context** — where work happens. Events land here, discussion happens here, outcomes appear here.
- **Scope** — holds nodes and contexts.

**An Event is not a workspace citizen. It is something that lands**, woken by the world rather than by a context. Where it came from is a **source**: a schedule, a folder or file change, a webhook, or a person pressing go.

Therefore:

- The `trigger` node kind is retired. It is an **Event node** with a source.
- Pulse, folder watcher and webhook are retired **as primitives**. They are sources of an Event. Their machinery — scheduling, file watching, HTTP receipt — is unchanged.
- **Actor and Command remain separate primitives**, on the stated ground of determinism, not by accident of history.

**A node is a citizen placed on a scope's canvas.** There are exactly two connections, both of which the substrate already implements through Context membership and subscription:

- an Event **lands in** a Context
- an Actor or a Command **takes part in** a Context

**A graph is not a primitive.** It is the picture of the nodes and how they are connected. Nothing is stored for it beyond layout.

**What will happen is the nodes in the scope. What has happened is in the context.** These are not two competing pictures of a scope. An outcome — a written file, a haiku — is inside the scope because its context is; it was never a node and does not become one.

## Consequences

Nothing that works is discarded. The firing path, the scheduler, the folder watcher and Context-based wiring are unchanged. What changes is naming, and where a source is configured.

- `ScopeGraphTriggerNode` becomes an event node carrying a source. `emitTriggerEvent` and the paths that call it are untouched.
- A folder watcher stops being declared by hand in the committed `.floe/floe.yaml` and becomes an Event node's source, configured where every other node is configured. This removes one instance of the write-path collision recorded in [#175](https://github.com/floe-ai/floe-subtrate/issues/175).
- `buildScopeProjection` stops being framed as a rival "derived graph" of a scope. What happened is read from contexts.

**This partially reverses [#154](https://github.com/floe-ai/floe-subtrate/issues/154)** on map [#153](https://github.com/floe-ai/floe-subtrate/issues/153), which established a Scope Graph as a record separate from the scope and declared that it and `buildScopeProjection` were "separate records, never merged into one 'the' graph for a scope". The separation of *authored* from *observed* stands — it is now expressed as nodes versus contexts rather than as two graphs. #154's other decisions are unaffected: there is still no stored edge record, and wiring is still inferred from shared Context membership.

CONTEXT.md glossary changes and the corresponding `floe-bus/src/docs-vocabulary.test.ts` rules retiring `trigger` node, and pulse/watcher/webhook as primitives, land with the code change that performs the collapse — not before, or the lint would ban vocabulary the code still legitimately uses.

A future **render node** is not decided here. It faces the same test: does it own something no existing primitive owns? If it is deterministic and one-shot it is a Command. If it owns a persistent surface a person looks at, it earns a primitive.

Recorded from [#176](https://github.com/floe-ai/floe-subtrate/issues/176) on map [#166](https://github.com/floe-ai/floe-subtrate/issues/166).
