# Architecture Integration Brief: v6-ui-shell-migration

## Existing ownership

- Package/component/module/library:
  - `floe-web` owns the current product UI in `floe-web\src\main.tsx` and `floe-web\src\styles.css`. The app shell, Workspace Home, Block Library, Field Surface, Inspector, and Channel are currently rendered by one React `App`.
  - Pure FloeWeb semantics live outside the monolith: Context labels/assignment helpers in `floe-web\src\contexts.ts`, Scope/Field projection API client in `floe-web\src\scope-projection-api.ts`, projection-to-React-Flow mapping in `floe-web\src\scope-projection.ts`, and Field layout helpers in `floe-web\src\fields.ts`.
  - `@xyflow/react` owns canvas interactions today: `ReactFlow`, `Controls`, `MiniMap`, handles, node/edge selection, connect/delete/reconnect events, pan/zoom, and layout coordinates.
  - `floe-bus` owns Workspaces, Scopes, Contexts, Events, Pulses, endpoint/runtime data, and the HTTP APIs. FloeWeb must remain a consumer of those APIs.
  - The v6 prototype under `C:\Development\ai-powered\floe-web-examples\mocks\v6` owns only visual/interaction reference material. It is hand-authored HTML/CSS/JS, not production data ownership.
- Current owner rationale:
  - Current docs define FloeWeb as the human/operator interface that talks to `floe-bus`; browser code must not read/write workspace files directly or create runtime paths around bus/bridge.
  - Current code already migrated Field semantics toward Scope Projection: Fields listed in the UI are derived from `listScopes()`, opened Field state is loaded from `getScopeProjection()`, and layout is saved through `/projection/layout/floeweb`.
  - Existing Playwright tests explicitly fail if legacy `/fields` endpoints are called.
- Source evidence:
  - `CONTEXT.md` defines Workspace Home as not a Scope, Field as a FloeWeb rendering/projection of Scope, Scope Projection as read-only substrate-derived view, and actors as workspace-scoped/not Field-owned.
  - `PRODUCT.md` says Workspace Home is top-level, Scope is optional for actor-anchored Contexts, Field canvas work should use React Flow, and shadcn/Tailwind must not be smuggled in without an explicit design-system migration.
  - `floe-web\package.json` currently has React/Vite, `@xyflow/react`, and `lucide-react`; no Tailwind, shadcn, Radix, or CSS utility build pipeline exists.
  - `mocks\v6\THEME.md` states the mock is hand-authored CSS and provides a future shadcn alias table, not an existing component-library dependency.

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace attach/create flow, bus URL selection, workspace switching, refresh, and `.floe/` init consent.
  - Workspace Home lists Scope-backed Fields and Workspace-level Contexts; unscoped actor Contexts can be opened in the right Channel or explicitly assigned to a named Scope.
  - Field creation and rename call Scope APIs, not legacy Field APIs.
  - Field Surface renders Scope Projection through React Flow; Context nodes can be opened into the existing Channel.
  - Field layout changes save renderer layout sidecars only; they do not mutate substrate membership.
  - Pulse-to-Context connections use React Flow handles/edges and call pulse subscriber APIs.
  - Right Inspector shows Workspace, Runtime, Workspace actors, and opened Field counts. Channel remains a separate right-side actor conversation pane.
  - Block Library supports click/drag creation of a Scope-backed Field and should remain unless explicitly redesigned.
- Behaviors that must remain unchanged:
  - Workspace Home must remain an index/dashboard, not a hidden/default Scope.
  - Unscoped actor Contexts must remain valid and visible outside Scope Projection; actorless/scoped operational flows require Scope.
  - Actors remain workspace-scoped endpoint participants, not Field-owned/draggable graph nodes.
  - Field remains a renderer/projection of Scope. It must not own a duplicated item/connection list or infer substrate membership client-side.
  - React Flow-native pan, zoom, drag, selection, handles, edge selection/delete, minimap/controls, rename/open affordances, and connection affordances must survive the shell migration.
  - Toolbar shortcuts may supplement canvas flows; they must not silently replace Block Library or React Flow canvas affordances.
- Runtime or UX evidence:
  - `tests\workspace-home-assignment.spec.ts` covers no Default Scope fallback, inline Scope creation/assignment, assignment failure behavior, and visibility of unscoped actor Contexts.
  - `tests\field-substrate.spec.ts` and `tests\scope-projection.spec.ts` cover Scope Projection rendering, no legacy Field endpoint calls, layout persistence, React Flow pan/zoom/selection/drag, and Pulse subscriber connect/delete.
  - v6 screenshots are `1700x1100` visual references for Home, Home actor selected, Scope map/writing/ops/actor selected, Context, and Activity. First slice should target Home shell + right inspector only; later slices need separate review before Scope/Activity/Context migration.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep `App` state/API refresh paths as the data owner until deliberately decomposed: `refresh`, `refreshFields`, `refreshWorkspaceContexts`, `refreshOpenField`, `openWorkspaceContext`, `openProjectedContext`, `createField`, `openField`, `promptCreateScopeAndAssign`.
  - Use `contexts.ts` for Workspace-level Context labels and assignment eligibility; do not duplicate these rules in presentational components.
  - Use `scope-projection-api.ts` and `scope-projection.ts` for Scope/Field projection reads and mapping; do not introduce prototype-local graph data.
  - Use `fields.ts` for renderer layout conversion and node-change persistence.
  - Use React Flow component APIs for future canvas work: `nodeTypes`, `edgeTypes`, `Handle`, `onNodesChange`, `onConnect`, `onMoveEnd`, `onNodeDragStop`, `onBeforeDelete`, `Controls`, `MiniMap`, `Background`.
  - Use existing dialog foundation (`dialog\dialog.tsx`, `dialog-controller.ts`) for prompts/confirmation.
  - Use existing Playwright route helpers in `tests\helpers.ts` for UI regression tests.
