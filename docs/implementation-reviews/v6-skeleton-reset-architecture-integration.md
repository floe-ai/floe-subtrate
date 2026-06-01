# Architecture Integration Brief: v6-skeleton-reset

## Existing ownership

- Package/component/module/library:
  - `floe-web` owns the visible production shell and FloeWeb UX. Today the shell is still concentrated in `floe-web\src\main.tsx`, with styling in `floe-web\src\styles.css`.
  - `main.tsx` currently owns the app-level React state and workflow callbacks: Workspace attach/create/select, view routing (`home` / `activity` / `field`), Scope-backed Field creation/open/rename, actor selection, Context opening, Channel state, Activity filters, Inspector selection, and React Flow handlers.
  - `home-view-model.ts` owns pure Workspace Home aggregation: recent activity, Scope cards, actor cards, and system warnings. It already uses Scopes, Contexts, endpoints, Activity rows, runtime bindings, and runtime readiness without querying Scope Projection for Home.
  - `inspector-view-model.ts` owns pure summaries for Workspace, Actor, and Scope inspector states.
  - `activity.ts` owns Workspace Activity rows and filters from events, telemetry, Contexts, endpoints, and Scopes.
  - `contexts.ts` owns Context naming, actor Context sorting, Workspace-level Context labels, Scope-assignment eligibility, assignment status copy, and `buildEmitBody`.
  - `scope-projection-api.ts` owns browser calls for `listScopes`, `getScopeProjection`, projection layout get/put, `createScope`, and `renameScope`.
  - `scope-projection.ts` owns Scope Projection -> React Flow mapping and pulse subscriber mutation derivation.
  - `@xyflow/react` owns Field/canvas interactions: node/edge rendering, handles, pan, zoom, selection, drag, connect/delete/reconnect hooks, `Controls`, `MiniMap`, and `Background`.
  - `floe-bus` owns Workspaces, Scopes, Contexts, Events, telemetry, Pulse subscription APIs, endpoints/actors, runtime bindings, and activity data. Browser code must remain a bus API consumer.
  - `C:\Development\ai-powered\floe-web-examples\mocks\v6` owns only visual and interaction reference material. Its HTML/CSS/JS is a port contract, not a runtime dependency or data owner.
- Current owner rationale:
  - `PRODUCT.md` defines FloeWeb as the human/operator interface over `floe-bus`, not a direct substrate/runtime path.
  - `CONTEXT.md` makes Workspace Home an index, Field a rendering of Scope, Scope Projection a read-only substrate-derived view, and Actors workspace-scoped endpoints.
  - Current code already corrected many substrate invariants: Home uses `buildWorkspaceHomeModel`, Fields are derived from `listScopes`, opened Fields load `getScopeProjection`, layout saves use `/projection/layout/floeweb`, and messages go through `/v1/events/emit`.
  - The current visible UI is still a hybrid: `main.tsx` has v6-ish test IDs and dark tokens, but the production shell uses `.floe-shell`, `.workspace-rail`, `.main-stage`, `.content-row`, separate `library-panel`/`channel`, and legacy "Field" content/copy in Home instead of the mock skeleton's `.v6shell > topbar + body(left nav/main/right inspector)`.
