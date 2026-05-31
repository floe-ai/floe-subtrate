# Architecture Integration Brief: issue-57-transitional-channel-preservation

## Existing ownership
- Package/component/module/library:
  - `floe-web\src\main.tsx` currently owns the transitional Channel UI and state: `channelOpen`, `channelMessage`, `selectedAgentId`, `contexts`, `workspaceContexts`, `selectedContextId`, `contextEventsState`, `draftMode`, request guards, actor inspector selection, `openWorkspaceContext`, `openProjectedContext`, `startNewConversation`, delete, and `sendFloeMessage`.
  - `floe-web\src\contexts.ts` owns pure Context helpers: sorting by selected actor, Workspace/scoped participation labels, assignment eligibility/status, and `buildEmitBody` for Channel sends.
  - `floe-bus` owns Context/Event/Endpoint/Scope data and the HTTP routes consumed by FloeWeb: `/v1/contexts?participant=...&workspace_id=...`, `/v1/workspaces/:id/contexts?scope=unscoped&limit=6`, `/v1/contexts/:id/events`, `/v1/events/emit`, Scope Projection APIs, and Context assignment APIs.
  - `@xyflow/react` owns Field canvas interaction. Projection Context nodes should keep using the existing React Flow node open button wired to `openProjectedContext`.
  - The v6 screenshots/prototype under `C:\Development\ai-powered\floe-web-examples` are visual references only, not runtime owners.
- Current owner rationale:
  - Product/domain docs define Workspace Home as an index, not a Scope; Contexts are anchored by actors and/or Scope; actors are Workspace-scoped; emit is the required Event creation path; FloeWeb must talk through `floe-bus` rather than direct runtime or file paths.
  - Current code already implements Channel as a separate right-side pane beside the right inspector, with event reads scoped to selected Context and sends delegated to `buildEmitBody` + `/v1/events/emit`.
  - Issue #55/#56 briefs explicitly keep the Channel transitional and distinct from the canonical right inspector while v6 shell/Home use existing App state/actions.
- Source evidence:
  - `CONTEXT.md`: Workspace Home is not Scope; Workspace-level actor Contexts may have `scope_id: null`; actorless Contexts require Scope; Events derive Scope from Context/source ownership; avoid Default Scope/Field.
  - `PRODUCT.md`: Channel is a right-side conversation pane; product loop includes opening global Floe Channel and sending messages through `floe-bus`; right inspector is configuration/state for current selection.
  - `docs\implementation-reviews\v6-ui-shell-migration-architecture-integration.md`: preserve current Channel behavior; Channel can open/toggle, choose actor/context, send through `buildEmitBody`, render context events; do not import prototype DOM/mock data.
  - `docs\implementation-reviews\issue-56-workspace-home-v6-surface-architecture-integration.md`: Home actor cards update inspector only; left-nav actor clicks currently also open Channel; Channel remains separate right-side pane unless explicitly redesigned.
  - `main.tsx`: state at lines 376-387; `openProjectedContext`/`openWorkspaceContext` at lines 746-777; Home Context Open at lines 2027-2067; Home actor inspector selection at lines 1937-1963; Field Context node callback at lines 874-889; send path at lines 1654-1683; Channel render at lines 2433-2729; shell/inspector/channel layout at lines 2733-2899.

## Existing interaction model
- User/system behaviors that already exist:
  - Topbar toggle opens/closes the transitional Channel without replacing the right inspector.
  - Home Workspace-level Context rows call `openWorkspaceContext(context)`, which may select a fallback actor participant, sets `selectedContextId`, exits draft mode, opens Channel, and refreshes `/v1/contexts/:id/events`.
  - Field/Scope Projection Context nodes call `openProjectedContext(contextId)`, derive participants from the loaded projection, possibly select a fallback actor, set `selectedContextId`, open Channel, and refresh Context events.
  - Actor participation for the right inspector uses `selectedAgentId` + `/v1/contexts?participant=<actor>&workspace_id=<workspace>` and labels rows with `contextParticipationLabel`.
  - Channel context-list rows switch `selectedContextId`; a selected context fetches `/v1/contexts/:id/events`; stale event responses are guarded by `contextEventsRequestRef`.
  - New conversation/draft mode sends without `context_id`; bus returns/adopts the new `context_id`; subsequent sends include that id.
  - Existing context sends use `buildEmitBody` and `POST /v1/events/emit`; the body has `type: message`, `workspace_id`, source operator endpoint, endpoint destination, optional `context_id`, content text/data, `response.expected: false`, and metadata `{ submitted_by: "floe-web", channel: "floe" }`.
  - Non-operator/read-only Contexts are shown but the composer disables if the operator is not a participant.
