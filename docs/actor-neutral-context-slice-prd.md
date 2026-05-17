# Actor-Neutral Context Slice — PRD

> Source design: `docs/design-actor-neutral-context.md` (grilled through 12 branches).
> Triage label: `ready-for-agent`.

## Problem Statement

When an operator selects an agent in FloeWeb (e.g., "floe"), unrelated conversations involving that agent merge into a single chat view. Messages emitted in one conversation bleed into another. The substrate has no first-class concept of a *context* — threads are implicit strings on events, and FloeWeb performs client-side source filtering on a workspace-wide event fetch. As a result:

- Operator → floe and floe ↔ reviewer messages render together when the operator selects floe.
- Pulse-fired events appear inside ordinary chat history.
- There is no way to address "this conversation" as a substrate object.
- The bleed is not fixable by client tweaks; the substrate genuinely doesn't carry the information needed to isolate conversations.

The product also needs a rule that prevents this from regressing as new clients (Slack, CLI, API, runtime adapters) arrive — without baking interface-specific assumptions (human/agent/web/runtime) into substrate identity.

## Solution

Introduce a first-class **context** primitive in the substrate, plus a strict, actor-neutral participant-aware rule for which context an emit belongs to. Replace the implicit `thread_id` with a canonical `context_id` carried on every event. Replace FloeWeb's workspace-wide event fetch with a context-scoped server endpoint. Render only events for the selected context.

Key properties:

- **Actor-neutral.** Substrate identity is endpoint-shaped today and `actor:<workspace_id>:<actor_id>` long-term; the slice does not migrate identity but commits to the direction. No human/agent/web special cases in routing, rendering, or rules.
- **Lazy creation.** Contexts exist only after a real emit. No empty draft contexts created on workspace attach, FloeWeb load, actor selection, or composer open.
- **Participant-aware continue.** Within a delivery turn, a runtime emitting to a participant of the current context continues that context; emitting to a non-participant opens a new `{source, destination}` context. UI-originated emits without explicit `context_id` always open a new context.
- **Strict participant gating.** Explicit `context_id` is validated against participants. Violations return a structured `E_NOT_CONTEXT_PARTICIPANT` error with bounded recovery hints; **no silent fallback**.
- **Frozen participant set.** No `add_participant`/`remove_participant` in this slice. The natural way to "bring in" a third endpoint is a new context plus an explicit summary back into the original context.
- **Pulse/webhook target-only.** Non-actor triggers populate context participants with the *target* endpoint only — no synthetic system endpoints, trigger metadata stays in event metadata.
- **Self-emit allowed.** Source == destination is valid.
- **Fresh-state implementation.** No production data exists; no migration, dual-write, or backfill. Existing test workspaces and bus DBs may be wiped.
- **Server-side scoping.** New `GET /v1/contexts/:id/events` returns only events for that context. FloeWeb stops fetching all workspace events for chat rendering.

The slice is intentionally narrow. Acting instances, actor identity migration, `caused_by_event_id`, broadcast cleanup, authority/permissions, context lifecycle (close/archive), participant management, multi-binding delivery, and `list_contexts` agent tools are deferred.

## User Stories

1. As an operator, I want messages I send floe in one conversation not to appear in a different conversation, so that my chat history reflects what actually happened.
2. As an operator, I want pulse-triggered events not to appear inside my chat with floe, so that scheduled activity does not pollute communication.
3. As an operator, I want to start a "new conversation with floe" without abandoning empty contexts in my list, so that the context list reflects real activity.
4. As an operator, I want my context list for a selected agent ordered by most-recent activity with a recognisable preview label, so that I can find the conversation I want.
5. As an operator, I want a fresh workspace to show no contexts until I send the first message, so that the list represents real history rather than a fake default.
6. As an operator, I want reloading FloeWeb to show the same real contexts I had before, so that the UI does not invent state.
7. As an agent author, I want my agent to know which context it is currently processing, so that it can choose to continue the same context or open a new one.
8. As an agent author, I want my agent to know who the other participants are in the current context, so that it can decide whether emitting to a particular endpoint will continue or branch the conversation.
9. As an agent, I want to consult another agent without leaking that exchange into the operator's view, so that internal coordination stays internal.
10. As an agent, I want to summarise a side conversation back into the operator's context by passing the explicit `context_id`, so that the operator sees the result without seeing the raw exchange.
11. As an agent, I want a clear, structured error when I try to emit into a context I'm not a participant of, so that I can recover programmatically rather than guessing.
12. As an agent, I want to be able to leave myself a note (self-emit) without the substrate rejecting it, so that single-participant contexts work.
13. As a pulse author, I want a pulse to fire into a context that contains only the target endpoint, so that scheduling does not leak into communication contexts.
14. As a webhook author, I want each ingest to land in its own target-only context, so that incoming external events don't pollute conversations.
15. As a frontend developer, I want a `GET /v1/contexts/:id/events` endpoint that returns only that context's events, so that I don't need to re-implement filtering on the client.
16. As a frontend developer, I want a `GET /v1/contexts?participant=<endpoint_id>` endpoint that returns the contexts an endpoint participates in, sorted by `last_event_at`, so that the agent panel can render the list cheaply.
17. As an integrator (future Slack/CLI/API), I want substrate identity and rules to be interface-neutral, so that my client doesn't need substrate-visible labels for what kind of client it is.
18. As a runtime adapter author, I want the bus to compute `context_id` for me when I omit it, so that simple agents don't need to manage context state explicitly.
19. As an operator, I want clicking "New conversation" to enter a local draft state without creating a server-side context, so that abandoning the draft costs nothing.
20. As an operator continuing an existing FloeWeb conversation, I want the client to pass the explicit `context_id`, so that my message lands in the right place without ambiguity.
21. As a maintainer, I want one canonical place where the participant-aware continue rule is implemented, so that the rule can be reasoned about and changed safely.
22. As a maintainer, I want context creation, participant gating, and event scoping to be testable in isolation from the HTTP layer, so that the substrate's correctness is verifiable in unit tests.
23. As a reviewer, I want the slice to make zero allowance for migration, dual-write, or backfill of legacy `thread_id` events, so that we don't carry forward technical debt.