- Relevant docs or library capabilities:
  - `PRODUCT.md` explicitly allows React Flow first and warns that full React Flow UI/shadcn/Tailwind requires an explicit design-system migration.
  - `mocks\v6\THEME.md` provides token names and alias mapping if shadcn/Tailwind is adopted later.
  - Current CSS already imports `@xyflow/react/dist/style.css`; any theme migration must restyle React Flow without disabling built-in behavior.
- Existing examples in this codebase:
  - Scope Projection API client tests prove the URL contract.
  - Field tests prove React Flow nodes/edges can be selected, dragged, connected, and deleted while recording only substrate-approved mutations.
  - Workspace Home assignment tests prove unscoped actor Contexts are not forced into Default Scope.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not replace `@xyflow/react` with the v6 prototype's hand-rolled SVG map/pan/zoom implementation.
  - Do not create a separate v6 mock data store or copy `mocks\shared\data.js` semantics into FloeWeb.
  - Do not call, revive, or emulate legacy `/fields` endpoints.
  - Do not bypass `floe-bus` for Workspace, Scope, Context, Event, Pulse, endpoint, runtime, or actor data.
  - Do not duplicate Context assignment rules outside `contexts.ts`/Bus APIs.
  - Do not replace the existing dialog, Scope Projection, Field layout sidecar, Channel, or Block Library paths without a separate explicit redesign.
- Shortcuts or parallel paths to avoid:
  - Do not implement Workspace Home as `scope_id=default`, `Field default`, or a fake Scope.
  - Do not make actors selectable by creating Field nodes for actors. Actor selection is shell/inspector/channel state.
  - Do not import prototype HTML as raw islands that manage their own DOM, selection state, routing, or data.
  - Do not add Tailwind/shadcn only to style this slice unless the implementation also commits to a design-system migration plan and test coverage.
  - Do not let v6 prototype "mock" actions replace real bus/API-backed behavior where production code already exists.
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
  1. Add production React components around the existing state/actions rather than importing prototype DOM:
     - App shell/layout components for v6 topbar, left navigation, main surface, and right inspector.
     - Workspace Home component that consumes existing `selectedWorkspace`, `fieldSummaries`, `recentWorkspaceContexts`, `scopeRecords`, `agents/endpoints`, and action callbacks.
     - Right Inspector component that reuses existing Workspace/Runtime/Actor/Field data and later can accept selection-specific content.
  2. Extract v6 visual tokens into `floe-web\src\styles.css` or a CSS file imported from it. Prefer a Floe token layer (`--canvas`, `--surface`, `--ink`, etc.) mapped onto current token names for this first slice.
  3. Keep current data/API callbacks in `main.tsx` until component boundaries are stable; pass them as props. After parity tests pass, consider moving presentational components to separate files.
  4. Preserve current Field/React Flow subtree and handlers unchanged except for shell positioning/theme wrappers. Later Scope map/ops slices must adapt the v6 visual design to React Flow, not port the prototype SVG implementation.
  5. Preserve Channel behavior. The v6 right inspector is not the same owner as the current Channel; if the first slice collapses or repositions conversation UI, that is a product decision requiring separate approval/tests.
- Why this is the correct integration point:
  - The requested slice is shell/Home/Inspector visual migration, not a substrate rewrite. Existing React state and Bus API ownership should remain authoritative.
  - The existing monolithic `App` already has the required state and callbacks. Componentizing around it reduces risk while enabling v6 visual migration.
  - Token extraction from the prototype avoids rework while avoiding a premature Tailwind/shadcn build-system migration.
- Alternatives considered and rejected:
  - Full shadcn/Tailwind introduction now: rejected for this slice. It adds package/config churn and a parallel styling model before component boundaries exist. The prototype is not built on shadcn; its own theme doc says aliases are a port contract, not a requirement. Revisit when adopting a broader design system or React Flow UI component stack.
  - Import prototype files directly: rejected because they manage DOM state, use mock data, hand-roll canvas interactions, and would bypass FloeWeb data/API owners.
  - Rebuild scope map from prototype SVG: rejected because current product and tests require React Flow-native canvas behavior.
  - Keep current light UI and only rename labels: rejected because it would not satisfy migration from v6 screenshots/prototype.

