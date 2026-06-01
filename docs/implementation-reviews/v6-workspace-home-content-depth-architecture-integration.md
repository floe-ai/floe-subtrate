# Architecture Integration Brief: v6-workspace-home-content-depth

## Existing ownership

- Package/component/module/library:
  - `floe-web\src\main.tsx` owns the App shell, Workspace/Home/Activity/Scope Map/Inspector/Channel rendering, App-level loaded substrate state, selection state, and refresh paths. Current Home is `renderHome()` in `main.tsx:2146-2388`; it already renders Workspace settings, recent activity teaser, actors, Scope-backed Fields, and Workspace-level Contexts.
  - `floe-web\src\activity.ts` owns pure Activity row derivation/filtering from loaded Events, runtime Telemetry, Context summaries, Endpoints, and Scopes. `buildActivityRows()` already produces display-ready category/kind/detail/source/Context/Scope state for Events and Telemetry (`activity.ts:51-127`).
  - `floe-web\src\inspector-view-model.ts` owns recent pure view-model derivation for Workspace, Actor, and Scope Inspector summaries (`inspector-view-model.ts:10-89`). It is the nearest precedent for extracting Home semantic summary logic out of JSX.
  - `floe-web\src\contexts.ts` owns Context labels, Workspace-level vs scoped participation wording, assignment eligibility/status, sorting, and Channel emit body semantics (`contexts.ts:7-153`).
  - Scope records/projections are owned by `floe-web\src\scope-projection-api.ts`, `floe-web\src\scope-projection.ts`, `fields.ts`, and the bus Scope APIs. React Flow (`@xyflow/react`) owns Scope Map/canvas interaction behavior in `main.tsx:2666-2696`.
  - `floe-bus` remains the owner of canonical Workspace, Endpoint/Actor, Context, Event, Runtime Telemetry, Scope, Pulse, Scope Projection, runtime binding, auth profile, and local config data. FloeWeb must only project data already exposed by existing APIs.
- Current owner rationale:
  - Workspace Home content depth is a richer dashboard/index over App-loaded Workspace substrate data, not a new backend surface or substrate primitive. The existing App already loads Workspaces/auth/local config (`main.tsx:1023-1031`), Endpoints/runtime bindings/Events/Telemetry (`main.tsx:1045-1056`), Scopes as Field summaries (`main.tsx:1281-1288`), unscoped Home Contexts (`main.tsx:818-828`), and all Context summaries for Activity/Inspector (`main.tsx:830-845`).
  - Activity and Inspector slices already established non-parallel pure derivation modules (`activity.ts`, `inspector-view-model.ts`); Home should follow that pattern instead of adding more domain derivation inside `renderHome()`.
- Source evidence:
  - `CONTEXT.md:131-148`, `PRODUCT.md:32-80`, and ADR-0004 (`docs\adr\0004-scope-as-substrate-organising-boundary.md:15-48`) define Workspace as top-level, Home as an index/dashboard not a Scope, Actors as Workspace-scoped Endpoints, Scope as intentional, Field as Scope representation/projection, and Workspace-level Contexts as valid when actor-anchored.
  - The prior Home surface brief (`docs\implementation-reviews\issue-56-workspace-home-v6-surface-architecture-integration.md:3-90`) established current Home ownership and do-not-bypass rules.
  - The Activity and Inspector briefs (`v6-activity-content-architecture-integration.md:3-113`; `v6-inspector-content-depth-architecture-integration.md:3-109`) established reuse of `activity.ts`, `contexts.ts`, and App-loaded substrate data.
  - Targeted runtime/test evidence: `npx playwright test v6-home-surface v6-activity-content v6-inspector-content-depth v6-channel-preservation --reporter=line` passed 7 tests on this inspection run.
  - Docs/code conflict check: current `CONTEXT.md`, `PRODUCT.md`, ADR-0004, and v6 implementation briefs align with the current code. Historical Field substrate docs and older helper defaults that mention/create `Default` are superseded compatibility fixtures, not source-of-truth product language for this slice.

## Existing interaction model