## Implementation Decisions

### Substrate (floe-bus)

- **New table `contexts`** with columns: `context_id` (PK), `workspace_id`, `parent_context_id` (nullable, low-risk forward compatibility for related-context views; not populated/queried in slice), `created_by_endpoint_id`, `created_at`. **No `status` column.**
- **New table `context_participants`** with columns: `context_id` (FK), `endpoint_id`, `joined_at`, PK `(context_id, endpoint_id)`. Inserts only at context creation; never updated, never deleted in this slice.
- **Events table change**: add `context_id` column. `thread_id` is removed from new flows; if any internal component still reads it, that component is updated in this slice. No dual-write.
- **Deep, isolated module — Context store**: pure CRUD over `contexts` and `context_participants`. Methods include `createContext`, `getContext`, `getContextParticipants`, `listContextsForParticipant`, `getLastEventAt`, `isParticipant`. No business rules.
- **Deep, isolated module — Context resolver**: pure function `resolveContext({ source_endpoint_id, destination, supplied_context_id, current_delivery_context_id }, ctxStore) → { context_id, created } | { error: "E_NOT_CONTEXT_PARTICIPANT", payload }`. Encodes the participant-aware continue rule (§3.1.4 of the design) in exactly one place. Pure read of the store; no writes.
- **Bus event submission** (`submitEvent` / `/v1/events/emit`): calls the resolver before persisting, writes the resulting `context_id` onto the event, creates the context if `created` is true, returns `context_id` in the response. Rejection from the resolver short-circuits — **no event is persisted, no delivery is created**.
- **Pulse/webhook trigger emission** (`pulse.fired`, webhook ingest): bus generates these as system-originated events. Context creation: lazy, target-only — `participants = [target_endpoint_id]`. `source_endpoint_id` is `null` (or an internal/legacy marker only for storage compatibility). Trigger metadata (pulse_id, pulse_name, webhook route) lives in the event `metadata` field. The resolver participant-aware rule applies only to actor/endpoint-originated emits, not to these bus-generated triggers.
- **New routes**:
  - `GET /v1/contexts?participant=<endpoint_id>` — returns contexts where `endpoint_id` is a participant, sorted by `last_event_at` desc, with a `last_event_at` aggregate and (optional) first-message preview for labelling.
  - `GET /v1/contexts/:id` — context metadata + participants.
  - `GET /v1/contexts/:id/events` — events for that context, in chronological order.
- **Error contract**: `E_NOT_CONTEXT_PARTICIPANT` payload includes `code`, `message`, `context_id`, `source_endpoint_id`, bounded `available_contexts: [{ context_id, participants, topic }]`, and `recovery: string[]`.

### Bridge (floe-bridge)

