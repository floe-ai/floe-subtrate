# Architecture Integration Brief: issue-46-scope-projection-workspace-context-discovery

## Existing ownership

- Package/component/module/library:
  - `floe-bus\src\scopes\projection.ts` owns Scope Projection construction. It currently derives only scoped Context and Pulse refs from `ContextStore.listContextsForScope(workspaceId, scopeId)` and `BusStore.listPulses({ workspace_id, scope_id })`.
  - `floe-bus\src\contexts\store.ts` owns Context persistence and read models: nullable `scope_id`, participants, first-message previews, participant indexes, and scoped Context indexes.
  - `floe-bus\src\server.ts` owns public HTTP routing and serialization for Context APIs, Scope APIs, Scope Projection APIs, and error mapping.
  - `floe-web\src\main.tsx` owns Workspace Home, Field rendering, Actor channel state, and current browser orchestration for Context fetching.
  - `floe-web\src\contexts.ts` owns pure Actor-channel Context helpers such as Context labels, actor-pair filtering, and emit body construction.
  - `floe-web\src\scope-projection-api.ts` owns Scope/Projection client calls and must remain scoped-only.
- Current owner rationale:
  - Scope Projection is a read-only view of one real Scope; it must not become the Workspace-level Context discovery source.
  - Context discovery is a Context read-model concern, so workspace-level listing belongs beside existing `ContextStore.listContextsForParticipant` and `ContextStore.listContextsForScope`, then exposed through `server.ts`.
  - Workspace Home is the correct UI surface for Workspace-level discovery because domain docs define it as an index/dashboard, not a Scope or Field.
  - FloeWeb Actor conversations already have a separate helper/API path; issue #46 should extend that Context discovery path rather than overloading Field or React Flow state.
- Source evidence:
  - `CONTEXT.md:9-15` defines Workspace-level Contexts as actor-participant Contexts with no Scope and Scoped Contexts as Contexts with non-null `scope_id`.
  - `CONTEXT.md:25-31` defines Scope Projection as read-only and Field Layout as renderer state that must not determine membership.
  - `CONTEXT.md:131-149` says Workspace Home is an index/dashboard, Scope Projection derives visible primitives, Contexts may be unscoped when actor-participant anchored, Events derive Scope from Context/source ownership, and Actors are workspace-scoped rather than Field-contained.
  - `docs\adr\0004-scope-as-substrate-organising-boundary.md:40-54` explicitly rejects Default Scope product behavior and says unscoped actor Contexts remain discoverable through Workspace, Actor, and Context views.
  - `docs\adr\0004-scope-as-substrate-organising-boundary.md:69-72` requires nullable Context Scope and Scope Projection limited to real scoped substrate records.
  - `floe-bus\src\scopes\projection.ts:84-116` currently builds projections from scoped Contexts/Pulses only.
  - `floe-bus\src\contexts\store.ts:117-144` enforces Context validity through Scope or participants, and `floe-bus\src\contexts\store.ts:199-250` owns participant/scoped Context list queries.
  - `floe-bus\src\server.ts:648-673` exposes `/v1/contexts` but currently requires `participant`, so it supports Actor views but not a Workspace-level Context index.
  - `floe-web\src\main.tsx:660-671` fetches Contexts for the operator participant only, then `floe-web\src\contexts.ts:65-85` filters them for the selected Actor.
  - `floe-web\src\main.tsx:1739-1807` renders Workspace Home as a Field index only today.

## Existing interaction model

- User/system behaviors that already exist:
  - A user can register/open a Workspace, view Workspace Home, create/open Fields, and open a Field backed by a Scope Projection.
  - Workspace Home lists Fields derived from Scopes via `listScopes` and `scopeToFieldSummary`; it does not currently list unscoped Contexts.
  - Actor-channel refresh calls `/v1/contexts?participant=<operator>&workspace_id=<workspace>` and keeps only Contexts where the operator and selected Actor both participate.
  - Scope Projection renders scoped Contexts as top-level Field refs and deliberately does not render individual Events as separate Field blocks.
  - Context APIs serialize `scope_id` already, so clients can distinguish Workspace-level Contexts (`scope_id: null`) from scoped Contexts once a workspace-level listing exists.
  - Bus anchor logic already allows actor-participant Contexts with nullable Scope and rejects actorless scopeless Contexts through `ContextStore.createContext`.
