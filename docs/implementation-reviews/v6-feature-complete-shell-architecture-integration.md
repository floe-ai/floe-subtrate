# Architecture Integration Brief: v6-feature-complete-shell

## Existing ownership

- Package/component/module/library:
  - `floe-web\src\main.tsx` owns the current production shell, Workspace selection/create/delete, Workspace Home, left navigation, Block Library, Scope/Field opening, React Flow Field surface, Inspector, transitional Channel, actor selection, Context opening, runtime binding controls, and App-level API refresh state (`main.tsx:351-462`, `main.tsx:1525-1535`, `main.tsx:1904-2906`).
  - `floe-web\src\styles.css` owns current v6 token mapping and visual treatment. It already imports `@xyflow/react/dist/style.css` and defines dark shell tokens/classes (`styles.css:1-143`).
  - `floe-web\src\contexts.ts` owns Context labels/sorting/assignment eligibility and `buildEmitBody`; do not duplicate Workspace-level vs scoped Context semantics in JSX (`contexts.ts:33-153`).
  - `floe-web\src\scope-projection-api.ts`, `scope-projection.ts`, and `fields.ts` own Scope API calls, Scope Projection-to-React Flow mapping, Pulse subscriber edge mutation helpers, and renderer layout sidecars (`scope-projection-api.ts:93-170`, `scope-projection.ts:201-258`, `fields.ts:1-142`).
  - `@xyflow/react` owns Field/canvas interaction: `ReactFlow`, `Handle`, node/edge types, `onNodesChange`, `onConnect`, `onMoveEnd`, `onNodeDragStop`, selection, controls, minimap, pan/zoom, and handles (`main.tsx:27-48`, `main.tsx:2169-2200`).
  - `floe-bus` owns canonical Workspaces, Scopes, Contexts, Events, endpoints/actors, runtime bindings, telemetry, Pulse subscribers, Scope Projection and layout APIs, and WebSocket refresh events (`server.ts:148-178`, `server.ts:272-344`, `server.ts:346-380`, `server.ts:426-587`, `server.ts:633-790`, `server.ts:807-825`, `server.ts:1006-1047`).
  - The v6 examples under `C:\Development\ai-powered\floe-web-examples\mocks\v6\` and `mocks\shared\` own visual/reference intent only. `THEME.md` explicitly says the mocks are hand-authored HTML/CSS, not a component-library/runtime owner (`THEME.md:1-19`).
- Current owner rationale:
  - Product/domain docs define FloeWeb as a bus-backed operator UI. Browser code must not read/write workspace files directly or create runtime paths around `floe-bus`/`floe-bridge` (`PRODUCT.md:17-45`).
  - Workspace Home is a top-level index, not a Scope; Field is a FloeWeb rendering of a Scope; Actors are workspace-scoped, not Field-owned (`PRODUCT.md:30-32`, `PRODUCT.md:58-72`, `CONTEXT.md:131-149`).
  - Current live proof `issue-58-live-current.png` shows the failure mode: the production app has a dark partial adaptation but still behaves/looks like a prior substrate-safe shell, with workspace list in the left rail, Block Library consuming persistent space, a visible `Default` Scope, and no brand-adjacent Workspace dropdown/create affordance.
- Source evidence:
  - `docs\implementation-reviews\v6-ui-shell-migration-architecture-integration.md`, `issue-56-workspace-home-v6-surface-architecture-integration.md`, and `issue-57-transitional-channel-preservation-architecture-integration.md` established safe first slices, but #58 was only live acceptance for those partial slices, not final feature-complete v6 UI.
  - GitHub issue #58 is still scoped as “Slice 1.4 - Live v6 shell acceptance and review” and is blocked by #57, confirming mismatch with the newly clarified end-to-end expectation.
  - v6 screenshots show a persistent topbar with Floe brand + brand-adjacent Workspace selector, left nav with Home/Activity/Scopes/Actors, a main Home surface with workspace settings, actor strip, Scope cards, recent activity stream, a right metadata Inspector, a Scope map canvas, a Context stream surface, and an Activity stream surface.

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace registration/opening uses `POST /v1/workspaces/register`; switching uses `POST /v1/workspaces/:workspace_id/select`; current UI exposes these as a left-rail list plus bottom path input (`main.tsx:1525-1535`, `main.tsx:2813-2850`).
  - Home currently lists Scope-backed Fields from `listScopes()`, unscoped Workspace-level Contexts from `/v1/workspaces/:id/contexts?scope=unscoped&limit=6`, and actors from `/endpoints` (`main.tsx:699-724`, `main.tsx:1144-1152`, `main.tsx:1904-2110`).
  - Named Scopes open as Fields through `openField(scope_id)` and load bus Scope Projection + renderer layout; layout changes save only `projection/layout/floeweb` sidecars (`main.tsx:1167-1197`, `main.tsx:1239-1310`, `main.tsx:1772-1778`).
  - React Flow nodes can be opened, selected, dragged, positioned, panned/zoomed; Pulse-to-Context edges call Pulse subscriber APIs; delete/backspace on valid edges unsubscribes (`main.tsx:1312-1414`, `main.tsx:2169-2200`).
  - Home actor cards update inspector only; inspector Context participation can open the transitional Channel; Home Context Open and projected Context Open reuse existing Channel/event paths (`main.tsx:763-784`, `main.tsx:1937-1974`, `main.tsx:2213-2260`, `main.tsx:2440-2737`).
  - Sending through Channel uses `buildEmitBody` and `POST /v1/events/emit`; it does not create a direct runtime path (`main.tsx:1654-1683`, `contexts.ts:131-153`).
- Behaviors that must remain unchanged:
  - Workspace Home must not become a hidden/default Scope and must not load Scope Projection until a named Scope is opened.
  - Direct actor Contexts may remain unscoped; actorless/operational streams must be scoped. No UI path may invent `Default Scope`, `Default Field`, `Home Scope`, or Field-owned membership.
  - Actors must stay workspace-scoped endpoints/participants, not draggable Field nodes.
  - Field remains a React Flow rendering of Scope Projection; layout is renderer state, not substrate membership.
  - Channel/Context event rendering remains bus-backed and actor-neutral; non-operator Contexts stay read-only.
- What is wrong or partial relative to full v6:
  - Top shell is inverted: Workspace selection/create lives in the left rail and bottom input, not a brand-adjacent dropdown next to “Floe” as in `mocks\v6\shell.js:14-57` and `home.png`.
  - Home is still a previous slice adaptation with stat cards, `Block Library`, “Fields” terminology, visible old/manual workspaces, and current fixture/runtime state leaking `Default`; it does not match v6 Home’s hero/settings/actor strip/scope grid/recent activity composition (`home-overview.js:27-99`).
  - Activity is disabled in the left nav (`main.tsx:2759-2762`) despite `activity.png`/`activity.html` defining an expected workspace stream surface.
  - Context is still a right-side transitional Channel, not the main-column Context stream surface in `context.png`/`context.html` (`context.html:40-50`, `context.html:109-191`).
  - Scope/Field visually remains generic React Flow nodes inside the old shell, not the v6 Scope map composition; however the implementation must adapt v6 visuals onto existing React Flow rather than port the mock’s hand-rolled map.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep App state/API refresh as the data owner while extracting presentational components: `selectedWorkspaceId`, `workspaces`, `fieldSummaries`, `scopeRecords`, `loadedProjection`, `endpoints`, `contexts`, `workspaceContexts`, `events`, `telemetry`, `runtimeBindings`, `selectedAgentId`, `selectedContextId`, `channelOpen`.
  - Use current actions: `selectWorkspace`, `registerWorkspace`, `deleteWorkspace`, `promptCreateField`/`createScope`, `openField`, `renameScope`, `openWorkspaceContext`, `openProjectedContext`, `assignWorkspaceContextToScope`, `promptCreateScopeAndAssign`, `sendFloeMessage`, `refresh`, `refreshFields`, `refreshWorkspaceContexts`, `refreshContexts`, `refreshContextEvents`.
  - Use current bus endpoints: `/v1/workspaces`, `/v1/workspaces/register`, `/select`, `/scopes`, `/projection`, `/projection/layout/floeweb`, `/contexts`, `/contexts/:id/events`, `/events/emit`, `/events`, `/runtime/telemetry`, `/runtime/bindings`, `/auth/profiles`, `/auth/models`, `/endpoints/register`.
  - Use `contexts.ts` helpers for labels/status/emit body; add pure helpers there for Activity/Context display only if needed.
  - Use `projectionToReactFlow`, `FieldItemNode`, existing `nodeTypes`/`edgeTypes`, `Handle`, `Controls`, `MiniMap`, and `Background`; style via CSS classes and React Flow theming rather than replacing the canvas.
  - Use existing Playwright route helpers in `floe-web\tests\helpers.ts`; extend them for visual/live acceptance and for Activity/Context stream routes instead of creating new mock harnesses.
  - Use v6 token contract (`tokens.css`, `linear-calm.css`, `v6.css`) as visual mapping references. Do not import them blindly if class names conflict; translate tokens/components into `styles.css` or imported FloeWeb CSS.
- Relevant docs or library capabilities:
  - `PRODUCT.md:103` explicitly allows React Flow core first and warns that Tailwind/shadcn/React Flow UI stack requires an explicit design-system migration.
  - v6 `THEME.md` says mocks are a port contract and future shadcn alias map, not an existing dependency.
  - React Flow supports custom nodes, handles, pan/zoom, controls, minimap, backgrounds, edge interaction paths, and layout; use those before hand-rolling.
- Existing examples in this codebase:
  - `v6-shell-frame.spec.ts`, `v6-home-surface.spec.ts`, `v6-channel-preservation.spec.ts`, `field-substrate.spec.ts`, and `scope-projection.spec.ts` already encode many guardrails: no `/fields`, no Default wording in v6 flows, Home actor selection does not open Channel, Field uses React Flow, node drag/layout persists, Pulse subscriber edges work.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not replace `@xyflow/react` with prototype SVG/DOM map/pan/zoom code.
  - Do not duplicate `floe-bus` Workspaces/Scopes/Contexts/Events/runtime/telemetry in a client store, copied `mocks\shared\data.js`, or static demo data.
  - Do not import prototype HTML/JS/CSS as runtime islands that own selection/routing/state.
  - Do not call, revive, or emulate legacy `/v1/workspaces/:id/fields`.
  - Do not bypass `scope-projection-api.ts`, `scope-projection.ts`, `fields.ts`, `contexts.ts`, DialogHost, or bus API wrappers.
  - Do not introduce Tailwind/shadcn merely to copy the mock unless a separate design-system migration is explicitly approved.
- Shortcuts or parallel paths to avoid:
  - No hidden `Default`, `default`, `Default Scope`, `Default Field`, `Home Scope`, or fake fallback bucket.
  - No Field-owned graph/membership/connections; no actors as graph nodes; no client-side membership inference to make screenshots look populated.
  - No fake-only Activity/Context streams. They must be derived from bus Events, Context events, telemetry, Scope Projection refs/relationships, and endpoint records.
  - No separate `openContextV6`, `emitV6`, or direct runtime/bridge call path. Context opens use existing `selectedContextId` + `/v1/contexts/:id/events`; sends use `buildEmitBody`.
  - No silently replacing Block Library drag/drop or canvas flows with toolbar-only shortcuts.
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
  1. First add/adjust tests and fixtures to define the full v6 acceptance target: topbar Workspace dropdown/create/switch; Home visual/content composition; named Scope React Flow map; Context main stream; Activity stream; no Default leak; no fake data; no legacy endpoints; React Flow interaction preservation.
  2. Componentize `main.tsx` without changing ownership: extract prop-fed presentational pieces such as `V6Topbar`, `WorkspaceSwitcher`, `LeftNav`, `WorkspaceHomeSurface`, `ScopeFieldSurface`, `ContextStreamSurface`, `ActivitySurface`, `RightInspector`, and `TransitionalChannel` while App retains state/actions/API calls.
  3. Move Workspace selection/create into the topbar next to the Floe brand. The dropdown should list `workspaces`, call `selectWorkspace`, expose create/open using current `registerWorkspace` path/dialog/input behavior, and preserve delete/remove affordance somewhere explicit.
  4. Rework Workspace Home as the v6 top-level index: hero, workspace settings path/runtime defaults, actor strip, named Scope card grid, recent Activity teaser. Use real `selectedWorkspace`, `fieldSummaries`/`scopeRecords`, `endpoints`, `events`, `telemetry`, `workspaceContexts`; never create a Scope for Home.
  5. Rework named Scope/Field visual shell around the existing React Flow tree. Style nodes/edges/background/legend/controls to align with `scope-writing.png`, add Map/Ops toggle only if it preserves the same projection owner; if Ops is not implemented, make it a non-destructive disabled/deferred affordance with tests.
  6. Implement Context as a main-column surface when a Context is selected/opened, matching `context.png`: header, participants, central stream, composer dock, metadata inspector. It should still use `/v1/contexts/:id/events`, `selectedContextId`, read-only guard, and `buildEmitBody`. Transitional Channel may remain as a shortcut/drawer, but it must not be the only Context experience if full v6 is the target.
  7. Implement Activity as a real workspace stream surface from bus `/v1/events`, `/v1/runtime/telemetry`, Context labels, endpoint names, and Scope titles. Filters may be client-side over retrieved real data for the first tranche; do not use mock emits.
  8. Only after shell/Home/Scope/Context/Activity all route through real data, do visual alignment passes against the four screenshots at 1700x1100 and live runtime data.
- Why this is the correct integration point:
  - The slice is a product UI completion over existing substrate owners. `main.tsx` already has all state/actions; extracting presentational components around it avoids new data ownership.
  - Bus APIs already expose the required substrate state; missing UI surfaces should consume them, not define new storage.
  - React Flow is already integrated and protected by tests; visual completion should theme/compose it rather than replace it.
- One large slice or vertical sub-slices:
  - Treat `v6-feature-complete-shell` as the umbrella acceptance objective, but implement as a small set of vertical sub-slices. One PR-sized mega-edit of shell + Home + Scope + Context + Activity would be high regression risk in the monolithic `main.tsx`.
  - Recommended sub-slices:
    1. **Topbar Workspace switch/create + shell navigation foundation**: brand-adjacent dropdown, create/open flow, left nav cleaned to Home/Activity/Scopes/Actors, preserve existing Home/Field/Channel behavior.
    2. **Workspace Home full v6 surface**: hero/settings/actors/scope grid/recent activity from real data, remove Block Library from Home’s persistent layout or reposition it so it no longer contradicts `home.png`; no Default leak.
    3. **Scope Field v6 map visual pass on React Flow**: v6 canvas shell, node/edge styling, legend/controls, Context list in left nav for selected Scope where real projection provides it; preserve React Flow affordances.
    4. **Context main stream surface**: Context route/view driven by current bus events and composer; Inspector metadata; Channel becomes secondary.
    5. **Activity workspace stream surface**: filters/stream from bus Events/telemetry with v6 visual alignment.
    6. **End-to-end visual/live hardening**: screenshot comparison/proof against `home.png`, `scope-writing.png`, `context.png`, `activity.png` and current mismatch capture.
- Recommended first implementation tranche:
  - Start with sub-slice 1 + enough of sub-slice 2 to remove the most visible mismatch: topbar Workspace dropdown/create/switch and Home composition. This directly addresses the user’s explicit top-shell/Home complaints and creates the component boundaries needed for Scope/Context/Activity.
- Alternatives considered and rejected:
  - Importing v6 mocks wholesale: rejected; creates mock data/DOM ownership and bypasses bus/React state.
  - Replacing React Flow with the mock map: rejected by product docs, tests, and required invariants.
  - Hiding the Default Scope with CSS while data remains stale: rejected; tests/live proof must show no product Default concept leaks.
  - Keeping #58 as acceptance-only: rejected by clarified expectation; live UI must become feature-complete end to end before being called complete.

## Regression checklist

- Product:
  - Workspace dropdown next to Floe brand switches existing workspaces, opens/creates workspaces, remains keyboard/focus accessible, and persists selection through bus.
  - Workspace Home is top-level and not a Scope/Field; no Home path loads `/projection` or uses `scope_id=default`.
  - Named Scopes render as Fields/canvas surfaces from real Scope Projection.
  - Context main stream and Activity stream use real bus Context/Event/telemetry data.
  - No visible `Default Scope`, `Default Field`, or product “Default” fallback in v6 flows. Existing historical tests may still seed default scopes outside v6 acceptance, but new v6 fixtures should not.
- Substrate:
  - No legacy `/fields` requests.
  - No fake client graph/membership/state; no actors inside Fields.
  - Direct actor Contexts can remain unscoped; actorless operational streams require real Scope.
  - Emits route through `/v1/events/emit`; Context events through `/v1/contexts/:id/events`.
  - Scope assignment uses `/assign-scope` and explicit named Scopes only.
- Visual:
  - Topbar/left nav/right inspector/main surfaces align with `home.png`, `scope-writing.png`, `context.png`, and `activity.png` proportions, typography, dark token palette, spacing, and hierarchy.
  - Current mismatch capture no longer reproduces: no Block Library dominating Home, no left-rail workspace list as primary switcher, no Default Scope leak, no partial stat-card-only Home.
  - React Flow nodes/edges/handles remain high contrast in dark mode.
- Accessibility:
  - Workspace switcher, create/open, nav, Scope cards, Context rows, Activity filters, composer, Inspector controls, and canvas controls have labels/focus states.
  - Keyboard users can switch Workspace, open Home/Activity/Scope/Context, send where allowed, and close secondary Channel/drawers.
  - Read-only Contexts announce why sending is disabled.
- Performance:
  - Navigation Home ⇄ Scope ⇄ Context ⇄ Activity remains responsive.
  - React Flow pan, zoom, drag, selection, and edge operations do not regress or stutter.
  - Activity stream filters should not render unbounded huge lists without limit/windowing; use bus limits or simple caps for first tranche.

## Test plan

- Existing tests to keep green:
  - `cd floe-web && npm run test:unit`
  - Targeted E2E before full run: `v6-shell-frame.spec.ts`, `v6-home-surface.spec.ts`, `v6-channel-preservation.spec.ts`, `workspace-management.spec.ts`, `workspace-home-assignment.spec.ts`, `context-rendering.spec.ts`, `no-actor-bleed.spec.ts`, `scope-projection.spec.ts`, `field-substrate.spec.ts`, `channel-activity.spec.ts`.
  - Full `cd floe-web && npm run build && npm run test:e2e` before merge when runtime permits.
- New tests to add before/with implementation:
  1. **Topbar Workspace dropdown/create/switch**: brand-adjacent Workspace button opens menu, lists workspaces, calls `/select`, exposes create/open through current register flow, no primary workspace list in left rail.
  2. **Home visual/data contract**: Home has v6 hero/settings/actor strip/scope cards/recent activity from mocked real bus data; no Block Library persistent panel on Home; no Default text; no projection/legacy calls.
  3. **No stale/manual workspace data**: seeded workspaces render from `/v1/workspaces` only; deleting/switching refreshes state; current live stale workspace leakage is covered.
  4. **Scope v6 React Flow preservation**: open named Scope, assert v6 map shell/legend/control affordances plus `.react-flow`, node labels/icons/handles, drag, selection, pan/zoom, Pulse-to-Context connect/delete, rename/open.
  5. **Context main stream**: opening Home or projected Context navigates/renders main Context surface, fetches `/v1/contexts/:id/events`, shows participants, metadata inspector, composer, read-only guard, and sends via existing emit body.
  6. **Activity stream**: Activity nav opens real workspace stream, filters by actor/kind/scope/workspace-only over seeded events/telemetry, no mock data imports, inspector remains metadata-only.
  7. **Visual acceptance smoke**: screenshot at 1700x1100 for Home, Scope, Context, Activity; assert key bounding boxes/classes and absence of old mismatch landmarks.
- Live proof required:
  - Capture new screenshots corresponding to supplied references: Home, Scope writing/map, Context, Activity, plus a before/after comparison to `issue-58-live-current.png`.
  - Capture browser console and network proof: no relevant errors, no failed requests, no `/fields`, no prototype/mock file imports, correct bus endpoints for Workspace/Scopes/Contexts/Events/runtime.
  - Verify live Workspace dropdown/create/switch behavior against `http://127.0.0.1:5378/`.
  - Verify React Flow interaction live: pan, zoom, drag, selection, handles/connection, rename/open.
  - User expectation to enforce: do not report the slice complete until the live UI is feature-complete against the full v6 vision end to end, including top Workspace dropdown/create behavior and visual alignment with all supplied screenshots.

