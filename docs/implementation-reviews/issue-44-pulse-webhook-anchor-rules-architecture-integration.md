# Architecture Integration Brief: issue-44-pulse-webhook-anchor-rules

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns authoritative anchor validation and persistence for Contexts, Events, Pulses, webhook ingress, generated delivery Contexts, and HTTP error mapping.
  - `floe-bus\src\store.ts` owns cross-cutting flow orchestration: `submitEvent`, `emitTriggerEvent`, `appendContextEvent`, `ingestWebhook`, `createPulse`, `getOrCreatePulseDeliveryContext`, `insertEvent`, delivery queueing, and scheduler-facing Pulse records.
  - `floe-bus\src\server.ts` owns public API validation and HTTP mapping for `/v1/events/emit`, `/v1/webhooks/:workspace_id/:route_id`, `/v1/pulses`, delivery, Context, and Scope routes.
  - `floe-bus\src\contexts\store.ts` owns Context persistence, nullable `scope_id`, participant rows, Context lookup, and the core invalid-shape guard for Contexts with neither Scope nor participants.
  - `floe-bus\src\scopes\store.ts` owns real Scope persistence, explicit Scope lookup, and the reserved `default` id.
  - `floe-bridge\src\bus-client.ts` consumes nullable event/context Scope and creates Pulse definitions via Bus APIs; bridge runtime/worklog code may expose stale assumptions but must not own bus anchor rules.
- Current owner rationale:
  - The anchor decision must happen before Context/Event/Pulse rows are persisted and before delivery Contexts are generated; only `BusStore` has all of Context, Scope, Pulse subscriber, webhook, and delivery state in one transaction boundary.
  - `ContextStore` already enforces the lowest-level validity invariant (`scope_id` or participants required) and should remain the only Context persistence path.
  - `server.ts` already centralises zod request shape validation and maps domain errors (`ScopeNotFoundError`, `ContextNotFoundError`, `ScopeRequiredError`) to public HTTP responses.
- Source evidence:
  - `docs\adr\0004-scope-as-substrate-organising-boundary.md:30-38` says actor-participant Contexts may be unscoped, actorless Contexts and generated Pulse/Webhook/event-source operational Contexts require real Scope, and Event Scope derives from Context/source ownership.
  - `docs\adr\0004-scope-as-substrate-organising-boundary.md:56-62` says webhook/event-source Scope comes from source/route configuration, not arbitrary request payload override.
  - `CONTEXT.md:143-147` says Pulse needs Scope or an explicit valid Context/subscriber anchor; Context Subscribers may append to unscoped actor Contexts; Endpoint Subscribers without `context_id` require Pulse Scope and reuse one stable generated scoped delivery Context; webhook actorless Events require scoped Contexts.
  - `floe-bus\src\store.ts:578-588` already has `validateScopeId` and `requireScopeId` as the correct Scope validation helpers.
  - `floe-bus\src\contexts\store.ts:117-144` is the Context creation owner and already rejects Contexts with no `scope_id` and no participants.
  - `floe-bus\src\store.ts:976-1024` owns trigger emission and currently supports explicit Context append versus generated operational Context creation.
  - `floe-bus\src\store.ts:1399-1458` owns Pulse creation and currently requires a non-null Scope from explicit `scope_id` or scoped `current_context_id` for all Pulse definitions.
  - `floe-bus\src\store.ts:1492-1543` owns stable generated Pulse delivery Context reuse by deterministic `ctx_pulse_...` id and `pulse_delivery_contexts` mapping.

## Existing interaction model

