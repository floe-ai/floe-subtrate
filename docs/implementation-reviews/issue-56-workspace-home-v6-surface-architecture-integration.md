# Architecture Integration Brief: issue-56-workspace-home-v6-surface

## Existing ownership
- Package/component/module/library:
  - `floe-web` owns the production UI in `floe-web\src\main.tsx` and `floe-web\src\styles.css`.
  - `main.tsx` currently owns App-level Workspace, endpoint/actor, Scope/Field, Context, Channel, inspector, and selection state.
  - `floe-web\src\contexts.ts` owns Context labels, actor participation sorting, Workspace-level/scoped labels, and Scope-assignment eligibility.
  - `floe-web\src\scope-projection-api.ts` owns Scope list/create/rename/projection/layout HTTP calls; `scope-projection.ts` maps Scope Projection into React Flow; `fields.ts` owns renderer layout only.
  - `@xyflow/react` owns Field canvas behavior. `floe-bus` owns Workspace, Scope, Context, Event, endpoint/actor, runtime, and assignment data.
  - v6 mocks and screenshots under `C:\Development\ai-powered\floe-web-examples` are visual references only.
- Current owner rationale:
  - Product/domain docs define Workspace Home as a top-level index, Scope as a named substrate boundary, Field as a rendering of Scope, Context as actor- and/or Scope-anchored, and Actor as workspace-scoped.
  - Current code already routes Fields through Scope APIs and Context assignment through the Bus endpoint, with tests guarding no legacy `/fields` calls.
  - The v6 prototype is hand-authored DOM/CSS and mock data; importing it would bypass production state/actions.
- Source evidence:
  - `CONTEXT.md`: Workspace Home is not Scope; Field renders Scope; Scope Projection is read-only; Actors are workspace-scoped and not Field-owned; unscoped actor Contexts are valid.
  - `PRODUCT.md`: Workspace Home is the top-level index; actors are not draggable Field objects; Field canvas work should use React Flow; Tailwind/shadcn is a separate design-system decision.
  - `docs\implementation-reviews\v6-ui-shell-migration-architecture-integration.md`: keep existing App state/actions, preserve React Flow, do not import prototype DOM/mock data, keep Channel distinct from right inspector.
  - `main.tsx`: state owners include `selectedWorkspaceId`, `view`, `fieldSummaries`, `scopeRecords`, `endpoints`, `selectedAgentId`, `contexts`, `workspaceContexts`, `selectedContextId`, `channelOpen`, and `loadedProjection`.

## Existing interaction model
- User/system behaviors that already exist:
  - App boots to `view: { kind: "home" }`; Workspace changes reset to Home.
  - Home lists `fieldSummaries` derived from `listScopes()` and opens Fields via `openField(scope_id)`.
  - Home lists recent unscoped Workspace Contexts via `/v1/workspaces/:id/contexts?scope=unscoped&limit=6`.
  - Unscoped Workspace Contexts can be opened in Channel or assigned to an explicit named Scope through `assignContextToScope`.
  - Left nav lists Scopes and Actors; actor clicks currently set `selectedAgentId`, clear context selection, and open Channel.
  - Channel already shows selected actor Context participation and labels each Context with `contextParticipationLabel`.
  - Inspector shows Workspace/Runtime/Workspace actors on Home and Opened Field data on Field.
- Behaviors that must remain unchanged:
  - Home must remain Workspace Home, not an implicit Default Scope/Field.
  - New Scope affordances must keep using `createScope`/`promptCreateField`; assignment must keep using `assignContextToScope`.
  - Actors must not become React Flow nodes, Field items, or Scope Projection members.
  - Context labels must distinguish `Workspace-level Context` from `Scoped Context · <Scope title>` without Default language.
  - Field Surface must keep React Flow pan/zoom/drag/selection/handles/open/connect/delete behavior.
  - Channel remains a separate right-side conversation pane unless a later explicit product decision changes it.
- Runtime or UX evidence:
  - `v6-shell-frame.spec.ts` asserts v6 landmarks, left nav Home/Activity/Scopes/Actors, no `Default Scope/Field`, Channel and inspector coexist, and no legacy Field calls.
  - `workspace-home-assignment.spec.ts` asserts unscoped actor Context visibility, assignment to named Scope, inline Scope creation, and no Default fallback.
  - `no-actor-bleed.spec.ts` asserts selected actor Context queries, read-only non-operator Contexts, scoped vs Workspace-level labels, and no Default language.
  - v6 `home.html`/`home-overview.js` shows the target Home as Workspace hero + settings + actor strip + Scope grid + activity teaser; `shell.js` shows actor selection drives the right inspector.