- Behaviors that must remain unchanged:
  - Opening a Context must not create or assign a Scope and must not call projection/layout/legacy Field APIs.
  - Sending through Channel must not introduce `current_delivery_context_id`, Default Scope, Default Field, or direct runtime/bridge APIs.
  - Home actor-card selection must continue to update inspector only: no Channel open, no event fetch, no projection call. Left-nav actor click may keep its current Channel-opening behavior unless product explicitly changes it.
  - Channel remains transitional conversation UI; right inspector remains canonical selection/details. Do not convert Channel into the v6 Context Stream/Activity surface.
  - Context list and message rendering must remain actor-neutral: do not client-filter events by `source_endpoint_id`; render all events in the selected Context.
  - Non-operator Context read-only behavior must stay visible and enforced.
- Runtime or UX evidence:
  - `context-rendering.spec.ts` protects draft sends, continuing existing conversations with explicit `context_id`, context-scoped event fetches, stale response guards, no source-endpoint filtering, Context ordering, delete dialog behavior, responsive Channel, and accessibility labels.
  - `no-actor-bleed.spec.ts` protects selected-actor participant queries, all selected-actor Contexts including scoped/unscoped labels, read-only non-operator Contexts, no cross-context bleed, and no endpoint-id leakage.
  - `scope-projection.spec.ts` protects opening a projected Context node through the existing conversation sidebar.
  - `v6-home-surface.spec.ts` protects Home actor selection updating inspector only with no Channel and no Context event/projection fetch.
  - `v6-shell-frame.spec.ts` protects Channel and inspector coexisting in the v6 shell and no legacy Field endpoint calls.

## Existing extension points
- APIs/hooks/components/library features/stores/conventions to use:
  - Use existing App callbacks: `openWorkspaceContext`, `openProjectedContext`, `selectActorForInspector`, `startNewConversation`, `sendFloeMessage`, `refreshContexts`, `refreshWorkspaceContexts`, `refreshContextEvents`, `clearContextEvents`.
  - Use `contexts.ts` helpers: `sortContextsForAgent`, `contextLabel`, `contextParticipationLabel`, `workspaceContextLabel`, `canAssignContextToScope`, `contextScopeAssignmentStatus`, `buildEmitBody`.
  - Use existing shell landmarks/test ids: `v6-shell`, `v6-topbar`, `v6-left-nav`, `v6-main-surface`, `v6-inspector`, `v6-channel`, `v6-home-contexts`, `v6-home-actors`, `context-list`, `context-list-item`, `active-conversation-header`.
  - Use CSS token layer in `styles.css` (`--canvas`, `--surface`, `--surface-panel`, `--surface-sunk`, `--accent`, etc.) and existing responsive Channel breakpoints.
  - Use existing Playwright helpers in `tests\helpers.ts`; `seedAppWithScopes` can seed Workspace contexts/endpoints and records `legacyFieldRequests`, `projectionGets`, `contextEventGets`.
- Relevant docs or library capabilities:
  - React Flow stays the Field canvas owner; use existing node data `onOpenContext` rather than adding DOM overlays or a new graph click system.
  - Bus Context/Event APIs are the extension point for reads/sends; do not create a v6-specific API abstraction for this slice.
  - Dialog/accessibility patterns already exist for destructive Channel actions; do not replace them.
- Existing examples in this codebase:
  - `main.tsx` Home Context Open button routes to `openWorkspaceContext`.
  - `main.tsx` projected Context node data passes `onOpenContext: openProjectedContext`.
  - `context-rendering.spec.ts` includes a stateful mock bus for emit adoption and event refresh.
  - `no-actor-bleed.spec.ts` includes scoped and Workspace-level Context participation examples.

## Do-not-bypass list
- Systems/libraries/components not to duplicate or replace:
  - Do not duplicate `floe-bus` Context/Event APIs, `buildEmitBody`, Context label helpers, Scope Projection mapping, React Flow, or Channel state/actions.
  - Do not replace the right inspector with Channel content and do not replace Channel with an inspector conversation component.
  - Do not import v6 prototype HTML/CSS/JS or mock data.
  - Do not call legacy `/v1/workspaces/:id/fields` or create Field-owned membership/connections.
- Shortcuts or parallel paths to avoid:
  - No new `openContextV6`, `sendContextEventV6`, direct `fetch('/emit')` outside `sendFloeMessage`, or local Context store.
  - No hidden `scope_id: default`, `Field default`, default assignment, or client-side fallback to make Contexts appear scoped.
  - No opening Home actor participation by first assigning it to a Scope or Field.
  - No event rendering based on workspace-wide `/v1/events?workspace_id=...` for selected chat; keep `/v1/contexts/:id/events`.
  - No optimistic fake-only success path that skips bus response/adopted `context_id`.