- User/system behaviors that already exist:
  - Actor-origin `/v1/events/emit` uses `resolveContext` for participant-aware continuation/branching and passes explicit Scope only for newly-created actor Contexts (`floe-bus\src\store.ts:911-965`).
  - Event rows derive `scope_id` from the owning Context in `insertEvent`, so Event Scope remains non-authoritative and cannot disagree with Context Scope (`floe-bus\src\store.ts:1673-1735`).
  - Bus-origin triggers (`pulse.fired`, webhook) have `source_endpoint_id = null`, no synthetic `system:*`, `pulse:*`, or `webhook:*` participants, and create target-only operational Contexts only when no explicit Context is supplied (`floe-bus\src\store.ts:967-1024`).
  - Trigger events without explicit Context already require Scope before creating an operational Context (`floe-bus\src\store.ts:991-999`; covered by `floe-bus\src\contexts\trigger.test.ts:56-68`).
  - Trigger events with explicit Context are allowed and inherit that Context's nullable Scope through `insertEvent` (`floe-bus\src\contexts\trigger.test.ts:147-170`).
  - Webhook ingest selects the first bridge-backed endpoint in the Workspace and requires a configured Scope before creating one scoped target-only Context per ingest (`floe-bus\src\store.ts:1362-1393`; covered by `floe-bus\src\contexts\trigger.test.ts:101-125` and `floe-bus\src\server.test.ts:281-303`).
  - Pulse Context Subscribers append a render-only `pulse.fired` Event to the supplied Context and do not create endpoint delivery (`floe-bus\src\pulse-subscribers.test.ts:68-122`).
  - Pulse Endpoint Subscribers with explicit `context_id` deliver to that endpoint in the supplied Context (`floe-bus\src\pulse-subscribers.test.ts:124-171`).
  - Pulse Endpoint Subscribers without `context_id` reuse one stable generated Context per Pulse + subscriber key across fires and recreate the same id if deleted (`floe-bus\src\pulse-subscribers.test.ts:173-355`).
- Behaviors that must remain unchanged:
  - Do not route Pulse/Webhook/event-source behavior through actor `resolveContext`; these are bus-origin triggers, not actor-to-actor messages.
  - Do not add synthetic source endpoints or mutate Context participants to satisfy anchor rules.
  - Existing scoped Pulse creation, scoped webhook ingest, scoped endpoint-generated delivery Context reuse, and scoped Scope Projection behavior must continue.
  - Existing explicit Context append behavior must continue for valid Context anchors, including unscoped actor Contexts where no generated actorless operational stream is needed.
  - Existing Context Scope authority must continue: if an explicit Context is scoped, Events inherit that Context Scope, not Pulse `scope_id`.
  - Unknown explicit Scope ids must reject before persistence.
  - Endpoint delivery without explicit Context must not create a new Context per fire; stable `pulse_delivery_contexts` mapping must remain.
- Runtime or UX evidence:
  - Existing tests exercise these paths directly: `floe-bus\src\contexts\trigger.test.ts`, `floe-bus\src\pulse-scope-propagation.test.ts`, `floe-bus\src\pulse-subscribers.test.ts`, `floe-bus\src\server.test.ts`, and `floe-bus\src\delivery-symmetry.test.ts`.
  - No live server was started for this scout; this brief is based on current code, docs, and test fixtures.
