# Architecture Integration Brief: field-create-duplicate-scope-id

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns Scope persistence, ID uniqueness, default Scope creation, Scope metadata mutation, and the HTTP Scope contract:
    - `GET /v1/workspaces/:workspace_id/scopes` lists Scopes.
    - `POST /v1/workspaces/:workspace_id/scopes` creates a Scope and returns `201 { scope }` or `409 { error: "scope_already_exists", workspace_id, scope_id }` when an explicit `scope_id` already exists.
    - `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` returns the Scope Projection rendered by FloeWeb.
    - `PATCH /v1/workspaces/:workspace_id/scopes/:scope_id` renames/describes the Scope.
  - `floe-bus\src\scopes\store.ts` owns the database invariant: `(workspace_id, scope_id)` is the primary key. `ScopeStore.createScope` accepts an optional `scope_id`; if omitted it generates `scope_${randomUUID()}`.
  - `floe-web\src\scope-projection-api.ts` owns the browser Scope client and currently exposes `createScope(busUrl, workspaceId, { scope_id?, title, description? })`.
  - `floe-web\src\main.tsx` owns the user-facing Field creation flow: `promptCreateField` opens the global dialog; `createField` currently derives `scope_id = slugifyFieldId(nextName)`, calls `createScope`, refreshes the Scope-backed Field list, navigates to the new Field, and fetches the empty projection canvas.
  - `floe-web\src\dialog\dialog.tsx` owns inline dialog validation/loading/error rendering. It catches thrown `onConfirm` errors and shows them inline in the existing global dialog.
  - `@xyflow/react` owns Field/canvas interaction primitives; this slice should not touch canvas ownership except as regression surface.
- Current owner rationale:
  - ADR-0004 and the Scope-first correction say Scope is substrate and Field is a FloeWeb projection/rendering of Scope. Scope IDs and uniqueness are substrate concerns; FloeWeb should create a Scope through the Scope API and render the returned record, not maintain a separate Field identity source.
  - The reproduced failure is not a persistence bug: the bus is correctly enforcing uniqueness for a client-supplied `scope_id`. The product bug is that FloeWeb's Scope-backed Field creation path still deterministically converts a human title into a Scope id, causing duplicate titles to collide.
- Source evidence:
  - `floe-web\src\main.tsx:1897-1915` derives `const scopeId = slugifyFieldId(nextName)` and posts `{ scope_id: scopeId, title: nextName }`.
  - `floe-web\src\main.tsx:1932-1943` uses `promptDialog` and `onConfirm: ({ value }) => createField(value, { throwOnError: true })`, so thrown API messages surface inline in the dialog.
  - `floe-web\src\scope-projection-api.ts:53-64` supports `createScope` with optional `scope_id`.
  - `floe-bus\src\scopes\store.ts:93-118` generates `scope_${randomUUID()}` only when `input.scope_id` is omitted and throws `ScopeAlreadyExistsError` for explicit duplicates.
  - `floe-bus\src\server.ts:189-217` maps duplicate explicit ids to HTTP 409 `scope_already_exists`.
  - Live artifact `field-create-variants.json` shows first create succeeds with `duplicate-scope-1779591611594`, while duplicate title posts the same id and receives 409. `field-create-duplicate-repro.png` shows the raw POST error inside the existing dialog.

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace Home lists Scopes as Fields with the existing Field list cards and `Add field` button.
  - `Add field` opens the global `New Field` dialog with a `Field name` text input, `Cancel`, and `Create`.
  - Successful create posts to `/v1/workspaces/:workspace_id/scopes`, refreshes the list, opens the created Scope as a Field, and fetches `/projection` for an empty Scope Projection canvas.
  - Duplicate-title create currently keeps the dialog open and shows the raw `POST ... 409 {"error":"scope_already_exists"...}` error; that is the behavior to fix.
  - Rename uses `PATCH /scopes/:scope_id`; the title changes but the existing `scope_id` remains stable.
  - The open Field surface continues to use React Flow nodes/edges, MiniMap, Controls, Background, pan, zoom, selection, drag, node double-click/open, and the existing sidebar conversation path for Context nodes.
  - Block Library click/drag currently supplements Field creation; nested Field Items are disabled while Fields render Scope projections.