- Invariants:
  - Workspace Home is not Scope; Scope Projection is scoped-only; actors are Workspace-level endpoints; direct actor Contexts can be unscoped.
  - Channel is transitional and visually separate from the right inspector.
  - Right inspector is the canonical current-selection/details panel.
  - Emits route through bus and derive event scope from the target Context/source ownership, not from UI defaults.
  - Non-operator Contexts remain readable but not writable by the operator.

## Integration plan
- Insert the change at:
  - Main behavior tests first: add a targeted v6 E2E spec, likely `floe-web\tests\v6-channel-preservation.spec.ts`, using existing helpers/stateful route patterns to cover Home Context open, actor participation open from inspector, Field projection Context open, emit send, read-only Context, and no Default Scope/Field text or API reliance.
  - Implementation should be surgical in `main.tsx` and `styles.css` only if tests expose regressions. Reuse the current callbacks and CSS classes; do not introduce new API helpers.
  - For actor participation open from inspector, add an `Open` affordance to existing `.inspector-context-card` that calls `openWorkspaceContext(context)` or directly the same existing callback; do not create a new fetch/send path. This is the one likely missing behavior for #57 because current actor inspector lists participation but does not expose an open button.
  - For visual distinction, adjust `styles.css` only around `.channel`/`.channel-header`/Channel list/body/composer if needed: Channel can use the v6 token layer but should have a different width, header title/icon, accent avatar/active row treatment, conversation-list/body/composer structure, and its own `data-testid="v6-channel"`; inspector remains `.inspector` with compact detail cards and `data-testid="v6-inspector"`.
- Why this is the correct integration point:
  - All required state and API ownership already lives in `App`; the slice preserves and tests that ownership rather than creating v6-specific plumbing.
  - Existing open callbacks already handle fallback actor selection, selected Context state, draft reset, Channel opening, and Context event refresh.
  - Existing send path already satisfies the bus emit contract and avoids Default Scope assumptions by omitting `context_id` only for a draft/new bus-owned Context.
- Alternatives considered and rejected:
  - New canonical Context Stream/Activity component now: rejected; explicitly deferred to a later slice.
  - Moving conversation into the right inspector: rejected; violates right inspector/Channel split and #55/#56 briefs.
  - Creating new Context APIs or client-side Default Scope assignment: rejected by substrate guardrails and existing helpers/tests.
  - Using Home Workspace-level list as the selected actor's full participation source: rejected; it is unscoped-only and limited to six, while actor participation comes from `/v1/contexts?participant=...`.
  - Porting prototype DOM/JS: rejected because it would bypass production state/actions.

## Regression checklist
- Behavior:
  - Topbar Channel toggle opens `v6-channel` while `v6-inspector` remains visible.
  - Home Workspace-level Context Open calls existing `openWorkspaceContext`, opens Channel, selects the correct Context, fetches `/v1/contexts/:id/events`, and shows messages.
  - Actor participation in the Home/right inspector can open the same existing Channel path without auto-assigning Scope, fetching projection/layout, or inventing default data.
  - Field projection Context Open calls existing `openProjectedContext`, opens Channel, selects the projected Context, and fetches Context events.
  - First draft send omits `context_id`; existing Context send includes selected `context_id`; neither includes `current_delivery_context_id` or any Default Scope field.
  - Read-only non-operator Contexts show the warning and disabled composer.
  - Channel list labels preserve `Workspace-level Context` and `Scoped Context · <Scope title>` with no Default Scope/Field wording.
  - Home actor selection still updates inspector only; no Channel/event fetch on actor-card click.
  - Left-nav actor behavior remains consciously preserved or deliberately tested if changed.
  - No legacy `/fields`, no unexpected projection/layout calls during Home/Channel Context open, and no direct runtime API calls.

## Test plan
- Existing tests to keep green:
  - `npm run test:unit`
  - Targeted E2E: `context-rendering.spec.ts`, `channel-activity.spec.ts`, `no-actor-bleed.spec.ts`, `v6-shell-frame.spec.ts`, `v6-home-surface.spec.ts`, `scope-projection.spec.ts`, `field-substrate.spec.ts`, plus full `npm run test:e2e` before merge.
  - Especially preserve: `context-rendering.spec.ts` draft/existing send tests; context-scoped event fetch; stale event guard; read-only/accessibility; `no-actor-bleed.spec.ts` selected actor query/read-only/labels; `scope-projection.spec.ts` projected Context open; `v6-home-surface.spec.ts` no Channel/event fetch on Home actor selection.