- Source evidence:
  - `PRODUCT.md:30-33` states Workspace Home is not a Scope, actor conversations can exist at Workspace level, Scope is intentional, Field is a Scope rendering, Actors are not Field-owned, and Floe is not a Field item.
  - `PRODUCT.md:40-45` says `floe-bus` owns substrate/runtime data and FloeWeb must not bypass bus/bridge.
  - `PRODUCT.md:96-103` describes the post-Workspace layout and says Field canvas work should use React Flow; React Flow UI/shadcn/Tailwind need an explicit design-system migration.
  - `CONTEXT.md:131-150` states Workspace -> Actors/Contexts/Scopes, Workspace Home is not Scope, Field renders Scope, Context may be unscoped with actors, and Actors are not Fields.
  - `floe-web\src\main.tsx:369-606` shows `App` owns the current shell state, Home/Activity/Field data, actor selection, Channel state, and view routing.
  - `floe-web\src\main.tsx:877-931`, `1805-1834`, and `1905-1948` show existing open Context, emit, create Scope, open Scope/Field, and rename paths that must remain behind the reset.
  - `floe-web\src\main.tsx:2705-2735` shows React Flow is the Field map owner.
  - `floe-web\src\main.tsx:3381-3551` shows the current production shell composition; it is not the v6 skeleton DOM/layout contract.
  - `mocks\v6\home.html:14-20` and `shell.js:14-228` show the skeleton: persistent topbar, left nav, main column, and right inspector.
  - `mocks\v6\components\home-overview.js:27-98` shows Home shape: hero, workspace settings, actor strip, Scope grid, and recent activity teaser.
  - `mocks\v6\THEME.md:3-18` and `linear-calm.css:14-108` define the hand-authored CSS/token contract.

## Existing interaction model

- User/system behaviors that already exist:
  - Open/create/select Workspace, configure bus URL, reconnect, refresh, and consent to `.floe/` initialization.
  - Workspace switcher lives in the topbar and can register new Workspaces through `registerWorkspace`.
  - Left nav currently exposes Home, Activity, Scopes, New Scope, Scope Contexts when a Field/Scope is open, and Actors.
  - Home currently lists Workspace settings, recent Activity, Actors, Scope-backed Fields, and Workspace-level Contexts.
  - Actor selection on Home updates Inspector without opening Channel in the Home actor strip; actor selection in left nav currently opens Channel as well.
  - Workspace-level Contexts can open in Channel and can be assigned to named Scopes through existing Context assignment APIs.
  - Activity is a distinct view with filters over actor/source, kind, Scope, and Context using bus-backed events/telemetry/Contexts.
  - Scope/Field opens a React Flow Surface backed by Scope Projection, with Map/Ops mode pills, Scope Context nav entries, node open, rename, pan/zoom/drag, and pulse subscriber connect/delete.
  - Channel is a separate right-side conversation pane, opened explicitly through buttons or Context open actions; it lists actor Contexts, renders Context events/runtime activity, and sends via `buildEmitBody` -> `/v1/events/emit`.
  - Block Library's old side panel is already hidden from Home/Field in v6 tests, but Scope creation drag/click affordance survives through "New Scope" in left nav and React Flow drop handlers.
- Behaviors that must remain unchanged:
  - Workspace Home must remain an index/dashboard, not a hidden Scope, default Scope, default Field, or Home Scope.
  - Scopes remain the source for Field cards; no legacy `/fields` endpoint, `/fields` fallback, or field-owned item/connection store may return.
  - Workspace-level actor Contexts with `scope_id: null` remain valid, visible, openable, and assignable; they must not be forced into a Default Scope.
  - Actor selection may drive Home/left-nav/Inspector/Channel UI state, but must not create actor graph nodes, actor Field membership, or Scope Projection writes.
  - Scope Projection remains scoped-only and React Flow-owned. The v6 prototype SVG/DOM map must not replace React Flow or its event model.
  - Channel emit/open behavior must remain available behind the reset. The first reset may visually reposition or contextualize the composer, but must still use `contexts.ts` and `/v1/events/emit`.
  - Runtime settings and actor access remain bus/runtime-binding-backed; visual reset must not invent prototype actor profiles or mock models.
  - Existing dialog flows for Scope creation, workspace creation, deletion, and confirmation remain owned by `dialog-controller.ts` / `dialog\dialog.tsx`.
