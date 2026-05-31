# Architecture Integration Brief: v6-activity-content

## Existing ownership

- Package/component/module/library:
  - FloeWeb shell/navigation, view state, Workspace Home, Scope Map, Inspector, and Channel are owned by `floe-web/src/main.tsx`. `View` is currently only `{ kind: "home" } | { kind: "field"; fieldId; backStack? }`, so Activity belongs in this same App-level view model rather than a separate shell.
  - Event and Emit ownership is in `floe-bus`: `/v1/events/emit` validates `EventCommandSchema` and calls `BusStore.submitEvent`; `/v1/events` returns `store.listEvents(...)`. FloeWeb only consumes event envelopes and must not create an alternate emit/send path.
  - Runtime Telemetry / Work Activity ownership is in `floe-bus`: `/v1/runtime/telemetry` appends and lists `runtime_telemetry` records via `BusStore.appendRuntimeTelemetry` and `BusStore.listRuntimeTelemetry`; FloeWeb parses `payload_json` only for display/grouping.
  - Context ownership is in `floe-bus` Context API and `floe-web/src/contexts.ts`. `/v1/workspaces/:workspace_id/contexts`, `/v1/contexts`, and `/v1/contexts/:id/events` serialize Context summaries/events; `contexts.ts` owns labels, sorting, participation labels, assignment eligibility, and `buildEmitBody` for the Channel emit path.
  - Scope records and Scope Projection ownership are in `floe-bus/src/scopes/*`, `floe-web/src/scope-projection-api.ts`, and `floe-web/src/scope-projection.ts`. FloeWeb maps Scope records to Field summaries and renders Scope Projection through React Flow.
  - Endpoints/actors are owned by `/v1/workspaces/:workspace_id/endpoints` and FloeWeb `Endpoint` state. Display labels are currently resolved by `endpointDisplayName(endpoint) ?? agent_id ?? "Actor"`, with operator fallback via `operatorActorId(workspace_id)` and cached operator display name.
  - Inspector is owned by `renderInspector()` in `floe-web/src/main.tsx`; it switches between selected actor, Workspace Home, and Scope inspection based on `view` and `selectedAgentId`.
- Current owner rationale:
  - Activity is a top-level workspace observability surface, not a new substrate primitive. The existing App already loads the exact substrate data needed: `events`, `telemetry`, `workspaceContexts`, `scopeRecords`, `endpoints`, and selected-context events.
  - Keeping Activity inside the existing shell preserves workspace switching, pulse/event refresh, Channel, Inspector, and Scope Map behavior.
- Source evidence:
  - `floe-web/src/main.tsx:180-182` defines the current View union.
  - `floe-web/src/main.tsx:351-405` owns App state including selected workspace, endpoints, events, telemetry, scopes, contexts, selected context, Channel, and Inspector state.
  - `floe-web/src/main.tsx:468-484` already derives `recentHomeActivity` by merging Events and Telemetry.
  - `floe-web/src/main.tsx:587-641`, `633-725`, and `2573-2626` already parse, label, merge, and render runtime activity for Channel.
  - `floe-web/src/main.tsx:933-980`, `1017-1045`, `1179-1237` load workspace data and refresh on event stream / Scope Projection changes.
  - `floe-bus/src/server.ts:587-641`, `671-729`, `807-830` expose canonical Emit/Event, Context, and Telemetry APIs.
  - `floe-bus/src/store.ts:1117-1168`, `1403-1448`, `1450-1498` own canonical Event submission, Telemetry persistence/listing, and Event listing.
  - `floe-web/src/contexts.ts:33-153` owns Context labels/sorting/assignment status and the existing Channel emit body.

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace Home is the default top-level view and explicitly says Home indexes Workspace state; it is not a Scope.
  - Home shows a recent activity teaser combining workspace Events and runtime Telemetry, but only the five newest rows and without filtering.
  - Home shows Workspace-level Contexts separately from Scopes and provides audited assignment to named Scopes.
  - Left navigation contains Home, disabled Activity, named Scopes, New Scope, and Actors. Actor rows select an actor and open the Channel.
  - Scope Map renders a named Scope via React Flow and Scope Projection, with node labels/icons/handles, selection, pan/zoom/drag, rename, connection, pulse subscriber, and layout persistence affordances.
  - Channel owns communication display and sending: Context list per actor, selected Context events, pulse cards, runtime activity grouped around agent messages, streaming output, read-only Context messaging guard, and composer using `/v1/events/emit`.
  - Inspector shows Workspace metadata on Home, Actor details plus Context participation when an actor is selected, and Scope counts when a Scope Map is open.
