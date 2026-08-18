# Endpoint

**An endpoint is the substrate's addressable identity for an [[Actor]].**

Every actor that can send or receive an [[Event]] is an endpoint. Nothing about an
endpoint says what backs it.

## No stored backing label

There is no `actor_kind` column, and no human/agent distinction stored anywhere.
Delivery is gated on **runtime attachment** — `bridge_id` plus `status` — never on any
label saying what the endpoint is. Peers cannot tell what backs a given endpoint, and
the substrate is built so they never need to.

An endpoint with no live runtime (`bridge_id` unset) still accrues readable history:
events land in its contexts and stay there. It just is not delivered to — there is no
bridge attached to hand the delivery bundle to.

## Registration and status

An endpoint registers with the bus, gets a `bridge_id` when a bridge attaches to run
it, and carries a status such as `idle`, `active`, or `runtime_unconfigured` (no
model/auth binding resolved yet, so it can't be delivered to even if attached).

## Watermarks and cursors

An **endpoint watermark** is a persisted [[Event]] cursor marking how far an endpoint
has been carried forward — the point it was last brought up to date. It advances only
when explicitly set, never on read, so "what's changed since I was last here"
persists until the endpoint deliberately marks itself caught up.

An **event cursor** is an opaque, ordered position in a workspace's event stream, keyed
by `(created_at, event_id)`. The `since` parameter on event queries speaks this cursor;
the tie-break on `event_id` means events sharing a timestamp can be paged past safely.

Neither is a per-message seen/unseen marker — they only ever mark a caught-up
position, set explicitly, never on read.

## Implementation

- `floe-bus/src/server.ts` — `POST /v1/endpoints/register`, `DELETE /v1/endpoints/:endpoint_id`, `POST /v1/endpoints/:endpoint_id/status`, `GET /v1/endpoints`, `GET /v1/workspaces/:workspace_id/endpoints`
- `floe-bus/src/server.ts` — `GET`/`PUT /v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark`
- `floe-bus/src/endpoint-watermark-store.ts` — `EndpointWatermarkStore`
- `floe-bus/src/event-cursor.ts` — `EventCursor`, `encodeEventCursor`, `decodeEventCursor`
- `floe-bus/src/server.ts` — bridge liveness: `POST /v1/bridges/:bridge_id/liveness`, socket-presence check in `GET /v1/runtime/status`

See [[Glossary]].
