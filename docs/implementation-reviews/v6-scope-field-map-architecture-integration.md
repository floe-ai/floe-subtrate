# Architecture Integration Brief: v6-scope-field-map

## Existing ownership

- Package/component/module/library:
  - `floe-web\src\main.tsx` owns the production FloeWeb shell, Workspace topbar switch/create/delete, Home composition, left navigation, Block Library placement, Field opening, React Flow Field surface, Inspector, transitional Channel, and App-level bus refresh/state (`main.tsx:870-915`, `main.tsx:1163-1216`, `main.tsx:1880-2030`, `main.tsx:2272-2369`, `main.tsx:2899-3030`).
  - `@xyflow/react` owns the Field/canvas mechanics already in production: `ReactFlow`, `ReactFlowProvider`, `Handle`, custom node/edge types, `onNodesChange`, `onEdgesChange`, `onBeforeDelete`, `onEdgesDelete`, `onMoveEnd`, `onNodeDragStop`, `onConnect`, `Controls`, `MiniMap`, pan, zoom, selection, drag, handles, and edge hit targets (`main.tsx:27-48`, `main.tsx:216-255`, `main.tsx:2329-2359`, `main.tsx:3294-3298`).
  - `floe-web\src\scope-projection-api.ts` owns Scope/Projection/list/create/rename/layout bus calls; it uses `/v1/workspaces/:workspace_id/scopes`, `/projection`, and `/projection/layout/floeweb`, not legacy Field endpoints (`scope-projection-api.ts:93-170`).
  - `floe-web\src\scope-projection.ts` owns mapping substrate Scope Projection refs and relationships into React Flow nodes/edges, including Context nodes, Pulse nodes, and Pulse-to-Context subscriber edges (`scope-projection.ts:201-258`).
  - `floe-web\src\fields.ts` owns renderer-only Field layout sidecars and explicitly does not own semantic Field membership or connection updates (`fields.ts:1-5`, `fields.ts:49-63`, `fields.ts:88-142`).
  - `floe-web\src\contexts.ts` owns Context labels, assignment status, sorting, and emit body semantics for the existing Channel/Context path (`contexts.ts:33-153`).
  - `floe-web\src\styles.css` owns production visual tokens and React Flow theming; it imports `@xyflow/react/dist/style.css` and already styles `.react-flow`, handles, nodes, edges, controls, minimap, canvas empty state, and shell surfaces (`styles.css:1-45`, `styles.css:1252-1387`).
- Current owner rationale:
  - The slice is a visual/interaction pass over the existing substrate-backed Field surface. Field is a renderer view of Scope Projection; Scope membership and graph relationships are bus-owned and projection-owned, while the browser owns presentation and renderer-only layout.
  - Recent parity work already moved Workspace switch/create/delete into the topbar and Home into v6 composition. The Scope/Field pass should continue inside the same `main.tsx` state/actions and CSS owner rather than introduce a second app shell or canvas path.
  - React Flow is already integrated, tested, and used for the affordances this slice must preserve. Replacing it with the mock's SVG map would bypass the current owner and regress tested interactions.
- Source evidence:
  - Existing umbrella brief `docs\implementation-reviews\v6-feature-complete-shell-architecture-integration.md` identifies Scope Field visual pass as sub-slice 3 and requires styling the existing React Flow tree, not replacing it (`v6-feature-complete-shell-architecture-integration.md:87-115`, `v6-feature-complete-shell-architecture-integration.md:150-163`).
  - `mocks\v6\THEME.md` says the v6 mocks are hand-authored HTML/CSS and a port contract, not a runtime/component-library owner (`THEME.md:1-19`).
  - The user-provided example filenames `mocks\v6\scope-writing.html` and `mocks\v6\scope-map.js` do not exist in the reference checkout; the available implementation reference is `mocks\v6\scope.html`. Treat this as a source-path mismatch, not a product requirement to create those mock files.

## Existing interaction model

