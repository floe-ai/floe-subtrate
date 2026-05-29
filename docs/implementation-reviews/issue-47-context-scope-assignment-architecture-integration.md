# Architecture Integration Brief: issue-47-context-scope-assignment

## Existing ownership

- Package/component/module/library:
  - `floe-bus\src\contexts\store.ts` owns Context persistence, nullable `scope_id`, participant rows, Context lookup/listing, first-message previews, and the low-level invalid Context guard.
  - `floe-bus\src\store.ts` owns cross-primitive substrate orchestration: Scope validation, Context/Event/Pulse/Webhook flow rules, transactions, canonical Event insertion, delivery queueing, and broadcasts.
  - `floe-bus\src\server.ts` owns HTTP API shapes, zod validation, Context/Scope/Event route placement, and public error mapping.
  - `floe-bus\src\scopes\store.ts` owns real Scope records and reserves `default`; Scope Projection construction remains owned by `floe-bus\src\scopes\projection.ts`.
- Current owner rationale:
  - Assigning an unscoped actor Context into operational work crosses Context, Scope, and Event/audit state, so `BusStore` should own the named operation and transaction while delegating raw Context persistence to `ContextStore` and Scope validation to `ScopeStore`.
  - Scope Projection must stay read-only and scoped-only; it should reflect the assigned Context through `Context.scope_id`, not perform assignment or infer membership.
  - HTTP routing should expose a named, workspace-bounded operation; FloeWeb/Field layout must not become a source of Scope membership.
- Source evidence:
  - `CONTEXT.md:131-149` defines Workspace as top-level, Actors as Workspace-scoped, nullable actor Context Scope, no orphan Contexts, Event Scope derivation from Context/source ownership, and Workspace Home not being a Scope.
  - `floe-bus\src\contexts\store.ts:119-145` creates Contexts and rejects rows with neither participants nor Scope.
  - `floe-bus\src\contexts\store.ts:232-275` lists Workspace/Scope Contexts; issue #46 already added workspace-bounded discovery.
  - `floe-bus\src\store.ts:659-669` validates real Scope ids; `floe-bus\src\store.ts:1845-1907` inserts Events with `scope_id` derived from `contextScopeId(contextId)`.
  - `floe-bus\src\server.ts:671-739` exposes current Context read/delete APIs; no assignment route exists yet.
  - `floe-bus\src\scopes\store.ts:4-5,88-91` reserves `default` and prevents new Default Scope creation.

## Existing interaction model

- User/system behaviors that already exist:
  - Actor-origin `/v1/events/emit` resolves or creates a Context, accepts explicit Scope only for newly-created Contexts, and stores Event Scope from the owning Context.
  - Workspace Context discovery can show unscoped actor Contexts via `GET /v1/workspaces/:workspace_id/contexts?scope=unscoped`.
  - Scope Projection shows only Contexts whose `Context.scope_id` equals the requested real Scope, and deliberately omits unscoped actor Contexts.
  - Pulse/Webhook/generated operational flows require Scope where they create actorless/generated operational Contexts; explicit Context anchors are validated in bus code.
  - Existing audit-like surface is canonical Events plus WebSocket broadcasts (`event_submitted`, `context_deleted`, `scope_created`, etc.); there is no separate audit table.
- Behaviors that must remain unchanged:
  - Unscoped actor Contexts remain valid and discoverable before intentional assignment.
  - Context identity must be preserved on assignment; do not create a replacement scoped Context or copy old Events into a new Context.
  - Future Events in an assigned Context must derive Scope from `Context.scope_id`; callers must not override Event Scope arbitrarily.
  - Scope Projection stays read-only; it must not mutate Contexts or materialize hidden membership.
  - Unknown Scope, unknown Context, wrong-workspace Context, already-scoped/move attempts, and orphan unscoped Contexts must fail clearly without partial persistence.