## Regression checklist

- Behavior: Workspace attach/create and bus reconnect still work.
- Behavior: Workspace Home is reachable and is not represented as a Scope or Field.
- Behavior: Scope-backed Fields still list from `GET /v1/workspaces/:workspace_id/scopes`.
- Behavior: Add/Rename Field still call Scope APIs and duplicate titles still use bus-generated Scope IDs.
- Behavior: Workspace-level actor Contexts remain visible/openable and assignable to named Scopes; no Default Scope/Field language appears.
- Behavior: Right Inspector still shows Workspace, Runtime, actor, and opened Field state without hiding errors.
- Behavior: Channel can still open/toggle, choose actor/context, send through `buildEmitBody`, and render context events.
- Behavior: Block Library click/drag affordance remains available unless explicitly redesigned.
- Behavior: Field Surface still renders React Flow projection; nodes/edges/handles/open buttons/rename/back navigation remain usable.
- Behavior: React Flow pan, zoom, drag, selection, connection, edge delete, minimap, and controls do not regress.
- Behavior: No production code reads mock files or screenshot assets at runtime.

## Test plan

- Existing tests to keep green:
  - `npm run test:unit`
  - `npm run test:e2e`
  - Especially: `tests\workspace-home-assignment.spec.ts`, `tests\field-substrate.spec.ts`, `tests\scope-projection.spec.ts`, `tests\context-rendering.spec.ts`, `tests\actor-neutral-ui.spec.ts`, `tests\no-actor-bleed.spec.ts`, and unit tests for `contexts.ts`, `fields.ts`, `scope-projection.ts`, `scope-projection-api.ts`.
- New tests to add before/with implementation:
  - E2E: v6 shell renders topbar, left navigation, Workspace Home main surface, and right inspector from mocked bus data.
  - E2E: selecting an actor in v6 Home updates the inspector without creating actor Field nodes or changing Scope Projection.
  - E2E: Workspace-level Contexts remain listed/openable/assignable in the v6 Home layout with no Default Scope/Field text.
  - E2E: Block Library click and drag still reach Scope creation after shell migration.
  - E2E: open a Field from v6 Home and verify React Flow nodes, handles, pan/zoom/drag/selection/open/connection affordances remain visible/functional.
  - Unit/presentational: pure component rendering for Home summary/Scope cards/actor strip if components are extracted.
  - Visual/live QA: compare implemented first-slice surface against `screenshots\home.png` and `screenshots\home-actor-selected.png` at a similar 1700x1100 viewport.
- Live proof required:
  - Run `npm run build` and relevant tests.
  - Start FloeWeb (`npm run dev`) against mocked or real local bus data and capture screenshots of Workspace Home and actor-selected Home.
  - Use Playwright to verify no console errors, no failed API calls to `/fields`, and no noticeable lag/regression when navigating Home -> Field -> Home and when dragging/zooming a Field node.

## Risk assessment

- Risk: the v6 prototype uses separate DOM state and mock data; copying it directly would create a parallel product path. Mitigation: translate visuals into React components using existing state/actions.
- Risk: Tailwind/shadcn introduction could consume the slice with tooling churn and inconsistent styling. Mitigation: first extract tokens/CSS and component boundaries; decide shadcn later with a dedicated design-system issue.
- Risk: shell layout changes can accidentally hide or replace the current Channel/Inspector split. Mitigation: tests must assert both inspector state and Channel affordances.
- Risk: left-nav actor selection could be misread as Field ownership. Mitigation: actor selection only drives inspector/channel state and never projection nodes.
- Risk: future Scope map screenshots show events/ops states that current Scope Projection does not render as top-level event/activity nodes. Mitigation: treat later screenshots as separate slices; adapt them to bus-owned projection semantics and React Flow after new architecture review.
- Risk: dark v6 theme may reduce React Flow handle/minimap/edge contrast. Mitigation: add explicit visual/interaction tests for handles, selection, edge labels, and controls.
- Risk: moving monolithic JSX into components may break closure-dependent callbacks. Mitigation: extract presentational components with typed props before moving stateful logic.

## Decision confidence

- Confidence: high for first slice (app shell + Workspace Home + right inspector) using existing React state/actions, existing Bus APIs, existing React Flow canvas, and extracted v6 tokens/CSS.
- Reasons:
  - Current code already has the substrate-correct ownership model needed by the slice.
  - Tests already cover most semantic invariants that the migration must preserve.
  - The v6 prototype is clear visual reference material but is not an architectural owner.
  - Avoiding Tailwind/shadcn for the first slice minimizes risk while keeping a documented path to adopt it later.
- Open questions:
  - Whether the first slice should keep the current separate Channel column exactly as-is or visually fold some conversation affordance into the v6 right inspector. This affects product behavior and should be approved before implementation.
  - Whether v6 dark mode should become the only theme immediately or land as a token/theme layer that can later support light mode.
  - Whether actor selection on Workspace Home should show only participation metadata in the inspector or also expose quick-open conversation actions in this first slice.