- Behaviors that must remain unchanged:
  - A Scope Projection for Scope `A` must not include unscoped actor Contexts or records from Scope `B`.
  - `default` must not reappear as a hidden Scope, fake Field, fallback Scope id, or Workspace Home substitute.
  - Field/canvas behavior must preserve React Flow-native pan/zoom/drag, node icons/labels/handles/selection, Block Library drag/drop, rename/open affordances, and connection affordances.
  - Existing Actor-channel Context filtering must continue to show only Contexts relevant to the selected Actor conversation.
  - Context membership must remain bus-owned; FloeWeb must not infer substrate membership from Field layout, React Flow nodes, or local UI lists.
  - Existing scoped Pulse, Webhook, and event-source operational flow rules from ADR-0004 must remain intact.
- Runtime or UX evidence:
  - No live server/browser was started by this scout; evidence is from current code, tests, and docs.
  - Current tests cover scoped Scope Projection behavior in `floe-bus\src\scope-projection.test.ts` and Actor-channel Context helper behavior in `floe-web\src\contexts.test.ts`.
  - Stale UX/test terminology remains: `floe-web\src\scope-projection-api.test.ts:25-59`, `119-153`, and `158-177` use `scope_id: "default"` fixtures and "Default Scope"; `floe-web\src\main.tsx:2567-2576` marks a fallback projection Scope as `is_default` when `projection.scope_id === "default"`.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add a ContextStore workspace read model, e.g. `listContextsForWorkspace(workspace_id, options)`, reusing the same `ContextListRow` shape as participant and scoped lists.
  - Expose workspace discovery through a bounded workspace route such as `GET /v1/workspaces/:workspace_id/contexts?scope=unscoped|scoped|all`, or a carefully bounded `/v1/contexts` extension that requires `workspace_id` when `participant` is omitted. Prefer the workspace route for clearer ownership and no behavior change to the existing participant route.
  - Reuse the existing Context serialization shape from `/v1/contexts`: `context_id`, `workspace_id`, `scope_id`, parent/creator timestamps, participants, and `first_message_preview`.
  - Keep Scope Projection client calls in `floe-web\src\scope-projection-api.ts` scoped-only; add a small Context discovery client/helper instead of reusing Scope Projection APIs.
  - In FloeWeb, integrate Workspace-level Context discovery into `renderHome` as another index section or tab, without changing Field/React Flow code paths.
  - Use existing pure helper style in `floe-web\src\contexts.ts` for sorting/filtering/labeling Workspace Context summaries before wiring React UI.
- Relevant docs or library capabilities:
  - Zod is already used in `server.ts` for query/path validation.
  - SQLite indexes already support `contexts(workspace_id, scope_id, created_at)` and participant lookups (`floe-bus\src\contexts\store.ts:93-111`), so workspace Context listing can be implemented without schema changes unless product requirements add search/pagination beyond the current slice.
  - React Flow is the existing Field/canvas library and should not be touched for Workspace Home Context discovery unless the agreed UX explicitly changes canvas behavior.
- Existing examples in this codebase:
  - `ContextStore.listContextsForParticipant` and `listContextsForScope` provide the query/row-mapping pattern to copy for workspace-level listing.
  - `/v1/workspaces/:workspaceId/scopes` and `/v1/workspaces/:workspaceId/scopes/:scopeId/projection` show the route ownership pattern for workspace-bounded read APIs.
  - `floe-web\src\contexts.ts` and `floe-web\src\contexts.test.ts` show how to isolate browser-free Context list semantics.
  - `floe-web\src\main.tsx:979-1032` shows the existing refresh pattern for Workspace Home/Field data.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass `ContextStore` with raw Context SQL in `server.ts` or FloeWeb-specific routes.
  - Do not change `buildScopeProjection` into a Workspace projection or Context index.
  - Do not store Context membership in Field layout, React Flow node state, `.floe/fields`, or FloeWeb local storage.
  - Do not duplicate Actor-channel sorting rules in React components when a pure helper can own them.
  - Do not bypass `ScopeStore`/Scope APIs or reintroduce Default Scope handling.
