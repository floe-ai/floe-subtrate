# Architecture Integration Brief: issue-38-39-stable-endpoint-pulse-delivery-contexts

## Existing ownership

- Package/component/module/library:
  - `floe-bus\src\server.ts` owns HTTP Pulse API validation, scheduler registration, and `firePulse(...)` orchestration.
  - `floe-bus\src\store.ts` / `BusStore` owns durable Pulse records, `pulse_subscribers`, endpoint resolution, event insertion, event queueing, delivery bundle creation, context deletion side effects, and Scope resolution.
  - `floe-bus\src\contexts\store.ts` / `ContextStore` owns Context rows, `context_participants`, context creation/list/get APIs, and Context Scope storage.
  - `floe-bus\src\scopes\projection.ts` owns Scope Projection: Context and Pulse refs plus derived relationships; Events and Activity intentionally remain empty top-level refs.
  - `floe-bridge\src\tools\pulse-tools.ts` owns agent-facing Pulse creation guidance and forwards `current_context_id` so bus can derive Pulse `scope_id`.
- Current owner rationale:
  - Scheduler firing is initiated by `PulseScheduler` callback in `server.ts`, but storage and canonical event/delivery behavior are already BusStore responsibilities.
  - Stable generated delivery Context identity is persistence/routing state for Pulse endpoint delivery, so it belongs in the bus/store layer, not FloeWeb, bridge tools, or generic trigger emission.
  - `ContextStore.createContext(...)` already supports caller-provided `context_id`, `scope_id`, and participant set, so generated Context creation should reuse that API.
- Source evidence:
  - `floe-bus\src\server.ts:826-828` wires `PulseScheduler` to `firePulse(...)`.
  - `floe-bus\src\server.ts:830-895` validates `/v1/pulses` and delegates to `store.createPulse(...)`.
  - `floe-bus\src\server.ts:979-1055` currently loops subscribers and calls `appendContextEvent(...)` for context subscribers or `emitTriggerEvent(...)` for endpoint subscribers.
  - `floe-bus\src\store.ts:328-355` defines `pulses` and `pulse_subscribers`.
  - `floe-bus\src\store.ts:878-925` creates trigger Events and queues endpoint delivery through existing event queue semantics.
  - `floe-bus\src\contexts\store.ts:76-103` creates Contexts with optional supplied `context_id`.
  - `floe-bus\src\scopes\projection.ts:84-116` derives Scope Projection from Contexts and Pulses only.

## Existing interaction model

- User/system behaviors that already exist:
  - Context Subscriber: requires explicit `context_id`, appends `pulse.fired` to that Context as `{ kind: "context" }`, and creates no endpoint delivery.
  - Endpoint Subscriber with explicit `context_id`: resolves `endpoint_ref`, emits `pulse.fired` with destination `{ kind: "endpoint" }`, stores the Event in the explicit Context, and queues delivery.
  - Endpoint Subscriber without `context_id`: currently calls `emitTriggerEvent(...)` with `context_id: null`, so `emitTriggerEvent(...)` creates a fresh target-only Context per fire in the Pulse's `scope_id`.
  - Generated trigger Contexts are target-only: `created_by_endpoint_id = target_endpoint_id`, participants `[target_endpoint_id]`, `source_endpoint_id = null`, and no synthetic `system:*` endpoint.
  - Delivery remains event-queue based: inserted endpoint Events go through `queueEvent(...)`, endpoint status updates, and delivery bundles/bridge claiming.
  - Pulse `scope_id` is resolved at creation from explicit `scope_id`, active `current_context_id`, or Default Scope.
  - Event `scope_id` is derived from the Event's Context at insert time; Context Scope is authoritative for Scope Projection.
  - Context deletion deletes that Context's Events, queue rows, delivery bundle entries, participants, and existing Pulse subscribers that explicitly reference the deleted `context_id`.
  - Scope Projection shows Context and Pulse refs plus `pulse_subscribers`; it does not render Events or Activity as Field-level refs.