- **Runtime adapter `pi-agent-core-adapter.ts`**: `deliveryToPrompt` includes `current_context_id` and `current_context_participants` in the rendered delivery context block. The `emit` tool gains an optional `context_id` parameter and forwards it to the bus.
- **Substrate guidance (`runtime-core/guidance.ts`)**: appends concise rules (per the design's Grill #10 update) explaining `context_id` vs `destination`, the participant-aware continue rule, and how to opt into continuing the current context vs branching.

### FloeWeb (floe-web)

- **Chat fetch**: replace workspace-wide `GET /v1/events?workspace_id=X` with `GET /v1/contexts/<id>/events`.
- **Remove client-side source filter** in the chat rendering path.
- **Agent panel context list**: when an agent is selected, fetch `GET /v1/contexts?participant=<agent_endpoint_id>`, render sorted by `last_event_at` desc, label by first-message preview (~80 chars; fall back to `"Pulse: <pulse_name>"` if pulse-only, else `"Conversation"`). The default context (if one exists) is pinned first.
- **"New conversation"**: clicking the affordance enters local UI draft state (`selected_context_id = null`, `draft_destination = endpoint:<agent>`). **No API call.** First send emits with `context_id: null`; bus creates the context and returns `context_id`; FloeWeb adopts it.
- **Continuing an existing conversation**: FloeWeb always passes the explicit `context_id` on send.
- **Empty state**: if an agent has no contexts, show "No conversations with <agent> yet. Send a message to start one." with a primed composer.

### Encoded resolver decision (from design § 3.1.4)

```text
For UI-originated emits with no current delivery context:
  context_id supplied        → rule 1 (validate participant or reject)
  context_id omitted         → open new context with {source, destination}

For runtime-originated emits during a delivery turn:
  context_id supplied        → rule 1
  destination ∈ current ctx  → continue current context (rule 2)
  destination ∉ current ctx  → open new context (rule 3)

Rejection on rule 1 violation:
  → E_NOT_CONTEXT_PARTICIPANT (no event persisted, no delivery created)

Pulse / webhook (bus-originated):
  → create new context with participants = [target_endpoint_id]
  → source_endpoint_id = null
  → trigger details in event.metadata
  → resolver participant-aware path NOT applied
```

## Testing Decisions

A good test for this slice exercises **external behaviour**: what `submitEvent` does (writes the event with the right `context_id`, creates the right context, rejects when it should), what the resolver returns for given inputs, what the HTTP routes return, and whether the rendered delivery context contains the agreed fields. Tests must not assert internal call counts, schema column orderings, or implementation details that would change under refactor.

### Modules to test (unit/integration)

- **Context resolver** — exhaustively cover the rule matrix (UI vs runtime origin × supplied vs omitted × participant vs not). Pure function tests; mock the store interface.
- **Context store CRUD** — create/read context + participants, listing for participant, `last_event_at` aggregate.
- **Bus emit integration with resolver** — emit through `submitEvent`; verify event row carries `context_id`, context exists with correct participants, rejection paths persist nothing.
- **Pulse trigger emission** — pulse fires → event has `context_id`, target-only participant, `source_endpoint_id` is null/marker, metadata carries trigger details.
- **HTTP routes** — `/v1/contexts`, `/v1/contexts/:id`, `/v1/contexts/:id/events` shape, sort order, filter correctness.
- **Bridge delivery context** — `deliveryToPrompt` contains `current_context_id`, `current_context_participants`, `source_endpoint`, `reply_destination`; does not contain a global contexts list.
- **FloeWeb context fetch** — chat rendering path uses `/v1/contexts/:id/events`; no client-side source filter remains.

### Unit test list (T1–T20 from design §6.1)

T1–T20 are the canonical substrate test list; see `docs/design-actor-neutral-context.md` §6.1.

### Live E2E proofs (E2E-1 … E2E-9 from design §6.2)

Acceptance for the slice is the nine live proofs in design §6.2. These must pass in a real workspace with bus + bridge + FloeWeb running before the slice is declared complete.

### Prior art

- `floe-bus` already has integration tests that boot the bus in-process and exercise emit + delivery (e.g., the pulse contract test added in slice 1 of the parent PRD). The new tests should follow the same pattern.
- `floe-bridge` adapter has unit tests that exercise `deliveryToPrompt` and `renderDestinationContext` (see `runtime-core/guidance.test.ts`). New delivery-context-shape tests extend this.

## Out of Scope

- **Acting instances** (`acting_instance_id`) — opaque correlation handle; deferred until there's a concrete audit/replay use case and a way to emit one without leaking interface identity.
- **Actor identity migration** to `actor:<workspace_id>:<actor_id>` — the slice keeps `endpoint_id` as the participant reference. Direction is documented; rename is a future slice.
- **`caused_by_event_id`** on events — not needed for context isolation; deferred.
- **Broadcast cleanup** — handled in the Broadcast Selector Contract Cleanup slice with delivery-processor selectors, not actor categories.
- **Authority / permissions** — placeholder only in long-term design; no enforcement in slice.
- **Context lifecycle** (open/close/archive, status field) — not in slice; contexts are always emittable.
- **`add_participant` / `remove_participant`** — participant set is frozen at creation in this slice.
- **Multi-binding delivery** semantics (same actor on FloeWeb + CLI simultaneously) — deferred.
- **`list_contexts` / `list_actor_contexts` agent tools** — agents see only `current_context_id` + `current_context_participants` in delivery context; richer discovery is a future tool.
- **Migration / dual-write / backfill** — none. Existing test workspaces and bus DBs will be wiped.
- **Profile views, multi-context navigation UI, related-context views** — out of slice.

## Further Notes

- Per maintainer policy: the project has not shipped. Breaking changes to bus schema and event shape are acceptable. Existing workspaces may be reset; no data preservation work is required.
- The slice's correctness depends on the **participant-aware continue rule** living in exactly one place (the resolver). Reviewers should reject any PR that inlines the rule into emit handlers or HTTP routes.
- Pulse target-only contexts intentionally produce single-participant contexts. This is consistent with self-emit being allowed (T14) and with §3.1.4 rule 2 when the agent later replies to the only participant (itself or via explicit `context_id`).
- The 9 E2E proofs in design §6.2 are the source of truth for acceptance. Unit-test coverage alone is insufficient; the slice is not complete until all 9 pass live.
