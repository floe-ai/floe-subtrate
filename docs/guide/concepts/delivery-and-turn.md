# Delivery and Turn

**The substrate is push-only — there is zero polling anywhere in the delivery path.**

## Delivery

Work reaches a bridge as a **delivery bundle**, carried over the bridge↔bus WebSocket
at `/v1/events/stream`. When an [[Event]] lands somewhere with a live [[Endpoint]] to
deliver to, the bus broadcasts `delivery_bundle_available` with the full bundle in the
payload — the bridge that owns that endpoint reads it directly off the socket. There
is no HTTP poll loop checking "anything for me?"

**Lease expiry and requeue.** A claimed delivery carries a lease. If it isn't
completed in time, it needs to go back into circulation. The bus does this with a
single scheduled timer pointed at the next lease-expiry deadline in the database —
never a scan loop over all deliveries. When the timer fires, it requeues whatever
expired and resets those endpoints to `idle`, then reschedules itself for the new
next deadline.

**Reconnect.** If the WebSocket drops, the bridge reconnects with exponential
back-off (starting short, capping at 16s), and on reconnect does one resync —
`attachKnownWorkspaces()` then `processDeliveries()` — not a recurring reconcile
timer.

**Liveness is socket presence.** The bridge sends `bridge_hello` with its `bridge_id`
as its first message on the socket. The bus considers a bridge live if that socket is
still open — there's no separate liveness ping.

## Turn

A **turn** is one agent run, built from exactly one [[Context]] — the delivery's
origin context. Nothing from any other context bleeds into it. The `BeforeTurn`
[[Hook]] payload carries `origin: {id, kind: "context" | "thread"}` so a hook can
scope its view to that one context and nothing else.

## Session

Each turn runs inside a **session** — a private, ephemeral construct keyed by
`(endpoint_id, context_id)`. It holds the agent's own tool-call and reasoning memory,
which nothing else can see. Sessions are not persisted: a bridge restart is a cold
start, an empty session, re-derived from the world (files) and the context's history.

**Thread-slice injection.** Before each turn, the bridge fetches context events since
the session's last cursor and renders them into the prompt ahead of the trigger event.
A cold session (cursor unset) gets the full backfill; a warm session only gets the
delta since its last successful turn. The cursor only advances after a turn completes
successfully — a failed turn re-fetches the same slice next time rather than skipping
ahead.

## Implementation

- `floe-bridge/src/daemon.ts` — `openEventStream`, WS reconnect back-off, `bridge_hello`, `delivery_bundle_available` handling
- `floe-bus/src/store.ts` — `scheduleNextLeaseExpiryCheck`, `requeueExpiredDeliveryLeases`, `setBroadcast`
- `floe-bus/src/server.ts` — `GET /v1/events/stream` (WebSocket), `GET /v1/delivery/claim`, `POST /v1/delivery/:delivery_id/status`, `POST /v1/bridges/:bridge_id/liveness`
- `floe-bridge/src/adapters/pi-agent-core-adapter.ts` — session map keyed `${endpoint_id}:${context_id}`, `threadCursor`, `renderThreadSlice`

See [[Glossary]].
