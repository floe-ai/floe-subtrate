# Context

**A context is a bounded stream of [[Event]]s with participants — where work happens and outcomes appear.**

Events land in a context, actors and commands take part in it, and its history is
the record of what actually happened, as opposed to what was authored on the
[[Scope]] canvas.

## A context is anchored, not owned

A context must be anchored by **a [[Scope]], by participants, or both**. That is
the only rule. It gives contexts two everyday shapes:

- **On a scope** — the context is one run of a [[Node]] on that scope's canvas.
  One node spawns as many contexts as the work needs.
- **Off any scope** — the context is simply a conversation between one or more
  [[Actor]]s. It belongs to no canvas, and nothing about it is lesser for that:
  it has the same history, participation, subscriptions and compaction as any
  other context.

A context that has a scope *and* participants is both at once.

Nothing in storage ties a context to a node — there is no node id on a context.
The scope is the only structural anchor, so "one run of a node" describes a
context's *situation*, never its definition.

## Events wake participants, wherever the context sits

An event can be injected into any context, including a scope-less one, to wake
the actors in it and get a reaction. This is how a bare conversation becomes
active work: something lands, a subscribed actor is woken, it responds. A
[[Node]] is not required for an actor to be woken — only a context, a
participant and a subscription that matches.

## Participation vs subscription

These are different things and the substrate never conflates them:

- **Participation** is membership. Any participant may always emit into the
  context — participation alone is enough to speak.
- **Subscription** is which event *types* wake an [[Actor]]. `["*"]` means woken
  by everything; `[]` means a silent watcher — a participant that can speak but
  is never woken; no subscription row at all means never woken.

There is no role enum anywhere. "Assignee" and "watcher" are not stored labels —
they're emergent from what an actor happens to be subscribed to. You can't ask
the substrate "who is the assignee here" — you can only ask "who is subscribed to
what."

## History, compaction, clear-history

A context's history grows as events land and actors emit. Two operations manage
it:

- **Compact** — collapse history before a watermark into one summary event,
  keeping the context usable without unbounded growth.
- **Clear-history** — delete all events, keeping the context, its participants
  and its subscriptions intact. Cannot run while a delivery is active.

## Participants change dynamically

Participants aren't fixed at creation. They're added and removed as work
progresses — a context can gain a reviewer partway through, or drop a watcher
once it's no longer relevant.

## Parent and child contexts

A context can declare a parent, and children can be listed from it. This is used
both for scope-hierarchy provenance and for peer contexts a runtime spins up on
the fly when it emits to a non-participant — the new context records the
context it came from as its parent.

## Implementation

- `floe-bus/src/contexts/store.ts` — context storage, `applyContextSubscriptions`, `compactContext`, `clearContextHistory`
- `floe-bus/src/server.ts` — `POST /v1/workspaces/:workspace_id/contexts` — create
- `floe-bus/src/server.ts` — `POST /v1/contexts/:id/participants`, `DELETE /v1/contexts/:id/participants/:endpoint_id`
- `floe-bus/src/server.ts` — `POST /v1/contexts/:id/subscriptions`, `DELETE /v1/contexts/:id/subscriptions/:endpoint_id`, `GET /v1/contexts/:id/subscriptions`
- `floe-bus/src/server.ts` — `POST /v1/contexts/:id/subscriptions:batch` — participants + subscriptions applied atomically
- `floe-bus/src/server.ts` — `POST /v1/contexts/:id/compact`, `POST /v1/contexts/:id/clear-history`
- `floe-bus/src/server.ts` — `GET /v1/contexts/:id/children`, `GET /v1/contexts/:id`, `GET /v1/contexts/:id/events`
- `floe-bus/src/contexts/participants.test.ts`, `subscriptions.test.ts`, `compaction.test.ts`, `batch-subscriptions.test.ts` — behaviour tests for the above

See [[Glossary]].