- User/system behaviors that already exist:
  - Home is the default top-level Workspace view and says `Workspace index`; it does not load a Scope Projection until a named Scope/Field is opened (`main.tsx:2146-2168`, `v6-home-surface.spec.ts:64-73`).
  - Home Workspace settings show location, `.floe`/Workspace status, and runtime default profile/model from existing runtime binding/auth state (`main.tsx:2161-2183`, `main.tsx:561-572`).
  - Home recent activity currently merges raw `events` and `telemetry` into a five-row teaser (`main.tsx:495-511`, `main.tsx:2184-2211`). This duplicates some Activity summary semantics and should be replaced or backed by the shared Activity row derivation.
  - Home actor cards are Workspace Endpoint identities. Clicking a Home actor calls `selectActorForInspector()`, updates the Inspector only, clears selected Context/draft/events, and does not open Channel (`main.tsx:900-905`, `main.tsx:2214-2251`, `v6-home-surface.spec.ts:74-88`).
  - Home lists Scope-backed Fields from named Scope records and opens the existing Scope Map through `openField(summary.id)` (`main.tsx:2253-2303`).
  - Home lists first-class Workspace-level unscoped Contexts from `/v1/workspaces/:id/contexts?scope=unscoped&limit=6`, labels them with `workspaceContextLabel()` and `contextParticipationLabel()`, opens them through the existing Channel path, and assigns them only through `assignContextToScope()` / `createScope()` (`main.tsx:818-828`, `main.tsx:884-920`, `main.tsx:923-970`, `main.tsx:2304-2384`).
  - Activity is a top-level read-only view over Activity rows; selecting Activity rows updates Inspector without opening Channel or fetching Context events unless `Open Context` is explicitly used (`main.tsx:2390-2653`, `main.tsx:2763-2794`, `v6-activity-content.spec.ts:94-143`, `v6-inspector-content-depth.spec.ts:68-138`).
  - Scope Map remains React Flow-native with nodes, edges, handles, selection, pan/zoom/drag, connect/reconnect, delete, toolbar, minimap, and Block Library drop surface (`main.tsx:2655-2704`).
- Behaviors that must remain unchanged:
  - Home remains a Workspace index/dashboard, not a Scope, Home Scope, Default Scope, or Default Field.
  - Home must not block rendering or Channel fixtures on the all-Context `activityContexts` fetch. The existing split between `workspaceContexts` (Home unscoped list) and `activityContexts` (all Context summaries for Activity/Inspector) should remain non-blocking and failure-tolerant (`main.tsx:818-845`, `main.tsx:1190-1199`).
  - Home Context `Open` and Inspector/Activity `Open Context` must continue through `openWorkspaceContext()` / Channel; no new send/open path.
  - Assignment must continue through audited bus calls and named Scopes; no client-side fake membership writes.
  - Activity filtering/row semantics must remain centralized in `activity.ts`; Home should summarize a subset, not fork filtering rules.
  - Field/Scope Map React Flow behavior and performance must not regress.
- Runtime or UX evidence:
  - `v6-home-surface.spec.ts` protects Home as Workspace index, actor-to-Inspector behavior, unscoped Context label, no Default terms, no projection calls, no Channel open.
  - `v6-channel-preservation.spec.ts:120-182` protects opening Home Workspace-level Contexts in a distinct Channel without Scope defaults or legacy `/fields` calls.
  - `v6-activity-content.spec.ts` protects real Event/Telemetry rows, filters, Workspace-only vs scoped rows, and no emit/context-event fetch during Activity filtering.
  - `v6-inspector-content-depth.spec.ts` protects substrate-backed Workspace/Actor/Scope summaries and no Home-as-Scope language.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Reuse App-loaded `selectedWorkspace`, `authProfiles`, `runtimeBindings`, `bridgeRuntimeKnown`, `bridgeRuntimeAdapter`, `effectiveProfile`, `effectiveModel`, `endpoints`, `events`, `telemetry`, `scopeRecords`, `fieldSummaries`, `workspaceContexts`, `activityContexts`, and `activityRows`.
  - Reuse `buildActivityRows()` output for Home recent Events/Telemetry summaries. Recommended: derive a Home-specific subset from `activityRows` (e.g. newest 3-5 rows) rather than re-merging raw `events`/`telemetry` in `renderHome()`.
  - Reuse `contexts.ts` helpers for Context labels/status: `workspaceContextLabel`, `contextParticipationLabel`, `sortWorkspaceContexts`, `contextScopeAssignmentStatus`, and `canAssignContextToScope`.
  - Reuse `inspector-view-model.ts` pattern for a new pure Home model. Recommended module: `floe-web\src\home-view-model.ts` (or a narrow addition to `inspector-view-model.ts` only if scope stays very small) with functions such as `buildWorkspaceHomeModel`, `buildHomeScopeCards`, `buildHomeActorCards`, and `buildHomeSystemWarnings` that accept App-loaded substrate arrays and return display-ready counts/labels/warnings.
  - Reuse existing open/action callbacks: `openField`, `promptCreateField`, `selectActorForInspector`, `openWorkspaceContext`, `assignWorkspaceContextToScope`, and `promptCreateScopeAndAssign`.
  - Reuse existing Playwright helpers in `floe-web\tests\helpers.ts`; they can seed Workspaces, Endpoints, Scopes, Contexts, Events, Telemetry, auth profiles, runtime bindings, runtime adapter, context-event fetch tracking, projection fetch tracking, and legacy `/fields` traps (`helpers.ts:156-285`, `helpers.ts:326-665`).