- Behaviors that must remain unchanged:
  - Context Subscribers stay render-only and explicit-Context-only.
  - Endpoint Subscribers with explicit `context_id` continue to use that explicit Context and keep current deletion behavior.
  - Endpoint delivery must continue through `emitTriggerEvent(...)`, `insertEvent(...)`, `resolveDestinations(...)`, and `queueEvent(...)`; do not enqueue manually.
  - Webhook trigger behavior remains one Context per ingest; do not change generic no-context trigger emission globally.
  - Generated Pulse delivery Contexts use the Pulse organising `scope_id`, not subscriber Context Scope (because there is no explicit subscriber Context).
  - Multiple endpoint subscribers must not be collapsed into one group Context unless the Pulse explicitly supplies shared `context_id`.
  - Deleting a generated delivery Context must not delete/cancel the Pulse or remove the endpoint subscriber.
  - Historical flooded Contexts are left untouched.
  - Scope Projection remains Context/Pulse only; Events/Activity remain Context history.
- Runtime or UX evidence:
  - `pulse-subscribers.test.ts:65-116` protects Context Subscriber render-only semantics.
  - `pulse-subscribers.test.ts:118-163` protects explicit endpoint `context_id` delivery semantics.
  - `pulse-subscribers.test.ts:165-242` protects mixed subscriber isolation and no synthetic participants.
  - `pulse-scope-propagation.test.ts:155-260` protects Pulse `scope_id` derivation.
  - `pulse-scope-propagation.test.ts:262-372` protects subscriber Context Scope vs Pulse Scope behavior.
  - `contexts\trigger.test.ts:51-78` protects target-only trigger Contexts and null source.
  - `scope-projection.test.ts:135-182` and `234-313` protect Context/Pulse-only Scope Projection.
  - `floe-web\src\scope-projection.test.ts:68-101` protects that FloeWeb renders top-level Context and Pulse refs, not Event/Activity/actor containment nodes.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a BusStore-owned Pulse delivery Context resolver, e.g. `getOrCreatePulseDeliveryContext(...)`, rather than embedding persistence logic directly in `firePulse(...)`.
  - Reuse `ContextStore.createContext(...)` for generated Context creation, passing explicit generated `context_id`, Pulse `scope_id`, `created_by_endpoint_id: endpointId`, and `participants: [endpointId]`.
  - Reuse `emitTriggerEvent(...)` by passing the resolved generated `context_id`; this preserves Event insertion, Scope derivation from Context, destination resolution, queueing, broadcast, and bridge delivery.
  - Reuse `resolveSubscriberEndpointId(...)` for endpoint delivery target resolution.
  - Reuse existing migration convention in `BusStore.applySchema(...)`: create tables with `CREATE TABLE IF NOT EXISTS` and add indexes during startup.
- Relevant docs or library capabilities:
  - `CONTEXT.md:55-63` defines Context Subscriber vs Endpoint Subscriber and the stable generated delivery Context rule.
  - `CONTEXT.md:127-140` defines Scope/Context/Pulse/Event relationships and confirms endpoint subscribers without explicit `context_id` use a stable generated Context.
  - `docs\ROADMAP.md:62-66` defines Pulse as scheduled event creation with subscriber kind determining render/delivery/processing behavior.
  - `docs\ROADMAP.md:174-188` requires Pulse and Context Scope propagation without Field-owned membership.
  - GitHub #37/#38/#39 acceptance criteria require stable per Pulse + endpoint subscriber Contexts, deletion/recreation, no migration, and existing explicit semantics.
- Existing examples in this codebase:
  - `BusStore.createPulse(...)` persists Pulse + subscribers and resolves `scope_id`; add generated delivery mapping near this Pulse CRUD area.
  - `BusStore.deleteContext(...)` already handles deletion side effects centrally; generated delivery mapping must be deliberately preserved or tombstoned there, not handled in UI.
  - `ContextStore.createContext(...)` already accepts stable caller-provided IDs; deterministic generated IDs can avoid per-fire random Contexts without adding a second Context creation path.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass `emitTriggerEvent(...)`, `insertEvent(...)`, `resolveDestinations(...)`, `queueEvent(...)`, delivery bundles, or bridge claim flow.
  - Do not create Events directly from `server.ts`.
  - Do not create a parallel Context store or Field-owned membership list.
  - Do not replace Scope Projection with FloeWeb-specific derivation.
  - Do not synthesize `system:*`, `pulse:*`, webhook, human/agent/user/bot typed endpoints, or actor categories.