## Risk assessment

- Risk:
  - The existing `main.tsx` monolith makes broad visual/product changes easy to entangle with data refresh and React Flow callbacks.
- Risk:
  - Default Scope leakage can come from real stale workspaces, older fixtures, `ScopeRecord.is_default`, or visible scope titles. Hiding strings without fixing product semantics would produce false success.
- Risk:
  - The v6 mocks include unsupported mock actions/counts and hand-authored streams; copying them can create hidden fake data or parallel UI/API paths.
- Risk:
  - Moving Context from transitional Channel into a main surface may accidentally break existing Channel tests or selected actor state.
- Risk:
  - Activity surface could over-fetch or render too much if it uses `/v1/events`/telemetry naively.
- Risk:
  - Styling React Flow to match `scope-writing.png` could hide handles, break edge hit targets, or degrade pan/zoom/drag performance.
- Mitigation:
  - Implement in vertical sub-slices with tests first, keep App as state owner, and extract presentational components before moving logic.
  - Use non-Default seeded fixtures for all v6 tests and add explicit no-Default assertions scoped to v6 flows.
  - Translate v6 visual language into production components; never import mock runtime files.
  - Keep Channel regression tests while adding Context main-surface tests; make any Channel de-emphasis explicit.
  - Add Activity limits/filters with test fixtures; defer unbounded virtualization only if data volume demands it, but do not block the first real stream.
  - Add/keep React Flow interaction tests before every canvas visual refactor.