- Behaviors that must remain unchanged:
  - Activity navigation must not open Channel implicitly or change selected actor/context unless a deliberate row action is later added.
  - Channel send/emit semantics must remain the only message publishing path; Activity is inspect-only for this slice.
  - Workspace Home must remain a Workspace index, not a Scope and not a Default Scope substitute.
  - Scope Map / Field canvas behavior must not change; preserve React Flow-native interactions, Block Library/New Scope drag affordances, node icons/labels/handles/selection, pan/zoom/drag performance, rename/open affordances, and connection/subscriber affordances.
  - Context assignment must continue through `assignContextToScope`, `createScope`, Scope refresh, and projection refresh, not through Activity filters.
  - Workspace switching should reset top-level view safely and prevent old workspace data from appearing as current Activity.
  - Existing pulse subscription behavior and event stream refresh should remain.
- Runtime or UX evidence:
  - `floe-web/src/main.tsx:2044-2285` renders Home, recent activity, actors, Fields/Scopes, and Workspace-level Contexts.
  - `floe-web/src/main.tsx:2288-2395` renders Scope Map through React Flow and Scope Projection.
  - `floe-web/src/main.tsx:2398-2474` renders Inspector for Workspace/Actor/Scope modes.
  - `floe-web/src/main.tsx:2628-2925` renders Channel, Context list, chat segments, runtime activity, and composer.
  - `floe-web/src/main.tsx:2947-2950` shows the current disabled Activity nav row with title `Activity surface follows in a later v6 slice`.
  - `floe-web/tests/v6-home-surface.spec.ts`, `v6-channel-preservation.spec.ts`, `v6-scope-field-map.spec.ts`, and `v6-feature-shell.spec.ts` protect Home, Channel, Scope Map, and workspace switching behavior.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Reuse App-loaded `events` from `/v1/events?workspace_id=...&limit=200`; do not fetch a mock feed.
  - Reuse App-loaded `telemetry` from `/v1/runtime/telemetry?workspace_id=...&limit=200`; parse with existing `parseTelemetryPayload`, `telemetryContextId`, `summarizeTelemetry`, and `runtimeActivityLabel` logic or extract equivalent pure helpers.
  - Reuse `workspaceContexts` / Context summaries for Context labels, scope association, workspace-only filtering, and Context filter options. For Activity, this should load `scope=all` (or otherwise have all Context summaries available) because scoped filtering needs scoped and unscoped Contexts.
  - Reuse `scopeRecords` and `scopeTitlesById` for Scope filters and labels; Scope must be derived from Context/source ownership where possible, not treated as independent UI truth.
  - Reuse `endpoints`, `endpointDisplayName`, `operatorActorId`, `operatorDisplayName`, and existing actor label conventions for actor/source labels.
  - Reuse `contextParticipationLabel`, `workspaceContextLabel`, `sortWorkspaceContexts`, and `contextLabel` from `contexts.ts` where they fit. If Activity derivation gets non-trivial, extract a pure module such as `floe-web/src/activity.ts` for `deriveActivityItems`, `filterActivityItems`, label resolution, and summary counts.
  - Reuse existing test helpers in `floe-web/tests/helpers.ts`; they already support seeding Events, Telemetry, Workspace Contexts, Endpoints, Scopes, and context events.
  - Reuse existing shell CSS primitives (`nav-row`, `topbar`, `quiet-empty`, cards/rows/chips where available) with minimal new CSS for legible filters, summary, and rows.
- Relevant docs or library capabilities:
  - `CONTEXT.md` defines Workspace, Scope, Context, Event, Emit, Endpoint, and Work Log semantics. It explicitly says Event Scope derives from Context/source ownership and Work Log/runtime output is activity, not communication.
  - React Flow is already the Scope Map owner; Activity should not use or replace React Flow because it is a stream/list surface, not a canvas.