- Behaviors that must remain unchanged:
  - `Cancel` in the `New Field` dialog writes nothing.
  - Empty or whitespace-only input still falls back to `Field ${fieldSummaries.length + 1}` unless intentionally redesigned later.
  - Successful create still opens the returned Scope's Field canvas and uses the returned `scope.scope_id` for navigation/projection fetch.
  - FloeWeb active list/open/render paths must keep using Scope APIs only and must not call legacy `/fields` APIs.
  - Bus 409 semantics for an explicitly requested duplicate `scope_id` must remain intact for API clients; do not silently reinterpret explicit ids.
  - Rename must remain metadata-only and must not regenerate IDs.
  - Existing global dialog shell, focus behavior, loading state, inline error slot, accessible labels, and `dialog-layer` test hooks remain.
  - Field/canvas invariants:
    - Use existing React Flow graph/canvas features before hand-rolling interactions.
    - Preserve Block Library drag/drop unless explicitly redesigned.
    - Preserve node icons, labels, handles, selection, pan, zoom, drag, rename, open, and connection affordances.
    - Substrate-backed behavior must integrate into the existing Field/canvas model, not create a separate path.
    - Toolbar shortcuts may supplement canvas flows, not silently replace them.
    - Performance regressions in navigation, pan, zoom, or drag are blockers.
    - Existing working affordances require regression tests before refactor.
- Runtime or UX evidence:
  - `field-create-variants.json` confirms clean create reaches the empty Scope Projection canvas, and duplicate title remains on Workspace Home with the raw dialog error.
  - `field-create-duplicate-repro.png` confirms the user-visible defect is the raw API error in the existing global dialog, not an error bar or canvas failure.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Preferred create extension point: call existing `createScope` without `scope_id` from FloeWeb's root Field creation path, allowing `ScopeStore.createScope` to allocate a bus-owned stable id.
  - Continue using `ScopeRecord` returned by the bus as the source of truth for navigation (`scope.scope_id`) and display (`scope.title`).
  - Continue using `refreshFields(workspaceId)` / Scope list refresh after create.
  - Continue using `refreshOpenField(workspaceId, scope.scope_id)` to open the created projection.
  - Use `ScopeProjectionApiError.status` and `.body` only if friendly error formatting is added for residual Scope API failures. Do not parse raw error strings from `.message`.
  - Use the existing `promptDialog` `input.validate` hook for local empty-name or duplicate-title validation only if product chooses to block duplicate titles; the approved slice is to fix duplicate-title setup error, so duplicate titles should be allowed unless a future product decision says otherwise.
  - Use existing Playwright `seedAppWithScopes` route mocks and extend them to emulate bus duplicate behavior or generated IDs as needed.
  - Use existing bus tests in `floe-bus\src\scopes-server.test.ts` if bus behavior is touched; preferred plan does not require bus changes.
- Relevant docs or library capabilities:
  - `docs\adr\0004-scope-as-substrate-organising-boundary.md` establishes Scope as substrate and Field as rendering. Layout/UI must not determine membership.
  - `docs\scope-substrate-slice-prd.md` says users can create a Scope with title/purpose, FloeWeb lists Scopes as Fields, and Field rendering queries bus-derived Scope state.
  - Prior brief `docs\implementation-reviews\issue-29-floeweb-consumes-scope-projection-architecture-integration.md` says `Add field` creates a Scope via `POST /scopes`, rename uses `PATCH /scopes/:id`, and active list/open/render must not invoke legacy Field semantic APIs.
  - Fastify/zod route capability already permits optional `scope_id`; no framework change is needed.
- Existing examples in this codebase:
  - `ScopeStore.createScope` already has the exact bus-generated-id extension point (`input.scope_id ?? scope_${randomUUID()}`).
  - `field-substrate.spec.ts` and `scope-projection.spec.ts` already test create/rename through Scope APIs and legacy-field endpoint avoidance.
  - `helpers.ts::seedAppWithScopes` already keeps an in-memory Scope store and can be tightened to reject duplicate explicit ids or to generate unique ids when no id is supplied.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not reintroduce legacy Field-owned semantic membership or `/v1/workspaces/:workspace_id/fields*` for creation, list, open, render, rename, or duplicate handling.
  - Do not create a parallel client-side Scope store or ID registry that becomes authoritative over the bus.
  - Do not change Scope Projection or derive membership client-side to work around creation.
  - Do not replace the global dialog; reuse its inline error/validation mechanism and improve the message only where necessary.
  - Do not replace React Flow canvas behavior, Block Library drag/drop, node rendering, handles, selection, pan/zoom/drag, rename/open affordances, or connection affordances.
  - Do not add a second create flow that bypasses `promptCreateField`/`createField` and posts directly elsewhere.
