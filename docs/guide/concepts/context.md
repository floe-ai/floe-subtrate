# Context

**A context is where work happens and outcomes appear — a multi-agent session, a conversation. It's one run of a node.**

Events land in a context, actors and commands take part in it, and its history is
the record of what actually happened, as opposed to what was authored on the
[[Scope]] canvas.

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