- Shortcuts or parallel paths to avoid:
  - Do not make `participant` optional on `/v1/contexts` in a way that permits unbounded global Context listing.
  - Do not represent unscoped Contexts by setting `scope_id: "default"` or rendering a "Default Field".
  - Do not filter Workspace Home Contexts client-side from only the operator participant list if the intended index is workspace-level; that misses Contexts the operator is not in.
  - Do not have Scope Projection return unscoped Contexts so Workspace Home can "find" them.
  - Do not touch Field canvas interactions to solve a Workspace Home index problem.
- Invariants:
  - Scope Projection remains scoped-only and substrate-derived.
  - Workspace Home remains a Workspace index/dashboard, not a Scope, Field, or canvas.
  - Actor-participant Contexts may be unscoped and discoverable at Workspace/Actor/Context surfaces.
  - Actorless Contexts and generated operational flows still require a real Scope.
  - `default` remains reserved stale compatibility cleanup only.
  - Events continue deriving `scope_id` from Context/source ownership, not from client UI state.

## Integration plan

- Insert the change at:
  1. Add `ContextStore.listContextsForWorkspace(workspace_id, options?: { scope?: "all" | "scoped" | "unscoped"; limit?: number })` in `floe-bus\src\contexts\store.ts`, using the same `ContextListRow` mapper as existing list methods.
  2. Add/extend a bounded HTTP read API in `floe-bus\src\server.ts`. Preferred route: `GET /v1/workspaces/:workspace_id/contexts?scope=unscoped|scoped|all&limit=...`. Keep existing `/v1/contexts?participant=...` behavior unchanged for Actor views.
  3. Add bus tests proving:
     - workspace Context discovery returns unscoped actor Contexts in that Workspace;
     - it does not return another Workspace's Contexts;
     - `scope=unscoped` excludes scoped Contexts and `scope=scoped` excludes unscoped Contexts;
     - existing participant `/v1/contexts` still requires/uses `participant`.
  4. Add a Scope Projection regression in `floe-bus\src\scope-projection.test.ts` with one unscoped actor Context and one scoped Context in the same Workspace, asserting only the scoped Context appears in `/scopes/:scope_id/projection`.
  5. Add a FloeWeb Context discovery API/helper if UI work is in scope; keep it separate from `scope-projection-api.ts` unless that file is renamed/split.
  6. Update `floe-web\src\main.tsx` Workspace Home to display Workspace-level Context discovery as an index section if issue #46 includes visible UI, preserving the current Fields section and Field open behavior.
  7. Remove stale Default Scope fixtures/flags in touched tests and helpers: use real Scope ids such as `research`/`ops`, and make `projectionScopeFallback` return `is_default: false` or remove the fallback field if the type allows.
- Why this is the correct integration point:
  - The store/server route makes Context discovery authoritative, testable, and reusable by future Workspace/Context views without contaminating Scope Projection or Field rendering.
  - Workspace Home is already the Workspace-level index surface and can consume Context summaries without changing canvas semantics.
  - Keeping Actor-channel Context APIs separate preserves the existing selected-Actor interaction model.
- Alternatives considered and rejected:
  - Add unscoped Contexts to Scope Projection: rejected because it violates ADR-0004 and makes Scope Projection no longer scoped-only.
  - Revive Default Scope/Default Field for unscoped Contexts: rejected by ADR-0004 and current `ScopeStore` reserved-id behavior.
  - Client-side discovery from `/v1/contexts?participant=<operator>`: rejected for Workspace Home because it is not a Workspace index and hides valid Contexts where the operator is not a participant.
  - Direct SQL route in `server.ts`: rejected because it bypasses `ContextStore` ownership and would duplicate row mapping.