- Runtime or UX evidence:
  - `tests\v6-shell-frame.spec.ts` already asserts v6 shell test IDs, Home/Activity/Scopes/Actors nav, no Default Scope/Field copy, and Channel as a transitional separate pane.
  - `tests\v6-feature-shell.spec.ts` asserts topbar Workspace switching/create and Home as v6 index instead of Block Library.
  - `tests\v6-home-surface.spec.ts` asserts Home does not prefetch Scope projections, actor selection updates Inspector without Channel, and Workspace-level Contexts stay visible.
  - `tests\v6-channel-preservation.spec.ts` asserts Home/Actor/Projected Contexts open through the same Channel path and emit payloads through the current bus path.
  - `tests\v6-scope-field-map.spec.ts`, `field-substrate.spec.ts`, and `scope-projection.spec.ts` assert React Flow map rendering, handles, Scope creation drag, no legacy `/fields`, layout persistence, pan/zoom/drag/selection, and pulse subscriber connections.
  - Current UX conflict: user rejected the incremental hybrid even though these tests pass. Existing tests protect substrate correctness and some v6 pieces, but they do not sufficiently assert visual skeleton fidelity against `home.png` / `home-actor-selected.png` or absence of legacy composition/copy.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep `App` as temporary state owner during the first reset slice. Extract view components around its existing state/actions rather than moving data ownership at the same time.
  - Reuse `buildWorkspaceHomeModel` for V6 Home content-depth summaries. Extend it only if the skeleton needs additional derived props, such as mock-like Scope descriptions or actor display metadata from real data.
  - Reuse `buildWorkspaceInspectorSummary`, `buildActorInspectorSummary`, and `buildScopeInspectorSummary` for V6 Inspector.
  - Reuse `buildActivityRows` / `filterActivityRows` for Activity surface and Home recent activity teaser.
  - Reuse `contexts.ts` for Context label/participation/assignment/message body semantics.
  - Reuse `scope-projection-api.ts`, `scope-projection.ts`, and `fields.ts` for all Scope/Field/React Flow data and layout behavior.
  - Reuse existing `api()` and refresh callbacks in `main.tsx`: `refresh`, `refreshFields`, `refreshWorkspaceContexts`, `refreshActivityContexts`, `refreshOpenField`, `openWorkspaceContext`, `openProjectedContext`, `createField`, `promptCreateField`, `promptCreateScopeAndAssign`, `selectActorForInspector`, `sendFloeMessage`.
  - Use React component extraction for the reset: `V6Shell`, `V6Topbar`, `V6LeftNav`, `V6Home`, `V6Inspector`, `V6ActivitySurface`, `V6ScopeSurface`, and a transitional `V6Channel` or `V6ComposerSlot` wrapper.
  - Use CSS modules/files under `floe-web\src` or the existing global `styles.css`; do not load mock CSS from `floe-web-examples` at runtime.
  - Preserve existing Playwright helpers in `tests\helpers.ts`; add richer selectors/routes there if tests need skeleton-specific proof.
- Relevant docs or library capabilities:
  - `@xyflow/react` already provides all required canvas primitives. The v6 skeleton can style React Flow, but must not replace it with the mock SVG/pan/zoom behavior.
  - `mocks\v6\THEME.md` says v6 is hand-authored CSS and only provides a future shadcn alias table. No Tailwind/shadcn stack exists in `floe-web\package.json`.
  - `linear-calm.css` is the closest token source: near-black canvas/surface ladder, `--ink*`, sage `--accent`, semi-transparent borders, Inter Variable, radius/elevation, and shadcn aliases if later adopted.
  - Current `styles.css` already mapped many v6 tokens to `oklch`, but class structure still follows older shell/content-row patterns.