- Relevant docs or library capabilities:
  - ADR-0004 permits actor-anchored Contexts with `scope_id: null` and explicitly says Home is not a Scope (`docs\adr\0004-scope-as-substrate-organising-boundary.md:30-48`).
  - React Flow is the existing library owner for Scope Map behavior; Home Scope cards should navigate to the existing map rather than previewing or reimplementing the canvas.
- Existing examples in this codebase:
  - `activity.ts` and `inspector-view-model.ts` show pure derivation extraction for content-heavy surfaces.
  - `renderInspector()` already consumes view-model output for Workspace/Actor/Scope summaries (`main.tsx:2709-2888`).
  - `renderHome()` already consumes all action callbacks needed for Scope cards, actors, and unscoped Contexts (`main.tsx:2146-2388`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate Activity row derivation/filtering from `activity.ts`.
  - Do not duplicate Context labels, participation labels, assignment status, or emit body semantics from `contexts.ts`.
  - Do not create a Home-specific backend store, mock substrate, localStorage cache, fake event feed, fake ops/work-log/object surface, or invented setup state.
  - Do not query or emulate legacy `/v1/workspaces/:id/fields`, `.floe/blocks`, field-owned membership, or Field-owned connections.
  - Do not duplicate Scope Projection mapping or React Flow canvas behavior. Home cards may link/open existing Scope Maps only.
  - Do not duplicate Channel send/open/event-fetch behavior.
- Shortcuts or parallel paths to avoid:
  - No `Default Scope`, `Default Field`, `Home Scope`, hidden `scope_id=default`, fake “general Field”, or Default fallback wording.
  - No treating Actors as Scope/Field members, React Flow nodes, Block Library items, or draggable canvas primitives.
  - No client-side inference that unscoped Contexts belong to a Scope just to produce counts.
  - No per-Scope projection fetches from Home just to count content. Use `activityContexts`, `activityRows`, `scopeRecords`, and available aggregate loaded data; defer projection-only metrics until a Scope is opened or backend summary exists.
  - No blocking Home or Channel fixtures on the all-Context fetch. If a new fetch is considered, it must be non-blocking, stale-safe, and separate from existing Channel event fetches.
- Invariants:
  - Workspace is top-level; Home is an index/dashboard over Workspace state.
  - Actors are Workspace-scoped Endpoints and are not inside Scopes/Fields.
  - Contexts are bounded streams; actor-anchored Contexts may be Workspace-level with `scope_id: null`.
  - Scopes are intentional named organising boundaries for connected/event-driven/operational work.
  - Field is FloeWeb's representation/projection of a Scope; React Flow owns Scope Map behavior.
  - Activity is read-only observability; Channel owns communication and `/v1/events/emit`.

## Integration plan

- Insert the change at:
  1. Add tests first around Home content depth in `floe-web\tests\v6-home-surface.spec.ts` or a new targeted `floe-web\tests\v6-home-content-depth.spec.ts`.
  2. Extract pure Home view-model derivation before expanding JSX if the Home content grows beyond simple display. Preferred new module: `floe-web\src\home-view-model.ts`, with unit tests if non-trivial aggregation/count logic is introduced.
  3. Replace `recentHomeActivity` raw merge in `main.tsx:495-511` with a summary derived from existing `activityRows`, so Home uses the same Event/Telemetry labels, source labels, Context labels, and Scope/workspace-only semantics as Activity.
  4. Enrich `renderHome()` sections in-place or through a prop-fed presentational component. Keep App state/fetching/callback ownership in `main.tsx`.
  5. Add Scope cards backed by `scopeRecords` + `activityContexts` + `activityRows`, showing substrate-safe facts that can be derived without projection fetches: Scope title/id, scoped Context count, recent Activity row count, latest activity timestamp/detail where present, and an `Open` action via `openField(scope_id)`. Continue using Field as representation wording only where existing UI labels require it; card copy should say named Scope / Scope-backed Field.
  6. Add actor cards backed by `endpoints`, `activityContexts`, `activityRows`, `runtimeBindings`, and local-config/auth state, showing status, runtime binding/readiness hints, Workspace-level/scoped participation counts, and latest actor Activity where present. Click continues `selectActorForInspector()` only.
  7. Promote Workspace-level unscoped Contexts as first-class communication streams: keep the dedicated Home section, preserve `scope=unscoped&limit=6`, show participant/last-activity/assignment status, and use `Open`/assign actions already present. If a total unscoped count is desired, use `activityContexts.filter(!scope_id)` only as an enhancement and label it as loaded count.
  8. Add system/setup warnings only from real loaded state: no auth profiles, local config unavailable, runtime adapter unknown/fake, selected Workspace not attached/authorized, no runtime binding/default model, no registered non-operator actors, no named Scopes, or no recent activity. Reuse existing `RuntimeSection` semantics/copy where possible.
- Why this is the correct integration point:
  - Home content depth is a projection of data already loaded for Home/Activity/Inspector. Deriving summaries in a pure module and rendering them through current Home preserves existing ownership and avoids backend/API churn.
  - `activityRows` is the correct shared summary source for recent Events/Telemetry because it already encodes Activity semantics and avoids duplicate parsing/filtering. Home should take a small unfiltered recent slice and link/navigate to Activity for deeper filtering, not own a second Activity language.
  - Scope cards should be based on named Scope records and correlated Context/Activity data, not Scope Projection fetches or Field membership. This prevents reviving Default Field/Scope and keeps React Flow as the only Scope Map owner.
  - Workspace-level unscoped Contexts should remain visually and semantically distinct from scoped Contexts using existing Context helpers and the dedicated `scope=unscoped` endpoint.
- Alternatives considered and rejected:
  - Backend/schema changes or a new dashboard endpoint: rejected; existing loaded data is sufficient for this vertical slice.
  - Home-specific Activity derivation from raw Event/Telemetry payloads: rejected; it would duplicate `activity.ts` semantics and risk drift from Activity filters/labels.
  - Fetching every Scope Projection to build Home cards: rejected; it would bypass the Scope Map owner, add expensive fan-out, and couple Home to projection completeness.
  - Treating Home as a Default Scope/Field to make counts look complete: rejected by ADR-0004 and current tests.
  - Adding unsupported Ops/work-log/object surfaces: rejected unless backed by existing Event/Telemetry/Context data and clearly labelled as Activity/runtime records.

## Regression checklist

- Behavior:
  - Home remains the default Workspace index/dashboard and never uses Default Scope, Default Field, Home Scope, Thread, `.floe/blocks`, or field-owned membership language.
- Behavior:
  - Home reuses `activityRows` for recent Events/Telemetry summaries; Activity row/filter semantics and the top-level Activity view remain unchanged.
- Behavior:
  - Home does not block on or require all-Context fetch success; older Channel fixtures and Home unscoped Context display continue working when `activityContexts` is empty or unavailable.
- Behavior:
  - Scope cards list named Scopes only, open via `openField(scope_id)`, do not call legacy `/fields`, and do not fetch Scope Projection until a Scope is opened.
- Behavior:
  - Workspace-level unscoped Contexts remain first-class, labelled distinctly from scoped Contexts, open through existing Channel, and assign only to explicit named Scopes.
- Behavior:
  - Actor cards remain Workspace Endpoint summaries; selecting one updates Inspector only and does not open Channel, create React Flow nodes, or imply Field/Scope membership.
- Behavior:
  - Runtime/setup warnings appear only from real loaded state and do not invent configuration records.
- Behavior:
  - Scope Map React Flow behavior remains unchanged: node icons/labels/handles/selection, pan/zoom/drag, rename/open affordances, connection affordances, minimap/controls, Block Library/New Scope drag/drop, and layout persistence.
- Behavior:
  - Channel communication and `/v1/events/emit` behavior remain unchanged.

## Test plan

- Existing tests to keep green:
  - Targeted Playwright: `v6-home-surface.spec.ts`, `v6-activity-content.spec.ts`, `v6-inspector-content-depth.spec.ts`, `v6-channel-preservation.spec.ts`, `v6-scope-field-map.spec.ts`, `context-rendering.spec.ts`, `channel-activity.spec.ts`, `field-substrate.spec.ts`, and `scope-projection.spec.ts`.
  - Unit/build where relevant: `cd floe-web && npm run test:unit`; `cd floe-web && npm run build` before merge.
  - Full e2e where runtime permits: `cd floe-web && npm run test:e2e` or at minimum the targeted specs above plus Home assignment/Scope Map/Channel preservation.
- New tests to add before/with implementation:
  1. Home content-depth e2e seeded with named Scopes, scoped/unscoped Contexts, Events, Telemetry, Endpoints, auth profiles, runtime bindings, and runtime adapter. Assert Home shows Workspace health/runtime readiness/profile/model/adapter from real state.
  2. Assert Scope cards show named Scope titles and meaningful counts/activity derived from `activityContexts`/`activityRows`; clicking opens the Scope Map; no projection request occurs before click; no legacy `/fields` request occurs.
  3. Assert Workspace-level unscoped Contexts remain in a distinct Home section with `Workspace-level Context` wording, participant/last-activity/assignment status, and existing `Open`/assign actions.
  4. Assert actor cards show status plus participation/activity/runtime hints, and clicking an actor updates Inspector only: Channel stays closed, no context-event fetch, no projection fetch, no React Flow actor node.
  5. Assert recent Home Activity rows use the same labels as Activity for Event vs runtime, source actor, Context label, and Workspace-only/Scope label; clicking/CTA to Activity is safe and does not emit or fetch Context events.
  6. Assert real setup warnings appear for seeded missing auth profiles/local-config/runtime binding/no actors/no Scopes states, and no warnings are invented when data is configured.
  7. Add Vitest tests for `home-view-model.ts` if extracted: Scope card aggregation, actor participation/activity counts, warning derivation, unscoped vs scoped labeling, empty/missing data fallbacks, and stable latest-activity ordering.
- Live proof required:
  - Run targeted Playwright proof and capture evidence that Home displays seeded real substrate data and no forbidden language.
  - Run live/local web stack if available; navigate Home -> Activity -> Scope Map -> Home Context Channel; capture screenshot(s), browser console with no errors, and network proof that Home did not call `/fields` or Scope Projection until Scope open.
  - Verify all-Context fetch failure/empty fixture does not break Home or Channel by preserving unscoped `workspaceContexts` and existing Channel flows.

## Risk assessment

- Risk:
  - Duplicating Activity semantics in Home would make Event/Telemetry labels, Context resolution, and Scope/workspace-only logic diverge from Activity.
- Risk:
  - Correlating Scope cards from incomplete loaded data could imply false totals. Counts should be labelled as loaded/visible when derived from `activityContexts`/`activityRows`; projection-only or backend-aggregate gaps should be deferred.
- Risk:
  - Using `activityContexts` as a required Home source could regress older tests/fixtures because the all-Context fetch is intentionally separate from the Home unscoped fetch and catches failures by setting `[]`.
- Risk:
  - Adding setup warnings from absence of optional data could over-warn in mocked or offline states. Warnings must be tied to explicit real state (`authProfiles.length === 0`, `bridgeRuntimeKnown === false`, missing binding/profile/model, Workspace status) and copy should say what is known.
- Risk:
  - Scope cards might revive Field-owned membership language if they show “Field contains actors/Contexts” rather than “named Scope / Scope-backed Field / projected when opened.”
- Risk:
  - Actor cards with participation hints might imply Actors live inside Scopes/Fields. Use Endpoint/Workspace actor and Context participation wording only.
- Risk:
  - More Home derivation inside `main.tsx` would deepen the monolith and make terminology harder to test.
- Mitigation:
  - Extract pure Home view-model helpers, reuse `activityRows` and `contexts.ts`, keep fetches non-blocking, label derived counts honestly, and add regression tests for no projection/legacy calls and no Default/Home Scope language.

## Decision confidence

- Confidence: high
- Reasons:
  - The needed data sources already exist in `main.tsx` and are covered by recent Activity/Inspector/Home/Channel tests.
  - Existing pure modules (`activity.ts`, `inspector-view-model.ts`, `contexts.ts`) provide clear extension points for content-first derivation without new backend/schema work.
  - ADR-0004 and current product docs align with code on Home-as-index, nullable actor Context Scope, named Scopes, and Field-as-Scope projection.
  - Targeted v6 tests passed during this scout run, confirming the current baseline for Home, Activity, Inspector, and Channel behavior.
- Open questions:
  - How many Home Activity rows should be shown before requiring navigation to Activity? Recommendation: 3-5 newest unfiltered `activityRows`, with a `View Activity` action rather than inline filters.
  - Should Scope cards display total loaded Context counts from `activityContexts` even if the all-Context fetch fails? Recommendation: yes only as loaded-data counts with empty fallback; do not block or invent totals.
  - Should Home get its own `home-view-model.ts` now? Recommendation: yes if implementing scope/actor/warning aggregation; avoid adding more semantic derivation to `renderHome()`.
  - Should live proof require real bus data or mocked seeded data? Recommendation: both if available; mocked Playwright is required, real/local stack screenshot and network proof are the acceptance-level live evidence.