## Regression checklist

- Behavior: Existing Scope Projection tests remain green and projections include only records whose `scope_id` equals the requested real Scope.
- Behavior: Existing `/v1/contexts?participant=...` Actor-channel behavior remains green and does not become an unbounded global list.
- Behavior: Workspace-level Context discovery returns unscoped actor Contexts with `scope_id: null` and participants intact.
- Behavior: Workspace-level Context discovery is bounded by Workspace id and cannot leak Contexts across Workspaces.
- Behavior: Workspace Home still opens Fields and Field canvas interactions remain unchanged.
- Behavior: No new code path creates, requires, routes through, or labels a hidden Default Scope.

## Test plan

- Existing tests to keep green:
  - `floe-bus` Scope/Context/Pulse tests, especially `floe-bus\src\scope-projection.test.ts`, Context resolver/store tests, and server Context API tests.
  - `floe-web` tests for Context helpers and Scope Projection API client.
- New tests to add before/with implementation:
  - Bus test for `ContextStore.listContextsForWorkspace` ordering/filtering and workspace isolation.
  - Server test for the new workspace Context discovery route and serialization of `scope_id: null`.
  - Scope Projection regression showing an unscoped actor Context in the same Workspace is absent from a real Scope Projection.
  - FloeWeb pure-helper test for any new Workspace Home Context sorting/filtering/labeling behavior.
  - FloeWeb API test that removes `Default Scope`/`scope_id: "default"` fixtures from Scope Projection client coverage.
- Live proof required:
  - Start bus and FloeWeb locally.
  - Register/open a Workspace.
  - Create at least one unscoped actor Context and one scoped Context.
  - Verify the Workspace Context discovery endpoint returns the unscoped Context with `scope_id: null`.
  - Verify the Scope Projection endpoint for a real Scope does not return the unscoped Context.
  - If UI is implemented, capture a browser screenshot or Playwright evidence showing Workspace Home lists/discovers the Workspace-level Context while the Field view still renders the scoped projection normally.

## Risk assessment

- Risk: Making `participant` optional on `/v1/contexts` could accidentally expose global Context listing or change Actor-channel assumptions.
- Risk: UI changes could blur Workspace Home, Scope, Field, and Context terminology, reintroducing Default Scope semantics.
- Risk: Adding Workspace Home Context cards could accidentally route through Field/canvas code and regress React Flow interactions.
- Risk: Existing tests and fixtures use `default` as a Scope id, making stale behavior look legitimate.
- Mitigation:
  - Prefer a workspace-bounded Context route and keep participant route behavior unchanged.
  - Add scoped-only Scope Projection regressions before UI wiring.
  - Keep Workspace Home Context discovery as list/index UI outside React Flow.
  - Replace touched Default Scope fixtures with real named Scopes and assert `scope_id: null` for Workspace-level Contexts.

## Decision confidence

- Confidence: high
- Reasons:
  - Backend ownership boundaries are clear: Context discovery belongs in `ContextStore`/`server.ts`; Scope Projection remains in `scopes\projection.ts`.
  - Current docs and ADRs are explicit that Workspace Home is not Scope/Field and Default Scope must not be preserved as product behavior.
  - Existing code already separates Actor-channel Context helpers, Scope Projection client calls, and Workspace Home/Field rendering.
  - The testable invariant is straightforward: Workspace Context discovery may include unscoped actor Contexts; Scope Projection must not.
- Open questions:
  - Exact Workspace Home UX for Context discovery is a product choice: list all Workspace Contexts, only unscoped Contexts, or a tab/filter for all/scoped/unscoped.
  - Pagination/search limits for large Context indexes are not yet designed; implement a bounded default limit for this slice rather than a broad search system.
  - Whether to add a new `floe-web\src\context-discovery-api.ts` or colocate a small helper with `contexts.ts` should be decided during implementation based on existing import shape.
