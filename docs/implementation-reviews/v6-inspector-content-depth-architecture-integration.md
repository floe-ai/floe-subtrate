# Architecture Integration Brief: v6-inspector-content-depth

## Existing ownership

- Package/component/module/library:
  - `floe-web\src\main.tsx` currently owns the App shell, `View` union (`home | activity | field`), Workspace Home, Activity view, Scope Map, right Inspector, transitional Channel, selected actor/context state, App-level loaded substrate data, and refresh paths (`main.tsx:362-540`, `main.tsx:760-890`, `main.tsx:2107-2744`, `main.tsx:3180-3362`).
  - `renderInspector()` in `floe-web\src\main.tsx` owns the right Inspector content today. It switches among selected actor, Activity aggregate counts, Workspace Home metadata/runtime/access, and opened Scope counts (`main.tsx:2657-2744`).
  - `floe-web\src\activity.ts` owns pure Activity row derivation/filtering from loaded Events, runtime Telemetry, Context summaries, Endpoints, and Scope records (`activity.ts:51-127`). Activity rows already carry row ids, category, title/kind/detail, source Endpoint labels, Context labels, Scope labels, Scope state, and created time (`activity.ts:28-42`).
  - `floe-web\src\contexts.ts` owns Context labels, participation labels, assignment eligibility/status, sorting, and Channel emit body semantics (`contexts.ts:33-153`).
  - `floe-web\src\scope-projection.ts`, `scope-projection-api.ts`, and `fields.ts` own Scope Projection mapping/API/layout. `projectionToReactFlow()` currently renders Context and Pulse projection refs into React Flow nodes/edges and does not render projection `events`/`activity` refs (`scope-projection.ts:60-76`, `scope-projection.ts:201-258`).
  - `@xyflow/react` owns Scope Map canvas mechanics in production: `ReactFlow`, `Handle`, `Controls`, `MiniMap`, `Background`, pan/zoom/drag/selection/connect/delete, and node/edge callbacks (`main.tsx:27-48`, `main.tsx:2547-2655`).
  - `floe-bus` owns canonical Workspace, Endpoint/Actor, Context, Event, Runtime Telemetry, Scope, Pulse, Scope Projection, and layout data. FloeWeb consumes existing APIs and must not create a parallel substrate store.
- Current owner rationale:
  - The requested slice is richer Inspector content over substrate data already loaded by `App`, not a backend/API/schema change. The Inspector should therefore remain a projection of App-owned view/selection state and pure view-model derivations.
  - Activity, Home, Actor, and Scope content already exist in App state; the missing capability is selection-aware/right-panel interpretation, not new substrate ownership.
  - Current `main.tsx` is already large. Non-trivial Inspector derivation should be extracted into a pure view-model module rather than adding more semantic branching directly inside JSX.
