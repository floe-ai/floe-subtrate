# Architecture Integration Brief: substrate-anchor-model-correction

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns persisted substrate truth for Workspaces, Scopes, Contexts, Events, Pulses, deliveries, and HTTP APIs.
  - `floe-bus\src\contexts\store.ts` owns Context schema, persistence, participant rows, list/filter helpers, and context metadata reads.
  - `floe-bus\src\contexts\resolver.ts` owns actor-to-actor context continuation/branching rules.
  - `floe-bus\src\scopes\store.ts` owns Scope persistence and the legacy Default Scope mechanism.
  - `floe-bus\src\store.ts` is the orchestration layer for Event, trigger, webhook, Pulse, and delivery flows.
  - `floe-bus\src\server.ts` is the public API boundary for events, contexts, scopes, pulses, webhooks, and delivery.
  - `floe-bridge\src\bus-client.ts`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts`, `floe-bridge\src\runtime-core\worklog.ts`, and `floe-bridge\src\tools\pulse-tools.ts` consume bus semantics in runtime tools, runtime turn state, delivery prompts, telemetry, worklogs, and pulse creation.
  - `floe-web` consumes Context and Scope projection APIs; it must not become the owner of Scope membership or substrate anchoring.
- Current owner rationale:
  - The Bus already centralises all authoritative persistence and validation before events, contexts, pulses, and deliveries are visible to bridge/runtime/web consumers.
  - The Context resolver already encodes participant-aware actor interaction and should remain the only actor-to-actor context decision point.
  - Scope projection already treats a Scope as a queryable projection over bus-owned records, not as a FloeWeb-owned Field model.
- Source evidence:
  - Current product/domain source of truth says Workspace is the top-level boundary; actors are Workspace-scoped; Context may be unscoped when actor participants exist; actorless Context requires Scope; Default Scope is superseded and is not preserved as product behavior; Workspace Home is not a Scope: `CONTEXT.md`, `PRODUCT.md`, `docs\adr\0004-scope-as-substrate-organising-boundary.md`.
  - ADR conflict resolved in issue #42: `docs\adr\0004-scope-as-substrate-organising-boundary.md` now explicitly supersedes the "every Workspace has Default Scope" invariant.
  - Stale code evidence:
    - `floe-bus\src\contexts\store.ts` currently types and stores `ContextRecord.scope_id` as non-null and defaults missing values to `"default"`.
    - `floe-bus\src\scopes\store.ts` exports `DEFAULT_SCOPE_ID`, `ensureDefaultScope`, and `is_default` persistence.
    - `floe-bus\src\store.ts` imports `DEFAULT_SCOPE_ID` and falls back to `ensureDefaultScope` in `resolveScopeId`; `EventEnvelope.scope_id` is non-null; event/pulse schemas are non-null/defaulted; trigger/webhook/pulse flows create/derive default scopes.
    - `floe-bus\src\server.ts` accepts nullable optional `scope_id` in event/pulse payloads but hands them to store logic that currently resolves null to default.
    - `floe-bridge\src\adapters\pi-agent-core-adapter.ts` `RuntimeTurnContext.scope_id` and worklog `scope_id` are non-null and fallback to `"default"`.

## Existing interaction model

- User/system behaviors that already exist:
  - Actor-to-actor emits use `/v1/events/emit`; the bus resolver either continues an explicit/current Context or opens a new Context with source/destination participants.
  - Explicit `context_id` is participant-gated; non-participant emits are rejected by the resolver rather than silently mutating Context participants.
  - Explicit `scope_id` is currently validated when present.
  - Context-scoped reads use `/v1/contexts`, `/v1/contexts/:id`, and `/v1/contexts/:id/events`.
  - Scope projection reads contexts and pulses by `scope_id`; FloeWeb calls Scope Projection APIs and explicitly avoids legacy Field endpoints.
  - Pulses may subscribe to a Context, an endpoint with an existing Context, or an endpoint that requires a generated pulse delivery Context.
  - Webhook ingest and pulse fires are bus-originated triggers with `source_endpoint_id = null`; they intentionally do not synthesize `system:*`, `pulse:*`, or `webhook:*` participants.
- Behaviors that must remain unchanged:
  - Context participant gating and branch/continue behavior in `resolveContext` must remain authoritative for actor-to-actor emits.
  - Context participants must remain immutable through event emission; no add/remove participant shortcut should appear.
  - Existing explicit scoped Context/Event/Pulse behavior must keep working when a real Scope is supplied.
  - Unknown explicit Scope ids must still reject before creating Contexts, Events, or Pulses.
  - Existing Context Scope remains authoritative when appending to an existing scoped Context.
  - Trigger-origin events must keep `source_endpoint_id = null`; do not introduce synthetic system endpoints to satisfy anchoring.
  - FloeWeb must continue consuming Scope Projection APIs and must not own, infer, or mutate Scope membership.
- Runtime or UX evidence:
  - `floe-bus\src\contexts\resolver.ts` defines rule 1 explicit context validation, rule 2 continuation when destination participates, and rule 3 new Context creation.
  - `floe-bus\src\contexts\integration.test.ts` covers participant-aware emits, rejection, immutable participants, explicit continuation, UI-originated new Contexts, and persisted `context_id`.
  - `floe-bus\src\scope-propagation.test.ts` currently proves explicit Scope propagation, Context Scope authority, unknown Scope rejection, and scope filters, but also contains stale Default Scope fallback expectations.
  - `floe-bus\src\pulse-scope-propagation.test.ts` proves pulse Scope/query behavior and trigger delivery behavior, but also encodes stale default fallback for pulses.
  - `floe-bus\src\contexts\trigger.test.ts` proves trigger events have null source and target-only participants, but currently expects webhook trigger Scope `"default"`.
  - `floe-web\src\scope-projection-api.test.ts` proves FloeWeb uses Scope Projection APIs and not legacy Field endpoints.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use `ContextStore.createContext`, `getContext`, `listContextsForParticipant`, `listContextsForScope`, and participant helpers as the persistence extension point.
  - Use `resolveContext` only for actor-origin Event commands.
  - Use `BusStore.submitEvent`, `emitTriggerEvent`, `appendContextEvent`, `ingestWebhook`, `createPulse`, and `getOrCreatePulseDeliveryContext` as the integration points for anchor validation.
  - Use `ScopeStore.getScope/createScope/listScopes/updateScope` for explicit Scope validation and metadata. Do not preserve legacy Default Scope behavior; any stale `"default"` data must be migrated, rejected, or explicitly assigned to a real Scope under the corrected anchor rules.
  - Use server zod schemas as the public validation boundary for distinct failure modes, not ad-hoc downstream errors.
  - Use bridge `BusClient` types and pi adapter `RuntimeTurnContext` as downstream consumers of nullable Scope semantics.
- Relevant docs or library capabilities:
  - Current docs establish the target model: Workspace top-level; Scope optional for actor Contexts; actorless Contexts require Scope; Default Scope is superseded; Workspace Home is index/dashboard, not a Scope.
  - SQLite migrations are currently performed imperatively in store schema helpers; nullable-column and backfill changes should follow that convention.
  - Zod is already the HTTP shape validator in `server.ts`.
- Existing examples in this codebase:
  - `scope_id` API payloads already accept `null`/optional in `server.ts` for events and pulses, so public shapes can be tightened without inventing new endpoints.
  - `ContextNotFoundError` and `ScopeNotFoundError` already provide API-specific error handling patterns.
  - `pulse-tools.ts` already says no Default Scope is invented in its tool description, but current bus behavior contradicts that text.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate `resolveContext`; modify/store-anchor around it.
  - Do not create a second Context table, Scope membership table, or web-owned Field/Scope membership model.
  - Do not replace Scope Projection with FloeWeb-local graph state.
  - Do not bypass `ContextStore` for Context creation or participants.
  - Do not synthesize system/pulse/webhook endpoints as source actors.
  - Do not bypass server zod schemas or BusStore transactions.
- Shortcuts or parallel paths to avoid:
  - Do not silently map null/missing `scope_id` to `"default"` for new actor Contexts, Events, Pulses, webhooks, or worklogs.
  - Do not keep Default Scope as a user-visible Workspace Home substitute.
  - Do not make actor Context validity depend on a Scope just to satisfy old indexes.
  - Do not let bridge/runtime invent `"default"` when an event/context is unscoped.
  - Do not make pulse endpoint subscribers always create a Scope; require either explicit valid Scope or append to an explicit valid unscoped actor Context according to the source-of-truth rules.
- Invariants:
  - Workspace is the top-level boundary.
  - Actors are Workspace-scoped, not Scope-scoped.
  - Valid Context shapes are:
    - actor participants with `scope_id = null`;
    - Scope with no actor participants;
    - Scope plus actor participants.
  - Invalid Context shape is no Scope and no actor participants.
  - Actor-origin Events may have `scope_id = null` when their owning Context is an unscoped actor Context.
  - Actorless Contexts require non-null valid `scope_id`.
  - Pulse/webhook/event-source flows require Scope unless appending to an explicit valid unscoped actor Context.
  - Scope Projection only includes scoped records. Unscoped actor Contexts belong to workspace/actor views, not to a fake default Scope projection.
  - Worklogs/telemetry must represent unscoped as null/absent/unscoped text, not `"default"`.

## Integration plan

- Insert the change at:
  1. Update domain docs conflict first or alongside implementation:
     - Amend/supersede `docs\adr\0004-scope-as-substrate-organising-boundary.md` to remove "every Workspace has Default Scope" as a current invariant.
  2. Make schema/types nullable at the bus substrate core:
     - `floe-bus\src\contexts\store.ts`: `ContextRecord.scope_id: string | null`; `CreateContextInput.scope_id?: string | null`; schema/migration must allow null; reads must not coalesce null to default.
     - `floe-bus\src\store.ts`: `EventEnvelope.scope_id: string | null`; events table `scope_id` nullable; pulses table decision should be explicit (see pulse rules below); row mappers must preserve null.
  3. Replace generic `resolveScopeId` fallback with explicit anchor resolution functions:
     - `validateExplicitScope(workspaceId, scopeId)` validates only non-null Scope ids.
     - `scopeForNewActorContext(command)` returns explicit valid Scope or null.
     - `scopeForExistingContext(contextId)` returns the owning Context's nullable Scope.
     - Trigger/pulse/webhook-specific resolvers must reject missing Scope unless appending to explicit valid unscoped actor Context.
  4. Keep `resolveContext` as-is for participant decisions, then pass anchor information into `ContextStore.createContext`.
     - New actor-origin Context with source/destination participants and no explicit Scope should be stored with `scope_id = null`.
     - Existing Context append should ignore mismatched optional `scope_id` after validating explicit Scope if supplied, preserving current "Context Scope authoritative" behavior.
  5. Update trigger flows:
     - `emitTriggerEvent` with explicit `context_id`: allow scoped or unscoped existing Context only after validating workspace; Event inherits the Context's nullable Scope.
     - `emitTriggerEvent` without `context_id`: require explicit valid `scope_id` because this creates an actorless/source-null target-only Context.
     - `ingestWebhook`: require a configured/explicit Scope route before creating a new trigger Context, or return a clear error. Do not call `ensureDefaultScope`.
  6. Update pulse flows:
     - `createPulse` should accept:
       - explicit valid `scope_id`;
       - `current_context_id` with a valid Context, inheriting its nullable `scope_id`;
       - no explicit/current Scope only when every subscriber appends to an explicit existing valid unscoped actor Context and no generated actorless/pulse delivery Context is needed.
     - Reject pulse creation when it would need a generated trigger/delivery Context without a Scope.
     - `firePulse` must not pass `(pulse as any).scope_id ?? "default"`; use the stored nullable anchor and enforce the above creation invariant.
     - `getOrCreatePulseDeliveryContext` should require non-null Scope for generated endpoint delivery Contexts, or use an explicit subscriber Context.
  7. Update bridge/runtime consumers:
     - `BusClient.EventEnvelope.scope_id` is already optional/nullable; make adapter `RuntimeTurnContext.scope_id` nullable or display-safe.
     - `startTurn`, telemetry, and worklog rendering should preserve null and render "unscoped" or omit Scope, not `"default"`.
     - `WorkLogEntry.scope_id` should be `string | null`; tests should prove unscoped worklogs are not labelled Default.
     - `pulse-tools.ts` should rely on bus results and surface rejected missing-anchor errors clearly.
  8. Update Scope Projection:
     - Types in `floe-bus\src\scopes\projection.ts` can remain non-null for projection refs because only scoped records should appear.
     - `listContextsForScope` and `listPulses({ scope_id })` should return only rows with that real Scope id; unscoped rows must not appear under `"default"`.
  9. Update API behavior:
     - `/v1/events?scope_id=...` filters real scoped events only.
     - `/v1/contexts?scope_id=...` filters real scoped contexts only.
     - `/v1/pulses?scope_id=...` filters real scoped pulses only.
     - Consider adding/using workspace or participant views to discover unscoped actor Contexts; do not overload Scope Projection for that.
- Why this is the correct integration point:
  - The incorrect model originates in bus persistence and BusStore fallback logic. Fixing only docs, bridge, or FloeWeb would leave persisted Events/Contexts/Pulses incorrectly anchored.
  - The bus is the only layer that can preserve invariants atomically across Context creation, Event insertion, Pulse persistence, and delivery.
  - Existing public APIs already expose nullable optional `scope_id`; this is a semantics correction rather than a new product surface.
- Alternatives considered and rejected:
  - Keep Default Scope but hide it in UI: rejected because Events, Contexts, Pulses, worklogs, and projections would still encode a false product concept and break unscoped actor Context semantics.
  - Treat Workspace Home as Default Scope: rejected by current docs; Workspace Home is an index/dashboard, not a Scope.
  - Let FloeWeb own unscoped/scoped membership: rejected because substrate anchoring is bus-owned and Scope Projection already consumes bus-owned state.
  - Add synthetic system actors for trigger flows: rejected because trigger tests and docs require source-null bus-origin events.

## Regression checklist

- Behavior: registering/selecting Workspaces does not expose, create, or depend on a user-visible Default Scope; stale `"default"` rows are not preserved as product behavior.
- Behavior: actor-to-actor emit without `scope_id` creates an unscoped Context/Event with participants and `scope_id = null`.
- Behavior: actor-to-actor emit with explicit valid `scope_id` creates scoped Context/Event.
- Behavior: actor-to-actor emit into existing Context preserves that Context's nullable Scope.
- Behavior: unknown explicit Scope rejects without persisting Context/Event/Pulse.
- Behavior: explicit Context participant gating remains unchanged.
- Behavior: webhook/pulse trigger creation without Scope rejects unless appending to explicit valid existing unscoped actor Context.
- Behavior: source-null trigger Events remain source-null and do not add synthetic participants.
- Behavior: Scope Projection excludes unscoped actor Contexts/Events/Pulses.
- Behavior: bridge runtime prompts, telemetry, and worklogs show unscoped accurately and never fallback to `"default"`.
- Behavior: FloeWeb continues using Scope Projection APIs and does not call legacy Field endpoints or own Scope membership.

## Test plan

- Existing tests to keep green:
  - `floe-bus\src\contexts\resolver.test.ts`
  - `floe-bus\src\contexts\integration.test.ts`
  - `floe-bus\src\contexts\trigger.test.ts` after updating stale Default Scope expectations.
  - `floe-bus\src\scope-propagation.test.ts` after replacing stale default fallback assertions with nullable unscoped assertions.
  - `floe-bus\src\scopes-server.test.ts` after replacing user-visible Default Scope assertions.
  - `floe-bus\src\pulse-scope-propagation.test.ts` after updating pulse anchor rules.
  - `floe-bus\src\scope-projection.test.ts` and layout server/store tests.
  - `floe-web\src\scope-projection-api.test.ts`, `floe-web\src\contexts.test.ts`, and Scope/Field UI tests.
  - `floe-bridge\src\tools\pulse-tools.test.ts`
  - `floe-bridge\src\adapters\pi-agent-core-adapter.test.ts`
  - `floe-bridge\src\runtime-core\worklog.test.ts`
- New tests to add before/with implementation:
  - Bus: actor emit without `scope_id` persists Context/Event `scope_id = null`.
  - Bus: actor emit with explicit Scope persists real Scope id.
  - Bus: actor emit into unscoped existing Context keeps Event `scope_id = null` even if no Scope supplied.
  - Bus: explicit unknown Scope still rejects before persistence.
  - Bus: actorless/source-null trigger without Scope and without explicit Context rejects with a clear code.
  - Bus: source-null trigger appended to explicit valid unscoped actor Context succeeds and keeps `scope_id = null`.
  - Bus: pulse creation without Scope/current Context rejects when it would generate a delivery Context.
  - Bus: pulse with context subscriber to unscoped actor Context succeeds and fired Event remains unscoped.
  - Bus: Scope Projection for a real Scope excludes unscoped rows and `/scope_id=default` does not act as a catch-all.
  - Bridge: delivery with null event/context Scope produces telemetry/worklog with null or "unscoped", never `"default"`.
  - Bridge pulse tool: omitted `scope_id` passes through only when bus can derive/validate a permitted anchor; rejection text is user-readable.
  - Migration: stale `"default"` rows are migrated, rejected, or explicitly assigned to a real Scope under the corrected anchor rules; new rows must not receive default.
- Live proof required:
  - Run relevant package tests after implementation.
  - Start the bus and perform live API checks:
    - register Workspace and actors;
    - emit actor-to-actor message without `scope_id`;
    - verify `/v1/contexts/:id` and `/v1/events` return `scope_id: null`;
    - create real Scope and emit scoped message;
    - verify Scope Projection includes scoped but not unscoped Context/Event;
    - attempt webhook/pulse trigger without Scope and verify rejection;
    - create a pulse anchored to an explicit unscoped actor Context and verify fired event/worklog semantics if scheduler path is in scope.
  - If FloeWeb is in scope for the implementation PR, use Playwright to verify Workspace Home and Field/Scope projection behavior: no Default Scope shown as Workspace Home, scoped Field renders real Scope projection, and unscoped actor Context remains reachable through actor/context UI rather than Field membership.

## Risk assessment

- Risk: nullable `scope_id` touches many TypeScript types, SQL columns, indexes, and tests; partial migration could cause runtime `null` crashes.
- Risk: legacy data containing `"default"` may be semantically ambiguous between old fallback and a real user-created Scope named default.
- Risk: trigger/pulse flows may lose a convenient fallback path and begin returning errors for previously accepted invalid commands.
- Risk: bridge worklogs/telemetry currently assume non-null Scope and may present misleading output or fail if not updated.
- Risk: Scope Projection users may expect all activity to appear somewhere; unscoped actor Contexts need an explicit workspace/actor discovery path.
- Mitigation:
  - Implement from the bus core outward: schema/types, resolver/orchestration, API errors, bridge consumers, web consumers.
  - Do not preserve legacy Default Scope behavior; prohibit new silent defaulting and handle stale `"default"` rows through explicit migration, rejection, or real Scope assignment.
  - Add explicit regression tests for every valid/invalid Context shape.
  - Keep trigger/pulse errors crisp and API-level, not low-level database errors.
  - Treat ADR-0004 as stale and update it in the same implementation slice so future agents do not reintroduce Default Scope.

## Decision confidence

- Confidence: high
- Reasons:
  - Current `CONTEXT.md` and `PRODUCT.md` are internally consistent and directly state the target substrate model.
  - The stale behavior is localisable to known bus fallback points and downstream non-null assumptions.
  - Existing tests already cover most interaction invariants; many need expectation changes rather than replacement.
  - Public API shapes already tolerate optional/nullable `scope_id`, reducing external contract churn.
- Issue #42 decisions:
  - Default Scope behavior does not need to be preserved. Stale `"default"` rows should be migrated, rejected, or explicitly assigned to a real Scope according to the corrected anchor rules.
  - Webhook and event-source Scope comes from source or route configuration, not arbitrary per-request caller override.
  - Unscoped actor Contexts are discoverable through Workspace Home, Actor views, and Context listing/filtering, never through a fake Default Field.
  - The Scope id `"default"` is reserved for stale cleanup/internal compatibility and must be forbidden for new user-created Scopes.
