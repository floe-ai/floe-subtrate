# Architecture Integration Brief: issue-23-pulse-persistence-scope-propagation

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns Pulse durable state, runtime scheduling, subscriber fanout, canonical `pulse.fired` creation, Event/Delivery queues, Context/Event Scope propagation, and public HTTP APIs (`floe-bus\src\store.ts:318-344`, `floe-bus\src\store.ts:1271-1446`, `floe-bus\src\server.ts:799-990`).
  - `floe-bus\src\scopes\store.ts` owns the bus Scope store/API spine and Default Scope semantics introduced by #21 (`floe-bus\src\scopes\store.ts:34-154`, `floe-bus\src\server.ts:162-228`).
  - `floe-bus\src\contexts\store.ts` and `floe-bus\src\contexts\resolver.ts` own Context records, participants, participant-aware context resolution, and Context Scope as the authoritative source for scoped communication state (#22) (`contexts\store.ts:5-184`, `contexts\resolver.ts:72-115`).
  - `floe-bridge` owns runtime embodiment, workspace `.floe/floe.yaml` loading/materialisation, extension pulse registration, agent-facing pulse tools, and forwarding active delivery context to bus event emits (`floe-bridge\src\daemon.ts:262-309`, `floe-bridge\src\tools\pulse-tools.ts:182-291`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:365-378`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:447-458`).
  - Query APIs today are bus-owned: `/v1/events`, `/v1/contexts`, `/v1/pulses`, and Scope APIs. Pulse subscriber relationship data exists in `pulse_subscribers`, but no public pulse response currently includes subscribers and no scope-filtered pulse/projection query exists (`floe-bus\src\store.ts:1337-1340`, `floe-bus\src\server.ts:835-840`).
- Current owner rationale:
  - Pulse Persistence and organising `scope_id` must be resolved where Pulse rows are created and fired: the bus. The scheduler already reads bus pulse state and `firePulse` already chooses context-vs-endpoint subscriber behavior.
  - Active Context inheritance needs bridge participation only to pass active turn context into pulse creation; the bus should still derive and validate the final Scope from `ContextStore`/`ScopeStore`.
  - Relationship rendering/querying must use bus-owned Pulse/subscriber data, not FloeWeb Field connections.
- Source evidence:
  - Corrected docs reserve Scope for workspace organisation and rename old Pulse "scope" storage language to Pulse Persistence (`CONTEXT.md:33-43`, `CONTEXT.md:121-148`, `docs\scope-substrate-slice-prd.md:72-79`, `docs\adr\0004-scope-as-substrate-organising-boundary.md:5-11`).
  - Historical Pulse docs overloaded the old Pulse storage field name and synthetic source language; #23 must correct those public docs while keeping the already-corrected runtime source-null pulse behavior (`floe-bus\src\store.ts:82-100`, `floe-bus\src\server.ts:959-970`).

## Existing interaction model

- User/system behaviors that already exist:
  - Pulse creation is `POST /v1/pulses`, stores a row in `pulses`, inserts subscriber JSON rows, broadcasts `pulse_created`, and schedules the pulse in the single bus `PulseScheduler` (`floe-bus\src\server.ts:803-832`, `floe-bus\src\store.ts:1271-1312`).
  - The scheduler is event-driven with one timeout/priority queue, not polling (`docs\adr\0001-pulse-scheduled-event-delivery.md:26-29`, `floe-bus\src\pulse-scheduler.ts`).
  - When a pulse fires, `firePulse` iterates stored subscribers. Context subscribers append `pulse.fired` into the supplied Context without endpoint delivery. Endpoint subscribers resolve `endpoint_ref`, create/associate a trigger event via `emitTriggerEvent`, and may produce a delivery (`floe-bus\src\server.ts:916-990`).
  - Context subscriber reminders currently render in the target context and do not wake/activate endpoints; tests assert no delivery/status change and no unrelated context pollution (`floe-bus\src\pulse-subscribers.test.ts:65-116`).
  - Endpoint subscriber deliveries currently carry the supplied `context_id` when present and appear in claimed delivery bundles (`floe-bus\src\pulse-subscribers.test.ts:118-163`).
  - #22 makes `insertEvent` write `event.scope_id` from the owning Context (`floe-bus\src\store.ts:1457-1524`), and context/event API tests already prove explicit Scope, Default fallback, Context-authoritative later events, filters, and unknown-Scope rejection (`floe-bus\src\scope-propagation.test.ts:58-390`).
  - Bridge runtime emits always forward `current_delivery_context_id` for normal `emit`, so active delivery Context is available in the adapter state for Pulse tool propagation too (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:447-458`).
- Behaviors that must remain unchanged:
  - `pulse.fired` remains the canonical event type.
  - Pulse events remain non-actor triggers with `source_endpoint_id: null`; do not reintroduce `system:pulse`.
  - Context subscribers append for rendering only and do not create endpoint delivery.
  - Endpoint subscribers create delivery and may activate only if the endpoint has a processor.
  - Context isolation/no-bleed, participant-aware `emit` resolution, and trigger target-only contexts remain intact.
  - Existing scheduler lifecycle, pause/resume/cancel, one-off completion, cron rescheduling, and restart hydration remain intact.
- Runtime or UX evidence:
  - `pulse-subscribers.test.ts` covers context subscriber render-only behavior, endpoint delivery in a supplied context, mixed subscribers, and malformed subscriber tolerance.
  - `scope-propagation.test.ts` covers Context/Event Scope propagation and queries.
  - `pulse-tools.test.ts` covers current agent-facing pulse tool schema/normalisation but still expects old `scope` output language; those tests must change for #23.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Extend the bus `pulses` schema with `persistence` and organising `scope_id`. Prefer a clean schema migration; any existing DB `scope` column is migration-only and must not remain meaningful in new public code.
  - Extend `BusStore.createPulse`, `rowToPulse`, `listPulses`, `getActivePulsesForScheduler`, and `firePulse` to carry `persistence` and `scope_id`.
  - Extend `POST /v1/pulses` validation to accept `persistence` and `scope_id`, and optionally a `current_context_id`/`context_id`-equivalent for active Context inheritance. Do not accept public `scope` as a compatibility alias.
  - Extend Bridge `BusClient.createPulse` types to include `persistence`, `scope_id`, and active context id; extend `getContext`/`EventEnvelope` types to include `scope_id` if bridge needs to inspect it.
  - Extend `createPulseTools` to receive active turn context via a getter (mirroring workspace tools' `getActiveTurn` pattern) or an equivalent adapter callback, so `create_pulse` can pass active `context_id` unless explicitly overridden.
  - Extend `.floe/floe.yaml` pulse reading/writing in `project.ts`/`pulse-tools.ts` to use `persistence` language only. Do not keep writing or teaching `scope` there.
  - Expose pulse subscriber relationship data through bus-owned query surfaces. The narrowest #23 path is to include `subscribers` in pulse create/get/list responses and support `GET /v1/pulses?workspace_id=...&scope_id=...`; a later Scope projection endpoint can reuse the same bus data.
- Relevant docs or library capabilities:
  - `ScopeStore.ensureDefaultScope`, `getScope`, and `ScopeNotFoundError` already provide Default fallback and explicit Scope validation.
  - `ContextStore.getContext(context_id)` already returns `scope_id`, which should be the source of truth when a subscriber or active creation context exists.
  - `appendContextEvent` and `emitTriggerEvent` already route pulse subscriber events through Context-owned event insertion, so Scope correctness can be achieved by selecting the right Context or new trigger Context Scope before inserting.
- Existing examples in this codebase:
  - Normal Event creation validates explicit `scope_id` and falls back through `resolveScopeId` only for newly-created Contexts (`floe-bus\src\store.ts:792-845`).
  - Trigger event creation validates explicit `scope_id`, uses existing Context Scope if `context_id` is supplied, or creates a target-only Context in a resolved Scope if no Context is supplied (`floe-bus\src\store.ts:857-904`).
  - Bridge tools can be provided runtime state via callback (`createWorkspaceTools({ getActiveTurn: () => state.activeTurn })` at `pi-agent-core-adapter.ts:369-374`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate or replace `BusStore`, `ScopeStore`, `ContextStore`, `resolveContext`, `PulseScheduler`, `appendContextEvent`, `emitTriggerEvent`, event queue/delivery bundles, bridge `BusClient`, or bridge runtime active-turn state.
  - Do not implement a second Pulse scheduler, polling loop, bridge-side timer, or extension-side timer.
  - Do not create a direct Event authoritative Scope path. Event `scope_id` stays denormalised/index data derived from Context/source primitive.
  - Do not replace Context subscriber behavior with endpoint delivery, and do not turn endpoint subscriber delivery into context-only rendering.
- Shortcuts or parallel paths to avoid:
  - No Field-owned connection for `pulse -> subscriber`.
  - No `.floe/blocks`.
  - No field-owned item list or field-owned connection graph.
  - No direct FloeWeb or bridge reads of pulse membership from workspace files for rendering/querying.
  - No actor containment; actors/endpoints remain workspace-scoped and may only appear via relationships such as pulse subscribers or context participants.
  - No synthetic `system:pulse` endpoint/source.
  - No caller-provided Event Scope override that can disagree with Context Scope.
- Invariants:
  - Pulse Persistence answers where/how a Pulse definition is stored/carried; organising `scope_id` answers where the Pulse belongs in the workspace model.
  - Every Pulse has one organising `scope_id`; missing explicit/active Context Scope falls back to Default Scope.
  - Pulse-fired events inherit from a subscriber Context when one exists; otherwise endpoint subscriber trigger contexts use the Pulse organising Scope.
  - Pulse subscriber relationship data is owned by Pulse records/subscriber rows, not by Field layout or semantic connections.

## Integration plan

- Insert the change at:
  1. `floe-bus\src\store.ts` Pulse schema and CRUD:
     - Add `persistence TEXT NOT NULL DEFAULT 'local'` and `scope_id TEXT NOT NULL DEFAULT 'default'` to `pulses`.
     - If old DB rows/columns are encountered, handle them as migration-only data; new code should treat `persistence` and `scope_id` as the only meaningful Pulse fields.
     - Ensure/validate Default Scope through `ScopeStore`; do not rely on the SQL default as the only source of `scope_id = "default"`.
     - Validate explicit `scope_id` through `resolveScopeId`.
     - If no explicit `scope_id`, derive from active creation Context (`current_context_id`/`context_id` supplied for pulse creation) by reading `ContextStore.getContext`; otherwise use `ensureDefaultScope`.
  2. `floe-bus\src\server.ts` Pulse API:
     - Accept `persistence` as the public field and reject legacy public `scope` payloads as invalid input.
     - Accept optional `scope_id` override and optional active context id. Unknown explicit `scope_id` should produce the same 404 shape as Event Scope validation.
     - Return `pulse.persistence`, `pulse.scope_id`, and `pulse.subscribers`; do not return `pulse.scope`.
     - Add `scope_id` query support to list pulses.
  3. `firePulse` in `floe-bus\src\server.ts`:
     - Context subscriber: no new Scope argument is needed; `appendContextEvent` inserts under the subscriber Context's `scope_id`. Add tests that a Pulse in `ops` firing into a `research` Context yields `event.scope_id === "research"`.
     - Endpoint subscriber with `context_id`: let `emitTriggerEvent` use existing Context Scope. Add tests that delivery event Scope is the associated Context Scope even if Pulse has another Scope.
     - Endpoint subscriber without `context_id`: pass `scope_id: pulse.scope_id` to `emitTriggerEvent` so the new target-only Context and Event use the Pulse organising Scope.
  4. `floe-bridge\src\bus-client.ts`, `floe-bridge\src\tools\pulse-tools.ts`, and `floe-bridge\src\adapters\pi-agent-core-adapter.ts`:
     - Rename tool/API language to `persistence`; update descriptions/results to say Pulse Persistence, workspace-backed/local-runtime-backed storage, and `scope_id` organising Scope.
     - Add optional `scope_id` parameter for explicit override.
     - Pass active turn `context_id` to pulse creation when available, so the bus can inherit its Scope unless `scope_id` is supplied.
     - For tool result details use `{ persistence, scope_id }`, not `{ scope }`.
  5. `floe-bridge\src\project.ts` and extension pulse registration in `daemon.ts`:
     - Parse workspace pulse definitions with `persistence` only; update templates/examples away from `scope`.
     - Register workspace/extension-declared pulses as `persistence: "workspace"` and default/declared `scope_id` as appropriate; do not invent extension Scope beyond existing config.
  6. Query/render relationship:
     - Add subscribers to pulse responses from the bus store/API, either by joining `pulse_subscribers` in `rowToPulse`/list mapping or by a helper that enriches list/get results.
     - This satisfies #23 without implementing FloeWeb Field/canvas work; future projection APIs can render `pulse -> subscriber` from this same data.
- Why this is the correct integration point:
  - Bus already owns the scheduler, pulse rows, subscribers, events, deliveries, ScopeStore, and ContextStore, so it is the only place that can atomically validate persistence/scope terminology and derive the correct firing Scope.
  - Bridge already owns agent-facing tool wording and active runtime turn state, so it is the right place to pass active Context into pulse creation without making the bridge authoritative for Scope.
  - Querying subscribers from bus-owned `pulse_subscribers` preserves the corrected Scope/Field model and avoids duplicating relationships in Field data.
- Alternatives considered and rejected:
  - Treat old `scope` as organising Scope: rejected because docs explicitly rename it to Pulse Persistence.
  - Let bridge compute final `scope_id` from `getContext` and send it as authoritative: rejected because bridge types can be stale/degraded; bus ContextStore must remain authoritative. Bridge may pass active context id, not decide final Scope.
  - Add a Field connection for `pulse -> subscriber`: rejected because the relationship already exists in Pulse subscriber data and Field connections are superseded for new work.
  - Create a separate projection/relationship store for Pulse subscribers: rejected as unnecessary duplication for #23.
  - Use Event `scope_id` from request payload for pulse-fired events: rejected because Event Scope is derived from Context/source primitive and direct Event authority would drift.

## Regression checklist

- Behavior: existing Scope APIs and Default Scope idempotency from #21 remain green.
- Behavior: existing Context/Event Scope propagation, Context-authoritative later Events, scope-filtered Event/Context queries, and unknown-Scope rejection from #22 remain green.
- Behavior: Pulse scheduler still fires due/overdue pulses, keeps one timer path, pauses/resumes/cancels, completes one-off pulses, and reschedules cron pulses.
- Behavior: context subscribers still append `pulse.fired` for rendering only, with no endpoint delivery or actor activation.
- Behavior: endpoint subscribers still create delivery and may activate delivery processors.
- Behavior: `pulse.fired` still has `source_endpoint_id: null`; no synthetic system/actor participant appears.
- Behavior: endpoint/context subscriber events do not pollute unrelated contexts.
- Behavior: bridge pulse tools still normalise relative one-off triggers and invalid subscriber/trigger errors remain clear.
- Behavior: workspace and extension-declared pulses still register on attach, now using Persistence language.
- Behavior: API/tool/doc surfaces do not expose old Pulse storage `scope` wording as Scope-facing language.
- Behavior: no Field-owned connection, no `.floe/blocks`, no second scheduler, no direct Event authoritative Scope, and no actor containment are introduced.

## Test plan

- Existing tests to keep green:
  - `npm run test --workspace floe-bus` for `scopes-server.test.ts`, `scope-propagation.test.ts`, `pulse-scheduler.test.ts`, `pulse-cron.test.ts`, `pulse-subscribers.test.ts`, context resolver/store/integration/server tests, and delivery symmetry tests.
  - `npm run test --workspace floe-bridge` for `tools\pulse-tools.test.ts`, bus client/daemon/project behavior, adapter active context emit tests, extension pulse registration, and work-log/telemetry tests.
  - `npm run build`.
- New tests to add before/with implementation:
  - Bus Pulse API accepts `persistence` and `scope_id`, stores/returns both, and response bodies do not include public `scope`.
  - Legacy request/config `scope: "local"|"workspace"` is rejected or ignored as stale public input; `persistence` is required for Pulse Persistence.
  - Unknown explicit `scope_id` on pulse creation is rejected without creating pulse/subscribers/scheduler entry.
  - Pulse creation with explicit `scope_id` uses that Scope even when an active Context is supplied.
  - Pulse creation with active scoped Context and no explicit `scope_id` inherits the Context Scope.
  - Pulse creation with no active Context and no explicit `scope_id` uses Default Scope.
  - Context subscriber firing uses subscriber Context Scope, not Pulse Scope.
  - Endpoint subscriber with associated Context uses associated Context Scope in the delivery event.
  - Endpoint subscriber without associated Context uses Pulse organising Scope for the target-only trigger Context/Event.
  - `GET /v1/pulses?scope_id=...` filters by Pulse organising Scope.
  - Pulse list/get/create responses include `subscribers`, making `pulse -> subscriber` relationship queryable without Field connections.
  - Bridge `create_pulse` schema/output uses `persistence` and `scope_id`, passes active turn context id, and no longer returns/details old `scope`.
  - Workspace `.floe/floe.yaml` read/write uses `persistence`; `scope` is not accepted or written in new pulse definitions.
  - Regression text guards search public docs/tool descriptions/API response snapshots for old Pulse storage wording leakage.
- Live proof required:
  - API-level proof is enough for #23; FloeWeb canvas implementation is out of scope.
  - Start a real bus/bridge or use app injection plus bridge tests to create a workspace, create two Scopes, create a Context in Scope A, create Pulses through bus and bridge paths, and verify:
    - pulse response shows `persistence` and `scope_id`;
    - active Context creation inherits Scope A;
    - no-context creation falls back to Default Scope;
    - context-subscriber and endpoint-subscriber firing Events query under the expected Scope;
    - pulse responses expose subscribers;
    - no `.floe/blocks` or Field connection file is created.

## Risk assessment

- Risk: intentional clean-break compatibility breaks for old `scope` request bodies or `.floe/floe.yaml` pulses. Mitigation: reject stale public `scope` clearly, update templates/docs/tests/examples, and reset local dev workspaces when needed because Floe is pre-ship.
- Risk: terminology drift where `scope` remains in tool descriptions, details, response JSON, docs, or tests and is mistaken for organising Scope. Mitigation: rename public surfaces to `persistence`, expose `scope_id` separately, and add regression guards over bridge tool schema/output and bus API snapshots.
- Risk: denormalized Event Scope drift if pulse firing writes Event `scope_id` directly. Mitigation: select/create the correct Context first; let `insertEvent` derive `event.scope_id` from Context.
- Risk: queue delivery Scope omissions when endpoint subscriber has no Context. Mitigation: persist Pulse `scope_id`, include it in scheduler hydration, and pass it to `emitTriggerEvent` for endpoint subscribers without `context_id`.
- Risk: query/render relationship gaps because subscribers exist in `pulse_subscribers` but are not currently exposed in pulse responses. Mitigation: enrich pulse get/list/create responses with subscribers and add API tests; do not build Field-owned connections.
- Risk: bridge cannot inherit active Context Scope because `createPulseTools` currently lacks active turn access and `BusClient.getContext` type omits `scope_id`. Mitigation: pass active context id into pulse creation from adapter state and let the bus derive Scope; update bridge types only as needed for returned data.
- Risk: extension/workspace-declared pulses do not have an active Context. Mitigation: register them with `persistence: "workspace"` and explicit/Default `scope_id`; do not invent extension/capability Scope associations in this issue.

## Decision confidence

- Confidence: high
- Reasons:
  - #21 and #22 are present in code: ScopeStore/Default Scope and Context/Event Scope propagation are already implemented and tested.
  - Pulse scheduling/subscriber ownership is centralised in `floe-bus`, and the required Scope choices map cleanly to existing `appendContextEvent` and `emitTriggerEvent` paths.
  - Docs are aligned on the correction: Pulse Persistence is separate from organising Scope, Field renders Scope, and relationships are derived from existing substrate state.
  - The main code conflict is narrow and well-isolated: current Pulse public/API/tooling still uses `scope` for storage.
- Open questions:
  - Resolved by user approval: use public field `persistence` with values `"workspace"`/`"local"` and descriptions that say workspace-backed/local-runtime-backed Pulse Persistence.
  - Resolved by user approval: do not preserve old public Pulse `scope` compatibility; if internal DB migration reads old data, it is migration-only and must not appear in new public API/tool/docs/tests.
