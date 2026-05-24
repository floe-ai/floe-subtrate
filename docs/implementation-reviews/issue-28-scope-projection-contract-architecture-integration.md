# Architecture Integration Brief: issue-28-scope-projection-contract

> Scope: first bus-owned **Scope Projection** read API for a single `(workspace_id, scope_id)`. Read-only derivation. No new storage, no React Flow state, no Field-owned item/connection model, no `.floe/blocks`.

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns Scope substrate state and Scope CRUD via `ScopeStore` and `/v1/workspaces/:workspace_id/scopes*` routes (`floe-bus\src\scopes\store.ts:34-154`, `floe-bus\src\server.ts:162-228`).
  - `floe-bus` owns Context substrate state and authoritative Context `scope_id` via `ContextStore` (`floe-bus\src\contexts\store.ts:5-12, 42-184`).
  - `floe-bus` owns Event state with denormalised `scope_id` and the scope-aware Event query path on `BusStore.listEvents(... scope_id ...)` exposed at `GET /v1/events?workspace_id=&scope_id=` (`floe-bus\src\store.ts:226-247, 1144-1193`, `floe-bus\src\server.ts:654-663`).
  - `floe-bus` owns Pulse state, organising `scope_id`, persistence, subscribers, and listing via `BusStore.listPulses` / `getPulse` / `getPulseSubscribers` and `GET /v1/pulses?workspace_id=&scope_id=` (`floe-bus\src\store.ts:328-360, 1347-1377`, `floe-bus\src\server.ts:878-886`).
  - `floe-bus` owns scope validation and Default Scope fallback via `BusStore.resolveScopeId` and `ScopeStore.ensureDefaultScope` (`floe-bus\src\store.ts:481-487`, `floe-bus\src\scopes\store.ts:59-75`).
  - `floe-bus` owns Runtime Telemetry rows joined to deliveries via `delivery_id` (no `scope_id` column today) (`floe-bus\src\store.ts:297-305, 1130-1142`).
  - `floe-bridge` derives and writes Work Log Scope into Markdown and into telemetry payloads per #24, but committed Work Log files are not yet indexed by the bus (per `docs\implementation-reviews\issue-24-trigger-worklog-scope-derivation-architecture-integration.md`).
  - `floe-web` currently renders Field-owned item/connection state through `fields-api.ts` / `fields.ts` / `main.tsx`; that path is superseded and is **not** the consumer #28 designs against (`floe-web\src\fields-api.ts`, `floe-web\src\fields.ts`, `floe-web\src\main.tsx`).
- Current owner rationale:
  - The bus already holds every authoritative Scope-owning primitive (Scope, Context, Event, Pulse) and the cross-primitive joins (`context_participants`, `pulse_subscribers`). Centralising a read-only projection inside the bus is the only place that can guarantee a single derivation path and prevent clients re-implementing scope membership.
- Source evidence:
  - `CONTEXT.md` defines Scope Projection as a **read-only substrate-derived view returning substrate refs and derived relationships, not React Flow state**, and explicitly avoids storage source, Field-owned item list, Field-owned connection graph, and client-side membership derivation (`CONTEXT.md:21-27`).
  - `CONTEXT.md` defines Field Layout as keyed by **stable projected refs, not old Field Item ids** (`CONTEXT.md:25-27`).
  - Accepted PRD names the exact derived relationship set for the first projection: context/thread → participants, pulse → subscribers, events → context/Scope, work logs → scoped delivery/context where available (`docs\scope-substrate-slice-prd.md:32-33, 85-89`).
  - ADR-0004 supersedes Field-as-substrate and rejects `.floe/blocks` (`docs\adr\0004-scope-as-substrate-organising-boundary.md:5-11`).

## Existing interaction model

