# ADR-0012: Lenses, not one universal surface

**Status:** accepted (2026-08-20)

## Context

Map [#166](https://github.com/floe-ai/floe-subtrate/issues/166) set its destination as *"everything the substrate can do is visible and changeable in floe-app"* — every workspace, scope, context, actor, binding, node, watcher, extension and subscription visible, editable, pausable and deletable in one surface.

That obligation cannot be discharged and cannot be closed. It grows with every primitive the substrate gains, and it grows again with every primitive an extension contributes. A workspace carrying real work — a file system, a running server, a database, a CI pipeline, hundreds of actors — has no single picture. Attempting one produces an IDE, a board, a canvas and a tracer welded together, which is what a substrate exists to avoid.

It also inverts MISSION.md's actor-generality test. A destination stated as *"reachable from floe-app"* makes a client the measure of the substrate. The test asks the opposite: is this useful to an actor that never opens the UI?

Map [#153](https://github.com/floe-ai/floe-subtrate/issues/153) got this right by accident of scope — it ruled visual editing out and proved the documentation pipeline from a terminal. #166 explicitly reversed that ruling. This ADR restores the principle on its own merits rather than as a scoping convenience.

The name for what was missing is a **lens**.

## Decision

**The substrate kernel has zero knowledge of any client. Humans reach it through lenses.**

### A lens

A **lens** is a client over a slice of the substrate that answers **one question**. It is built independently, and it is deletable without touching another lens.

- *"What needs me?"* is a question. *"Show scopes"* is not — it is an inventory, and an inventory is the obligation this ADR exists to reject.
- A lens is judged by whether its question is answered, never by how much of the substrate it covers.
- Coverage is not a goal. A substrate capability with no lens is not a gap; it is a capability nobody has needed to look at yet.

### floe-app is a shell, not a surface

`floe-app` hosts lenses. It owns arrival, workspace selection, navigation, the right-hand `aside`, and routing. **It owns no domain view of its own.** Everything substantive is a lens.

The host mechanism already exists and is not rebuilt: `ExtensionManifest.views`, `GET /v1/extensions`, the extension HTTP relay, `PlaceholderExtensionView`, and `ScopeDetail`'s dynamic tabs. A lens is contributed the way an extension view is contributed today.

Because the shell is the single 5379 surface, every lens is reachable in a plain browser and inside the Tauri desktop shell without being built twice. That, and not a second application, is what makes floe a service gateway.

### floe-cli is lens zero

**Every substrate capability must be exercisable headlessly through `floe-cli`.** A lens may only render what the CLI can already print.

This is a gate, not an aspiration. It forces a capability into the substrate and the CLI *first*, so a graphical surface can never be the only way to reach something. It is the mechanism that makes MISSION.md's headless-first stance testable.

### No route exists for a client

No bus route, field or table may be added because a lens needs it. If a capability is not useful to an actor that never opens a UI, it is lens code and belongs in the lens.

### The kit is extracted, not authored

A shared visual language across lenses is wanted, and `floe-ui-kit` is its vehicle. Its boundary is absolute:

- **The kit holds** tokens, headless mechanics, and layout — the boring parts. It knows nothing about floe.
- **The kit never holds** a domain component. No `ScopeCard`, no `ActorPill`, no `ContextTimeline`. A domain component in the kit makes every lens depend on the whole domain, which is the monolith this ADR rejects, reassembled underneath.

**The kit is built by extraction from the second lens, never up front.** Up-front tokens are a guess with no slice behind them. Lens one styles itself; lens two extracts what two real lenses actually share.

## Consequences

**Map #166 is re-aimed, not merely closed.** Its destination is replaced by *"floe-app is a lens shell"*, and its first lens is the supervisor lens — *what needs me?* — which its own [#184](https://github.com/floe-ai/floe-subtrate/issues/184) already argued for: enumeration dies at scale, and *the only thing a surface may volunteer unprompted is what is wrong*. Its accepted decisions survive: [#176](https://github.com/floe-ai/floe-subtrate/issues/176)'s four citizens (ADR-0008), [#179](https://github.com/floe-ai/floe-subtrate/issues/179)'s node-is-work / context-is-one-run, [#184](https://github.com/floe-ai/floe-subtrate/issues/184)'s per-run `called_by`, and [#169](https://github.com/floe-ai/floe-subtrate/issues/169)'s depth-by-reference. Those are substrate and product findings; only the totalising destination is withdrawn.

**#153's terminal-only ruling stands** and is no longer an exception needing justification. A graphical surface is one lens among several, earned by a question, not by a threshold being crossed.

**Existing floe-app views are now either shell or lens.** Anything that is neither — a view that exists because a primitive exists — has no question and is deleted rather than migrated. Pre-release; delete and replace.

**The kit is deferred** until a second lens exists to extract it from. `floe-ui-kit` remains the chosen vehicle and is not re-litigated when that point arrives.

**This does not license a second application.** Lenses that fragment the shell — a separate desktop app, a second port, a parallel UI stack — reintroduce the one-server-one-UI problem ADR-0005's split and the 5377/5379 topology were settled to avoid.

Vocabulary for **lens** and **shell** lands in CONTEXT.md with the first lens, not before, so `docs-vocabulary.test.ts` does not ban language the code has not yet earned.

Raised by the operator after reviewing an outside critique of the substrate's direction; recorded against maps [#166](https://github.com/floe-ai/floe-subtrate/issues/166) and [#153](https://github.com/floe-ai/floe-subtrate/issues/153).