- Existing examples in this codebase:
  - `main.tsx:2156-2427` is a partial Home component using real state; it should be replaced/recomposed to match `renderHomeOverview` sequence, not patched further as-is.
  - `main.tsx:2748-2927` is a useful Inspector owner but its class/section structure should be wrapped/restyled into the v6 `.rinsp` contract.
  - `main.tsx:3081-3377` is the existing Channel owner; it should be retained as the behavior owner while being phased into a contextual right-side affordance.
  - `main.tsx:3381-3551` is the highest-leverage reset boundary. Replace this composition with a skeleton-aligned shell rather than trying to style the current grid into compliance.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate `floe-bus` APIs, route around bus/bridge, read workspace files directly, or invent a prototype-local store.
  - Do not import or fetch `mocks\v6` HTML/JS/CSS/data/screenshots in production runtime.
  - Do not recreate `mocks\shared\data.js`, `window.FLOE`, `window.FLOE_UI`, or prototype mock actors/scopes/profiles in React.
  - Do not revive or emulate legacy `/fields` endpoints.
  - Do not replace `@xyflow/react` for Scope/Field map behavior.
  - Do not duplicate Context assignment rules outside `contexts.ts` and bus APIs.
  - Do not replace existing dialog infrastructure for create/confirm flows.
  - Do not add Tailwind/shadcn/Radix as a side-effect of this slice unless explicitly approved as a separate design-system migration.
- Shortcuts or parallel paths to avoid:
  - Do not "make it look right" by leaving legacy Channel/Home/Field sections hidden offscreen or duplicated under the new skeleton.
  - Do not keep the old `.floe-shell`/`.workspace-rail`/`.content-row` composition as the primary layout and merely rename classes to `v6`.
  - Do not let left-nav actor clicks automatically open Channel if implementing `shell.js` semantics; actor selection should update selection/Inspector first. Channel/composer should be contextual and explicit.
  - Do not display Workspace-level actor Contexts in left nav. They surface through actor selection/Inspector and Home, not as nav children.
  - Do not rename Scopes to Fields in Home. The user specifically wants v6 skeleton semantics; Home cards should say Scopes while opening their Field/Map.
  - Do not create actor Field nodes or "Floe" canvas nodes.
  - Do not use screenshots as runtime assets or assert pixel-perfect marketing-page output; use them as QA reference only.
- Invariants:
  - Workspace Home is not a Scope.
  - No Default Scope, Default Field, Home Scope, Thread, `.floe/blocks`, or field-owned membership language in product UI.
  - Actors are Workspace-level endpoints, not Field-owned graph objects.
  - Workspace-level actor Contexts can be unscoped and remain discoverable through Home/Actor/Inspector/Channel.
  - Scope Projection/Field remains scoped-only and React Flow-owned.
  - Preserve Block Library/New Scope creation affordance unless explicitly redesigned; if the visible "Block Library" panel is removed, left-nav New Scope click/drag must keep the functional affordance.
  - Preserve React Flow node icons/labels/handles/selection, pan, zoom, drag, rename/open, connection, edge delete, minimap, and controls.
  - Preserve bus emit/open behavior through `buildEmitBody` and `/v1/events/emit`.

## Integration plan