## Existing extension points
- APIs/hooks/components/library features/stores/conventions to use:
  - Add a shell/inspector selection discriminator inside `main.tsx`, e.g. Workspace default vs selected actor, while keeping data state in current App.
  - Reuse `selectedAgentId` as actor selection where possible; if a separate inspector selection is added, keep it UI-only and endpoint-id based.
  - Reuse `endpoints`/`agents` for Workspace-level actors, `selectedWorkspace` for metadata, `fieldSummaries`/`scopeRecords` for named Scope-backed Field entries, `workspaceContexts` for unscoped discovery, and `contexts` for selected-actor participation.
  - Reuse `refreshContexts(workspaceId, actorEndpointId)`, `sortContextsForAgent`, `contextParticipationLabel`, `workspaceContextLabel`, `canAssignContextToScope`, `openWorkspaceContext`, `promptCreateScopeAndAssign`, `assignWorkspaceContextToScope`, `promptCreateField`, and `openField`.
  - Keep presentational extraction optional: a `WorkspaceHome` and `Inspector` component may be extracted, but should receive existing state/actions as props rather than owning API calls.
- Relevant docs or library capabilities:
  - React Flow remains owner of Field canvas interactions; do not port v6 prototype SVG map.
  - Existing dialog helpers in `dialog\dialog.tsx`/`dialog-controller` should remain the prompt/confirm path.
  - Existing CSS token layer from issue #55 is the right styling extension point; do not add Tailwind/shadcn for this slice.
- Existing examples in this codebase:
  - `renderHome()` already consumes Workspace, Fields, Workspace Contexts, and Scope assignment callbacks.
  - `renderInspector()` already branches by `view.kind`.
  - `renderChannel()` actor selector already updates `selectedAgentId` without mutating projection.
  - `tests\helpers.ts::seedAppWithScopes` already mocks Scopes, projections, unscoped Workspace Contexts, assignment, and legacy `/fields` traps.

## Do-not-bypass list
- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate Scope APIs, Context assignment API, Context label helpers, Scope Projection mapping, Field layout sidecars, React Flow, DialogHost, or Channel state.
  - Do not add a v6 mock data store or import prototype JS/CSS as runtime code.
  - Do not call or emulate legacy `/v1/workspaces/:id/fields`.
- Shortcuts or parallel paths to avoid:
  - No `default`, `Default Scope`, or `Default Field` fallback to make Home look populated.
  - No actor Field nodes, actor Block Library primitives, actor Projection refs, or client-side actor membership writes.
  - No client-side inference that assigns unscoped Contexts to a Scope just for display.
  - No replacing Channel with inspector conversation UI in this slice.
- Invariants:
  - Workspace Home is an index over Workspace state.
  - Actors are Workspace-level endpoint identities.
  - Scope Projection is scoped-only and read-only for membership.
  - Field/FloeWeb owns rendering/layout, not substrate membership or semantic connections.
  - New Scope and assignment affordances go through audited Bus paths.

## Integration plan
- Insert the change at:
  - Primary insertion point: `main.tsx` Home and Inspector rendering (`renderHome`, `renderInspector`, left-nav actor click handlers), using existing state/actions.
  - Secondary styling point: `styles.css` v6 Home/actor/inspector classes, reusing the issue #55 dark token layer.
  - If extraction is desired, first extract presentational `WorkspaceHomeSurface` and `RightInspector` components fed by current App props; keep state/actions in `App`.
- Why this is the correct integration point:
  - The slice changes Home presentation and inspector selection, not substrate ownership. Current App already owns all required data: Workspace metadata (`selectedWorkspace`), actors (`endpoints`/`agents`/`selectedAgentId`), named Scopes-as-Fields (`scopeRecords`/`fieldSummaries` from `listScopes`), Workspace Contexts (`workspaceContexts`), selected actor Contexts (`contexts`), and inspector rendering (`renderInspector`).
  - Actor selection should update UI selection only: set `selectedAgentId`, clear `selectedContextId`/draft/events as current code does, and render actor metadata/participation in inspector. It must not call `openField`, create projection nodes, or write Scope Projection.
  - Home Context labels should be produced by `workspaceContextLabel` for unscoped Home list and `contextParticipationLabel(ctx, scopeTitlesById)` for selected-actor participation, so `Workspace-level Context` and `Scoped Context · Name` stay distinct.
- Alternatives considered and rejected:
  - Importing `mocks\v6\home.html`, `home-overview.js`, or `shell.js`: rejected because they own DOM selection and mock data.
  - Creating a new v6 store/API layer: rejected because App already owns data and tests already protect those API contracts.
  - Modeling actors as Field nodes for selection: rejected by docs and would mutate the wrong ownership model.
  - Folding Channel into inspector now: rejected because current brief for #55 keeps Channel transitional and distinct.
  - Broad component/library migration: rejected for this slice; no Tailwind/shadcn stack exists in `package.json`.