- Docs/code conflicts or gaps:
  - `CONTEXT.md:145` says a Context Subscriber may append to an unscoped actor Context, but `createPulse` currently rejects all Pulse definitions whose explicit/current anchor resolves to `scope_id: null` (`floe-bus\src\store.ts:1412-1424`). A Pulse with only explicit unscoped Context subscribers cannot currently be configured even though the policy allows it.
  - `CONTEXT.md:143` says Pulse can have explicit Context/subscriber anchor, but the `pulses.scope_id` column is still `TEXT NOT NULL` (`floe-bus\src\store.ts:349-354`, `403-405`), so persisting intentionally unscoped anchored Pulses requires either nullable pulse Scope or a separate persisted anchor classification.
  - `emitTriggerEvent` with explicit `context_id` validates only Context existence/workspace (`floe-bus\src\store.ts:984-990`); it does not currently prove the Context is a valid intentional actor anchor for the target endpoint. That is acceptable for Context append subscribers but risky for endpoint delivery into unrelated unscoped actor Contexts.
  - Bridge tests still contain stale default Scope expectations (`floe-bridge\src\adapters\pi-agent-core-adapter.test.ts:131-137`) and bridge runtime still falls back to `"default"` when a delivery trigger lacks Scope (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:676-688`). This is downstream drift from issue #43 and should not be copied into bus rules.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use `BusStore.validateScopeId` and `BusStore.requireScopeId` for all real Scope validation; extend them or add narrowly named anchor helpers beside them rather than validating scopes ad hoc.
  - Use `ContextStore.getContext`, `getContextParticipants`, and `createContext` for explicit Context validation and generated Context creation.
  - Use `emitTriggerEvent` as the single bus-origin event insertion path for Pulse endpoint delivery and webhook/event-source intake.
  - Use `appendContextEvent` as the Context Subscriber append path, because it already avoids endpoint delivery and derives Event Scope from the existing Context.
  - Use `getOrCreatePulseDeliveryContext` and `pulse_delivery_contexts` for endpoint subscribers without explicit Context; do not create a new mapping or generate random Context ids per fire.
  - Use `server.ts` zod schemas and error mapping for public failures, keeping domain errors as `ScopeRequiredError`, `ScopeNotFoundError`, and `ContextNotFoundError` where possible.
  - Use existing `listPulses({ scope_id })`, `listEvents({ scope_id })`, `ContextStore.listContextsForScope`, and Scope Projection query semantics for real scoped records only.
- Relevant docs or library capabilities:
  - Zod is already the API validator in `server.ts`.
  - SQLite schema migration is performed imperatively in `BusStore.migrate`, `relaxEventScopeColumn`, and `applyContextSchema`; pulse schema changes should follow this pattern if `pulses.scope_id` becomes nullable.
  - `cron-parser` and `PulseScheduler` own scheduling only; they should not receive anchor rules.
- Existing examples in this codebase:
  - `relaxEventScopeColumn` converts old non-null/default Event Scope to nullable (`floe-bus\src\store.ts:423-480`).
  - `applyContextSchema` and `relaxContextAnchorColumns` converted Context anchors to nullable while preserving ContextStore ownership (`floe-bus\src\contexts\store.ts:41-112`).
  - `ScopeReservedIdError` and server mapping show the pattern for public domain errors (`floe-bus\src\scopes\store.ts:30-35`, `floe-bus\src\server.ts:196-211`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate or bypass `ContextStore` for Context creation/participant persistence.
  - Do not duplicate or bypass `emitTriggerEvent`/`appendContextEvent` with direct `events` table inserts.
  - Do not replace `pulse_delivery_contexts` stable mapping with a new Pulse delivery registry.
  - Do not route trigger flows through `resolveContext`; that resolver owns actor-origin events only.
  - Do not make FloeWeb, bridge, extension code, or request payloads the source of truth for Scope membership.
  - Do not resurrect hidden Default Scope or use `default` as a compatibility fallback for new Pulse/Webhook/event-source paths.
- Shortcuts or parallel paths to avoid:
  - Do not satisfy Pulse creation by forcing unscoped explicit Context subscribers into a fake Scope.
  - Do not allow request body webhook payloads to arbitrarily choose Scope; webhook/event-source Scope must come from route/source configuration or a validated configured anchor.
  - Do not silently create generated actorless operational Contexts when `scope_id` is missing.
  - Do not validate only at fire time when the invalid configuration is knowable at Pulse creation time; acceptance requires Pulse configuration rejection.
  - Do not permit endpoint subscriber explicit `context_id` to smuggle delivery into an unrelated unscoped actor Context without validating the target endpoint participates in that Context.
- Invariants:
  - Actorless/generated operational streams require a real Scope.
  - Explicit appends to valid actor-anchored unscoped Contexts remain unscoped where no generated actorless operational stream is being created.
  - Events derive Scope from Context/source ownership, not independently from Pulse/webhook payload.
  - Endpoint subscribers without explicit Context reuse a stable scoped delivery Context and never create a new Context per fire.
  - Webhook/event-source intake that creates an operational stream requires a real configured Scope.
  - `default` remains reserved for stale cleanup/internal compatibility only and must not become a product fallback.

## Integration plan

- Insert the change at:
  1. Add narrow anchor-resolution helpers in `floe-bus\src\store.ts` near `validateScopeId`/`requireScopeId`:
     - a helper to read and validate an explicit Context anchor by workspace;
     - a helper to identify whether a Context is an actor-anchored unscoped Context (`scope_id === null` and participants length > 0);
     - a helper to validate endpoint delivery into an explicit Context (`target_endpoint_id` participates when required);
     - a helper to decide whether a Pulse configuration will create any generated endpoint delivery Context.
  2. Update `createPulse` in `floe-bus\src\store.ts:1399-1458` to validate Pulse configuration before inserting:
     - explicit `scope_id`: validate with `validateScopeId` and persist that Scope;
     - `current_context_id` / subscriber explicit Context anchors: validate Context exists in workspace;
     - if any endpoint subscriber omits `context_id`, require explicit real Scope or scoped current Context because `getOrCreatePulseDeliveryContext` will create/reuse a generated operational Context;
     - if all subscribers are explicit Context anchors and those anchors are valid actor-anchored unscoped Contexts, allow the Pulse only when no generated endpoint delivery Context is needed;
     - if explicit Context anchors are scoped, persist/use the scoped anchor as appropriate, but Events must still inherit the subscriber Context's Scope at fire time.
  3. If unscoped explicit-Context-only Pulse definitions are allowed to persist, relax `pulses.scope_id` in `floe-bus\src\store.ts` from `TEXT NOT NULL` to nullable using the same rebuild pattern as `relaxEventScopeColumn`; make `rowToPulse` preserve `null` and keep `listPulses(scope_id)` scoped-only.
  4. Update `firePulse` in `floe-bus\src\server.ts:959-1042` only as the executor of already-validated anchors:
     - Context Subscribers continue through `appendContextEvent`.
     - Endpoint Subscribers with explicit `context_id` continue through `emitTriggerEvent`, but explicit Context should have been validated at creation and can be revalidated defensively before emitting.
     - Endpoint Subscribers without explicit `context_id` must call `getOrCreatePulseDeliveryContext` only with a non-null real Scope.
  5. Keep `getOrCreatePulseDeliveryContext` (`floe-bus\src\store.ts:1492-1543`) as the only generated endpoint delivery Context creator, but make its signature/guard require a non-null validated Scope and fail loudly if called without one.
  6. Keep `emitTriggerEvent` (`floe-bus\src\store.ts:976-1024`) as the common trigger path, but tighten explicit Context validation so unscoped explicit Context use is limited to valid intentional anchors. For endpoint deliveries, require target participant membership before appending to an unscoped actor Context; for context-only appends, require only valid workspace Context.
  7. Keep `ingestWebhook` (`floe-bus\src\store.ts:1362-1393`) requiring `configuredScopeId` for current HTTP route behavior. If issue #44 adds event-source route config, insert it before `ingestWebhook` calls so configured Scope or configured Context anchor is validated by `BusStore`, not by request body payload.
  8. Update `server.ts` only for public schema/error mapping needed by these stricter domain errors; do not add parallel Pulse/Webhook endpoints.
  9. Update `floe-bridge\src\bus-client.ts` types only if Pulse `scope_id` can now be `null` in returned records. Do not move bus validation into bridge.
- Why this is the correct integration point:
  - The current gaps are in bus configuration-time acceptance (`createPulse`) and trigger explicit-Context validation (`emitTriggerEvent`), not in scheduling, rendering, or bridge delivery.
  - `insertEvent` already derives Event Scope from the Context; enforcing anchors before Context/Event creation preserves that invariant without adding a second source of truth.
  - Stable endpoint delivery Context reuse already exists in `getOrCreatePulseDeliveryContext`; the change should strengthen its preconditions, not replace it.
- Alternatives considered and rejected:
  - Validate missing Pulse Scope only in `firePulse`: rejected because acceptance requires invalid Pulse configuration to be rejected and because bad persisted Pulses would fail later and noisily.
  - Always require Pulse Scope even for explicit unscoped Context subscribers: rejected because docs and issue #44 intentionally allow appends to valid actor-anchored unscoped Contexts where no generated stream is created.
  - Add synthetic Pulse/Webhook actors to anchor actorless streams: rejected by trigger tests and domain model; triggers remain source-null.
  - Let webhook request payload carry arbitrary `scope_id`: rejected by ADR-0004 route/source ownership rule.
  - Create new delivery Context per fire to avoid schema migration: rejected by acceptance and existing stable delivery Context tests.

## Regression checklist

- Behavior: actor-origin `submitEvent` and `resolveContext` behavior remains unchanged for participant-gated actor messages.
- Behavior: Events continue deriving `scope_id` from owning Context, including `null` for unscoped actor Contexts.
- Behavior: trigger-created operational Contexts without explicit Context reject when no real Scope is supplied.
- Behavior: webhook ingest without configured Scope rejects and persists no Event/Context.
- Behavior: webhook ingest with configured Scope creates scoped source-null target-only Events and Contexts.
- Behavior: Pulse Context Subscribers append `pulse.fired` to exactly the supplied Context, create no delivery, add no synthetic participants, and may remain unscoped for valid actor Context anchors.
- Behavior: Pulse Endpoint Subscribers with explicit valid Context deliver in that Context and inherit that Context Scope; unscoped use is allowed only when the target endpoint is a participant and no generated Context is created.
- Behavior: Pulse Endpoint Subscribers without explicit Context require real Scope and reuse one stable generated scoped delivery Context per Pulse + subscriber key across fires and deletion/recreation.
- Behavior: unknown explicit Scope and unknown explicit Context reject without persisting Pulse/Event/Context rows.
- Behavior: `scope_id=default` queries do not act as catch-all, and no new row receives hidden Default Scope.
- Behavior: bridge `EventEnvelope.scope_id` remains nullable-compatible; bridge/worklog stale default fallbacks are not used as bus behavior.

## Test plan

- Existing tests to keep green:
  - `floe-bus\src\contexts\trigger.test.ts`
  - `floe-bus\src\pulse-scope-propagation.test.ts`
  - `floe-bus\src\pulse-subscribers.test.ts`
  - `floe-bus\src\server.test.ts`
  - `floe-bus\src\delivery-symmetry.test.ts`
  - `floe-bus\src\scopes-server.test.ts`, `floe-bus\src\scope-propagation.test.ts`, and `floe-bus\src\scope-projection.test.ts` for no Default Scope regression.
  - Relevant bridge tests if returned Pulse records can now have `scope_id: null`: `floe-bridge\src\tools\pulse-tools.test.ts`, `floe-bridge\src\adapters\pi-agent-core-adapter.test.ts`, and `floe-bridge\src\runtime-core\worklog.test.ts`.
- New tests to add before/with implementation:
  - Pulse append: creating a Pulse with only a Context Subscriber pointing at a valid unscoped actor Context succeeds; firing appends `pulse.fired` with `scope_id: null`, no delivery, no synthetic participants.
  - Pulse delivery explicit context: endpoint subscriber with explicit valid unscoped actor Context succeeds only when target endpoint participates; fired event is source-null, delivered to endpoint, and remains `scope_id: null`.
  - Pulse delivery generated context: endpoint subscriber without `context_id` and without explicit/derived Scope rejects at Pulse creation and persists no Pulse.
  - Pulse delivery generated context: endpoint subscriber without `context_id` and with real Scope reuses the same generated scoped Context across fires and after deletion/recreation; Context `scope_id` remains the real Scope.
  - Mixed subscribers: a Pulse with a generated endpoint subscriber and unscoped Context Subscriber still requires real Scope because one subscriber creates a generated operational Context; Context Subscriber event still inherits its Context Scope/null.
  - Webhook intake: `ingestWebhook`/HTTP route without configured Scope rejects; with configured Scope creates scoped source-null target-only Context/Event; if route-level explicit Context anchors are added later, actor-anchored unscoped use is tested separately.
  - Invalid actorless+scopeless flow setup: direct `emitTriggerEvent` without `context_id`/`scope_id`, Pulse config requiring generated delivery Context without Scope, and webhook without configured Scope all reject with `scope_required` and leave no persisted rows.
  - Explicit invalid Context anchor: Pulse subscriber/current Context referencing missing or wrong-workspace Context rejects; endpoint subscriber referencing unscoped Context that does not include target endpoint rejects.
  - Schema/migration: if `pulses.scope_id` becomes nullable, old scoped Pulse rows survive, unscoped explicit-anchor Pulse rows return `scope_id: null`, and `/v1/pulses?scope_id=...` returns only real scoped Pulses.
- Live proof required:
  - Run targeted bus tests after implementation: `npm --prefix floe-bus test -- pulse-subscribers pulse-scope-propagation contexts/trigger server delivery-symmetry` or equivalent Vitest filters.
  - Run `npm --prefix floe-bus test` if schema migration or shared BusStore logic changes broadly.
  - Start the bus and perform live API checks: register Workspace/endpoints; create unscoped actor Context via actor event; create/fire Pulse with Context Subscriber anchored to that Context; verify `scope_id: null` and no delivery; attempt endpoint-generated Pulse without Scope and verify `scope_required`; create real Scope and endpoint-generated Pulse and verify stable generated scoped Context across two fires; call webhook without configured Scope and verify rejection.
  - If bridge-facing types change, run relevant bridge tests and one live bridge delivery/worklog path to confirm nullable Scope is not rendered as `default`.

## Risk assessment

- Risk: Allowing unscoped explicit-Context Pulses may require making `pulses.scope_id` nullable; partial migration could break Pulse listing, scheduler hydration, or Scope Projection assumptions.
- Risk: Tightening Pulse configuration may reject previously accepted local Pulses from bridge tools/extensions that omitted Scope and relied on current fallback rejection/error text; surface clear `scope_required` reasons.
- Risk: Endpoint subscriber explicit Context validation can reveal existing invalid test fixtures or user configs where the delivery target is not a Context participant.
- Risk: If validation happens only at fire time, invalid persisted Pulses may remain active and repeatedly log errors; validate at creation and defensively at fire.
- Risk: `emitTriggerEvent` is shared by Pulse and webhook paths; over-tightening explicit Context logic could break allowed trigger append to valid unscoped actor Contexts.
- Risk: Bridge/runtime stale `default` assumptions may mask or mislabel nullable Scope in live QA even when bus behavior is correct.
- Mitigation:
  - Keep validation helpers narrow and covered by direct BusStore tests.
  - Preserve existing stable delivery Context mapping and existing Event Scope derivation.
  - Add migration/listing tests if `pulses.scope_id` is relaxed.
  - Run full `floe-bus` tests and relevant bridge tests after implementation.

## Decision confidence

- Confidence: medium-high
- Reasons:
  - Ownership and extension points are clear: `BusStore` and `ContextStore` already own the relevant behavior, and current tests cover most paths.
  - Issue #43 already implemented nullable Context/Event Scope and removed Default Scope fallback, so issue #44 is a focused refinement of Pulse configuration and explicit Context validation.
  - Confidence is not full high because persisting intentionally unscoped explicit-Context-only Pulses conflicts with current `pulses.scope_id TEXT NOT NULL`, so implementation must choose between nullable Pulse Scope and a separate anchor classification.
- Open questions:
  - Resolved for implementation: a Pulse with only explicit unscoped Context anchors persists with `pulses.scope_id = null`; no separate anchor metadata is introduced in this slice.
  - Resolved for implementation: Endpoint Subscribers with explicit unscoped Context must target an endpoint that already participates in that Context.
  - Resolved for implementation: this slice keeps webhook work to enforcement plus store-level configured Scope support; it does not add a persisted webhook route registry/API.