- Insert the change at:
  1. Reset the production shell composition at `main.tsx`'s return boundary (`main.tsx:3381-3551`) into a skeleton-aligned React component tree:
     - `V6Shell`: renders persistent topbar, body grid, left nav, main column, and right inspector.
     - `V6Topbar`: brand + Workspace switcher + breadcrumbs/context controls only; keep Workspace create/select callbacks.
     - `V6LeftNav`: Home and Activity always; Scopes list; New Scope; Contexts only when a Scope/Field is open; actors selectable but not Channel-opening by default.
     - `V6Inspector`: canonical right-side selection/details panel, with optional composer slot only where the selected Context/Actor interaction requires it.
     - `V6Home`: ports `renderHomeOverview` sequence using real `homeModel`, `selectedWorkspace`, `scopeRecords`, `agents`, `recentWorkspaceContexts`, activity rows, and existing action callbacks.
     - `V6ActivitySurface`, `V6ScopeSurface`, and later `V6ContextSurface`: keep current behavior/data owners but align shell boundaries and skeleton styling.
  2. Preserve `App` state/API ownership in the first reset. Pass typed props into new components; do not move bus fetching/state machines and visual reset in the same slice.
  3. Replace visible Home copy/structure with skeleton semantics:
     - Hero: "Workspace" eyebrow, workspace name, explanatory subcopy close to mock but substrate-correct.
     - Workspace settings: path/status/runtime defaults from real state.
     - Actor strip: selecting actor sets shell selection/Inspector only.
     - Scope grid: Scope cards from `scopeRecords`/`homeModel.scopeCards`, with New Scope card/button.
     - Recent activity teaser: use `homeModel.recentActivity` and link/switch to Activity.
     - Move Workspace-level Context list out of left nav; either keep a Home section if useful or surface primarily through actor Inspector. If retained on Home, style it as a skeleton-compatible content section, not legacy Channel.
  4. Phase the old Channel:
     - First reset slice: keep `renderChannel` behavior owner available, but stop treating it as always-visible legacy content. Open it only through explicit Context/composer affordances from Inspector/Home/Scope.
     - If a composer is placed inside `V6Inspector`, it must call the same `sendFloeMessage`/`buildEmitBody` path and share selected actor/context state. Do not implement a second composer state machine.
     - Tests may continue to refer to "Channel" internally, but user-visible copy should move toward Context/Actor conversation affordance as approved.
  5. Port CSS from `v6.css` / `linear-calm.css` into production-owned CSS:
     - Adopt `.v6shell`, `.v6top`, `.lnav`, `.v6main`, `.rinsp`, `.hero`, `.actor-strip`, `.scope-grid`, `.scope-card`, `.ws-stream`, and related token semantics.
     - Keep production `oklch` token values if desired, but align names/roles to the mock token contract and ensure screenshot-level structure matches.
     - Explicitly restyle React Flow inside the v6 shell without disabling its interaction model.
  6. Keep Scope/Field map handlers intact. If `V6ScopeSurface` is extracted, it must receive existing React Flow props/handlers and not reimplement map state.
  7. Add/adjust tests to encode the reset, including skeleton composition and screenshot/liveness comparison, then update old tests that encode the rejected hybrid.
- Why this is the correct integration point:
  - The user's rejection is about visible composition and behavior affordances, not a substrate data rewrite. The shell return boundary can change the product experience while retaining proven bus/React Flow owners.
  - `main.tsx` already has all required data/actions for a skeleton port; component extraction around it prevents parallel data paths.
  - The v6 skeleton's `shell.js` is structurally clear enough to port into React components, but its data/model APIs are mock-only and must not cross into production.
  - Reusing current pure view models keeps corrected substrate invariants while allowing visible UX reset.
- Alternatives considered and rejected:
  - Continue incremental styling of current `.floe-shell`: rejected. It is exactly the hybrid path the user rejected.
  - Copy prototype DOM/JS into React with `dangerouslySetInnerHTML` or script islands: rejected. It would bypass React state, bus owners, routing, and tests.
  - Import mock data/runtime: rejected. It would create a demo path parallel to FloeWeb.
  - Rewrite Scope map to match prototype SVG: rejected. React Flow is the production owner and substrate invariant.
  - Full shadcn/Tailwind migration now: rejected for this reset slice. The theme doc says aliases are a future port contract, and the app has no such stack.
  - Fully delete Channel behavior in the first slice: rejected. Existing bus send/open behavior is working and must be preserved while the right-side affordance is redesigned.

## Regression checklist