- Source evidence:
  - `CONTEXT.md` defines Workspace Home as not a Scope, Field as a FloeWeb rendering/projection of Scope, Scope Projection as read-only substrate-derived view, Actors as Workspace-scoped Endpoints, Contexts as bounded streams, and Thread as legacy wording (`CONTEXT.md:21-27`, `CONTEXT.md:68-83`, `CONTEXT.md:131-149`).
  - `docs\floe_web_product_spec.md` says the Inspector is not chat, not Floe, and not the full event log; it configures/explains the current selection and may show Workspace, Field/Block, actor access, activity, and setup health (`floe_web_product_spec.md:529-581`).
  - The pushed Activity brief established Activity as a top-level read-only observability surface over Events/Telemetry/Contexts/Scopes/Endpoints, using `src\activity.ts` for pure row derivation and avoiding emit/assignment side effects (`v6-activity-content-architecture-integration.md:94-150`, `activity.ts:51-127`).
  - The pushed Scope Map brief requires Scope content to integrate with React Flow and Scope Projection, not a mock/local graph or hand-rolled canvas path (`v6-scope-field-map-architecture-integration.md:61-100`).

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace Home is the default top-level view and renders Workspace settings, recent activity teaser, Actors, Scope-backed Fields, and Workspace-level Contexts. It explicitly says Home indexes Workspace state and is not a Scope (`main.tsx:2107-2349`).
  - Activity is a top-level read-only workspace surface. It derives rows from loaded Events, Telemetry, Context summaries, Endpoints, and Scopes; supports actor/source, kind, Scope/workspace-only, and Context filters; and row-level `Open Context` actions reuse the existing Channel path (`main.tsx:2351-2545`).
  - Activity filters do not emit Events, assign Scopes, fetch per-Context event lists, or open the Channel unless the user clicks `Open Context` (`v6-activity-content.spec.ts:84-143`).
  - Selecting an actor on Home updates the Inspector and does not open Channel or create actor nodes in React Flow (`v6-home-surface.spec.ts:74-88`). Actor rows in the left nav intentionally open Channel as a separate affordance (`main.tsx:3285-3298`).
  - Actor Inspector shows name, Endpoint id, status, optional agent id, Context participation cards, and ActorAccess. Context cards open the existing Channel (`main.tsx:2668-2704`).
  - Scope Map opens named Scopes via `openField(scope_id)`, loads Scope Projection and renderer layout, renders React Flow, preserves Context `Open`, rename, fit/center, handles, selection, pan/zoom/drag, Pulse subscriber connect/delete, and Block Library/New Scope drag affordances (`main.tsx:942-983`, `main.tsx:2547-2655`, `v6-scope-field-map.spec.ts:88-162`).
  - Transitional Channel owns opening Contexts and send/emit behavior. `openWorkspaceContext()` / `openProjectedContext()` set selected Context, open Channel, and fetch Context events; `sendFloeMessage()` uses `buildEmitBody` and `/v1/events/emit` (`main.tsx:836-867`, `v6-channel-preservation.spec.ts:86-118`).
- Behaviors that must remain unchanged:
  - Inspector enrichment must not make Activity create Events, assign Scopes, or become a full event-log replacement for Activity or Channel.
  - Opening Contexts from Inspector or Activity must continue through `openWorkspaceContext()` / `openProjectedContext()` and the existing Channel/event fetch path; do not add `openContextV6`, `emitV6`, or a direct runtime path.
  - Workspace Home must stay an index/dashboard over Workspace state, not a Scope, Home Scope, Default Scope, Default Field, or hidden fallback bucket.
  - Actor Inspector content must stay Workspace-scoped and endpoint/Context-participation oriented; it must not imply Actors are Field members, graph nodes, or contained by Scopes/Fields.
  - Scope Inspector content must stay derived from `loadedProjection`, `scopeRecords`, `activityRows`, and existing App data. It must not infer membership from unrelated workspace Events or rely on empty projection `refs.events` / `refs.activity` as proof that there are no Events/Telemetry.
  - Scope Map React Flow behavior and performance are out-of-scope except for preserving selection/navigation state while the right Inspector gets richer.
- Runtime or UX evidence:
  - `v6-activity-content.spec.ts` proves read-only Activity filters and no `/events/emit` or per-Context event fetches during filtering.
  - `v6-home-surface.spec.ts` proves Home actor selection updates Inspector only and does not fetch projection or create actor graph nodes.
  - `v6-channel-preservation.spec.ts` proves Home, Actor Inspector, and projected Context openings use the existing Channel path and emit semantics.
  - `v6-scope-field-map.spec.ts` proves named Scope projection, React Flow rendering, legend, Inspector Scope counts, no legacy Field ownership, and New Scope drag affordance.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Keep Inspector display state in `App` unless extracting a pure module. Minimal new UI state for Activity row selection/drill-in should live beside `activityFilters` in `main.tsx`, e.g. `selectedActivityRowId`, because Activity rows are derived from App-loaded state and should reset on workspace switch/filter invalidation.
  - Reuse `activityRows` / `filteredActivityRows` and `ActivityRow` from `src\activity.ts` for Activity selected-row detail. Do not create a second row derivation inside Inspector.
  - If row detail needs richer facts, extend `src\activity.ts` with pure view-model helpers such as `summarizeActivitySelection`, `buildActivityInspectorModel`, or `buildInspectorViewModel` that accept loaded data and return display-ready facts.
  - Reuse `contextActivityLabel`, `contextParticipationLabel`, `workspaceContextLabel`, `sortContextsForAgent`, and `contextLabel` from `contexts.ts` for Context labels and actor participation semantics.
  - Reuse existing open callbacks: `openWorkspaceContext(context)` for full ContextSummary rows and `openProjectedContext(context_id)` for Scope Projection refs. Activity selected-row detail may expose `Open Context` only when an existing Context summary is available or the selected row's Context can be resolved through `activityContexts`/`workspaceContexts`/`contexts`.
  - Reuse App-loaded Workspace/Home data: `selectedWorkspace`, `scopeRecords`, `fieldSummaries`, `workspaceContexts`, `activityContexts`, `events`, `telemetry`, `endpoints`, `runtimeBindings`, `authProfiles`, `bridgeRuntimeKnown`, `bridgeRuntimeAdapter`, `effectiveProfile`, and `effectiveModel`.
  - Reuse Scope Projection data: `loadedProjection.projection.refs.contexts`, `refs.pulses`, relationships, unsupported entries, and derived counts already in `openedScopeActorCount` / `openedScopeEmitCount`.
  - Reuse existing test helpers in `floe-web\tests\helpers.ts`; they can seed Endpoints, Workspace Contexts, Events, Telemetry, Scopes, projections, Context events, and intercept legacy `/fields` / emit calls (`helpers.ts:156-285`, `helpers.ts:326-697`).
