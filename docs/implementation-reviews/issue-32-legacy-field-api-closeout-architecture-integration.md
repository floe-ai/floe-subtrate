# Architecture Integration Brief: issue-32-legacy-field-api-closeout

> Scope: close out the superseded Field-owned semantic item/connection API surface now that active FloeWeb list/open/render/create/rename/layout uses Scope, Scope Projection, Scope metadata, Pulse subscriber relationships, and projection layout. Do not remove or weaken renderer layout persistence. Remove or hard-disable only the old Field semantic membership/connection model unless current code evidence proves an active path still needs it.

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns the **active substrate**: Scope CRUD/list (`floe-bus\src\server.ts:164-247`), Scope Projection (`server.ts:172-188`, `floe-bus\src\scopes\projection.ts:84-117`), Context/Pulse Scope relationships, and Pulse subscriber mutations (`server.ts:964-970` and the following unsubscribe route).
  - `floe-web` owns the **Field/canvas renderer** in `floe-web\src\main.tsx`, translating Scope Projection through `floe-web\src\scope-projection.ts` and React Flow (`main.tsx:2286-2384`).
  - `@xyflow/react` owns graph/canvas interaction: nodes, handles, edges, pan, zoom, drag, selection, reconnect, delete, MiniMap, Controls, Background (`main.tsx:2344-2374`).
  - Legacy Field semantic APIs are owned by `floe-bus\src\fields-store.ts` and `floe-bus\src\server.ts:280-334,410-429`: `.floe\fields\<id>.yaml` semantic list/load/upsert/delete with `items` and `connections`.
  - Renderer layout sidecars are currently still transported by `floe-bus\src\fields-store.ts:54-71,348-408` and `server.ts:336-389`, but current usage is projection layout keyed by Scope ids and stable projected refs, not Field membership.
- Current owner rationale:
  - `CONTEXT.md:5-27,127-143,151-155`, `docs\adr\0004-scope-as-substrate-organising-boundary.md:5-11`, and `docs\ROADMAP.md:69-84,138-172` agree: Scope is substrate; Field is FloeWeb rendering; Field-owned item/connection lists are superseded.
  - Current code agrees for active paths: FloeWeb lists Scopes via `listScopes` (`main.tsx:1043-1048`), opens projections via `getScopeProjection` (`main.tsx:1066-1088`), creates/renames via `createScope`/`renameScope` (`main.tsx:1914-1939,2011-2025`), and uses Pulse subscriber APIs for projection edges (`main.tsx:1281-1310,1355-1391`).
- Source evidence:
  - Legacy semantic schema still exists with `items`/`connections`: `floe-bus\src\fields-store.ts:29-52`; semantic CRUD functions: `fields-store.ts:222-345,410-429`; server routes: `server.ts:280-334,410-429`.
  - Active projection layout uses `getFieldLayoutOnly`/`putFieldLayout` only (`floe-web\src\main.tsx:934-944,1075-1088,1110-1114,1178-1179,1217-1218,1253-1254`).
  - Active negative-call Playwright guards already expect no legacy semantic Field endpoint requests except layout (`floe-web\tests\helpers.ts:358-397`; `scope-projection.spec.ts:12-96,98-123,153-228,230-319`; `field-substrate.spec.ts:130-255`).

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace Home shows Scopes as Fields and opens a Scope-backed canvas (`main.tsx:2184-2248`).
  - Add Field creates a Scope; Rename Field patches Scope metadata (`main.tsx:1914-1939,2011-2056`).
  - Opening a Field loads Scope Projection plus renderer layout, then renders Context and Pulse nodes and derived Pulse→Context subscriber edges (`scope-projection.ts:201-258`).
  - Context nodes open the existing conversation/sidebar (`main.tsx:2082-2088`); no second conversation UI exists.
  - Projection node drag, viewport movement, and position changes write renderer layout only (`main.tsx:1153-1279`).
  - Projection edge create/delete writes Pulse subscriber APIs, not Field connections (`main.tsx:1281-1310,1355-1391`).
  - Block Library click/drag still creates a Scope-backed Field from Home; nested Field Items are explicitly disabled while Fields render Scope projections (`main.tsx:1999-2009,2045-2080,2468-2499`).
- Behaviors that must remain unchanged:
  - React Flow-native pan, zoom, drag, selection, handles, edge delete/connect, MiniMap, Controls, Background, and canvas performance.
  - Block Library drag/drop affordance unless explicitly redesigned.
  - Node icons, labels, handles, selection, rename, open affordances, Pulse→Context connection affordances, and Context sidebar opening.
  - Layout must remain renderer metadata and must not create, filter, or order membership.
  - Pulse→Context edge edits must continue to mutate Pulse subscribers only; no Field-owned connection graph.