- Behavior: Workspace attach/create/select/reconnect/refresh still work.
- Behavior: Topbar Workspace switcher remains brand-adjacent and creates/selects real Workspaces through current bus routes.
- Behavior: Home is reachable as Workspace Home and is not represented as a Scope or Field.
- Behavior: Home visible composition follows v6 skeleton order: hero, workspace settings, actor strip, Scope grid, recent activity teaser.
- Behavior: Left nav shows Home and Activity always, Scopes and New Scope, Scope Contexts only inside a Scope/Field, and does not show Workspace-level actor Contexts.
- Behavior: Selecting an actor updates Inspector without creating Field nodes or opening Channel implicitly unless an explicit conversation affordance is used.
- Behavior: Workspace-level actor Contexts remain visible/discoverable through Home/Actor/Inspector and openable in the preserved conversation path.
- Behavior: Assigning an unscoped actor Context to a named Scope still uses `assignContextToScope` and never Default Scope fallback.
- Behavior: Scope cards derive from `/v1/workspaces/:id/scopes`; Home does not prefetch Scope projections.
- Behavior: New Scope click/drag uses `createScope`; no `/fields` call appears.
- Behavior: Scope/Field map still loads `getScopeProjection`, maps via `projectionToReactFlow`, and saves layout via `/projection/layout/floeweb`.
- Behavior: React Flow pan, zoom, drag, selection, handles, Context open, rename, pulse subscriber connect/delete, MiniMap, and Controls still work.
- Behavior: Channel/composer sends through `buildEmitBody` and `/v1/events/emit`; read-only Context constraints remain enforced.
- Behavior: Activity surface still filters bus-backed Activity rows by actor/source, kind, Scope, and Context.
- Behavior: Runtime profile/model controls and actor access summary still use real auth profiles/runtime bindings.
- Behavior: No production runtime import/read of mock HTML/CSS/JS/data or screenshots.
- Behavior: No product UI copy contains "Default Scope", "Default Field", "Home Scope", "Thread", `.floe/blocks`, or actors-as-Field-nodes language.

## Test plan

- Existing tests to keep green:
  - `npm run test:unit`
  - `npm run test:e2e`
  - High-priority E2E: `v6-shell-frame.spec.ts`, `v6-feature-shell.spec.ts`, `v6-home-surface.spec.ts`, `v6-channel-preservation.spec.ts`, `v6-scope-field-map.spec.ts`, `v6-activity-content.spec.ts`, `v6-inspector-content-depth.spec.ts`, `workspace-home-assignment.spec.ts`, `field-substrate.spec.ts`, `scope-projection.spec.ts`, `context-rendering.spec.ts`, `actor-neutral-ui.spec.ts`, `no-actor-bleed.spec.ts`, `emit-e2e.spec.ts`, and `workspace-management.spec.ts`.
  - Unit tests for `activity.ts`, `contexts.ts`, `home-view-model.ts`, `inspector-view-model.ts`, `scope-projection.ts`, `scope-projection-api.ts`, and `fields.ts`.
- New tests to add before/with implementation:
  - E2E skeleton contract: assert `.v6shell`/topbar/body/left-nav/main/right-inspector structure, persistent across Home/Activity/Scope.
  - E2E left-nav semantics: Home and Activity always; Scopes and New Scope; Contexts only inside opened Scope; Workspace-level Context text absent from left nav.
  - E2E actor semantics: selecting actor from Home and left nav updates right Inspector, does not auto-open Channel, does not fetch projection, and creates no `.react-flow__node` for the actor.
  - E2E Home skeleton: hero, workspace settings, actor strip, Scope grid/card, New Scope card, recent activity teaser in the same order as `renderHomeOverview`.
  - E2E Channel/composer preservation: explicit Inspector/Home/Scope conversation affordance opens contextual composer/Channel and emits the same `buildEmitBody` payload.
  - E2E no legacy residue: Home/Scope/Activity do not show visible legacy "Fields" or "Block Library" panels unless explicitly retained as renamed New Scope affordance; no Default/Home Scope copy.
  - E2E visual smoke: at `1700x1100`, capture Home and actor-selected Home screenshots and compare manually/threshold against `floe-web-examples\screenshots\home.png` and `home-actor-selected.png`. Use scope/activity/context screenshots for boundary sanity, not full parity in first slice.
  - E2E responsive smoke: no horizontal overflow and usable topbar/Inspector/Channel at tablet/mobile sizes after shell reset.
  - Unit/presentational: if extracted, render `V6Home`, `V6LeftNav`, and `V6Inspector` from fixture props to assert semantics without bus.
- Existing tests to update/remove if they encode old UI:
  - Update selectors/copy that expect `.floe-shell`, `.workspace-rail`, `.content-row`, `.library-panel`, "Field" Home headings, or actor left-nav clicks opening Channel.
  - Keep the behavior assertions from those tests; only remove old visual/composition expectations that conflict with approved reset.
  - Any test expecting Workspace-level Contexts in left nav must be changed to expect discovery through Home/Actor/Inspector.