- User/system behaviors that already exist:
  - Users open a named Scope from Home or left nav via `openField(scope_id)`; opening clears field editing state, switches `view` to `{ kind: "field" }`, and loads Scope Projection plus `floeweb` renderer layout (`main.tsx:1795-1801`, `main.tsx:1186-1207`, `main.tsx:1491-1503`).
  - Field nodes and edges are derived from `projectionToReactFlow`, not from client-owned graph state (`main.tsx:870-905`, `scope-projection.ts:201-258`).
  - Node selection is tracked from React Flow `NodeChange` events; node positions and viewport persist only to renderer layout sidecars with debounced `putScopeProjectionLayout` (`main.tsx:1258-1301`, `main.tsx:1303-1329`, `main.tsx:1441-1469`).
  - Pulse-to-Context connection uses React Flow handles and `onConnect`, then calls `subscribePulse`; Backspace/Delete on selected edges calls `unsubscribePulse` through existing edge deletion callbacks (`main.tsx:1331-1418`).
  - Context nodes preserve an `Open` button and double-click/open path into the existing Channel/Context event flow (`main.tsx:216-249`, `main.tsx:1844-1851`, `main.tsx:2599-2897`).
  - Block Library drag/drop currently exists in Field view and Home surface drop handling: dragging/clicking the Field primitive calls the existing Scope creation path, and React Flow receives `onDrop`/`onDragOver` (`main.tsx:1821-1842`, `main.tsx:2345-2346`, `main.tsx:2490-2521`, `main.tsx:3014-3022`).
- Behaviors that must remain unchanged:
  - Named Scope/Field surfaces must stay substrate-backed through Scope Projection and renderer layout; no `.floe/blocks`, field-owned membership, fake graph state, local mock data, or legacy `/fields` endpoint may be introduced.
  - Home must remain a Workspace index, not a hidden/default Scope; no default scope fallback or visible `Default Scope` / `Default Field` product concept may leak into v6 flows.
  - Actors remain workspace-scoped endpoints/participants and must not become draggable map nodes.
  - Node icons/labels/handles/selection, pan, zoom, drag, rename, open, and connection affordances are existing working behavior and need regression coverage before any refactor.
  - Toolbar shortcuts such as Map/Ops/Fit/Center may supplement canvas flows but must not silently replace React Flow canvas interactions.
- Runtime or UX evidence:
  - Current production Field is a generic React Flow canvas with toolbar, rename action, Block Library column, background dots, controls, minimap, custom nodes, handles, empty state, and right Inspector (`main.tsx:2272-2369`, `styles.css:1197-1387`).
  - The v6 mock `scope.html` uses a hand-rolled SVG map with hardcoded `MAP_LAYOUT`, fake shared data, and custom pan/zoom (`scope.html:306-465`). Its visual direction is useful, but its interaction implementation is explicitly a bypass candidate for production.
  - The mock includes event diamonds and Map/Ops mode (`scope.html:61-98`, `scope.html:244-264`, `scope.html:467-525`), while current `projectionToReactFlow` only renders Context and Pulse nodes and Pulse-to-Context edges even though Projection types include `events` and `activity` refs (`scope-projection.ts:39-76`, `scope-projection.ts:219-257`). Adding event/activity map nodes would be a behavior/contract expansion and needs tests, not a CSS-only copy.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep App-level state/actions in `main.tsx`: `selectedWorkspaceId`, `view`, `fieldSummaries`, `scopeRecords`, `loadedProjection`, `selectedFieldItemIds`, `selectedFieldConnectionId`, `workspaceContexts`, `contexts`, `events`, `telemetry`, `channelOpen`, `openField`, `refreshOpenField`, `renameScope`, `createScope`, `openProjectedContext`, `subscribePulse`, `unsubscribePulse`, and layout save callbacks.
  - Use `projectionToReactFlow` as the sole source of React Flow nodes/edges. If visual metadata is needed, add it to projection node `data` or derived presentational props without changing substrate ownership.
  - Use `FieldItemNode` / `fieldNodeTypes` and `FieldConnectionEdgeComponent` / `fieldEdgeTypes` for visual node/edge styling. Prefer additional CSS classes and React Flow props over new DOM/SVG map rendering.
  - Use React Flow built-ins already present: `Background`, `Controls`, `MiniMap`, `Handle`, default viewport, `setViewport`, pan/zoom props, selection classes, interaction paths, and node/edge callbacks.
  - Use `scope-projection-api.ts` for all Scope/Projection/layout API access and `pulse-api.ts` for Pulse subscriber mutations.
  - Use `contexts.ts` helpers for labels and Context semantics; do not duplicate Context ownership inside the Field map.
  - Use `floe-web\tests\helpers.ts` route harness and existing Playwright patterns for v6 and React Flow regression tests.