- Runtime or UX evidence:
  - `npm test --workspace floe-bus -- --runInBand=false` exited 0 in this worktree (npm warned the extra CLI flag is unknown, but Vitest completed successfully).
  - Focused Context/Scope tests also exited 0: workspace discovery, scope projection, and scope propagation suites.
  - No live browser was started; API behavior was inspected through Fastify route code and existing inject tests.
- Docs/code conflicts or gaps:
  - No current conflict found for the issue #47 substrate ruling: current code has nullable Context/Event/Pulse Scope and Scope Projection is scoped-only.
  - Gap: there is no named API or store operation for assigning an existing unscoped Context to a Scope, and no dedicated audit table. Use the existing canonical Event surface unless a broader audit subsystem is introduced later.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a `BusStore.assignContextScope(...)` operation near existing Context/Scope helpers in `floe-bus\src\store.ts` so validation, Context update, audit Event insertion, and broadcasts share one transaction boundary.
  - Add a small `ContextStore` mutation such as `setContextScope(context_id, scope_id)` or keep raw update private to `BusStore`; do not put Scope validation in `ContextStore`.
  - Expose a named workspace route, e.g. `POST /v1/workspaces/:workspace_id/contexts/:context_id/assign-scope`, with body `{ scope_id }`.
  - Reuse `ScopeStore.getScope`/`BusStore.validateScopeId`, `ContextStore.getContext`, and `ContextStore.getContextParticipants` for validation.
  - Reuse the canonical Event table for audit by inserting a source-null, context-destination Event type such as `context.scope_assigned` with metadata `{ previous_scope_id:null, scope_id, assigned_by?, reason? }`.
  - Reuse existing zod validation and HTTP error patterns (`scope_not_found`, `context_not_found`, `context_anchor_invalid` or a narrow new error) in `server.ts`.
- Relevant docs or library capabilities:
  - SQLite updates and Event insertions can be kept atomic with the existing `BusStore.transaction` pattern.
  - Because `insertEvent` derives Event Scope from Context, assignment audit insertion should occur after `contexts.scope_id` is updated if the audit Event itself should be visible as scoped.
  - `buildScopeProjection` already consumes `ContextStore.listContextsForScope`, so no projection code change is needed beyond regression tests unless returned fields change.
- Existing examples in this codebase:
  - `deleteContext` shows a Context route calling a BusStore operation and broadcasting a context-level mutation.
  - `submitEvent`, `emitTriggerEvent`, and `appendContextEvent` show Event insertion/broadcast conventions and error mapping.
  - `workspace-discovery.test.ts` and `scope-projection.test.ts` show before/after visibility fixtures for unscoped vs scoped Contexts.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass `ContextStore`/`BusStore` with direct SQL in `server.ts`, FloeWeb, or tests except targeted legacy/orphan fixture setup.
  - Do not bypass `ScopeStore` or accept a `scope_id` that is not a real Scope in the same Workspace.
  - Do not modify `buildScopeProjection` to assign or infer Context membership.
  - Do not introduce Field/FloeWeb layout, React Flow state, `.floe/fields`, or Workspace Home UI as Scope membership source.
  - Do not create a parallel audit database/table unless explicitly chosen as a separate substrate audit system; canonical Events are the current audit surface.
- Shortcuts or parallel paths to avoid:
  - Do not route assignment through hidden `default`, `Default Scope`, or `Default Field` semantics.
  - Do not create a new scoped Context and delete/archive the old unscoped Context.
  - Do not bulk rewrite historical Events silently. If implementation updates denormalized historical `events.scope_id`, it must be in the same transaction and described in the audit Event metadata; preferred first slice is preserving historical rows and relying on Context ownership plus future Event derivation.
  - Do not permit arbitrary re-scope/move of already-scoped Contexts unless a separate audited move operation is designed.
  - Do not let request payload `scope_id` on `/v1/events/emit` retroactively assign an existing Context.
