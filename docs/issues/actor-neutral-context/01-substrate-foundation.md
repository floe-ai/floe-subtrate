# Slice 1 — Substrate Foundation: Context schema, store, resolver, submitEvent integration

> **Type:** AFK
> **Honesty note:** This is a technical tracer through the substrate. It is **not** a complete vertical product slice — there are no HTTP routes, no bridge changes, and no FloeWeb changes here. Demoable via in-process bus integration tests. The product feature is **not** complete after this slice; live FloeWeb proof comes in Slice 6.

## Parent

`docs/actor-neutral-context-slice-prd.md`

## What to build

Establish the substrate primitives needed for actor-neutral context isolation:

- New `contexts` table: `context_id` (PK), `workspace_id`, `parent_context_id` (nullable, not populated/queried in slice), `created_by_endpoint_id`, `created_at`. **No `status` column.**
- New `context_participants` table: `context_id` (FK), `endpoint_id`, `joined_at`, PK `(context_id, endpoint_id)`. Inserts only at context creation; never updated, never deleted in this slice.
- `events` table gains a `context_id` column. `thread_id` is removed from active code paths in this slice; do not preserve old workspace compatibility.
- **Deep, isolated module — Context store.** Pure CRUD over the new tables. Methods include `createContext`, `getContext`, `getContextParticipants`, `listContextsForParticipant`, `getLastEventAt`, `isParticipant`. No business rules.
- **Deep, isolated module — Context resolver.** Pure function:

  ```text
  resolveContext({
    source_endpoint_id,
    destination,
    supplied_context_id,
    current_delivery_context_id,
  }, ctxStore)
    → { context_id, created: bool }
    | { error: "E_NOT_CONTEXT_PARTICIPANT", payload }
  ```

  The participant-aware continue rule lives **only here**. No DB writes; takes a read-only context-store interface. Rule (from PRD § "Encoded resolver decision"):

  ```text
  UI-originated (no current delivery context):
    context_id supplied → rule 1 (validate participant or reject)
    context_id omitted  → open new context with {source, destination}

  Runtime-originated (during delivery turn):
    context_id supplied            → rule 1
    destination ∈ current context  → continue current context (rule 2)
    destination ∉ current context  → open new context (rule 3)

  Self-emit (source == destination) is allowed.
  ```
- **Wire resolver into `submitEvent`.** Every emit calls the resolver before persistence; the resulting `context_id` is written onto the event. If `created` is true, the bus also creates the new context row + participants. Rejection from the resolver short-circuits — **no event persisted, no delivery created**.
- **Error contract** for `E_NOT_CONTEXT_PARTICIPANT`: payload includes `code`, `message`, `context_id`, `source_endpoint_id`, bounded `available_contexts: [{ context_id, participants, topic }]`, and `recovery: string[]`.

Out of this slice: HTTP routes, pulse/webhook trigger emission changes, bridge delivery context, FloeWeb. Those have their own slices.

## Acceptance criteria

- [ ] `contexts` and `context_participants` tables exist with the documented schema; no `status` column.
- [ ] `events.context_id` column exists and is non-null for all newly persisted events.
- [ ] No active code path reads `events.thread_id` after this slice; the column may remain in storage if removing it is structurally intrusive, but it is no longer authoritative.
- [ ] Context store exposes the documented CRUD methods and is unit-tested in isolation (no HTTP, no resolver coupling).
- [ ] Context resolver is implemented as a pure function and unit-tested across the full rule matrix (UI vs runtime origin × supplied vs omitted × participant vs not).
- [ ] `submitEvent` calls the resolver, writes the resolved `context_id`, creates contexts/participants when `created` is true, and short-circuits on rejection (zero event rows, zero delivery rows on rejection paths).
- [ ] `E_NOT_CONTEXT_PARTICIPANT` rejection returns the documented payload shape including bounded `available_contexts`.
- [ ] Self-emit (source == destination) is accepted.
- [ ] Tests T1–T7, T10–T14, T18–T19 from `docs/design-actor-neutral-context.md` §6.1 pass.
- [ ] All existing bus tests continue to pass after schema change.

## Caution (from PRD)

Keep the participant-aware continue rule in **one resolver only**. Reviewers must reject any PR that inlines the rule into emit handlers, HTTP routes, the bridge, or FloeWeb.

## Blocked by

None — can start immediately.
