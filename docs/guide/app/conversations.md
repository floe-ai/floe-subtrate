# Conversations in floe-app

**A [[Context]] opens as a conversation: a message list, who is currently working, and who you are speaking as.**

## Opening a conversation

You reach a conversation from a scope's Contexts tab, an actor's Conversations tab, or Activity (see [[Navigating floe-app]]). It opens with a header showing the context's human label and pills for each current participant, by name.

## The message list

The body is a scrollable, chronological stream. Only events of `type === "message"` render as chat bubbles — lifecycle bookkeeping (like a context being created) is hidden from the stream by default. Each bubble shows the author's resolved name and a timestamp; the author is looked up from the [[Endpoint]] id on the event, never shown as a raw id if a name is available. The list auto-scrolls to the bottom as new messages arrive, but stops sticking if you scroll up to read history.

## Speaking as

There is no human identity in floe — the substrate has no human/agent distinction, and peers cannot tell what backs an [[Actor]]. So the composer does not ask who *you* are; it asks which [[Actor]] you want to post as, via a "Speaking as" selector. Sending a message posts it into the context as that actor's [[Endpoint]].

The default operator/Floe entry is intentionally narrower: it fixes the speaking endpoint to the workspace operator and shows the workspace provider, model, and reasoning effort above the composer. Its composer remains disabled until a connected provider and model are saved, so an operator cannot create a message that Floe is not configured to handle. Developer-opened conversations keep the general "Speaking as" behaviour.

## Joining a context

The "Speaking as" selector stays visible even if the actor you have selected is not a [[Context|Participant]] of this context yet. A "Join context" button lets you add that actor as a participant before you send. Participation is membership, not a subscription to being woken — joining does not by itself make the actor respond to anything; it only makes it able to emit and be seen as present.

## Seeing who is working

A "`<actor> is working…`" indicator appears while an actor has a live [[Delivery and Turn|Delivery]] or turn in progress in this context. It is driven by the same bridge↔bus WebSocket the substrate uses for everything else — there is no polling.

## Creating a new context

New contexts are created from a scope (the "New scope" / context-creation affordances in scope detail) or from an actor's view when starting a fresh conversation with it. A created context can optionally belong to a [[Scope]]; one with no scope still exists and is reachable directly, it just is not listed anywhere as a group (see [[Navigating floe-app]] for that gap).

See [[Glossary]].

## Implementation

- `floe-app/src/scope/ContextConversation.tsx` — conversation view, message stream, Speaking-as selector, Join context, working indicator
- `POST /v1/contexts/:id/participants` — join a context (`addContextParticipant`)
- `GET /v1/contexts/:id/events` — message stream (`listContextEvents`)
- `POST /v1/workspaces/:ws/contexts` — create a context (`createContext` / `createDirectContext`)
- Bus WebSocket `GET /v1/events/stream` — live updates, `delivery_bundle_available` / turn-end signals drive the working indicator