- Relevant docs or library capabilities:
  - React Flow is already the canvas owner; Inspector content may reflect current Scope Projection state but should not implement canvas selection behavior outside React Flow.
  - Product spec allows Activity/Inspectors as ways to surface substrate concepts but says Inspector is not chat and not the full event log (`floe_web_product_spec.md:112`, `floe_web_product_spec.md:529-535`, `floe_web_product_spec.md:803-822`).
- Existing examples in this codebase:
  - `src\activity.ts` is the precedent for extracting substrate display derivation out of `main.tsx`.
  - `contexts.ts` is the precedent for pure semantic helpers with Vitest coverage.
  - `renderInspector()` already uses `InspectorSection`, `Detail`, `RuntimeSection`, and `ActorAccessSection`; enrich within those patterns before adding new layout systems.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate `src\activity.ts` Activity row derivation or re-parse Telemetry differently in the Inspector.
  - Do not duplicate `contexts.ts` Context labels, participation labels, assignment status, or `buildEmitBody` semantics.
  - Do not bypass `floe-bus` APIs or add local/mock substrate records for Inspector detail.
  - Do not replace or wrap React Flow with a parallel Scope selection/canvas state owner.
  - Do not add backend schema/API changes for this slice unless existing loaded App data is demonstrably insufficient; the requested outcome is explicitly based on substrate data already loaded by App.
  - Do not create new Channel/send/emit/open Context paths from Inspector detail.
- Shortcuts or parallel paths to avoid:
  - No `Default Scope`, `Default Field`, `Home Scope`, fake `scope_id=default`, `.floe/blocks`, or Field-owned membership wording.
  - No Actor-as-Field-member phrasing such as “Actor in this Field”; use Workspace actor, Endpoint, source, participant, Context participation, runtime readiness.
  - No Activity selected-row state stored inside the row component DOM, localStorage, or URL until routing is designed; keep it App-local and reset when Workspace changes.
  - No reliance on `loadedProjection.projection.refs.events.length === 0` or `refs.activity.length === 0` to claim the Scope has no Events/Telemetry. Those projection arrays currently exist in types but are not a reliable populated source for this content slice.
  - No full event log in the Inspector. Inspector can show selected-row details, recent/top counts, and actionable links; Activity remains the stream/filter surface.
- Invariants:
  - Workspace is top-level; Home is an index/dashboard over Workspace state and is not a Scope.
  - Actors are Workspace-scoped Endpoints and are not inside Scopes/Fields.
  - Contexts are bounded streams; Workspace-level actor Contexts with `scope_id: null` are valid.
  - Scoped Contexts have non-null `scope_id` and are required for actorless/event-linked operational flows.
  - Field is a FloeWeb rendering/projection of Scope; React Flow owns Scope Map canvas behavior.
  - Activity is read-only observability and must not create Events or assign Scopes.
  - Preserve React Flow-native interaction patterns, Block Library drag/drop/New Scope affordance, node icons/labels/handles/selection, pan/zoom/drag performance, rename/open affordances, and connection affordances.

