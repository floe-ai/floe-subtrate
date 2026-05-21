# Architecture Integration Brief: issue-11-field-layout-sidecar-proof

## Existing ownership

- Package/component/module/library:
  - `@xyflow/react` owns canvas node dragging, controlled `onNodesChange`, `onNodeDragStop`, viewport `onMoveEnd`, selection, pan, zoom, edge handles, and keyboard delete affordances (`node_modules\@xyflow\react\dist\esm\types\component-props.d.ts:62-67,105-113,184-188,269-275`; `node_modules\@xyflow\system\dist\esm\types\changes.d.ts:2-24`).
  - `floe-web\src\fields.ts` owns pure Field ↔ React Flow transforms and layout updates: `reactFlowToLayout()` captures node positions/dimensions plus viewport, and `applyNodeChangesToLayout()` applies React Flow position/dimension changes while ignoring select/remove changes (`floe-web\src\fields.ts:165-260`).
  - `floe-web\src\main.tsx` owns FloeWeb Field/canvas wiring, layout save scheduling, semantic save orchestration, Field deletion UI, summaries refresh, and open-view cleanup (`floe-web\src\main.tsx:923-1058,1060-1085,1740-1755,2065-2095`).
  - `floe-web\src\fields-api.ts` owns the FloeWeb bus client; layout must use `putFieldLayout()` and whole-Field deletion must use `deleteField()`, not browser file writes (`floe-web\src\fields-api.ts:204-229`).
  - `floe-bus\src\fields-store.ts` owns `.floe\fields\*.yaml` semantic/layout validation and file I/O. `upsertFieldLayout()` writes only the sidecar; `deleteField()` removes the semantic file and every `<field-id>.layout.*.yaml` sidecar (`floe-bus\src\fields-store.ts:348-402`).
  - `floe-bus\src\server.ts` owns HTTP Field API routes and event broadcasts, including `PUT /layout/floeweb` as `changed: "layout"` and whole-Field `DELETE` as `field.deleted` (`floe-bus\src\server.ts:221-286`).
- Current owner rationale:
  - `CONTEXT.md` defines semantic Field files as authoritative and Field Layout as renderer-specific sidecars; FloeWeb is one renderer, not the source of truth (`CONTEXT.md:78-101`).
  - ADR 0003 rejects inline renderer layout because it couples layout churn to semantic Field diffs (`docs\adr\0003-field-substrate-primitive.md:15-21,23-35`).
  - The product spec says Field canvas work should use React Flow core and must not smuggle in a broader React Flow UI/shadcn/Tailwind migration (`PRODUCT.md:101`; `docs\floe_web_reset_report.md:36-40`).
- Source evidence:
  - Issue #11 is a validation-hardening slice: prove existing React Flow drag/layout and bus delete paths end-to-end. Product code changes are likely unnecessary unless the proof exposes a real bug.
  - Existing tests already cover pure layout transforms, bus layout writes, bus delete sidecars, and some real bus/file Field flows; the apparent missing proof is real FloeWeb node drag causing disk sidecar change without semantic mtime/content churn, plus UI whole-Field delete with sidecar present.

## Existing interaction model

- User/system behaviors that already exist:
  - Opening a Field maps semantic items/connections and optional layout into controlled React Flow nodes/edges (`floe-web\src\fields.ts:165-205`; `floe-web\src\main.tsx:659-689`).
  - React Flow node position/dimension changes route through `handleFieldNodesChange()` to `applyNodeChangesToLayout()`, update local loaded layout, and debounce `putFieldLayout()` (`floe-web\src\main.tsx:981-1045`).
  - React Flow `onNodeDragStop` defensively writes the stopped node's final position into the layout sidecar path (`floe-web\src\main.tsx:1060-1085`).
  - React Flow viewport movement routes through `handleFieldMoveEnd()` and `reactFlowToLayout()` so viewport/layout persistence remains sidecar-only (`floe-web\src\main.tsx:1047-1058`).
  - Whole-Field deletion is the Inspector `Delete field` button, confirms via `window.confirm`, calls bus `DELETE`, clears the open Field view, returns home, and refreshes summaries (`floe-web\src\main.tsx:1740-1755,2131-2140`).
  - Field Item deletion is a separate React Flow selected-node Delete/Backspace flow through `onBeforeDelete`; it updates parent semantic only and must not be confused with whole-Field deletion (`floe-web\src\main.tsx:1151-1207,2073,2083`).
  - Field Connection creation/deletion/reconnection uses React Flow handles/edges and semantic `buildSemanticUpdate()` calls (`floe-web\src\main.tsx:1087-1149,1209-1234,2074-2080`).