- Existing examples in this codebase:
  - Home recent activity derivation in `main.tsx:468-484`.
  - Channel telemetry filtering/grouping in `main.tsx:598-725`.
  - Context label and participation helpers in `contexts.ts:33-118`.
  - Docs/code conflict: Scope Projection types include `events` and `activity` refs, but current projection returns empty arrays, so Activity should not rely solely on Scope Projection for workspace-wide activity yet.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create a mock data feed, static fixture feed, local storage persistence, or client-generated substrate records for Activity.
  - Do not duplicate `/v1/events/emit`, `buildEmitBody`, Channel send/emit, or Event creation semantics.
  - Do not create new Context, Scope, Endpoint, Event, Emit, Work Log, Thread, Field, or Default semantics.
  - Do not introduce hidden Default Scope / Default Field language, `.floe/blocks`, field-owned membership, or fake local graph ownership.
  - Do not treat Event `scope_id` as independent UI truth; prefer Context `scope_id` and source ownership derivation where Context data exists.
  - Do not make Work Log / runtime Telemetry look like communication messages; label it as runtime activity/work activity.
  - Do not touch Scope Map/React Flow behavior except ensuring navigation to and from Activity preserves existing state and refresh behavior.
- Shortcuts or parallel paths to avoid:
  - Avoid querying `/v1/contexts/:id/events` for every Context just to build Activity; App already has workspace-level Events/Telemetry. Per-context fetches are only appropriate for existing Channel/open Context flows or a future drill-in.
  - Avoid adding backend API or persistence for this slice unless existing loaded data is demonstrably insufficient. This is a content-first FloeWeb surface over current data.
  - Avoid building filters in a way that mutates selected Context/actor or assigns Scope.
- Invariants:
  - Workspace is the top-level boundary; Workspace Home is not a Scope.
  - Scope is intentional and nullable for actor-anchored Contexts; no Default Scope fallback.
  - Context is a bounded stream anchored by participants, Scope, or both.
  - Event Scope is derived from Context/source ownership and must not become independent UI truth.
  - Runtime output / Work Log is activity, not communication.
  - Use Context, Event, Emit, Endpoint, Scope terminology; Thread is legacy.

## Integration plan

- Insert the change at:
  - Extend `View` in `floe-web/src/main.tsx` with `{ kind: "activity" }` and update shell rendering/breadcrumb/active nav logic accordingly.
  - Replace the disabled Activity nav row with an enabled button that clears Field editing/projection state similarly to Home and sets `view` to Activity without opening Channel.
  - Add `renderActivity()` as a sibling to `renderHome()` and `renderField()` inside the existing `App`, or delegate UI to a small component while keeping data ownership in App.
  - Add Activity filter state near existing App state: actor/source, kind, Scope/workspace-only, and Context. Keep it UI-local and reset only on workspace switch if needed.
  - Derive normalized Activity rows from existing `events`, `telemetry`, `workspaceContexts`, `scopeRecords`, and `endpoints`; sort newest-first for observability; cap or virtualize later if needed.
  - Render summary counts: total matching rows, Event/Emit count, runtime activity count, Context count, Scope/workspace-only count, and active filter summary.
  - Render stream rows that clearly distinguish canonical Events/Emits from runtime Telemetry/Work Activity records, show timestamp, kind, actor/source Endpoint label, Context label/id, Scope label or Workspace-only, and payload/content summary.
  - Add clear empty states for no substrate activity and for filters matching zero rows.
- Why this is the correct integration point:
  - Activity is top-level navigation over already-loaded workspace substrate content. `App` is already the shell owner and data loader, so the least parallel path is adding a view to the existing `View` union and deriving rows from current App state.
  - This preserves Channel as communication owner and Scope Map as React Flow owner while making existing substrate content inspectable.
- Alternatives considered and rejected:
  - Rejected mock parity UI from `floe-web-examples/mocks/v6/activity.html` as implementation source because the user corrected direction to prioritize content over v6 style and the mock uses static `F.allEmits` data.
  - Rejected backend Activity feed for this slice because Events, Telemetry, Contexts, Scope records, and Endpoints are already loaded and sufficient for content-first parity.
  - Rejected deriving scoped filtering solely from Event `scope_id` because `CONTEXT.md` says Event Scope derives from Context/source ownership and must not become independent UI truth.
  - Rejected embedding Activity inside Home teaser or Channel because the target is a top-level Activity view and Channel already owns send/communication semantics.
  - Rejected touching Scope Map/Field canvas because this slice is stream observability, not canvas behavior.

## Regression checklist