- Shortcuts or parallel paths to avoid:
  - Do not change generic `emitTriggerEvent(...)` no-context behavior; webhook ingest must still create one Context per ingest.
  - Do not make endpoint subscribers share one Context per Pulse by default.
  - Do not mutate endpoint subscribers by filling in generated `context_id`; that would make generated state look explicit and interfere with deletion semantics.
  - Do not delete/cancel a Pulse, remove its endpoint subscriber, or migrate historical flooded Contexts when a generated Context is deleted.
  - Do not introduce Field membership, Event nodes, Activity nodes, or broader FloeWeb redesign in #38/#39.
- Invariants:
  - Context Subscriber = render-only append to explicit Context.
  - Endpoint Subscriber = endpoint delivery and optional processor activation.
  - Explicit `context_id` wins.
  - No explicit `context_id` = stable generated Context per Pulse + endpoint subscriber configuration.
  - Generated Context `scope_id` = Pulse organising `scope_id`.
  - Generated Context participant set remains target-only unless a later approved design changes trigger participation.
  - Scope Projection remains Context/Pulse only.

## Integration plan

- Insert the change at:
  - Add a BusStore-owned generated delivery Context resolver close to Pulse CRUD in `floe-bus\src\store.ts`.
  - Add schema for a small bus-owned mapping table, recommended name `pulse_delivery_contexts`, in `BusStore.applySchema(...)`.
  - Change only the endpoint-subscriber/no-explicit-`context_id` branch of `firePulse(...)` in `floe-bus\src\server.ts` to resolve a generated Context before calling `emitTriggerEvent(...)`.
  - Keep Context Subscriber and explicit endpoint `context_id` branches structurally unchanged.
- Why this is the correct integration point:
  - Stable generated Context identity is durable bus routing state, not a server-only scheduling detail and not a FloeWeb projection concern.
  - A BusStore resolver can own SQLite transactions, deterministic keys, Scope validation, generated Context recreation, and tests through public store/API seams.
  - `firePulse(...)` remains the scheduler subscriber loop, while `emitTriggerEvent(...)` remains the canonical trigger event/delivery path.
- Alternatives considered and rejected:
  - Server-only `firePulse(...)` logic: rejected because it would put persistence/key generation in the scheduler layer and be harder to test without driving time.
  - Changing generic `emitTriggerEvent(...)` to reuse trigger Contexts: rejected because it would affect webhook and future trigger kinds that intentionally create fresh target-only Contexts.
  - Mutating stored subscriber JSON to include generated `context_id`: rejected because generated Contexts must remain distinct from explicit subscriber Contexts, and deletion of explicit-context subscribers currently removes subscribers.
  - One group Context per Pulse: rejected by domain decision; each endpoint subscriber gets its own generated Context by default.
  - Pure deterministic ID with no mapping table: possible but less inspectable and more fragile if subscriber-key derivation changes. It also leaves no clear bus-owned origin record for debugging.