## Decision confidence

- Confidence: medium-high
- Reasons:
  - Ownership boundaries are clear and already documented by #55-#57: FloeWeb UI consumes bus APIs, Scope/Field uses React Flow, Context/Event semantics live in bus/helpers, mocks are visual references only.
  - Existing tests protect many substrate invariants and some v6 partial shell behavior.
  - The main uncertainty is scope size: the clarified expectation is larger than issue #58/#55-#57 and should be delivered as several vertical sub-slices under one umbrella, not one unreviewable patch.
  - Another uncertainty is visual exactness: screenshots include richer counts/streams/Scope map affordances than current bus projections expose (e.g. Activity/Event refs in Scope Projection are currently empty in bus projection), so some visual elements must be adapted to available real substrate data or backed by new bus read APIs in later reviewed slices.
- Open questions:
  - Should the transitional Channel remain available after Context main surface lands, or become a shortcut/drawer only? Recommendation: keep it temporarily with regression tests, but make Context main surface canonical for v6.
  - Should Scope Projection include event/activity refs for richer map stats, or should Scope/Activity surfaces query events/telemetry separately? Recommendation: do not extend projection in the first tranche; use existing bus event/telemetry APIs for Activity, and file a separate architecture gate if projection contract changes.
  - Should Block Library be removed from Home or relocated? Recommendation: remove it from persistent Home layout for visual alignment, preserve drag/drop in Scope/Field or a deliberate create affordance with tests.