- Behavior: Workspace Home remains default, says Workspace index, shows settings/recent activity/actors/Scopes/Workspace-level Contexts, and has no Default Scope/Field terms.
- Behavior: Activity nav enables the top-level Activity view without opening Channel, changing selected actor unexpectedly, or mutating Context/Scope assignments.
- Behavior: Scope Map opens from Home/nav, continues to use React Flow, and preserves node icons, labels, handles, selection, pan/zoom/drag, rename/open affordances, and connection/subscriber affordances.
- Behavior: Channel still opens from actor rows, Home/Scope controls, and selected Context actions; sends only through `/v1/events/emit`; read-only Contexts remain guarded.
- Behavior: Context assignment from Home still uses audited assign/create Scope paths and refreshes Fields/Workspace Contexts/Open Scope.
- Behavior: Pulse subscriptions and Scope Projection stream refresh remain intact.
- Behavior: Workspace switching clears stale selected workspace data and does not leave Activity showing rows from the previous workspace.
- Behavior: Existing e2e and unit tests remain green, especially `v6-home-surface`, `v6-channel-preservation`, `v6-scope-field-map`, `v6-feature-shell`, `pulse-e2e` live skip behavior, Context tests, and Scope Projection tests.
- Behavior: No user-visible Default Scope, Default Field, Thread, `.floe/blocks`, or field-owned membership language appears in the new Activity surface.

## Test plan

- Existing tests to keep green:
  - `npm run test --workspace floe-web` should remain green (Vitest + Playwright).
  - Existing targeted specs: `floe-web/tests/v6-home-surface.spec.ts`, `v6-feature-shell.spec.ts`, `v6-channel-preservation.spec.ts`, `v6-scope-field-map.spec.ts`, `workspace-home-assignment.spec.ts`, `context-rendering.spec.ts`, and `channel-activity.spec.ts`.
  - Relevant bus tests should remain green if backend is untouched: `npm run test --workspace floe-bus` or targeted Event/Context/Scope Projection tests if full bus suite is costly.
- New tests to add before/with implementation:
  - Add a Playwright tracer spec, recommended file `floe-web/tests/v6-activity-content.spec.ts`, using `seedAppWithScopes` to seed at least:
    - two Endpoints with readable names;
    - one Workspace-level Context (`scope_id: null`) and one scoped Context (`scope_id` matching a Scope record);
    - canonical Events with `context_id`, source Endpoint, destination, type such as `message` and/or `pulse.fired`, and meaningful content;
    - Telemetry records with `endpoint_id`, `kind` such as `BeforeToolUse`/`AfterToolUse`/`visible_output_worklog`, and `payload_json` containing `summary`, `toolName`, `context_id`, optional `event_id`, duration/files.
  - Test that Activity nav is enabled, becomes active, and renders a top-level Activity surface with real seeded Event and Telemetry rows, actor/source labels, Context labels, Scope label, Workspace-only label, kind labels, and summary counts.
  - Test actor/source filter reduces rows to the selected Endpoint and clear filters restores all.
  - Test kind filter can isolate Event/Emit-like rows versus runtime activity rows.
  - Test Scope filter isolates the scoped Context while Workspace-only filter isolates `scope_id: null` actor Context rows.
  - Test Context filter appears for the chosen Scope or Workspace-only set and isolates a specific Context.
  - Test filtered-empty state appears for a valid filter combination that matches nothing, while initial empty state appears when seeded Events/Telemetry are both empty.
  - Test no forbidden terms appear: `/Default (Scope|Field)|\bThread\b|\.floe\/blocks/`.
  - Test opening Activity and applying filters does not call `/v1/events/emit`, does not call legacy fields endpoints, and does not fetch per-context event lists unless the user opens Channel.
  - If derivation/filtering is extracted to `src/activity.ts`, add Vitest unit tests for scope derivation precedence, telemetry payload parsing, actor label fallbacks, filter combinations, and stable sorting.
- Live proof required:
  - After implementation, run the new Playwright tracer and capture a screenshot or Playwright evidence of the Activity view showing seeded real Event + Telemetry content and active filters.
  - Run or document live app proof against a running bus/web stack: navigate to Activity, verify current workspace Events/Telemetry render, apply Workspace-only/Scope/actor/kind filters, inspect browser console for no errors, and confirm no Default Scope/Field/Thread terminology.

## Risk assessment