- Live proof required:
  - Run `npm --prefix floe-web run build`.
  - Run `npm --prefix floe-web run test:unit`.
  - Run relevant Playwright specs first, then full `npm --prefix floe-web run test:e2e` if time permits.
  - Start `npm --prefix floe-web run dev` and use Playwright at `1700x1100` to capture:
    - Workspace Home
    - Workspace Home with actor selected
    - Scope map
    - Activity surface
    - explicit Context/Channel/composer open state
  - In browser proof, check console has no errors, network has no `/fields` calls, and Home -> Scope -> Home navigation remains responsive.
  - Field live proof must include node select/drag, pan/zoom, handle visibility, Context open, and New Scope drag/drop.

## Risk assessment

- Risk: over-preserving old UI produces another hybrid and fails the user's explicit reset intent.
- Risk: over-porting prototype semantics imports mock data, mock routing, mock actor config, or mock DOM state into production.
- Risk: moving Channel into Inspector can accidentally create a second composer state machine or break existing emit/read-only behavior.
- Risk: changing actor selection semantics can break tests/flows that currently expect left-nav actor clicks to open Channel.
- Risk: replacing the shell grid can hide or remove Inspector, error bar, DialogHost, workspace create form, bus settings, or refresh controls.
- Risk: styling React Flow into v6 may reduce handle/edge/minimap contrast or accidentally disable pan/zoom/drag/drop.
- Risk: extracting components too aggressively can break closure-heavy callbacks in `main.tsx` or refresh race guards.
- Risk: visual tests can become brittle if treated as pixel-perfect rather than skeleton/layout fidelity.
- Risk: CSS token replacement can regress accessible focus rings, reduced-motion behavior, responsive layout, or contrast.
- Mitigation:
  - Make the first reset slice vertical but bounded: skeleton shell + Home + left nav + Inspector + preserved Channel path, leaving deeper Context surface parity for a follow-up.
  - Keep data/API ownership in `App` and pure view models; extract presentational components with typed props only.
  - Add tests for skeleton semantics and update old hybrid expectations before broad styling.
  - Run React Flow regression tests and live pan/zoom/drag proof after layout changes.
  - Keep old Channel behavior available behind explicit affordances until the user approves a full Context/composer surface redesign.

## Decision confidence

- Confidence: high for a bounded first reset slice that changes the production shell/Home/Inspector/left-nav composition while preserving current bus, Context, Activity, Scope Projection, and React Flow owners.
- Reasons:
  - The existing code already has substrate-correct state/actions and pure view models.
  - The v6 skeleton has clear composition contracts and CSS token references.
  - The reset can occur at a well-defined shell boundary without rewriting bus flows.
  - Existing tests cover many invariants; new tests can close the visual/skeleton gaps that allowed the hybrid to persist.
- Open questions:
  - Should the first reset immediately remove all visible "Field" wording from Home in favor of "Scopes" + "open Field/Map" affordance? Recommendation: yes, because the user explicitly wants v6 skeleton semantics and no old/new convention mixing.
  - Should left-nav actor clicks only select actors, or should they also open conversation UI? Recommendation: select only; explicit "Open conversation"/composer affordance belongs in Inspector.
  - Should the first reset embed a composer slot in the right Inspector, or keep the current separate Channel pane opened from Inspector? Recommendation: keep current Channel behavior owner, but render/open it contextually from Inspector; do not implement an embedded composer until the first skeleton shell is stable.
  - Should Context surface (`context.html`) be implemented in this slice? Recommendation: no. First slice should cover shell/Home/Activity entry/Scope boundary and preserve Channel; a dedicated Context surface reset should follow after the shell is accepted.
  - Should production adopt Inter via external `@import` like the mock? Recommendation: no external font dependency without approval; use system stack or package/self-host later.