## Regression checklist
- Behavior:
  - Home heading/eyebrow says Workspace/Home/Workspace index language, not Field/Scope fallback.
  - Home lists only named Scope-backed Fields from `GET /v1/workspaces/:workspace_id/scopes`.
  - New Scope buttons/dialogs still call `POST /scopes`; rename still calls `PATCH /scopes/:id`.
  - Home actor cards/left-nav actors set actor selection and update inspector; they do not open a Field unless the user selects a Scope/Field.
  - Actor inspector shows actor metadata plus related Context participation including both scoped and Workspace-level/unscoped Contexts.
  - Workspace-level unscoped Contexts remain discoverable on Home and/or selected actor views.
  - Scoped Contexts and Workspace-level Contexts use distinct labels with no Default wording.
  - Assigning a Workspace-level Context still requires an explicit Scope and calls `/contexts/:context_id/assign-scope`.
  - No active path calls legacy `/fields` endpoints or creates Field-owned membership/connections.
  - Existing Field React Flow affordances and Block Library click/drag Scope creation remain usable.
  - Channel still opens/toggles and selected actor conversation behavior remains actor-neutral.

## Test plan
- Existing tests to keep green:
  - `npm run test:unit`
  - `npm run test:e2e`
  - Especially `workspace-home-assignment.spec.ts`, `v6-shell-frame.spec.ts`, `scope-projection.spec.ts`, `field-substrate.spec.ts`, `context-rendering.spec.ts`, `actor-neutral-ui.spec.ts`, and `no-actor-bleed.spec.ts`.
- New tests to add before/with implementation:
  1. E2E Home-as-Workspace: seeded named Scopes and actors render on Home as Workspace index; no Default Scope/Field text; Home does not load any Scope projection until a Scope is opened.
  2. E2E actor inspector selection: click an actor on Home/left-nav; right inspector changes to Actor details and Context participation; no `.react-flow__node` for that actor appears and no projection/layout/assignment request is made.
  3. E2E Context discovery labels: selected actor inspector lists both an unscoped actor Context as `Workspace-level Context` and a scoped Context as `Scoped Context · <Scope title>`.
  4. E2E Scope affordances: Home `New Scope`/add Field still uses `POST /scopes`; Context assignment still uses `/assign-scope`; no legacy `/fields` calls.
  5. E2E Channel protection: selecting actor for inspector must not break existing Channel actor/context list and read-only behavior.
  6. Unit/pure tests only if new helper functions are added for actor participation grouping; otherwise keep using existing `contexts.ts` tests.
- Live proof required:
  - Run `npm run build`, `npm run test:unit`, and targeted Playwright specs above.
  - Start FloeWeb with mocked or local bus data and capture Playwright screenshots at about 1700x1100 for Workspace Home and actor-selected Home, comparing against `screenshots\home.png` and `screenshots\home-actor-selected.png`.
  - Capture console/network evidence: no console errors, no failed requests, no `/fields` requests, Home loads without projection calls until Field open, actor selection produces only context/endpoint reads.

## Risk assessment
- Risk:
  - Current `selectedAgentId` drives Channel selection as well as prospective inspector selection; selecting an actor from Home may unintentionally open Channel because left-nav currently does. Mitigation: decide whether Home actor-card selection should update inspector only or also open Channel; if changed, add tests protecting topbar Channel behavior.
  - Current `refreshWorkspaceContexts` fetches only `scope=unscoped&limit=6`; actor inspector participation currently comes from `/v1/contexts?participant=<actor>&workspace_id=<id>`, which can include scoped and unscoped Contexts. Do not use the unscoped Home list as the actor inspector's full participation source.
  - Some existing tests seed a Scope titled `Default` for historical coverage. This conflicts with corrected product language only if visible in new Home/actor flows. New #56 tests should seed named non-Default Scopes; legacy tests may need careful updating if broad no-Default assertions expand.
  - The v6 prototype inspector includes editable actor runtime profile/model controls; production already has runtime binding controls in Workspace inspector. Avoid adding unsupported actor config writes unless existing APIs own them.
  - `main.tsx` is monolithic; extraction can break closure-dependent callbacks. Prefer prop-fed presentational extraction or surgical in-place changes first.
  - Visual port may hide Block Library or React Flow affordances under new layout. Keep regression tests for Field/open/back/pan/zoom/drag/connect.

## Decision confidence
- Confidence:
  - High for integrating the v6 Home surface and actor inspector through existing `main.tsx` state/actions with CSS/token changes only.
- Reasons:
  - The required state owners and Bus-backed actions already exist.
  - Existing helper functions already encode the scoped vs Workspace-level Context language.
  - Existing tests and helpers already trap legacy Field calls, Default language, assignment paths, actor-neutral UI, and no actor/context bleed.
  - v6 references match the current architecture if treated as layout/visual guidance rather than data/runtime ownership.
- Open questions:
  - Should clicking an actor card on Home open Channel, or only select the actor in the right inspector? Recommendation: Home actor cards should update inspector only; topbar/Floe button should remain the Channel affordance. Left-nav may keep or change its current Channel-opening behavior only with explicit acceptance tests.
  - Should actor inspector expose runtime profile/model editing in #56, or only metadata/read-only participation? Recommendation: metadata + participation only for this slice; actor runtime editing needs a separate API/ownership review.
  - Should Home show a total Context count beyond the existing unscoped `limit=6` endpoint? Recommendation: do not invent counts unless Bus already returns them; display only available lists/counts from current endpoints.