- Shortcuts or parallel paths to avoid:
  - Avoid changing the bus to auto-suffix an explicitly provided duplicate `scope_id`; explicit IDs are an API contract and 409 is correct.
  - Avoid client-only preflight as the sole fix. A preflight against `fieldSummaries` can be stale and does not handle concurrent creates.
  - Avoid retry loops that keep posting deterministic slug ids unless there is a strong reason to preserve slug-like Scope ids. Retry-on-409 is at best a fallback for explicit-id clients, not the primary FloeWeb path.
  - Avoid making duplicate titles invalid unless product explicitly decides titles must be unique. The current Scope schema has no unique title index, and duplicate human titles can legitimately map to distinct Scope records.
  - Avoid surfacing raw HTTP method/URL/body strings to users for expected create conflicts.
- Invariants:
  - Field === Scope projection in FloeWeb.
  - Scope ids are stable substrate ids and must not change on rename.
  - The bus remains the final authority for Scope identity and uniqueness.
  - Default Scope remains `default`, singular, bus-owned, and non-deletable.
  - Layout and React Flow state remain renderer metadata only.
  - Existing Field/canvas affordances and performance remain protected.

## Integration plan

- Insert the change at:
  1. `floe-web\src\main.tsx::createField`.
     - Stop deriving and sending `scope_id` for the normal FloeWeb `Add field` flow.
     - Call `createScope(busUrl, workspaceId, { title: nextName })` and use the returned `scope.scope_id` for `setView` and `refreshOpenField`.
     - Keep `nextName` fallback behavior unchanged.
  2. Optional but recommended in `floe-web\src\main.tsx` or a small helper near the create path:
     - If `createScope` still throws a `ScopeProjectionApiError` with `status === 409` and body `{ error: "scope_already_exists" }`, convert it to a user-facing sentence such as `A Scope with that id already exists. Try again or choose another name.` This is defensive only; the normal path should no longer hit 409 because it omits `scope_id`.
     - Do not replace all API errors with vague messages; unexpected errors should remain diagnosable in the existing dialog/error surfaces.
  3. `floe-web\tests\helpers.ts::seedAppWithScopes`.
     - Make the mock mirror real bus semantics: if POST omits `scope_id`, generate a unique id; if POST includes a duplicate explicit `scope_id`, return 409 `scope_already_exists`.
     - This prevents tests from masking the real duplicate-id behavior again.
  4. `floe-web\tests\scope-projection.spec.ts` and/or `floe-web\tests\field-substrate.spec.ts`.
     - Add a regression test that creates two Fields with the same title from the UI and verifies two Scope-backed Field entries exist, the second creation opens an empty projection, no raw POST error appears, and no legacy Field endpoint is called.
     - Assert the create POST body for the normal UI path does not include `scope_id` if the recommended bus-generated-id approach is implemented.
- Why this is the correct integration point:
  - The bug is introduced exactly where FloeWeb derives `scope_id` from a title for the Scope-backed Field create path. The bus already provides a unique-id mechanism when `scope_id` is omitted, so the smallest architectural correction is to stop overriding the substrate owner.
  - This preserves the existing HTTP API, ScopeStore uniqueness invariant, global dialog flow, Scope list/projection rendering, and React Flow canvas path.
- Alternatives considered and rejected:
  - **Generate a unique Scope id preflight in FloeWeb**: rejected as the primary fix. It keeps identity derivation in the renderer, can be stale under concurrent creates, and duplicates bus uniqueness logic. It is acceptable only if product explicitly requires readable slug ids; then pair it with a 409 retry.
  - **Retry on 409 with `-2`, `-3`, ... suffixes**: rejected as the primary fix. It handles races better than preflight but still makes FloeWeb an ID allocator. Use only as a defensive fallback if explicit ids remain required.
  - **Use bus-generated ids**: recommended. The bus already owns the optional-id behavior, eliminates title collisions and races, preserves duplicate titles, and aligns with Scope-first ownership.
  - **Change bus behavior to auto-suffix explicit duplicate ids**: rejected. It would weaken the explicit-id API contract and make a request for a specific id silently create a different id.
  - **Make Scope title unique or block duplicate titles in the dialog**: rejected for this slice. The schema and PRD do not require unique titles, and the user approved fixing duplicate-title setup rather than forbidding it.

## Regression checklist

- Clean first-create path still succeeds from Workspace Home: dialog opens, user enters a title, Scope is created via `/scopes`, list refreshes, the new Field opens.
- Duplicate-title create succeeds and produces a distinct Scope record, not a raw 409 dialog.
- Create POSTs from the FloeWeb UI use Scope APIs only and do not call legacy Field endpoints.
- The Field list still renders Default Scope and user-created Scopes as Field cards.
- Opening the created Field still fetches `/scopes/:scope_id/projection` and shows the empty Scope Projection canvas.
- Rename still uses `PATCH /scopes/:scope_id`, updates the title, keeps the same `scope_id`, and refreshes list/canvas metadata.
- Existing global dialog behavior remains: cancel writes nothing, focus returns, Enter/Escape behavior works, inline errors remain available.
- Bus explicit duplicate `scope_id` still returns 409 `scope_already_exists` for API clients.
- React Flow Field/canvas remains unchanged: pan, zoom, selection, drag, handles, labels, icons, connection affordances, MiniMap, Controls, Background, node open, and Block Library click/drag/drop continue to work.
- No performance regressions in navigation, pan, zoom, or node drag.