- User/system behaviors that already exist:
  - Clients list Scopes via `GET /v1/workspaces/:workspace_id/scopes` (`floe-bus\src\server.ts:162-168`).
  - Clients list scoped Contexts indirectly via `GET /v1/contexts?participant=&workspace_id=&scope_id=` (participant-keyed; not a Scope membership query) (`floe-bus\src\server.ts:669-694`).
  - Clients list scoped Events via `GET /v1/events?workspace_id=&scope_id=` (`floe-bus\src\server.ts:654-663`).
  - Clients list scoped Pulses via `GET /v1/pulses?workspace_id=&scope_id=` (`floe-bus\src\server.ts:878-886`).
  - Clients list raw runtime telemetry per workspace via `GET /v1/runtime/telemetry?workspace_id=` (no scope filter today) (`floe-bus\src\server.ts:766-772`).
  - Event `scope_id` is denormalised from the owning Context for query/index, and is reconciled by a SQL update statement that COALESCEs from `contexts.scope_id` (`floe-bus\src\store.ts:406-415`).
  - Trigger Events (no `context_id`) create a Context in the resolved Scope before insertion, so Event Scope always traces back to an owning Context or Pulse (`floe-bus\src\store.ts:880-912`).
- Behaviors that must remain unchanged:
  - Existing Scope/Context/Event/Pulse APIs keep their request/response shapes — projection is additive.
  - Context `scope_id` remains the authority for Event Scope; Event Scope remains denormalised.
  - Pulse `scope_id` (organising) remains separate from Pulse Persistence.
  - Default Scope is auto-ensured and never deletable.
  - Webhook ingress lands in Default Scope unless an owning primitive supplies Scope (no projection-driven change to ingress).
  - Field file APIs at `/v1/workspaces/:workspace_id/fields*` continue to exist but are superseded; #28 does not extend, remove, or hard-disable them (legacy closeout is later).
  - FloeWeb Field/canvas invariants (React Flow-native interaction, Block Library drag/drop, node icons/labels/handles/selection, pan/zoom/drag performance, rename/open affordances, connection affordances) remain untouched: #28 does not ship the FloeWeb consumer and must not commit the API shape to React Flow concepts.
- Runtime or UX evidence:
  - `floe-bus\src\scope-propagation.test.ts`, `pulse-scope-propagation.test.ts`, `scopes-server.test.ts`, and `server.test.ts` exercise the current behaviours through API/store calls and are the prior-art baseline for projection tests.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add **one read-only route** under the existing scopes namespace, owned by `floe-bus\src\server.ts`:
    - `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection`
  - Build a thin module `floe-bus\src\scopes\projection.ts` that composes existing stores: `ScopeStore.getScope`, `ContextStore.listContextsForParticipant` (or a new minimal `listContextsForScope` if needed), `BusStore.listEvents({ workspace_id, scope_id })`, `BusStore.listPulses({ workspace_id, scope_id })`, `BusStore.getPulseSubscribers`, and `BusStore.listRuntimeTelemetry({ workspace_id })` filtered post-hoc by delivery → event → scope.
  - Reuse `BusStore.resolveScopeId` semantics for 404 on unknown Scope and the existing `workspace_not_found` / `scope_not_found` 404 shape used by the scopes routes (`floe-bus\src\server.ts:162-228`).
  - Reuse `zod` request param parsing and the broadcast-free read pattern already used by `/v1/events`, `/v1/pulses`, `/v1/contexts`.
  - Use Vitest + Fastify test pattern from `scopes-server.test.ts` and `scope-propagation.test.ts` for new tests.
- Relevant docs or library capabilities:
  - `CONTEXT.md` glossary entries: Scope, Default Scope, Scoped Primitive, Field, Scope Projection, Field Layout, Block, Derived Relationship.
  - PRD `docs\scope-substrate-slice-prd.md` (Implementation Decisions + Testing Decisions blocks scoped relationships and forbids `.floe/blocks` / field-owned membership).
  - ADR-0004.
