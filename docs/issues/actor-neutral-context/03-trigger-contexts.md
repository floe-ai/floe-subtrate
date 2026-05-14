# Slice 3 — Trigger Contexts: pulse + existing webhook ingest become target-only

> **Type:** AFK

## Parent

`docs/actor-neutral-context-slice-prd.md`

## What to build

Make non-actor triggers (pulse, webhook) emit into target-only contexts so they cannot pollute actor-to-actor communication contexts.

**Pulse fired events:**
- When a pulse fires, the `pulse.fired` event is created with `context_id` resolved as: lazily create a new context with `participants = [target_endpoint_id]`. The target is the sole participant.
- `source_endpoint_id` is `null` (or, if the schema cannot accept null, an internal/legacy marker that is **never rendered and never added as a participant**).
- Trigger metadata (`pulse_id`, `pulse_name`, `trigger_kind: "pulse"`) lives in the event `metadata` field.
- The participant-aware continue rule (Slice 1 resolver) does **not** apply to bus-generated trigger events — the bus directly creates the target-only context.

**Webhook ingest events** (the existing `POST /v1/webhooks/:workspace_id/:route_id` path in `floe-bus/src/store.ts:847+`):
- Replace the current synthetic `endpoint:<ws>:webhook:<routeId>` source with `source_endpoint_id: null` (or internal marker) and a target-only context with `participants = [target_endpoint_id]`.
- Trigger metadata (`route_id`, `trigger_kind: "webhook"`) in event `metadata`.
- One context per ingest is acceptable for the slice.
- **Do not expand webhook scope.** Apply the target-only rule to the existing path only; do not add new webhook features.

**Do not** create synthetic system endpoints (no `endpoint:<ws>:system:scheduler`, no `endpoint:<ws>:system:webhook`). Trigger sources are not actors and must not be treated as participants.

## Acceptance criteria

- [ ] When a pulse fires, the resulting event has `context_id` set, the context's participants contain only the target endpoint, `source_endpoint_id` is null/marker, and `metadata` carries `trigger_kind`, `pulse_id`, `pulse_name`.
- [ ] When a webhook ingest occurs on the existing route, the resulting event has `context_id` set, the context's participants contain only the target endpoint, `source_endpoint_id` is null/marker, and `metadata` carries `trigger_kind: "webhook"` and `route_id`.
- [ ] No synthetic `endpoint:<ws>:system:*` or `endpoint:<ws>:webhook:*` participants are created.
- [ ] Tests T8 (pulse) and T9 (webhook) from design §6.1 pass.
- [ ] Existing pulse contract test continues to pass (with updated expectations for context shape).
- [ ] No webhook surface area is expanded; only the existing ingest path is touched.

## Blocked by

- Slice 1 — Substrate Foundation