- Invariants:
  - Context identity is stable across assignment.
  - Assignment source must be an unscoped actor Context: `scope_id === null` and participants length > 0.
  - Orphan Contexts (`scope_id === null` and no participants) fail clearly even if assigning would make them scoped.
  - Event Scope remains derived from Context/source ownership.
  - Scope Projection includes the Context only after the substrate Context owns the real Scope.

## Integration plan

- Insert the change at:
  1. Add narrow domain errors in `floe-bus\src\store.ts` if needed: e.g. `ContextAlreadyScopedError` and `ContextAnchorError` reason for orphan/not assignable. Reuse `ScopeNotFoundError` and `ContextNotFoundError` for those cases.
  2. Add `BusStore.assignContextScope(input, broadcast)` that:
     - validates Workspace exists or lets the route do so consistently with existing workspace routes;
     - loads Context and ensures it belongs to the route Workspace;
     - validates target Scope exists in the same Workspace;
     - checks `context.scope_id === null`;
     - checks `getContextParticipants(context_id).length > 0` to reject orphan Contexts;
     - updates the existing Context row to the new `scope_id` without changing `context_id` or participants;
     - inserts a canonical audit Event `context.scope_assigned` for the same Context after the update, with source `null`, destination `{kind:"context", context_id}`, no delivery, and metadata carrying previous/new Scope and actor/request provenance if provided;
     - broadcasts a clear mutation event such as `context_scope_assigned` plus the normal `event_submitted` audit broadcast.
  3. Add `POST /v1/workspaces/:workspace_id/contexts/:context_id/assign-scope` in `server.ts` near Context routes, with zod body `{ scope_id: z.string().min(1), assigned_by?: z.string().optional(), reason?: z.string().optional() }` if provenance is desired.
  4. Map errors to stable HTTP shapes: unknown Workspace 404 `workspace_not_found`, unknown Scope 404 `scope_not_found`, unknown/wrong-workspace Context 404 `context_not_found`, orphan/already-scoped invalid assignment 409 or 400 with explicit `context_scope_assignment_invalid` reason.
  5. Keep `insertEvent` unchanged so future Events automatically inherit the assigned Scope through `contextScopeId`.
  6. Keep Scope Projection unchanged; add tests proving it reflects the assigned Context because `ContextStore.listContextsForScope` now sees the updated Context.
- Why this is the correct integration point:
  - `BusStore` is the only existing owner with Context, Scope, Event, transaction, and broadcast access; assignment is not just a Context row update because acceptance requires auditability and future Event derivation.
  - A workspace-bounded route makes the operation intentional and auditable, and avoids overloading emit, Scope Projection, or Context discovery.
  - Existing Event insertion already provides the desired audit surface and preserves Event Scope derivation.
- Alternatives considered and rejected:
  - Assign by passing `scope_id` with an existing `context_id` to `/v1/events/emit`: rejected because emit Scope is only for newly-created Contexts and must not become caller override.
  - Add unscoped Contexts to Scope Projection under a fallback: rejected because it violates scoped-only projection and Default Scope rulings.
  - Create a new scoped Context and copy history: rejected because Context identity must be preserved and history becomes misleading.
  - Add a generic `PATCH /v1/contexts/:id` for arbitrary fields: rejected for this slice because acceptance asks for a named, intentional operation.

## Regression checklist

- Behavior: Workspace-level unscoped actor Context discovery remains available before assignment.
- Behavior: Scope Projection remains scoped-only and does not include the Context before assignment.
- Behavior: Assignment preserves `context_id`, participants, parent, creator, and existing Event rows.
- Behavior: Assignment records a canonical audit Event or equivalent existing audit surface and broadcasts it.
- Behavior: New Events emitted into the assigned Context have `scope_id` equal to the assigned Scope through Context ownership.
- Behavior: Unknown Scope, unknown/wrong-workspace Context, orphan Context, and already-scoped Context attempts fail clearly and do not update Context or insert audit Events.
- Behavior: Pulse/Webhook anchor validation and generated scoped delivery Context behavior remain unchanged.
- Behavior: No code path creates or routes through `scope_id: "default"`.

## Test plan