- New tests to add before/with implementation:
  1. V6 Home Context Open: seed an unscoped Workspace-level Context; click Home `Open`; assert `v6-channel` visible, inspector still visible, selected Context messages visible, `/v1/contexts/:id/events` called, no Default Scope/Field text, no projection/layout/legacy Field calls.
  2. V6 actor participation Open: click Home actor card, verify inspector only; then click an Open affordance on an inspector participation card; assert existing Channel opens with that Context and existing Context event fetch. Include one unscoped and one scoped Context label.
  3. V6 Field projection Open: open a Scope-backed Field, click projected Context node Open, assert Channel opens through `openProjectedContext` and no new API path or Default requirement appears.
  4. V6 Channel send: from opened existing Context, send a message; assert one `/v1/events/emit` call with `context_id`, `metadata.channel === "floe"`, no `current_delivery_context_id`, no `scope_id`/Default fields; assert returned/new event renders after refresh.
  5. V6 draft send/no Default requirement: start `+ New conversation`, send first message; assert emit omits `context_id`, bus returns/adopts a new Context, no Scope selection is required, no Default Scope/Field displayed.
  6. V6 read-only preservation: open a selected-actor Context where operator is not a participant; assert warning and disabled composer.
  7. Visual/layout assertion: with Channel open, `v6-inspector` and `v6-channel` both visible and have separate bounding boxes/classes; Channel width/placement does not collapse inspector or cause mobile/tablet overflow.
- Live proof required:
  - Run `cd floe-web && npm run build` and targeted Playwright specs above, then full relevant E2E if runtime permits.
  - Start FloeWeb (`npm run dev`) against mocked or local bus data and use Playwright at ~1700x1100 to capture screenshots for: Home with inspector/no Channel; Home Context opened in Channel; actor inspector participation then Channel open; Field projection Context opened in Channel; read-only Context.
  - Capture console/network evidence: no console errors, no failed requests, no `/fields` requests, no projection/layout fetch on Home actor selection or Home Context open, `/v1/contexts/:id/events` on Channel opens, `/v1/events/emit` on send with expected body.

## Risk assessment
- Risk:
  - `selectedAgentId` is shared by inspector and Channel; changing actor selection can unintentionally open Channel or clear selected Context/events. Mitigation: preserve `selectActorForInspector` for Home actor cards; route actor participation Open through existing open callback; test Home selection remains inspector-only.
  - Current actor inspector cards have no Open affordance; adding one could accidentally bypass `openWorkspaceContext` or make the inspector canonical conversation UI. Mitigation: button only delegates to existing Channel opener and labels it as opening in Channel.
  - `openProjectedContext` only knows participants present in loaded Scope Projection relationships; if projection lacks participants, it still opens Channel but may not select a fallback actor. Mitigation: test seeded projection relationships and do not add API assumptions.
  - Visual tweaks could make Channel indistinguishable from inspector because both currently use `--surface-panel` and right borders. Mitigation: keep separate landmark/test id, width, header, accent/active row styling, and conversation/composer structure.
  - Existing tests still contain scopes titled `Default` for historical coverage; broad no-Default assertions can fail if those fixtures are reused. Mitigation: new #57 v6 tests should seed named non-Default scopes and assert no product Default Scope/Field assumptions in the tested flow.
  - Validation text `Choose a named Scope that is not Default` exists in Scope assignment flow and runtime binding scopes use `workspace_default`; these are not Channel Default Scope assumptions but can trip careless text/API assertions. Scope assertions to user-visible Channel/Home flows and request bodies.

## Decision confidence
- Confidence:
  - High for preserving Channel open/send behavior through existing App state/actions and bus helpers; medium-high for actor participation Open because the inspector currently lists participation but appears to lack an Open action.
- Reasons:
  - Required state/actions already exist and are well covered by E2E tests.
  - Domain docs, #55, and #56 briefs align: Channel remains transitional; inspector remains canonical; no Default Scope/Field.
  - The missing work is mostly v6-facing coverage and a likely small affordance, not a new data model.
- Open questions:
  - Should left-nav actor click continue opening Channel in #57, or should only explicit participation/Channel controls open it? Current code opens Channel from left-nav actor; Home actor cards do not. Recommendation: preserve current left-nav behavior for this slice unless a product decision says otherwise.
  - Should inspector participation cards expose `Open in Channel` for both scoped and unscoped Contexts? Recommendation: yes; route both through existing Channel path, no assignment/defaults.
  - Should Channel styling diverge further from inspector now or wait for the canonical Context Stream? Recommendation: only enough visual distinction for #57; avoid redesigning conversation semantics before the later Activity/Context Stream slice.