- Relevant docs or library capabilities:
  - React Flow supports custom nodes, handles, controls, minimap, background, pan/zoom, draggable nodes, selectable edges, and fit/viewport controls. These are already installed in `package.json` via `@xyflow/react` and imported in `main.tsx`.
  - The v6 token/source contract is in `mocks\shared\tokens.css`, `mocks\v6\linear-calm.css`, and `mocks\v6\v6.css`; production already has dark `oklch` token mappings in `styles.css`. Translate visual language rather than importing mock runtime files wholesale.
  - Older product docs such as `docs\floe_web_product_spec.md` mention an empty Field with bottom Inspector (`floe_web_product_spec.md:371-377`), but current code and v6 shell use a right Inspector. Current code/runtime wins.
- Existing examples in this codebase:
  - `field-substrate.spec.ts` protects React Flow rendering, no legacy `/fields`, Context Open, non-overlap, create/rename through Scope APIs, and pan/zoom/selection/drag behavior (`field-substrate.spec.ts:130-255`).
  - `scope-projection.spec.ts` protects Scope opening without legacy Fields, renderer layout persistence, and Pulse-to-Context connect/delete through subscriber APIs (`scope-projection.spec.ts:12-96`, `scope-projection.spec.ts:153-228`, `scope-projection.spec.ts:230-321`).
  - `v6-shell-frame.spec.ts`, `v6-feature-shell.spec.ts`, and `v6-channel-preservation.spec.ts` protect the topbar/Home/left nav/Inspector/Channel substrate contract and no Default leakage in v6 flows.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not replace `@xyflow/react` with the mock's hand-rolled SVG map, custom pan/zoom, custom edge hit targets, or independent selection store.
  - Do not duplicate `floe-bus` Workspaces, Scopes, Contexts, Events, runtime bindings, telemetry, Pulse subscribers, or Scope Projection in client-only mock data.
  - Do not import or execute `floe-web-examples\mocks\shared\data.js`, `mocks\v6\scope.html`, or mock JS/CSS as production runtime islands.
  - Do not revive `/v1/workspaces/:id/fields`, `.floe/blocks`, or any Field-owned membership/storage model.
  - Do not bypass `scope-projection-api.ts`, `scope-projection.ts`, `fields.ts`, `contexts.ts`, `pulse-api.ts`, or DialogHost.
- Shortcuts or parallel paths to avoid:
  - No hidden `Default`, `default`, `Default Scope`, `Default Field`, `Home Scope`, or fallback scope for v6 acceptance.
  - No parallel Scope/Context ownership in the map rail/legend/inspector; Context state must stay bus-backed and helper-backed.
  - No toolbar-only create/open/connect paths that remove drag/drop, handles, double-click/open, selection, or keyboard delete behavior.
  - No fake event diamonds/activity nodes just to match `scope-writing.png`; if added, they must be derived from real Scope Projection refs or real bus event/telemetry APIs.
- Invariants:
  - Use existing React Flow graph/canvas features before hand-rolling interactions.
  - Preserve Block Library drag/drop unless explicitly redesigned.
  - Preserve node icons, labels, handles, selection, pan, zoom, drag, rename, open, and connection affordances.
  - Substrate-backed behavior must integrate into the existing Field/canvas model, not create a separate path.
  - Toolbar shortcuts may supplement canvas flows, not silently replace them.
  - Performance regressions in navigation, pan, zoom, or drag are blockers.
  - Existing working affordances require regression tests before refactor.

## Integration plan