## Test plan

- Existing tests to keep green:
  - `npm run test:unit --workspace floe-web` for pure transform/client coverage.
  - `npm run test:e2e --workspace floe-web -- scope-projection.spec.ts` and/or the targeted Playwright project command used by this repo.
  - `floe-web\tests\scope-projection.spec.ts` existing tests: list/open without legacy Field calls; create/rename through Scope APIs.
  - `floe-web\tests\field-substrate.spec.ts` existing Scope-backed Field UI tests, especially React Flow pan/zoom/selection/drag protection.
  - `npm run test --workspace floe-bus -- scopes-server.test.ts` if any bus route/store behavior is changed. Preferred implementation should not require bus changes, but the explicit 409 contract should stay covered.
- New tests to add before/with implementation:
  - Playwright: `Add field` twice with the exact same title. Expected: two Field cards with that title (or an unambiguous count), no inline raw `POST ... 409` text, second create opens a heading with that title and an empty Scope Projection canvas, and `legacyFieldRequests` remains `[]`.
  - Playwright/request assertion: normal UI create POST body omits `scope_id` and includes the title.
  - Helper/mock regression: `seedAppWithScopes` returns 409 for duplicate explicit `scope_id`, proving tests can reproduce the old failure if code sends deterministic duplicate ids.
  - Optional unit/helper test if a friendly Scope API error formatter is introduced: 409 `scope_already_exists` maps to a human-readable sentence rather than raw method/URL/body.
- Live proof required:
  - Start real `floe-bus` and `floe-web` against a clean test workspace.
  - Create a Field named e.g. `Duplicate Scope Live QA`; verify it appears in the Field list and opens an empty Scope Projection canvas.
  - Return to Workspace Home, create another Field with the exact same title; verify no raw 409 dialog appears, a second Scope-backed Field exists, and the second Field opens an empty Scope Projection canvas.
  - Capture a screenshot equivalent to the previous repro showing success, plus network evidence that POST `/scopes` succeeded and projection was fetched for the returned unique `scope_id`.

## Risk assessment

- Risk: Existing users/tests may have expected human-readable slug Scope ids from FloeWeb-created Fields.
  - Mitigation: Treat `scope_id` as stable opaque substrate identity in UI; continue showing the human title prominently. If readable ids are a product requirement, use preflight+retry with suffixes only after explicit approval.
- Risk: Duplicate titles in the list may be visually ambiguous.
  - Mitigation: This slice should fix setup failure first. If ambiguity hurts UX, add a later UI affordance (secondary id/created time) without making titles unique.
- Risk: Tests may keep masking bus behavior if mocks always accept duplicate explicit ids.
  - Mitigation: Tighten `seedAppWithScopes` to mirror real 409 semantics.
- Risk: Friendly error mapping could hide useful diagnostics for unexpected failures.
  - Mitigation: Special-case only known `ScopeProjectionApiError.status === 409`/`scope_already_exists`; leave unknown errors diagnostic.
- Risk: Accidentally touching legacy Field creation/nested Field logic could regress disabled nested behavior or old canvas code paths.
  - Mitigation: Limit implementation to root Scope-backed create; preserve `createNestedFieldItem` disabled path and existing guards that return early when `loadedProjectionRef.current` exists.
- Risk: Canvas regressions from unrelated edits.
  - Mitigation: Do not edit React Flow handlers or projection renderer for this slice; run existing canvas regression tests.

## Decision confidence

- Confidence: high
- Reasons:
  - The reproduced failure has a direct code cause: deterministic title slug is sent as an explicit Scope id.
  - The bus already has the desired unique-id extension point when `scope_id` is omitted.
  - The recommended change is local to FloeWeb's create path and test mocks; it preserves bus contracts and Scope-first ownership.
  - Existing tests already cover most surrounding behavior and need only a focused duplicate-title regression.
- Open questions:
  - Product may later prefer readable slug-like Scope ids over opaque bus-generated ids. That is a UX/identity decision outside this bug fix; if required, choose preflight+409-retry suffixing deliberately and document the trade-off.
  - Duplicate Field titles may need disambiguation in the UI later, but they should not block creation in this slice.