- Recommended data model strategy:
  - Add `pulse_delivery_contexts` with at least:
    - `pulse_id TEXT NOT NULL`
    - `subscriber_key TEXT NOT NULL`
    - `context_id TEXT NOT NULL`
    - `workspace_id TEXT NOT NULL`
    - `endpoint_ref TEXT NOT NULL`
    - `endpoint_id TEXT NOT NULL`
    - `created_at TEXT NOT NULL`
    - `updated_at TEXT NOT NULL`
    - primary key `(pulse_id, subscriber_key)`
    - index on `context_id`
  - `subscriber_key` should be a stable canonical hash over the Pulse endpoint subscriber configuration for generated delivery, not raw `JSON.stringify(...)` insertion order. Include at least `kind: "endpoint"`, the configured `endpoint_ref`, and absence of explicit `context_id`; do not include fire number or schedule time. Prefer sorted-key canonical JSON then hash.
  - `context_id` should be deterministic and bounded, e.g. `ctx_pulse_${hash(workspace_id + "\0" + pulse_id + "\0" + subscriber_key)}`, so recreation after deletion and scheduler restarts cannot create duplicate live generated Contexts. The mapping table makes the origin inspectable and gives a stable lookup seam.
  - Resolver algorithm:
    1. Accept `pulse_id`, `workspace_id`, Pulse `scope_id`, endpoint subscriber, and resolved `endpoint_id`.
    2. Reject/skip if subscriber has explicit `context_id`; caller should use explicit branch.
    3. Compute canonical `subscriber_key` from subscriber configuration.
    4. Look up mapping `(pulse_id, subscriber_key)`.
    5. If mapping exists and `ContextStore.getContext(context_id)` exists in the same workspace, return it.
    6. If mapping missing, insert mapping with deterministic `context_id`.
    7. If Context row missing, create it with Pulse `scope_id`, `created_by_endpoint_id: endpoint_id`, and participants `[endpoint_id]`.
    8. Return `context_id`.
  - Deletion/recreation behavior:
    - Do not add cascade/FK behavior that deletes the mapping row when the Context is deleted.
    - `deleteContext(...)` may leave `pulse_delivery_contexts` rows intact. On later fire, resolver sees the missing Context and recreates it.
    - Because the generated endpoint subscriber itself has no `context_id`, existing `deleteContext(...)` logic that deletes explicit `pulse_subscribers` by `subscriber.context_id` will not remove it.
    - Recreated Context should use the same deterministic `context_id` if available; if implementation chooses a new random ID, it must update mapping and prove no duplicate live Context remains, but deterministic ID is preferred.

## Regression checklist

- Behavior: Context Subscribers still append `pulse.fired` to explicit Contexts, create no endpoint delivery, and do not activate endpoints.
- Behavior: Endpoint Subscribers with explicit `context_id` keep using that Context, queue endpoint delivery, and keep current context deletion behavior.
- Behavior: One endpoint subscriber without explicit `context_id` receives repeated fires as multiple `pulse.fired` Events in one generated Context.
- Behavior: Multiple endpoint subscribers without explicit `context_id` receive separate generated Contexts, not a shared group Context.
- Behavior: Generated delivery Contexts use the Pulse `scope_id`; resulting Events derive the same Scope from their Context.
- Behavior: Generated trigger Contexts remain source-null and target-only with no synthetic participants/endpoints.
- Behavior: Endpoint delivery still goes through event_queue, delivery_bundles, bridge claim, and endpoint status transitions.
- Behavior: Deleting a generated Context deletes its history/deliveries as today but does not cancel the Pulse or remove the endpoint subscriber; a later fire recreates a usable generated Context.
- Behavior: Historical flooded Contexts are not migrated, hidden, merged, or deleted.
- Behavior: Scope Projection continues to return Context/Pulse refs only, with Events/Activity as empty top-level refs.
- Behavior: Webhook ingest continues one Context per ingest.
- Behavior: Agent-facing Pulse tool guidance remains: Context Subscribers for current-conversation reminders; Endpoint Subscribers for scheduled actor work.

## Test plan

- Existing tests to keep green:
  - `npm run test --workspace floe-bus -- pulse-subscribers.test.ts`
  - `npm run test --workspace floe-bus -- pulse-scope-propagation.test.ts`
  - `npm run test --workspace floe-bus -- contexts\trigger.test.ts`
  - `npm run test --workspace floe-bus -- scope-projection.test.ts`
  - `npm run test --workspace floe-bridge -- pulse-tools.test.ts`
  - `npm run test --workspace floe-web -- scope-projection.test.ts contexts.test.ts`
- New tests to add before/with implementation:
  - Bus/API test: create a recurring or manually re-fired Pulse with one endpoint subscriber omitting `context_id`; prove two fires create two `pulse.fired` Events with the same `context_id` and only one generated Context row.
  - Bus/API test: same Pulse with two endpoint subscribers omitting `context_id`; prove each endpoint gets its own stable generated Context across repeated fires.
  - Bus/API test: explicit endpoint subscriber `context_id` remains authoritative and does not create `pulse_delivery_contexts` mapping.
  - Bus/API test: Context Subscriber remains render-only and creates no endpoint delivery.
  - Scope test: generated delivery Context uses Pulse `scope_id`; Scope Projection gains the generated Context once, and repeated fires do not add more Context refs.
  - Deletion test for #39: delete the generated Context through `DELETE /v1/contexts/:id`, assert Pulse remains active (or completed/active according to trigger schedule, but not deleted/cancelled), subscriber remains stored, later fire recreates Context in Pulse Scope, receives later `pulse.fired`, and queues endpoint delivery normally.
  - Store-level key test: semantically equivalent endpoint subscriber objects produce stable `subscriber_key` independent of property insertion order.
  - Regression test: webhook `emitTriggerEvent(...)` / `ingestWebhook(...)` still creates a fresh Context per ingest.