- Risk: Stale data if Activity relies on `workspaceContexts` but current code only loads unscoped recent contexts (`scope=unscoped&limit=6`) while the requested slice needs workspace-wide scoped and unscoped associations.
- Risk: Misleading Scope derivation if UI trusts Event `scope_id` over Context `scope_id` or cannot resolve a Context because only recent/unscoped Contexts were loaded.
- Risk: Actor/source labels may be ambiguous for null sources, operator pseudo-actor, deleted/unregistered Endpoints, or telemetry Endpoint IDs not currently in `endpoints`.
- Risk: Telemetry payload parsing can fail or payloads may use different keys (`context_id`, `event_id`, `summary`, `toolName`, `text`, `files_touched`, `duration_ms`); rows need safe fallbacks and must not crash rendering.
- Risk: Performance on large lists if all filters recompute over 200-500 Events plus 200-500 Telemetry records each render. Current limits are bounded, but derive/filter work should be memoized; if limits increase, consider virtualization or backend pagination.
- Risk: Communication vs work activity semantics can confuse users if telemetry rows are styled or labeled like messages. Keep Events/Emits and runtime activity visually/semantically distinct.
- Risk: Adding Activity view in `main.tsx` increases an already-large component. If derivation/filtering logic is more than simple mapping, extract a pure module before UI integration.
- Mitigation:
  - Load all Workspace Context summaries for Activity (`scope=all`, up to server max) or explicitly maintain a separate `activityContexts` state rather than reusing the Home-only recent unscoped list.
  - Build a Context lookup and Scope title lookup; derive Scope label from Context first, then use Event `scope_id` only as fallback with cautious labeling.
  - Use safe parser/fallback labels and memoized selectors; cap rendered rows initially while showing total count if necessary.
  - Keep Activity inspect-only and add tests that no emit/assignment APIs are called from filters.

## Decision confidence

- Confidence: medium
- Reasons:
  - High confidence on placement: existing App shell and loaded data are the right integration point for a top-level Activity view.
  - High confidence that Channel send semantics and Scope Map React Flow behavior should not be touched.
  - Medium confidence on exact data derivation because current `workspaceContexts` loading conflicts with the requested `scope=all` fact and Scope Projection `events/activity` refs are currently empty.
  - Medium confidence on telemetry-to-context association because it depends on optional `payload_json.context_id` and may be absent for some runtime records.
- Open questions:
  - Should Activity load a separate all-context list for the full workspace, or change existing `workspaceContexts` from Home-only `scope=unscoped&limit=6` to all contexts and derive Home's recent unscoped subset client-side? Recommended: change to all contexts if volume remains capped by server limit, or add separate `activityContexts` if preserving Home fetch shape is safer.
  - Should Activity row derivation/filtering be extracted first? Recommended: yes if implementation needs more than a small `useMemo`. A pure `src/activity.ts` module will make filter correctness testable and avoid adding complex substrate semantics directly to `main.tsx`.
  - Should Event `scope_id` ever be shown when no Context summary is available? Recommended: only as a fallback with wording such as `Scope from Event record` internally avoided in UI, and preferably surface `Unknown Context` rather than making Event Scope primary.
  - How should null source Events be labelled? Recommended: `System` for null `source_endpoint_id`, matching existing Channel message source fallback.

- Docs/code conflict: user-provided known fact says `workspaceContexts` loads `/v1/workspaces/:id/contexts?scope=all`; current code loads `/v1/workspaces/:id/contexts?scope=unscoped&limit=6` in `refreshWorkspaceContexts()` (`floe-web/src/main.tsx:749-755`). Activity needs all Contexts or a separate all-context data source.
- Docs/code conflict: `CONTEXT.md` says use Context/Event/Emit terminology and Thread is legacy, but current `EventEnvelope` still includes `thread_id` and Home recent activity can display `event.thread_id` as a fallback (`floe-web/src/main.tsx:140-142`, `468-473`). New Activity UI must not surface `Thread` terminology and should avoid making `thread_id` a visible primary label.
- Docs/code conflict: Scope Projection types include `refs.events` and `refs.activity`, but `buildScopeProjection()` currently returns `events: []` and `activity: []` (`floe-bus/src/scopes/projection.ts:91-105`). Activity should use workspace Events/Telemetry APIs for content-first parity, not Scope Projection event/activity refs, unless backend projection is expanded in a separate slice.