- Insert the change at:
  1. Add/adjust tests first around named Scope Field v6 map acceptance using non-default named Scope fixtures (`scope_writing` / `Writing System`) and existing route helpers. Assert no `/fields`, no Default text, real `/scopes/:id/projection`, `.react-flow`, handles, controls/minimap/background, drag/selection/pan/zoom, rename/open, and Pulse subscriber connect/delete still work.
  2. Keep `renderField()` as the production insertion point. Recompose its shell to look like the v6 `scope-writing.png` direction: stable v6 topbar crumb, left nav with scope-local Context list if derived from real projection, main map stage, right Inspector, lightweight Map/Ops/Fit/Center affordances, and v6 legend. The canvas inside the stage remains `<ReactFlow>`.
  3. Update `FieldItemNode` and `FieldConnectionEdgeComponent` presentation to carry v6 node shapes/metadata. Prefer CSS classes based on `data-kind` and existing `node.data` fields. Preserve `Handle` placement and `canvas-node-action` open affordance.
  4. Update `styles.css` for v6 map chrome, React Flow background, node/edge colors, legend, and toolbar. Do not import mock CSS blindly; map token values into existing `oklch` token system.
  5. If event/activity visual nodes are required for parity, extend `projectionToReactFlow` deliberately to include `projection.refs.events` / `refs.activity` only when the bus projection contract is sufficient, and add unit + E2E coverage. Otherwise show a deferred/unsupported visual affordance and do not fake nodes.
  6. Preserve Block Library drag/drop by either keeping it available in Field view or moving it behind an explicit, tested create affordance that still supports drag/drop onto the React Flow surface.
- Why this is the correct integration point:
  - `renderField()`, `FieldItemNode`, `projectionToReactFlow`, and `styles.css` are the current production owners of the Scope Field map surface; changing them preserves data ownership and avoids a parallel map.
  - The existing App state already owns all API calls and interaction callbacks, so presentational component extraction is safe if props are fed from existing state/actions.
  - React Flow already provides the canvas interaction contract and is protected by tests; v6 visual alignment should be implemented as React Flow composition and theming.
- Alternatives considered and rejected:
  - Port `scope.html` wholesale: rejected because it uses static `MAP_LAYOUT`, shared mock data, hand-rolled SVG pan/zoom, fake mock actions, and a local selection store.
  - Create a separate `ScopeMap` canvas outside React Flow: rejected because it duplicates the Field owner and would lose existing handles, selection, drag, layout persistence, and Pulse subscriber tests.
  - Hide old affordances with CSS to match the screenshot: rejected because Block Library drag/drop, open, rename, handles, and keyboard delete are required behaviors.
  - Infer Scope membership or event/activity graph client-side from workspace events: rejected unless backed by an explicit bus/projection contract and tests.

## Regression checklist

- Behavior:
  - Opening a named Scope still fetches Scope Projection and `layout/floeweb`; Home does not fetch projection and no legacy `/fields` requests occur.
  - React Flow remains visible and interactive; pan, zoom, drag, selection, handle connection, edge selection/delete, node open, double-click/open, viewport restore, and layout persistence still work.
  - Rename and create still call Scope APIs; duplicate titles remain allowed through bus-generated Scope ids.
  - Block Library drag/drop or its explicitly approved replacement remains tested and user-visible.
  - Context node Open and projected Context event loading continue through the existing Channel/Context path.
  - No v6 flow leaks `Default Scope`, `Default Field`, fake graph state, `.floe/blocks`, or field-owned membership.
- Behavior:
  - Workspace topbar switch/create/delete and Home v6 composition from commit `a7954f4` remain unchanged.
  - Left nav keeps Home, Activity placeholder, Scopes, New Scope, Actors, and actor selection behavior unless intentionally redesigned in a separate slice.
  - Right Inspector continues to show Workspace/Actor/Opened Field metadata and runtime controls.
- Behavior:
  - Map visual changes do not degrade navigation, pan, zoom, drag, or selection performance.
  - Dark-mode node/edge/handle contrast remains sufficient; edge hit targets remain large enough for delete/reconnect operations.
  - Browser console has no relevant errors and no failed network requests during live Scope map QA.

## Test plan

- Existing tests to keep green:
  - `cd floe-web && npm run test:unit`
  - Targeted E2E: `floe-web\tests\field-substrate.spec.ts`, `floe-web\tests\scope-projection.spec.ts`, `floe-web\tests\v6-shell-frame.spec.ts`, `floe-web\tests\v6-feature-shell.spec.ts`, `floe-web\tests\v6-channel-preservation.spec.ts`
  - Full `cd floe-web && npm run build && npm run test:e2e` before merge when runtime permits.