## Integration plan

- Insert the change at:
  1. Add tests first for richer Inspector content, using existing Playwright fixtures and Vitest for pure helpers. Recommended new file: `floe-web\tests\v6-inspector-content-depth.spec.ts`; recommended unit file if extracting a module: `floe-web\src\inspector-view-model.test.ts`.
  2. Introduce Activity row selection/drill-in in `main.tsx` as App-level state, e.g. `selectedActivityRowId`, because the selected row is derived from `activityRows` and needs to drive the right Inspector. Activity row click/keyboard selection should update this state; `Open Context` remains a separate explicit Channel action. Reset it on workspace switch and clear it when filters make the selected row unavailable.
  3. Extend Activity rows with accessible selected state (`aria-selected` or button semantics) and preserve existing filter behavior. The selected row should populate an Inspector section with category, kind/title, detail, source Endpoint, Context label/id, Scope state/label, timestamp, and safe actions (`Open Context` only when a Context summary is resolvable). It must not emit, assign Scope, or fetch Context events just to select.
  4. Extract a pure Inspector view-model module if the content logic goes beyond simple JSX. Recommended `floe-web\src\inspector-view-model.ts` or small additions to `activity.ts` for Activity-specific selection. Inputs should be plain App data; output should be display rows/sections/actions descriptors. This avoids increasing `main.tsx` semantic complexity and makes terminology/test cases easy to lock down.
  5. Enrich Workspace/Home Inspector from existing Home data without treating Home as Scope: show Workspace id/name/location/status, `.floe` state, runtime adapter/default profile/model/readiness, counts for named Scopes, Workspace-level Contexts, all loaded Contexts, Workspace Events, runtime records, Actors, and “Home is Workspace index, not a Scope” wording. Avoid “Fields” where “named Scopes” is the substrate-correct content; if product UI still says Field for card labels, Inspector should be precise: `Named Scopes` / `Scope-backed Fields`.
  6. Enrich Actor Inspector with Workspace-scoped Endpoint facts: Endpoint id, name/status/agent id, runtime binding/readiness for that Endpoint, Context participation counts split by Workspace-level vs scoped, recent participation list using `sortContextsForAgent`, and selected actor Activity counts from `activityRows`. Keep wording “Workspace actor/Endpoint” and “Context participation”; do not imply Field membership.
  7. Enrich Scope Inspector with content from `loadedProjection` and correlated Activity rows: Scope title/id, projected Context count and labels, Pulse count/status/fire counts, unique participant/actor count from projection relationships, unsupported count/details, Activity rows whose `scopeId === view.fieldId`, and a clear note when projection `events/activity` refs are empty/unpopulated. For Context lists, use `loadedProjection.projection.refs.contexts`; for Event/Telemetry summaries, prefer `activityRows` correlated by Context/Scope over empty projection refs.
  8. Keep `RuntimeSection` and `ActorAccessSection` reused rather than duplicating readiness/access UI.
- Why this is the correct integration point:
  - The right Inspector already lives in `main.tsx` and already branches by App view/selection. App already has the substrate data required for this slice, so enriching Inspector models there avoids backend/API churn and avoids another state owner.
  - Activity row selection is view-specific UI state, not substrate state. It belongs next to `activityFilters` and should reference derived `ActivityRow.id` rather than copying row objects into state.
  - A pure view-model module mirrors `activity.ts` and `contexts.ts`, keeps substrate terminology testable, and prevents the already-large `main.tsx` from accumulating more domain derivation.
- Alternatives considered and rejected:
  - Backend Inspector endpoint: rejected for this slice because App already loads Events, Telemetry, Contexts, Endpoints, Scopes, and Projection data.
  - Making Activity row selection open Channel automatically: rejected because Activity is inspect-only; opening Context remains an explicit row action.
  - Storing selected Activity row in URL/localStorage: rejected until a routing/deep-link design exists.
  - Deriving Scope Inspector activity solely from Scope Projection `refs.events`/`refs.activity`: rejected because current projection mapping/rendering does not treat those as populated reliable display sources, and previous Activity brief flagged them as empty/incomplete.
  - Moving Inspector into Channel: rejected because product spec and existing tests keep Inspector separate from chat/communication.