- Live proof required:
  - For #40 later: run a real bus/FloeWeb path with a recurring endpoint Pulse without explicit `context_id`; capture repeated fires, one stable generated delivery Context in Field/Scope Projection, one conversation/work stream rather than per-fire flood, and delivery claim/log evidence.
  - For #38/#39 automated slice: live UI redesign is not required, but include API/log evidence from public seams if possible.

## Risk assessment

- Risk: Scheduler idempotency or overlapping fires could race to create the same generated Context.
  - Mitigation: deterministic `context_id`, unique mapping primary key, transaction around mapping/context creation, and create-if-missing checks.
- Risk: Subscriber JSON stability could create duplicate generated Contexts when property order differs.
  - Mitigation: use sorted canonical subscriber key, not raw `json(subscriber)`/`JSON.stringify(...)`, for generated mapping identity.
- Risk: Endpoint reference aliases (`floe`, `agent:floe`, full endpoint id) could resolve to the same endpoint but produce different generated Contexts.
  - Mitigation: define identity as Pulse + endpoint subscriber configuration, so configured `endpoint_ref` is part of the key; keep delivery target resolution via `resolveSubscriberEndpointId(...)` per fire. If product wants endpoint-id coalescing later, that is a separate design decision.
- Risk: Context participant set could accidentally change FloeWeb conversation visibility or actor-neutral semantics.
  - Mitigation: preserve current trigger participant model: generated Context has only target endpoint participant and null source; do not add operator/system participants in this slice.
- Risk: Generated Context Scope could drift if event `scope_id` is supplied directly rather than derived from Context.
  - Mitigation: create Context with Pulse `scope_id`, then call `emitTriggerEvent(...)` with that `context_id`; `insertEvent(...)` derives `scope_id` from `contextScopeId(...)`.
- Risk: Deleting generated Context could leave a stale mapping.
  - Mitigation: resolver must treat mapping as a pointer, verify Context existence every fire, and recreate when missing. Stale mapping is expected and not a Pulse cancellation signal.
- Risk: Existing `deleteContext(...)` removes pulse subscribers with explicit `context_id`.
  - Mitigation: do not store generated `context_id` in subscriber JSON. This preserves explicit behavior and prevents generated deletion from removing endpoint subscriptions.
- Risk: Backwards compatibility with old flooded Contexts.
  - Mitigation: no automatic migration/cleanup; new behavior only affects future fires after implementation.
- Risk: Scope Projection could show generated Context plus Pulse relationship unexpectedly.
  - Mitigation: generated Context belongs in Context refs because it is a real Context; do not project Events/Activity or invent new generated-context node kinds.
- Risk: Code/docs conflict around actor conversation list flooding.
  - Mitigation: current bus trigger tests show target-only participants, while `floe-web\src\contexts.ts` filters selected actor conversations by operator + actor participants. Do not change participant semantics to chase list visibility in #38/#39; validate live behavior in #40 and file a UI follow-up if needed.

## Decision confidence

- Confidence: high
- Reasons:
  - Existing code has clear owners: `server.ts` schedules/fires, `BusStore` persists/queues, `ContextStore` creates Contexts, Scope Projection derives Context/Pulse refs.
  - The requested behavior can be implemented by resolving a stable Context before the existing `emitTriggerEvent(...)` call, preserving endpoint delivery and trigger invariants.
  - Existing tests already protect most non-target behaviors; missing tests are well-scoped and can be added around public bus/API seams.
  - A mapping table plus deterministic `context_id` satisfies stability across fires/restarts, inspectability, and deletion/recreation without changing subscriber semantics.
- Open questions:
  - None that should stop implementation.
  - Non-blocking follow-up for #40: confirm live FloeWeb conversation-list behavior, because current target-only generated trigger Contexts may not appear in the operator + selected actor filtered list despite the PRD wording about actor conversation flooding.

