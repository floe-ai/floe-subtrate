# Slice 4 — Runtime Context Awareness: bridge delivery context + emit tool

> **Type:** AFK

## Parent

`docs/actor-neutral-context-slice-prd.md`

## What to build

Make the agent runtime aware of the current context so agents can reason about and intentionally control where their emits land.

**Bridge runtime adapter (`pi-agent-core-adapter.ts`):**
- `deliveryToPrompt` includes the following in the rendered `[Delivery Context]` block:
  - `current_context_id` — the context the delivery belongs to
  - `current_context_participants` — list of endpoint IDs that are participants of the current context
  - `source_endpoint` — the source of the current delivery
  - `reply_destination` — the natural reply target
- The block does **not** include a global list of contexts the source participates in. (That is a future explicit `list_contexts` tool, out of scope here.)
- The `emit` tool gains an optional `context_id` parameter and forwards it to the bus. If omitted, the bus's resolver applies the participant-aware continue rule using the current delivery context.

**Substrate guidance (`runtime-core/guidance.ts`):**
- Append concise rules to `SUBSTRATE_GUIDANCE`:
  - `context_id` groups related events; `destination` controls delivery.
  - Emitting to a participant in the current context continues that context.
  - Emitting to a non-participant without a `context_id` opens a new context.
  - To intentionally respond in the current context, pass the current `context_id`.
  - To consult another endpoint privately, omit `context_id` unless that endpoint is already a participant.
  - Contexts are not channels or broadcasts.

## Acceptance criteria

- [ ] `deliveryToPrompt` rendered output contains `current_context_id`, `current_context_participants`, `source_endpoint`, and `reply_destination`.
- [ ] `deliveryToPrompt` rendered output does **not** contain a global contexts list for the source.
- [ ] The `emit` tool accepts an optional `context_id` parameter and forwards it to the bus emit endpoint.
- [ ] Omitting `context_id` from `emit` causes the bus resolver to apply the participant-aware rule using the current delivery context.
- [ ] `SUBSTRATE_GUIDANCE` is updated with the documented concise rules.
- [ ] Tests T15, T16, T17 from design §6.1 pass.
- [ ] Existing `guidance.test.ts` tests continue to pass.
- [ ] Existing bridge runtime tests continue to pass; the conditional emit rule (prior slice) is preserved.

## Caution (from PRD)

The participant-aware continue rule is **not** re-implemented in the bridge. The bridge passes `current_delivery_context_id` to the bus; the bus's resolver makes the decision.

## Blocked by

- Slice 1 — Substrate Foundation