- New tests to add before/with implementation:
  - `v6-scope-field-map.spec.ts`: seed a named non-default Scope with Context + Pulse projection, open it from Home/nav, assert v6 map shell landmarks, `.react-flow`, node label/metadata, handles, controls/minimap/background, no Default text, no `/fields`, and no mock imports.
  - Add/extend Field substrate regression for v6-styled nodes: selected class remains visible, Context `Open` button remains clickable, long labels do not overlap the Open affordance, handles retain `.connectionindicator`.
  - Add/extend layout/interaction regression: drag a node, verify `PUT /projection/layout/floeweb`; pan/zoom or Fit/Center must update/restore viewport without semantic writes.
  - Add/extend Pulse connection regression after visual changes: drag from Pulse source handle to Context target handle, verify `subscribePulse`; select edge and Backspace, verify `unsubscribePulse`.
  - If Map/Ops toggle lands, test Map keeps React Flow mounted/interactable and Ops is either real substrate-backed content or explicitly disabled/deferred without altering graph state.
- Live proof required:
  - Run FloeWeb locally at `http://127.0.0.1:5378/`, open a real named Scope, and capture screenshot evidence against `C:\Development\ai-powered\floe-web-examples\screenshots\scope-writing.png`.
  - Capture browser console and network proof: no relevant console errors, no failed bus requests, no `/fields`, no mock reference imports, expected `/scopes`, `/projection`, `/projection/layout/floeweb`, Pulse subscriber, and Context events endpoints.
  - Manually verify pan, zoom, drag, selection, handles/connection/delete, rename, open Context, and Block Library drag/drop on the live surface.

## Risk assessment

- Risk:
  - Styling or recomposing the Field surface can accidentally hide React Flow handles, reduce edge hit targets, break keyboard delete, or obscure the Context Open button.
- Risk:
  - Copying the mock map too literally can introduce fake `MAP_LAYOUT`, event diamonds, static data, or custom SVG pan/zoom that bypass the substrate and React Flow.
- Risk:
  - The current projection renderer ignores `events` and `activity` refs. Visual parity with `scope-writing.png` may tempt a fake graph or an unreviewed projection contract expansion.
- Risk:
  - Moving Block Library or Field toolbar controls for visual alignment can silently remove tested drag/drop, create, rename, and Channel entry points.
- Risk:
  - Existing tests still seed default scopes for non-v6 substrate regressions, while this v6 slice forbids Default leakage. New v6 tests must use named Scope fixtures and scoped assertions.
- Mitigation:
  - Test first around existing affordances, keep `ReactFlow` as the canvas, style via CSS/classes, and treat any event/activity node expansion as a separate tested projection change if real data is insufficient.
  - Preserve existing callbacks and API helpers; do not add new bus paths or local graph stores.
  - Use named Scope fixtures in v6 tests while leaving older default-seeded substrate tests intact unless they conflict with v6 acceptance.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership boundaries are clear in current code: `main.tsx` owns UI state/actions, `@xyflow/react` owns canvas behavior, `scope-projection*` owns substrate-to-flow mapping and API calls, `fields.ts` owns renderer layout only, and `styles.css` owns visuals.
  - Existing E2E/unit tests already protect the most important substrate and React Flow affordances, so the implementation can proceed test-first without guessing.
  - The main architectural decision is straightforward: adapt v6 visuals onto the existing React Flow Field surface rather than porting the mock's hand-rolled SVG map.
- Open questions:
  - How close should this slice get to mock event diamonds/Ops mode? Recommendation: ship the v6 map shell and style existing real Context/Pulse projection first; only add event/activity nodes if backed by current projection data and tests.
  - Should Block Library remain as a left Field column or move into a map toolbar/drawer? Recommendation: keep or relocate only with explicit tests preserving drag/drop and create behavior.
  - Should Scope-local Context list appear in the left nav during this slice? Recommendation: add only if derived from loaded Scope Projection refs; do not query or own parallel Context state.