- Existing tests to keep green:
  - `floe-bus\src\contexts\store.test.ts`
  - `floe-bus\src\contexts\resolver.test.ts`
  - `floe-bus\src\contexts\workspace-discovery.test.ts`
  - `floe-bus\src\scope-propagation.test.ts`
  - `floe-bus\src\scope-projection.test.ts`
  - `floe-bus\src\pulse-scope-propagation.test.ts`, `pulse-subscribers.test.ts`, `contexts\trigger.test.ts`, and `server.test.ts`
- New tests to add before/with implementation:
  - Store/domain test for assigning an unscoped actor Context to an existing Scope: same `context_id`, updated `Context.scope_id`, participants unchanged, audit Event inserted with expected metadata.
  - Server test for `POST /v1/workspaces/:workspace_id/contexts/:context_id/assign-scope` success and response shape.
  - Before/after visibility test: unscoped Context appears in workspace discovery and not projection before assignment; after assignment it disappears from `scope=unscoped`, appears in `scope=scoped`/specific Scope Projection, and keeps same id.
  - Future-event derivation test: emit into the assigned Context after assignment and assert Event `scope_id` is the assigned Scope even if caller omits or supplies no Scope.
  - Invalid tests: unknown Scope 404, unknown/wrong-workspace Context 404, orphan unscoped Context fails clearly, already-scoped Context fails/no-op according to chosen contract, and no audit Event is inserted on failure.
  - Regression asserting assignment never creates `scope_id: "default"` and never creates a second Context.
- Live proof required:
  - Start bus (and FloeWeb if UI consumes this operation later).
  - Register a Workspace, two actor endpoints, and a real Scope.
  - Emit an unscoped actor message; verify `/v1/workspaces/:workspace_id/contexts?scope=unscoped` returns it and Scope Projection does not.
  - Call the assignment route; verify response/audit Event.
  - Emit a follow-up Event into the same Context; verify its `scope_id` is the assigned Scope.
  - Verify the Scope Projection for that Scope now includes the same `context_id`.

## Risk assessment

- Risk: Updating `Context.scope_id` changes projection membership immediately; stale clients may need refresh via broadcast.
- Risk: Inserting the audit Event before updating Context would leave the audit Event unscoped; define ordering deliberately.
- Risk: Rewriting historical Event Scope could blur historical truth or hide that assignment happened later.
- Risk: Allowing already-scoped reassignment could become an unaudited move operation with broader implications.
- Risk: Adding assignment logic in `server.ts` directly would duplicate ownership and skip transaction/audit invariants.
- Mitigation:
  - Keep one `BusStore.assignContextScope` transaction and test counts/no-partial-persistence for every failure.
  - Insert assignment audit after Context update and include previous/new Scope metadata.
  - Preserve historical Events unless a traceable backfill is explicitly required.
  - Reject already-scoped Contexts in this slice; design a separate move operation if needed.
  - Use WebSocket broadcast naming consistent with existing substrate events so clients can refresh.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership boundaries are clear: ContextStore owns rows, ScopeStore owns real Scopes, BusStore owns cross-primitive operations and audit Event insertion, server owns route mapping.
  - Existing code already derives Event Scope from Context ownership, so future scoped operational Events fall out naturally after updating `Context.scope_id`.
  - Issue #46 already added the before/after read surfaces needed to prove assignment visibility without changing projection ownership.
  - Existing tests strongly cover Scope/Context/Pulse/Webhook invariants and passed in this worktree.
- Open questions:
  - Whether assignment should accept `assigned_by`/`reason` provenance now or keep metadata minimal; either way the audit Event should include previous and new Scope.
  - Whether already-assigned-to-same-Scope should be a 409 invalid assignment or idempotent success. Recommendation: 409 for this slice to keep the operation strictly unscoped-to-scoped.
  - Whether historical `events.scope_id` should ever be backfilled. Recommendation: not in issue #47; preserve history and rely on Context ownership plus assignment audit Event.