- Runtime or UX evidence:
  - Existing Playwright tests cover list/open/render/create/rename, layout persistence, Pulse→Context connect/disconnect, Context open, and React Flow interactions without legacy semantic requests (`floe-web\tests\scope-projection.spec.ts`, `floe-web\tests\field-substrate.spec.ts`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep using Scope APIs: `GET/POST /v1/workspaces/:workspace_id/scopes`, `PATCH /v1/workspaces/:workspace_id/scopes/:scope_id`, and `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection`.
  - Keep using Pulse subscriber APIs for derived relationship edits: `POST /v1/pulses/:pulse_id/subscribe` and `/unsubscribe`.
  - Keep using existing projection transform helpers in `floe-web\src\scope-projection.ts`, especially stable refs (`context:<id>`, `pulse:<id>`) and edge ids (`pulse-subscriber:<pulse_id>:context:<context_id>`).
  - Keep using React Flow handlers already wired in `main.tsx:2344-2374`; remove dead semantic branches rather than adding alternate DOM/pointer flows.
  - Keep renderer layout helpers (`reactFlowToLayout`, `applyNodeChangesToLayout`) only as layout utilities; do not use `fieldToReactFlow` or `buildSemanticUpdate` for active projection behavior.
- Relevant docs or library capabilities:
  - ADR-0004 (`docs\adr\0004-scope-as-substrate-organising-boundary.md:5-11`) is the governing architecture.
  - `docs\field-substrate-slice-prd.md` is explicitly superseded (`lines 3-7`) but records the old five semantic endpoints (`lines 99-104`), which are the closeout target.
  - Prior #31 brief intentionally reused the layout sidecar transport and warned about `field_id` vs `scope_id` ambiguity (`docs\implementation-reviews\high-confidence-floeweb-pulse-field-fixes-architecture-integration.md:58-61,180`).
- Existing examples in this codebase:
  - Active static/Playwright negative guard pattern: `floe-web\tests\helpers.ts:358-397`.
  - Server layout-without-semantic behavior: `floe-bus\src\fields-server.test.ts:206-242`.
  - Scope Projection API/store tests: `floe-bus\src\scope-projection.test.ts:146-243`.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass `ScopeStore`, `ContextStore`, `BusStore`, or `buildScopeProjection` by reconstructing membership in FloeWeb.
  - Do not replace React Flow with custom canvas interactions.
  - Do not replace the conversation/sidebar open path for Context nodes.
  - Do not replace Pulse subscriber APIs with Field connections for Pulse→Context links.
- Shortcuts or parallel paths to avoid:
  - No compatibility shim that maps old Field Items/Connections to Scope membership, Scope Projection refs, or Pulse subscriber edges.
  - No `.floe\blocks`, no `.floe\fields\<id>.yaml` semantic membership resurrection, no Field-owned canonical connection graph.
  - No route/client alias that keeps `PUT /fields/:field_id` writing `floe.field.v1` while claiming it is Scope-backed.
  - No fallback from Scope list/projection failure to `listFields`/`getField`.
  - No layout-derived membership, hidden visibility flag, or "placed in Field" membership concept.
- Invariants:
  - Use existing React Flow graph/canvas features before hand-rolling interactions.
  - Preserve Block Library drag/drop unless explicitly redesigned.
  - Preserve node icons, labels, handles, selection, pan, zoom, drag, rename, open affordances, and connection affordances.
  - Substrate-backed behavior must integrate into the existing Field/canvas model, not create a separate path.
  - Toolbar shortcuts may supplement canvas flows, not silently replace them.
  - Performance regressions in navigation, pan, zoom, or drag are blockers.
  - Existing working affordances require regression tests before refactor.
  - Active FloeWeb paths use Scope, Scope Projection, Scope metadata, Pulse subscribers, and projection layout only.

## Integration plan

- Insert the change at:
  1. **Bus server: hard-disable legacy semantic routes.**
     - In `floe-bus\src\server.ts`, remove or hard-disable:
       - `GET /v1/workspaces/:workspace_id/fields` (`server.ts:280-291`)
       - `GET /v1/workspaces/:workspace_id/fields/:field_id` (`server.ts:293-309`)
       - `PUT /v1/workspaces/:workspace_id/fields/:field_id` (`server.ts:311-334`)
       - `DELETE /v1/workspaces/:workspace_id/fields/:field_id` (`server.ts:410-429`)
     - Recommended hard-disable response if routes remain: `410 Gone` with `error: "field_semantic_api_superseded"` and message directing callers to Scopes/Scope Projection. Do **not** return semantic data or accept `floe.field.v1` writes.
     - Keep `GET/PUT /v1/workspaces/:workspace_id/fields/:field_id/layout/:renderer` (`server.ts:336-389`) for now, but mark as renderer-layout transport only. It must remain unable to create membership and must continue to allow Scope-backed layout sidecars without semantic files.
  2. **Bus store: remove or quarantine semantic helpers.**
     - Delete or stop exporting `FieldSemanticSchema`, `loadField`, `loadAllFields`, `upsertFieldSemantic`, `deleteField`, and semantic validation helpers from `floe-bus\src\fields-store.ts` if only disabled routes/tests use them.
     - Leave/rename only layout-specific pieces (`FieldLayoutSchema`, `upsertFieldLayout`, `loadFieldLayout`) or move them to a clearer `scope-layout-store`/`projection-layout-store` module if the implementer can do so surgically.
     - If a full module split is too large, leave the file with comments that semantic Field APIs are superseded and only layout functions are active. This is acceptable only if semantic exports/routes are unreachable.
  3. **Bus watcher: remove or hard-disable semantic field watching.**
     - `floe-bus\src\fields-watcher.ts` currently watches `.floe\fields` semantic files and calls `loadField` before broadcasting (`fields-watcher.ts:44-164`). If semantic APIs are closed, remove watcher registration/imports from `server.ts:21,115-128` or restrict it to renderer-layout events if useful.
     - Do not make watcher-created semantic files reappear as active Fields.
  4. **FloeWeb client: remove legacy semantic client surface.**
     - In `floe-web\src\fields-api.ts`, remove or hard-disable `listFields`, `getField`, `putFieldSemantic`, `deleteField`, and `subscribeToFieldEvents`.
     - Keep `parseFieldStreamMessage`, `putFieldLayout`, and `getFieldLayoutOnly` only if comments/tests make clear they are projection layout transport. Alternatively move layout functions to a projection layout API module.
  5. **FloeWeb main: remove dead semantic branches/imports.**
     - `main.tsx` still imports semantic helpers and carries unreachable `loadedField` branches (`main.tsx:57-71,1105-1108,1281-1337,1393-1455,1880-1900,1941-1979,2089-2106`). Remove old branches/state/types if no active path sets `loadedField`.
     - Keep projection branches and React Flow handler wiring intact. `saveOpenFieldSemantic` should disappear rather than silently returning false if all callers are removed.
     - Keep nested Field Item disabled behavior only if the UI can still reach it; otherwise delete dead UI.
  6. **Tests/docs touched by removal.**
     - Replace old `fields-api.test.ts`, `fields-store.test.ts`, and `fields-server.test.ts` semantic expectations with closeout tests asserting 410/removal and layout-only survival.
     - Update comments in files touched so they say Scope is substrate and Field is rendering/projection; avoid reviving superseded Field Item/Connection terminology except in "superseded" warnings.
- Why this is the correct integration point:
  - The old source of truth is exposed by bus routes and client wrappers; closing those surfaces prevents accidental revival while leaving current Scope/Projection/React Flow paths intact.
  - Removing dead FloeWeb semantic branches makes static guards meaningful: active UI cannot call removed functions because they are no longer imported.
  - Keeping layout transport avoids regressing #31 while still closing the semantic item/connection API.
- Alternatives considered and rejected:
  - **Keep semantic routes but hide UI calls**: rejected; tests already hide active calls, but issue #32 is API closeout.
  - **Convert old Field semantic files into Scopes**: rejected; migration/shim would revive Field-owned membership semantics.
  - **Remove layout endpoint together with semantic APIs**: rejected for this slice because current projection layout persists through that transport after #31.
  - **Fallback to old Field list/open when Scope Projection fails**: rejected; parallel path around Scope substrate.

## Regression checklist

- Behavior: Workspace Home still lists Scopes as Fields; Default Scope appears.
- Behavior: Add Field creates a Scope; Rename Field patches Scope metadata.
- Behavior: Open Field fetches Scope Projection and projection layout; no semantic Field GET/list.
- Behavior: Context nodes open the existing conversation/sidebar.
- Behavior: Projection node drag and viewport changes persist renderer layout and do not create `.floe\fields\<id>.yaml`.
- Behavior: Pulse→Context connect/disconnect mutates Pulse subscriber APIs and renders derived edges.
- Behavior: React Flow pan, zoom, drag, selection, handles, delete, connect/reconnect, MiniMap, Controls, Background remain working and performant.
- Behavior: Block Library click/drag remains available; no toolbar-only replacement.
- Behavior: Old semantic routes/functions are removed or return a hard failure; no compatibility shim maps old items/connections to Scopes.
- Behavior: No `.floe\blocks`, Field-owned canonical membership, or Field-owned canonical connection graph is introduced or extended.
- Behavior: Existing docs/code comments touched by the change reflect Scope as substrate and Field as rendering.

## Test plan

- Existing tests to keep green:
  - `npm run test --workspace floe-bus`
  - `npm run test --workspace floe-web`
  - `npm run build`
  - Specifically preserve `floe-web\tests\scope-projection.spec.ts`, `floe-web\tests\field-substrate.spec.ts`, `floe-web\src\scope-projection.test.ts`, `floe-web\src\scope-projection-api.test.ts`, and `floe-bus\src\scope-projection.test.ts`.
- New tests to add before/with implementation:
  - Bus route tests: semantic Field list/get/put/delete return 410 or are absent; layout GET/PUT still works for a Scope id and does not create a semantic file.
  - Bus static/unit guard: no `upsertFieldSemantic`, `loadAllFields`, `loadField`, or `deleteField` is imported by active server code if hard-disabled routes are removed.
  - FloeWeb unit/static guard: `main.tsx` must not import `listFields`, `getField`, `putFieldSemantic`, `deleteField`, `subscribeToFieldEvents`, `fieldToReactFlow`, or `buildSemanticUpdate`.
  - Playwright negative-call guard: active list/open/render/create/rename/layout/connect/disconnect paths still produce no old semantic `/fields` calls; allow only `/fields/:scope_id/layout/floeweb` until a dedicated projection-layout route exists.
  - Filesystem/API guard: projection layout PUT does not create `.floe\fields\<scope_id>.yaml`, and no `.floe\blocks` path is created.
  - React Flow regression: pan/zoom/drag/selection and Pulse→Context connect/delete still pass after semantic branches are removed.
- Live proof required:
  - Start bus/web, open a real workspace, open Default Scope as Field, create/rename a Field (Scope), drag a Context/Pulse node, reload and confirm position persists, connect/disconnect Pulse→Context, and verify no semantic `.floe\fields\<scope_id>.yaml` or `.floe\blocks` is created.
  - Capture browser/network evidence that active requests use `/scopes`, `/scopes/:id/projection`, Pulse subscriber APIs, and layout-only transport; semantic `/fields` list/get/put/delete are not called.

## Risk assessment

- Risk: Removing old helpers may accidentally remove layout transport used by #31.
- Risk: Removing dead semantic branches in `main.tsx` can regress React Flow handlers if projection and semantic branches are tangled.
- Risk: Tests or examples still written for superseded Field semantics will fail and must be updated/deleted as historical, not preserved through shims.
- Risk: `fields-watcher.ts` removal may change external `.floe\fields` live-update behavior. That behavior belongs to superseded semantic Fields; do not keep it alive for membership. If external layout sidecar watching is still desired, implement it as renderer layout only and test it separately.
- Risk: The route name `/fields/:id/layout/floeweb` is still ambiguous. Mitigate with comments/tests; a future slice can move it to `/scopes/:scope_id/layout/floeweb`.
- Mitigation: Make semantic closeout tests explicit, keep layout tests explicit, and run full bus/web/build checks plus live QA.

## Decision confidence

- Confidence: high
- Reasons:
  - Current active FloeWeb paths already use Scope/Projection/Scope metadata/Pulse subscribers and have negative-call tests.
  - Current docs and ADR-0004 are aligned that Field-owned item/connection semantics are superseded.
  - The only active dependency on the old Field route namespace is renderer layout, not semantic membership; this can be preserved while semantic APIs are removed or 410-hard-disabled.
- Open questions:
  - Whether to **remove** semantic routes entirely or keep `410 Gone` hard-disabled responses for clearer client failures. Recommendation: `410 Gone` for one slice if less disruptive to route ordering/tests, but no semantic payloads or writes.
  - Whether to split layout helpers into a renamed projection-layout module now or leave them in `fields-store.ts` with superseded comments. Recommendation: split only if surgical; otherwise quarantine semantic exports and document layout-only survival.
