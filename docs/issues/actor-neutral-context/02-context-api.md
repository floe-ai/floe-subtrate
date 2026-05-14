# Slice 2 — Context API: list, detail, context-scoped events

> **Type:** AFK

## Parent

`docs/actor-neutral-context-slice-prd.md`

## What to build

Expose the context primitives over HTTP so clients can query without re-implementing filtering:

- `GET /v1/contexts?participant=<endpoint_id>` — returns contexts where `endpoint_id` is a participant. Sorted by `last_event_at` descending. Each entry includes `context_id`, `participants`, `last_event_at`, and a `first_message_preview` field (text preview of the first `message` event, truncated to ~80 chars; null if no message events yet).
- `GET /v1/contexts/:id` — returns context metadata + participants.
- `GET /v1/contexts/:id/events` — returns events for that context only, in chronological order. Must not return events from any other context regardless of source.

Implementation is a thin wrapper over the Context store from Slice 1. No business logic in routes.

## Acceptance criteria

- [ ] All three routes exist and respond with the documented shapes.
- [ ] `GET /v1/contexts?participant=` returns only contexts the endpoint participates in, sorted by `last_event_at` desc.
- [ ] `last_event_at` is computed cheaply (e.g., `MAX(events.created_at)` aggregate).
- [ ] `first_message_preview` is the text of the first `message`-type event in the context, truncated to ~80 chars, null if none.
- [ ] `GET /v1/contexts/:id/events` is provably context-scoped (test T7 from design §6.1).
- [ ] Unit/integration tests cover route shape, sort order, filter correctness, and isolation between contexts.
- [ ] No new business logic exists in the route handlers — they delegate to the store.

## Blocked by

- Slice 1 — Substrate Foundation