- Existing examples in this codebase:
  - The `BusStore.listEvents` scope filter is the established pattern for scoping list endpoints (`floe-bus\src\store.ts:1144-1193`).
  - The pulse `getPulse` row builder is the established pattern for stable substrate refs with denormalised fields (`floe-bus\src\store.ts:1467-1484`).
  - `ContextStore.getContextParticipants` is the established pattern for derived participant lists (`floe-bus\src\contexts\store.ts:118-123`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - `ScopeStore`, `ContextStore`, `BusStore.listEvents`/`listPulses`/`getPulseSubscribers`/`resolveScopeId`/`ensureDefaultScope` — do not query SQLite directly from a new code path; compose existing accessors.
  - `BusStore` is the only authoritative substrate accessor for clients. Projection must not read workspace files (`.floe/fields/*`, agent worklog Markdown) for membership.
  - Existing fields-store, fields-watcher, and `/v1/workspaces/:workspace_id/fields*` routes are superseded — projection must **neither extend nor depend on** them, and must not write any field-side or `.floe/blocks` artefact.
- Shortcuts or parallel paths to avoid:
  - No new projection table, no derived index table, no materialised view, no cached membership rows, no on-disk projection cache.
  - No new authoritative Event Scope path; keep Event `scope_id` derived from owning Context/source primitive.
  - No React Flow node/edge type, no `position`/`type: "default"`/`source`/`target`/`handle` shape, no `nodes`/`edges` naming that bakes React Flow into the contract. The contract must be primitive-typed substrate refs and typed derived relationship records that a non-FloeWeb client (e.g., CLI, future SDK) can consume.
  - No use of old Field Item ids as the stable ref. Stable refs are primitive identifiers: `context_id`, `pulse_id`, `event_id`, `endpoint_id`, `telemetry_id`/`delivery_id`.
  - No fanning-out at the client. FloeWeb (later, in #29) must not re-derive membership across contexts/pulses/events/work-logs/telemetry/future primitives; the projection is the single derivation point.
  - No client-supplied Scope membership. Membership is derived only from primitive `scope_id` or owning Context/source Scope.
  - No layout-implied membership: even if Field Layout sidecars exist later, they must never feed projection membership.
  - No introduction of cross-scope or many-to-many membership in this slice.
  - No participant containment claims: rendering an Actor as a Context participant must not be expressed as Actor-in-Scope membership.
  - No `kind: "unknown"` rows that fabricate membership; unsupported primitives are either omitted or returned in a separate, explicitly named `unsupported`/`unsupported_refs` collection with a stable reason string.
  - No use of `runtime_telemetry` as an authoritative activity store; treat it as activity-only and join via `delivery_id` → event → context Scope.
- Invariants:
  - Projection input is exactly `(workspace_id, scope_id)`. Unknown workspace → 404 `workspace_not_found`. Unknown Scope → 404 `scope_not_found`.
  - Projection is idempotent and side-effect-free; it must not call `ensureDefaultScope` as a write side-effect for missing Scopes (it may still resolve the explicit Default Scope, which is auto-ensured at workspace registration).
  - A Context appears in the projection iff `ContextStore.getContext(ctx).scope_id === scope_id`.
  - A Pulse appears iff `pulses.scope_id === scope_id`.
  - An Event appears iff its owning Context's `scope_id === scope_id` (preferred) or, for non-Context trigger events (e.g., pulse-fired endpoint deliveries), `events.scope_id === scope_id` from the source primitive. Event `scope_id` is not authoritative on its own — when present without an owning Context, the source primitive's Scope is the rationale.
  - Context participant relationships come from `context_participants` only.
  - Pulse subscriber relationships come from `pulse_subscribers` only.
  - Work Log / activity refs come from `runtime_telemetry` rows whose delivery resolves to a scoped Event/Context; if no such resolution exists, the activity is omitted (not faked).
  - Output uses substrate refs (typed by primitive) and typed derived relationship records; no React Flow vocabulary.
  - Field Layout is not produced, accepted, or referenced by this API.

## Integration plan

- Insert the change at:
  1. New module `floe-bus\src\scopes\projection.ts` exporting `buildScopeProjection(store: BusStore, workspaceId: string, scopeId: string): ScopeProjection` and the `ScopeProjection` type.
  2. New route in `floe-bus\src\server.ts` registered next to the existing scopes routes:
     - `app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/projection", ...)`
     - Validate params with `zod`, 404 on unknown workspace, 404 on unknown Scope using `store.getScope(workspace_id, scope_id)`.
  3. Minor helper additions if needed:
     - `ContextStore.listContextsForScope(workspaceId, scopeId)` — straight SQL on `contexts` already indexed by `idx_contexts_workspace_scope` (`floe-bus\src\contexts\store.ts:67-70`); returns the same `ContextListRow` shape so participants/first-message preview reuse current code.
     - Optionally a `BusStore.listTelemetryForScope(workspaceId, scopeId)` that joins `runtime_telemetry → delivery_bundles → events.scope_id`. Keep it inside `BusStore` so projection composes only existing accessors and the join is testable in isolation.
- Proposed response shape (illustrative, finalised in implementation; **not** a React Flow shape):
  ```jsonc
  {
    "workspace_id": "ws_…",
    "scope_id": "scope_…",
    "generated_at": "2026-05-23T…Z",
    "refs": {
      "contexts": [ { "context_id": "ctx_…", "parent_context_id": null,
                       "created_by_endpoint_id": "actor:…",
                       "created_at": "…", "last_event_at": "…",
                       "first_message_preview": "…" } ],
      "pulses":   [ { "pulse_id": "pulse_…", "persistence": "local",
                       "status": "active", "trigger": { … },
                       "next_fire_at": "…", "last_fired_at": "…",
                       "fire_count": 0, "created_at": "…", "updated_at": "…" } ],
      "events":   [ { "event_id": "evt_…", "type": "…", "context_id": "ctx_…",
                       "source_endpoint_id": "actor:…|null",
                       "created_at": "…" } ],
      "activity": [ { "telemetry_id": "tel_…", "delivery_id": "dlv_…",
                       "endpoint_id": "actor:…", "kind": "…",
                       "context_id": "ctx_…|null", "created_at": "…" } ]
    },
    "relationships": {
      "context_participants": [ { "context_id": "ctx_…", "endpoint_id": "actor:…" } ],
      "pulse_subscribers":    [ { "pulse_id": "pulse_…",
                                   "subscriber": { … as stored … } } ],
      "event_context_ownership": [ { "event_id": "evt_…", "context_id": "ctx_…" } ]
    },
    "unsupported": [ { "kind": "webhook_route" | "file_resource" | "extension" | "capability",
                       "reason": "no_owning_scope_metadata" } ]
  }
  ```
  - `refs.*` arrays hold stable substrate refs only — they are not React Flow nodes.
  - `relationships.*` records are derived relationship records — they are not React Flow edges.
  - `unsupported` is informational only and carries no membership weight; it may be omitted entirely if empty.
  - Field Layout is intentionally absent.
- Why this is the correct integration point:
  - Bus owns every primitive contributing membership and every derived relationship needed by the first projection.
  - Composing existing stores keeps the projection a derivation, not a new source.
  - A separate `projection.ts` module isolates the contract from primitive accessors and lets future projections (additional Scopes / different primitive sets) reuse it.
  - Anchoring the route under `/v1/workspaces/:workspace_id/scopes/:scope_id/projection` mirrors existing scopes routes and makes the API discoverable.
- Alternatives considered and rejected:
  - **Materialise projection rows on writes** to all owning primitives: rejected — creates a second source of truth and contradicts ADR-0004 / PRD.
  - **Return React Flow `nodes`/`edges`**: rejected — locks contract to FloeWeb internals; violates `CONTEXT.md` Scope Projection definition and breaks non-FloeWeb clients.
  - **Expose projection by reusing the Field routes (`/v1/workspaces/:workspace_id/fields/:field_id`)**: rejected — those routes own the superseded field-file model; reusing them re-entangles Field-as-substrate.
  - **Let FloeWeb compose projection from existing list endpoints**: rejected — repeats the membership-derivation logic in every client and prevents a stable, testable substrate contract.
  - **Add a `scope_id` column to `runtime_telemetry`**: out-of-slice; not required to derive activity refs via delivery join. May be revisited in a later slice if activity scope queries become hot.

## Regression checklist

- Behavior: `GET /v1/workspaces/:workspace_id/scopes`, `/scopes` POST/PATCH continue to work unchanged.
- Behavior: `GET /v1/contexts`, `GET /v1/contexts/:id`, `GET /v1/contexts/:id/events`, `GET /v1/events`, `GET /v1/pulses`, `GET /v1/runtime/telemetry` continue to work unchanged.
- Behavior: Default Scope auto-creation per workspace remains the only auto-write; projection reads do not create or mutate Scopes, Contexts, Events, Pulses, or telemetry.
- Behavior: Field file APIs at `/v1/workspaces/:workspace_id/fields*` are not changed by this slice (no extension, no removal).
- Behavior: Context/Event/Pulse Scope propagation (#21–#24) remains green.
- Behavior: Webhook ingress continues to land in Default Scope; projection does not alter ingress.
- Behavior: No new SQLite table, no `.floe/blocks`, no field-owned item list, no field-owned connection graph, no field-owned layout-as-membership.
- Behavior: Unknown workspace → 404 `workspace_not_found`; unknown Scope → 404 `scope_not_found`; valid empty Scope → 200 with empty refs/relationships.
- Behavior: Pulse Persistence wording is preserved; no API/copy regression to "Pulse scope" meaning persistence.
- Behavior: No React Flow vocabulary appears in bus contracts, tests, or types.

## Test plan

- Existing tests to keep green:
  - `npm run test --workspace floe-bus`, including `scopes-server.test.ts`, `scope-propagation.test.ts`, `pulse-scope-propagation.test.ts`, `pulse-subscribers.test.ts`, `server.test.ts`, `contexts/*.test.ts`, `pulse-scheduler.test.ts`, `delivery-symmetry.test.ts`, and (untouched) `fields-server.test.ts` / `fields-store.test.ts`.
  - `npm run test --workspace floe-bridge` and `floe-web` (untouched in #28) to confirm no incidental coupling.
  - `npm run build` across workspaces.
- New tests to add before/with implementation (Vitest + Fastify against in-memory bus, mirroring `scopes-server.test.ts`):
  - **In-scope contexts** — create two Contexts in Scope A and one in Scope B; assert `refs.contexts` contains only Scope A contexts with correct `context_id`, `created_by_endpoint_id`, `parent_context_id`, `last_event_at`, `first_message_preview`.
  - **Out-of-scope contexts excluded** — Context whose `scope_id` does not match must be absent.
  - **In-scope pulses** — Pulses with matching `scope_id` appear; pulses in other scopes do not; persistence is reported.
  - **In-scope events with Context owner** — Events whose owning Context has matching Scope appear; Events of out-of-scope Contexts do not, even if their denormalised `events.scope_id` is stale (regression guard for derivation order).
  - **Trigger events with source primitive Scope** — `pulse.fired` endpoint deliveries with no Context but matching pulse `scope_id` appear; with non-matching pulse `scope_id` they do not.
  - **Context participants relationship** — `relationships.context_participants` mirrors `context_participants` rows; no Actor-in-Scope membership row is produced from this.
  - **Pulse subscribers relationship** — `relationships.pulse_subscribers` mirrors `pulse_subscribers` rows; both `context` and `endpoint` subscriber kinds round-trip.
  - **Event–Context ownership relationship** — `relationships.event_context_ownership` is emitted only for events with a `context_id`.
  - **Activity refs where available** — telemetry whose `delivery_id` resolves to a scoped Event/Context appears in `refs.activity`; telemetry without that resolution is omitted (not faked).
  - **Unsupported primitives** — when an `unsupported` collection is populated, no `refs.*` row is fabricated for it.
  - **404s** — unknown workspace and unknown Scope return the existing error shape.
  - **Empty Scope** — valid Scope with no scoped primitives returns 200 with empty arrays.
  - **No side effects** — calling the projection does not insert/update any row in `scopes`, `contexts`, `context_participants`, `events`, `event_queue`, `pulses`, `pulse_subscribers`, `runtime_telemetry`, `delivery_bundles`, or any field-related table; no file is written to `.floe/`.
  - **Contract guard (regression)** — response JSON does not contain the keys `nodes`, `edges`, `position`, `handle`, `field_item_id`, or any `.floe/blocks` path string; types do not import React Flow.
  - **Stable ref guard** — every entry in `refs.*` and every endpoint in `relationships.*` is a primitive id (matches existing id patterns: `ctx_`, `pulse_`, `evt_`, `actor:`, `tel_`, `dlv_`).
- Live proof required:
  - With a real bus process and a disposable workspace:
    1. Create Scope `research`. Create Context A in `research` with a `user`+`agent` participant pair. Emit one message Event in Context A. Create Pulse P in `research` with a context subscriber on A and an endpoint subscriber on the agent. Run a turn so a `runtime_telemetry` row joins via delivery to A.
    2. `curl GET /v1/workspaces/<ws>/scopes/research/projection` and capture JSON.
    3. Verify: Context A and Pulse P present; events for A present; activity row present; relationships include `(A, user)`, `(A, agent)`, `(P, context A)`, `(P, endpoint agent)`, `(event, A)`; no Field/canvas/React Flow vocabulary; no `.floe/blocks` and no Field file written.
    4. Repeat with Default Scope to prove fallback membership.
    5. Repeat with a non-existent Scope to capture 404.

## Risk assessment

- Risk: API shape leaks React Flow concepts because the eventual consumer is FloeWeb. Mitigation: contract tests assert absence of React Flow vocabulary and use primitive-typed refs; type names use substrate language (`refs`, `relationships`); review against `CONTEXT.md` glossary before merge.
- Risk: Event Scope drift between `contexts.scope_id` and denormalised `events.scope_id` produces inconsistent projection. Mitigation: prefer owning-Context Scope for events with `context_id`; cover with a stale-denormalisation test that mutates raw `events.scope_id` and asserts projection still uses the Context.
- Risk: Activity join via `delivery_id → events → scope_id` becomes expensive on large workspaces. Mitigation: bound by Scope-filtered delivery set; cap default response with a documented `limit`/`since` pagination contract — but only if needed by tests, otherwise leave unpaginated for v1 and note in brief follow-ups.
- Risk: Hidden write side-effects via `ensureDefaultScope` or similar accessor reuse. Mitigation: projection module restricted to read-only accessors; test asserts no row mutations occur on a GET.
- Risk: Future FloeWeb consumer ends up keying layout by primitive ids in a way that re-creates Field Item id semantics. Mitigation: contract states stable refs are primitive ids (`context_id`, `pulse_id`, …); brief and tests forbid `field_item_id` keys.
- Risk: Membership creep — adding webhook route Scope, file/resource Scope, or extension Scope to make `unsupported` smaller. Mitigation: brief and tests reject any membership row sourced from a primitive without an owning `scope_id`; `unsupported` stays informational.
- Risk: Implementer extends `/v1/workspaces/:workspace_id/fields*` to deliver the projection. Mitigation: brief explicitly forbids this; new route must live under the scopes namespace.
- Risk: Doc/code conflict — PRD `User Stories #10` and `#17` describe pulse subscribers as "rendered as existing relationships" and Field rendering of derived relationships; the contract must be FloeWeb-agnostic. Mitigation: keep PRD intent (derived relationships only) but express it in substrate vocabulary in the API; FloeWeb rendering is later (#29).

## Decision confidence

- Confidence: **high**
- Reasons:
  - Every input primitive (Scope, Context, Event, Pulse, Pulse Subscriber, Runtime Telemetry) already exists in bus with scope-aware accessors from #21–#24.
  - The derivation is a thin compose-and-shape over existing accessors; no new substrate is needed.
  - `CONTEXT.md`, PRD, and ADR-0004 agree on the contract guardrails (read-only, substrate refs, derived relationships, no React Flow, no Field-owned membership, no `.floe/blocks`).
  - Existing test idioms in `scopes-server.test.ts` / `scope-propagation.test.ts` cover the test surface cleanly.
- Open questions (do not block start; flag with `Question` if encountered during implementation):
  - Final field names in the response envelope (`refs` vs `members`, `activity` vs `work_log_refs`). Pick names that read as substrate, not as rendering, and lock them in tests.
  - Whether `pulse-fired` Events without a Context but with a matching Pulse `scope_id` should appear under `refs.events` or only as relationships of the Pulse. Recommendation: include under `refs.events` with `context_id: null` so a future client can render them, and add an `event_pulse_source` relationship if needed — but only if a test/PRD requirement appears; otherwise omit the extra relationship and revisit in #29.
  - Pagination/limit defaults for events and activity. Recommendation: cap events/activity at a sane default (e.g., 200 newest) with a query param; if implementer prefers unbounded for v1, document the limit and add a follow-up.
  - If implementer proposes any new SQLite table, new authoritative Event Scope path, new Field-coupled API, or any React Flow shape in the contract — **stop and raise a `Question` for architecture review**.