## Regression checklist

- Behavior:
  - Activity remains top-level, read-only observability. Selecting rows updates Inspector only; filters still do not emit, assign Scope, or fetch Context events; `Open Context` explicitly uses existing Channel.
  - Workspace Home remains top-level and not a Scope. No Default Scope/Field/Home Scope language appears; Home does not fetch Scope Projection unless a named Scope is opened.
  - Actor Inspector describes Workspace-scoped Endpoints and Context participation. It does not create actor graph nodes, fetch Scope Projection, or imply Field membership.
- Behavior:
  - Scope Inspector content derives from opened Scope Projection plus correlated loaded Activity rows. Empty projection event/activity refs are not treated as authoritative absence of activity.
  - Scope Map React Flow behavior remains unchanged: node labels/icons/handles/selection, pan/zoom/drag, rename/open, fit/center, Pulse subscriber connect/delete, Block Library/New Scope drag/drop, minimap/controls, layout persistence.
  - Transitional Channel remains distinct from Inspector and continues to own Context event display and message submission through `/v1/events/emit`.
- Behavior:
  - Workspace switching clears stale Inspector selections including selected Activity row; Activity and Inspector do not show rows/facts from the previous Workspace.
  - Existing runtime readiness/access sections still show correct profile/model/adapter/binding status and do not hide errors.
  - No legacy `/fields`, mock data, `.floe/blocks`, Thread terminology, or direct file/runtime bypass is introduced.

## Test plan

- Existing tests to keep green:
  - Unit: `cd floe-web && npm run test:unit` including `src\activity.test.ts`, `contexts` tests, `scope-projection` tests, and any new Inspector view-model tests.
  - E2E targeted: `floe-web\tests\v6-activity-content.spec.ts`, `v6-home-surface.spec.ts`, `v6-scope-field-map.spec.ts`, `v6-channel-preservation.spec.ts`, `workspace-home-assignment.spec.ts`, `context-rendering.spec.ts`, `no-actor-bleed.spec.ts`, `scope-projection.spec.ts`, and `field-substrate.spec.ts`.
  - Full relevant validation before merge: `cd floe-web && npm run build && npm run test:e2e` when runtime permits.
- New tests to add before/with implementation:
  - E2E: Activity row selection updates the right Inspector with selected row details (category, kind/title, source, Context, Scope state, timestamp, detail) while not opening Channel and not calling `/v1/events/emit`, `/assign-scope`, `/v1/contexts/:id/events`, or legacy `/fields`.
  - E2E: Activity selected row `Open Context` remains an explicit action and uses the existing Channel path, fetching Context events only after the action.
  - E2E: filtering Activity clears or updates stale selected-row Inspector detail when the selected row is no longer visible.
  - E2E: Home Inspector shows Workspace substrate summary (named Scopes, Workspace-level Contexts, all loaded Contexts, Events, runtime records, Actors, runtime readiness) and contains “Workspace index”/not-Scope semantics with no Default/Thread/`.floe/blocks` leakage.
  - E2E: Actor Inspector shows Workspace-scoped Endpoint/runtime readiness plus Context participation split between Workspace-level and scoped Contexts; selecting an actor does not open Channel from Home and does not create actor React Flow nodes.
  - E2E: Scope Inspector shows projected Contexts, Pulses, unsupported entries, participant/actor count, and correlated scoped Activity rows; it does not claim no activity solely because projection `refs.events`/`refs.activity` are empty.
  - E2E: Scope Map interactions still pass after Inspector enrichment: open Context, drag node/layout PUT, handles visible, Pulse subscribe/unsubscribe, New Scope drag.
  - Unit: pure Inspector/Activity view-model helpers for Workspace/Home counts, Actor participation/runtime readiness, Activity selected row detail, Scope projection summary, and terminology guard cases.