- Behaviors that must remain unchanged:
  - Use existing React Flow graph/canvas features before hand-rolling interactions.
  - Preserve Block Library drag/drop unless explicitly redesigned.
  - Preserve node labels, handles, selection, pan, zoom, drag, rename, open, and connection affordances. The current node markup shows labels/handles/kind styling, not a separate icon element; do not introduce or remove iconography as part of #11 (`floe-web\src\main.tsx:206-225`).
  - Substrate-backed behavior must integrate into the existing Field/canvas model, not create a separate path.
  - Toolbar shortcuts may supplement canvas flows, not silently replace them.
  - Performance regressions in navigation, pan, zoom, or drag are blockers.
  - Existing working affordances require regression tests before refactor.
  - Moving an Item must not perform semantic PUTs, mutate `.floe\fields\<field-id>.yaml`, or update its mtime.
  - Deleting a whole Field must not leave stale home summaries or an open deleted Field view.
- Runtime or UX evidence:
  - Mocked Playwright already covers render, viewport restore, Block Library drop, nested navigation, connection create/label/delete/reconnect, selected Field Item delete, and mocked whole-Field delete (`floe-web\tests\field-substrate.spec.ts:46-628`).
  - Real bus Playwright already covers create/delete Field without sidecar, rename preservation, add items, referenced primitive preservation, and external YAML/live sidecar creation (`floe-web\tests\field-substrate.spec.ts:641-1113`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Existing React Flow props on the Field `<ReactFlow>`: `onNodesChange`, `onNodeDragStop`, `onMoveEnd`, `onDrop`, `onDragOver`, `onBeforeDelete`, `onEdgesDelete`, `onConnect`, and `onReconnect` (`floe-web\src\main.tsx:2065-2095`).
  - Existing debounced layout save path: `scheduleFieldLayoutSave()` → `sendFieldLayoutSave()` → `putFieldLayout()` (`floe-web\src\main.tsx:981-1007`).
  - Existing local-layout-write suppression for event-stream echo handling: `markLocalLayoutWrite()` / `hasRecentLocalLayoutWrite()` and the field event subscription (`floe-web\src\main.tsx:968-979,1245-1265`).
  - Existing bus/client APIs: `PUT /fields/:id/layout/floeweb` for layout and `DELETE /fields/:id` for whole-Field deletion (`floe-web\src\fields-api.ts:204-229`; `floe-bus\src\server.ts:246-286`).
  - Existing real bus Playwright setup patterns in `floe-web\tests\field-substrate.spec.ts`: `createBusServer`, workspace creation through the UI, direct YAML inspection, and real file assertions (`floe-web\tests\field-substrate.spec.ts:641-1113`).
- Relevant docs or library capabilities:
  - React Flow provides node drag stop, controlled node changes, viewport move end, and delete key handling; #11 should exercise these capabilities rather than custom DOM/key/file hacks (`node_modules\@xyflow\react\dist\esm\types\component-props.d.ts:62-67,105-113,184-188,269-275`).
  - `NodeChange` includes `position`, `dimensions`, `select`, and `remove`; the current layout helper intentionally persists only position/dimensions (`node_modules\@xyflow\system\dist\esm\types\changes.d.ts:2-24`; `floe-web\src\fields.ts:230-260`).
  - The Field PRD says layout writes never modify semantic files and whole-Field delete removes semantic plus all matching layout sidecars (`docs\field-substrate-slice-prd.md:84-102,125`).
- Existing examples in this codebase:
  - `fields.test.ts` already asserts `reactFlowToLayout()` and `applyNodeChangesToLayout()` behavior, including no-op select/remove changes (`floe-web\src\fields.test.ts:229-281`).
  - `fields-store.test.ts` already asserts sidecar writes do not change semantic mtime and that `deleteField()` removes multiple renderer sidecars (`floe-bus\src\fields-store.test.ts:175-236`).
  - `fields-server.test.ts` already asserts layout PUT writes sidecars, delete removes semantic + sidecar, and layout PUT broadcasts a layout change (`floe-bus\src\fields-server.test.ts:190-248,308-348`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not add document-level drag/key handlers, direct DOM transforms, synthetic hidden controls, test-only product code, or browser-direct filesystem writes.
  - Do not bypass React Flow `onNodesChange`, `onNodeDragStop`, `onMoveEnd`, selection, handles, pan, zoom, drag, edge gestures, `Controls`, or `MiniMap`.
  - Do not bypass `reactFlowToLayout()` or `applyNodeChangesToLayout()` for layout shape.
  - Do not bypass `putFieldLayout()` / `DELETE /fields/:id` / bus Field APIs from FloeWeb.
  - Do not bypass `floe-bus\src\fields-store.ts` for sidecar discovery/deletion.
- Shortcuts or parallel paths to avoid:
  - Do not make movement a semantic `PUT /fields/:id`.
  - Do not directly edit `.floe\fields\<field-id>.layout.floeweb.yaml` from FloeWeb or tests as the proof of user movement.
  - Do not call Field Item deletion (`onBeforeDelete` semantic update) when proving whole-Field deletion.
  - Do not replace canvas drag proof with toolbar coordinates, mocked request-only assertions, or direct helper calls.
  - Do not introduce a second renderer layout path, a second canvas model, inline semantic layout, or a `.floe\blocks\` storage path.
- Invariants:
  - Semantic source of truth is `.floe\fields\<field-id>.yaml`; FloeWeb layout is `.floe\fields\<field-id>.layout.floeweb.yaml`.
  - Layout sidecars may change positions, dimensions, and viewport only; semantic items/connections/timestamps must remain unchanged on move/viewport persistence.
  - Whole-Field delete removes the semantic file and every matching `.layout.*.yaml` sidecar.
  - Home summaries and open view state must reflect deletion immediately after the bus delete succeeds.
  - Existing React Flow-native canvas behavior and performance are protected; any regression in pan/zoom/drag/navigation blocks #11.

## Integration plan

- Insert the change at:
  - Primary work should be tests/proof in `floe-web\tests\field-substrate.spec.ts`, adjacent to the current real bus/file-backed Field tests, because #11 is a validation-hardening slice.
  - Keep `floe-web\src\fields.test.ts`, `floe-bus\src\fields-store.test.ts`, and `floe-bus\src\fields-server.test.ts` green; only add unit coverage if a missing pure invariant appears during implementation.
  - Product code changes are likely unnecessary unless the real proof exposes a real bug in the existing React Flow → layout API → bus → disk chain or Field delete cleanup.
- Why this is the correct integration point:
  - Acceptance requires the integrated UI path and disk evidence. Real bus Playwright is the narrowest proof that movement flows through React Flow and the bus layout API without touching semantic YAML.
  - Bus unit/server tests already prove store/server sidecar mechanics; the missing risk is FloeWeb's real UI path.
  - Keeping the proof inside the existing Field substrate spec preserves regression coverage for rename, item creation, connection creation/deletion, and prior Field slices in the same user-visible surface.
- Recommended automated proof shape:
  - Start a real bus and real workspace through existing Playwright setup; seed or create a Field with at least one item and an existing `.layout.floeweb.yaml` sidecar.
  - Open the Field in FloeWeb; record semantic file contents and `mtimeMs`; drag the React Flow node using Playwright's canvas/node locator, not direct DOM style mutation or direct sidecar writes.
  - Wait for the debounced layout save and assert the layout sidecar item position changed on disk; assert semantic file contents and mtime remain unchanged.
  - If testing viewport persistence, pan/zoom through React Flow interaction and assert only `PUT /layout/floeweb`/sidecar viewport changes, not semantic PUT/file churn.
  - For delete proof, create a Field with semantic file plus at least `.layout.floeweb.yaml` and another matching sidecar such as `.layout.cli.yaml`; open it, delete via Inspector `Delete field`, accept confirmation, then assert every matching file is gone, home has no stale card, empty state/summaries update, and no deleted Field view remains open.
  - Keep request monitoring to distinguish `PUT /layout/floeweb`, semantic `PUT /fields/:id`, and `DELETE /fields/:id`.
- Alternatives considered and rejected:
  - Directly call `putFieldLayout()` or `deleteFieldApi()` from a test without UI: rejected because it would not prove React Flow/user affordance integration.
  - Simulate movement by editing `loadedField` state or YAML: rejected as a parallel path around React Flow and the bus API.
  - Add a toolbar "save layout" or "move item" control: rejected because toolbar shortcuts may supplement but not replace canvas flows, and #11 is not a UX redesign.
  - Rewrite layout persistence: rejected unless current proof fails; existing ownership and tests show the correct production path already exists.

## Regression checklist

- Behavior: React Flow node drag updates `.layout.floeweb.yaml` with the new item position.
- Behavior: React Flow node drag does not change semantic Field YAML contents or semantic file `mtimeMs`.
- Behavior: viewport/pan/zoom persistence continues to use only `PUT /layout/floeweb` and the layout sidecar.
- Behavior: `reactFlowToLayout()` and `applyNodeChangesToLayout()` pure tests remain green, including no-op select/remove changes.
- Behavior: whole-Field delete with one or more layout sidecars removes semantic file and every matching `.layout.*.yaml` sidecar.
- Behavior: whole-Field delete clears `loadedField`, returns FloeWeb home, refreshes Field summaries, and leaves no open deleted Field view.
- Behavior: whole-Field delete is distinct from selected Field Item deletion and does not use React Flow item delete handlers.
- Behavior: rename preserves id/filename/items/connections/layout; Field Item creation keeps stable refs; Connection create/delete/reconnect stays React Flow-native; prior Field slice tests remain green.
- Behavior: Block Library drag/drop, node labels/handles/selection, pan, zoom, drag, nested open/back, edge labels, Controls, and MiniMap remain unchanged.
- Behavior: no performance regression in Field open, pan, zoom, or drag.

## Test plan

- Existing tests to keep green:
  - `floe-web\src\fields.test.ts`, especially `reactFlowToLayout()` and `applyNodeChangesToLayout()` coverage (`floe-web\src\fields.test.ts:229-281`).
  - `floe-web\src\fields-api.test.ts`, especially `putFieldLayout()`, `deleteField()`, and Field event parsing (`floe-web\src\fields-api.test.ts:125-161,164-220`).
  - `floe-bus\src\fields-store.test.ts`, especially layout sidecar mtime separation and multi-sidecar delete (`floe-bus\src\fields-store.test.ts:175-236`).
  - `floe-bus\src\fields-server.test.ts`, especially layout PUT, DELETE semantic+layout, and layout event broadcast (`floe-bus\src\fields-server.test.ts:190-248,308-348`).
  - `floe-web\tests\field-substrate.spec.ts` prior Field slice coverage: render, viewport restore, Block Library drop, nested navigation, connections, Field Item deletion, real bus create/delete/rename/add/ref preservation/live rendering (`floe-web\tests\field-substrate.spec.ts:46-1113`).
- New tests to add before/with implementation:
  - Real bus/file-backed Playwright: drag a React Flow Field Item node and assert sidecar position changes while semantic contents and `mtimeMs` remain unchanged. Monitor requests to ensure layout API only.
  - Real bus/file-backed Playwright: optional viewport/pan/zoom persistence assertion if not naturally covered by node drag side effects; ensure semantic file is untouched.
  - Real bus/file-backed Playwright: delete a whole Field with `.layout.floeweb.yaml` plus at least one additional `.layout.<renderer>.yaml`; assert all matching files are removed and FloeWeb home/summaries/open view are clean.
  - If a product bug is found, add the smallest failing test first, fix only through the existing owners above, then keep the real bus proof.
- Live proof required:
  - Run the real bus + FloeWeb path and capture evidence: before/after semantic file contents, before/after semantic `mtimeMs`, before/after layout sidecar YAML position/viewport, observed request methods/URLs, and post-delete directory listing.
  - Capture user-visible proof after delete: home view with no stale Field card or empty state as appropriate, and no open deleted Field heading/inspector.
  - Avoid screenshots/artifacts containing tokens or secrets. Do not commit ad hoc QA artifacts unless explicitly requested.

## Risk assessment

- Risk: Playwright drag might move a node visually but not wait long enough for the 300 ms debounced layout save.
- Risk: React Flow emits both `onNodesChange` and `onNodeDragStop`; request assertions must tolerate the intended layout debounce while still rejecting semantic PUTs.
- Risk: a viewport move caused by opening/dragging could create sidecar writes that obscure the item-position assertion.
- Risk: filesystem timestamp precision on Windows can make mtime assertions flaky if setup and drag happen too close together.
- Risk: sidecar delete proof could accidentally prove bus store behavior only if it calls the API directly rather than using FloeWeb's Inspector delete.
- Risk: current docs mention old test naming (`field-block.spec.ts`) while current code uses `field-substrate.spec.ts`; follow current code/tests as source of truth (`docs\field-substrate-slice-prd.md:175`; `floe-web\tests\field-substrate.spec.ts:1-1114`).
- Mitigation:
  - Use `expect.poll()` for sidecar file contents and semantic mtime/content stability; insert a small delay before drag if necessary to separate mtimes.
  - Record and clear request arrays after initial open/settling so only movement/delete traffic is assessed.
  - Assert the item-specific sidecar coordinates changed, not merely that a layout file exists.
  - Use UI delete for whole-Field deletion, then inspect disk and UI state.
  - Do not change product code unless the proof exposes a real failure in the production path.

## Decision confidence

- Confidence: high
- Reasons:
  - Current architecture already has the intended React Flow hooks, pure layout transforms, bus layout API, and bus sidecar deletion mechanics.
  - Existing unit/server tests cover most lower-level invariants; #11 can focus on the missing real FloeWeb → bus → disk proofs.
  - The user's instruction to leverage React Flow aligns with existing production code and prior integration briefs (#9, #12, #13).
- Open questions:
  - Whether live QA evidence should be committed or kept as session artifact. Recommendation: keep ad hoc live QA evidence out of product code unless explicitly requested.
  - Whether viewport persistence needs a separate Playwright scenario beyond node movement. Recommendation: add a focused assertion if the drag proof does not clearly exercise `onMoveEnd`.