- Live proof required:
  - Run the targeted new E2E spec and capture Playwright evidence/screenshot of: Activity selected row reflected in Inspector, Home Inspector substrate summary, Actor Inspector participation/runtime readiness, and Scope Inspector projection/activity summary.
  - In a live FloeWeb session against a running bus, navigate Home -> Activity -> select row -> Open Context -> Scope Map; verify Inspector updates, Channel remains explicit, browser console has no relevant errors, network has no `/fields`, and no Default Scope/Field/Thread terminology appears.
  - Manually verify React Flow pan/zoom/drag/selection/handles/rename/open and Block Library/New Scope drag still work after the right Inspector changes.

## Risk assessment

- Risk:
  - Adding Activity row selection can accidentally open Channel, fetch Context events, or mutate filters/Scope assignment. Keep selection App-local and side-effect-free; reserve Channel opening for existing explicit `Open Context` actions.
- Risk:
  - More JSX inside `renderInspector()` can further entangle `main.tsx` and duplicate domain rules. Extract a pure Inspector view-model when deriving counts/lists/status from multiple data sources.
- Risk:
  - Actor detail can drift into Field-membership language or visual graph ownership. Use Endpoint/Workspace actor/Context participation terminology and add tests that no actor React Flow nodes are created.
- Risk:
  - Scope detail may mislead users if it uses empty projection `events/activity` refs as authoritative. Use projection refs for projected primitives and use `activityRows`/Context correlation for observed Events/Telemetry; label unresolved/unsupported data explicitly.
- Risk:
  - Runtime readiness logic can diverge from existing `RuntimeSection` / Channel composer logic if duplicated. Reuse existing effective profile/model/binding calculations and only add read-only presentation.
- Mitigation:
  - Test first against seeded substrate data; keep all data derivation pure and App-fed; preserve existing callbacks; add forbidden-terminology and forbidden-network-call assertions; run targeted React Flow/Channel regressions after implementation.

## Decision confidence

- Confidence: high
- Reasons:
  - Ownership is clear: `main.tsx` owns the shell/Inspector state, `activity.ts` and `contexts.ts` own pure derivations, Scope Projection/React Flow own Scope Map data/canvas, and bus owns substrate records.
  - The requested slice explicitly uses existing data already loaded by App, so no backend or schema change is required.
  - Existing tests already protect Activity read-only behavior, Home not-as-Scope semantics, Actor Inspector separation, Channel preservation, and Scope Map React Flow invariants.
  - The main implementation choice—side-effect-free Activity row selection plus pure Inspector view-model extraction—is low-risk and directly addresses current `main.tsx` complexity.
- Open questions:
  - How much row detail should be shown for unresolved Context ids? Recommendation: show row source/kind/detail/timestamp and `Context unresolved`; do not offer `Open Context` unless a Context summary can be resolved.
  - Should Inspector support keyboard navigation between Activity rows? Recommendation: make rows buttons or selectable articles with accessible pressed/selected state in this slice if low-cost; otherwise cover mouse selection first and keep keyboard focus sane.
  - Should `src\activity.ts` own Activity selected-row detail, or should a new `inspector-view-model.ts` own all Inspector modes? Recommendation: create `inspector-view-model.ts` if Home/Actor/Scope enrichment is included in the same slice; keep Activity-specific helpers in `activity.ts` only if row detail is the only extraction.

- Docs/code conflict: `docs\floe_web_product_spec.md` still describes Field as a Block and mentions a bottom Inspector for empty Field (`floe_web_product_spec.md:131-147`, `floe_web_product_spec.md:369-377`), while current `CONTEXT.md`, pushed briefs, and code treat Field as a FloeWeb rendering/projection of Scope with a right Inspector. Use current code/runtime and `CONTEXT.md` for this slice.
- Docs/code conflict: Product spec says Inspector configures selection, but current v6 Inspector is mostly read-only observability/settings. For this content-first slice, enrich read-only substrate content; do not add mutation/configuration controls unless backed by existing safe actions.
- Docs/code conflict: Scope Projection types include `refs.events` and `refs.activity`, but current React Flow projection mapping ignores them and prior Activity brief flagged projection event/activity refs as incomplete/empty. Do not depend on those refs for rich Scope Inspector activity unless implementation evidence shows they are populated reliably.
