# Architecture Integration Brief: issue-35-context-only-scope-projection

> Scope: correct the bus Scope Projection contract and FloeWeb Field renderer so a scoped Context is the Field-level conversation/work node. Context-owned Events/messages and context-owned runtime Activity/telemetry must not appear as standalone projection refs, React Flow nodes, or Field edges. Pulse refs and Pulse-to-Context subscriber relationships remain top-level Field-visible primitives/relationships.

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns the substrate Scope Projection contract and route:
    - `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` calls `buildScopeProjection` (`floe-bus\src\server.ts:171-186`).
    - `buildScopeProjection` currently derives `refs.contexts`, `refs.pulses`, `refs.events`, `refs.activity`, `relationships.context_participants`, `relationships.pulse_subscribers`, and `relationships.event_context_ownership` (`floe-bus\src\scopes\projection.ts:49-65,102-188`).
  - `floe-bus` owns Context storage, participants, first-message preview, last-event timestamps, Event routing, deliveries, Pulse definitions/subscribers, and runtime telemetry. Scope Projection should use those existing stores; it must not become storage.
  - `floe-web` owns the Field rendering adapter in `floe-web\src\scope-projection.ts`, which currently maps Context, Pulse, Event, and Activity refs to React Flow `fieldItem` nodes and maps `event_context_ownership` to edges (`floe-web\src\scope-projection.ts:119-198`).
  - `floe-web\src\main.tsx` owns the active Field shell, Inspector, Scope list/open path, React Flow canvas wiring, and existing Context-open path (`openProjectedContext`) (`main.tsx:715-755,1001-1049,2172-2305`).
  - `@xyflow/react` owns the canvas interaction model: pan, zoom, selection, drag, handles, edges, MiniMap, Controls, Background, node lifecycle, and drop surface (`main.tsx:2230-2260`).
- Current owner rationale:
  - `CONTEXT.md` now says Scope Projection is a read-only substrate-derived view (`CONTEXT.md:21-23`), Field renders a Scope (`CONTEXT.md:17-19,130`), Context belongs to one Scope (`CONTEXT.md:132`), Events inherit Scope from Context or source (`CONTEXT.md:133`), and Field renders Context as the top-level conversation/work node while Events inside are history, not separate Field blocks (`CONTEXT.md:134`).
  - ADR-0004 reserves Scope as the substrate organising boundary and says Field layout/rendering must not determine membership (`docs\adr\0004-scope-as-substrate-organising-boundary.md:5-11`).
- Source evidence:
  - Current code conflicts with the resolved domain language by including context-owned Events in `refs.events` and deriving `event_context_ownership` (`floe-bus\src\scopes\projection.ts:105-111,141-152,180-185`).
  - Current code also projects runtime telemetry as `refs.activity` when it resolves through a scoped delivery (`floe-bus\src\scopes\projection.ts:112-123,153-171`), which now conflicts with "raw runtime telemetry is not Work Log".
  - Current FloeWeb tests and Playwright fixtures still expect Event/Activity nodes and two Field edges (`floe-web\src\scope-projection.test.ts:62-94`, `floe-web\tests\field-substrate.spec.ts:88-95`, `floe-web\tests\scope-projection.spec.ts:79-84`).
  - Baseline targeted checks pass before this change: `npm run test --workspace floe-bus -- scope-projection` and `npm run test:unit --workspace floe-web -- scope-projection`.

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace Home lists Scopes as Fields and opens them without legacy `/fields` endpoint calls (`floe-web\tests\scope-projection.spec.ts:12-85`, `floe-web\src\scope-projection-api.ts:37-50`).
  - Opening a Field fetches the bus Scope Projection and renders it through `projectionToReactFlow` (`main.tsx:1011-1045`, `main.tsx:722-755`).
  - Context nodes display the first message preview, participant count, and an `Open` action. `Open` routes through `setSelectedContextId`, `setDraftMode(false)`, `setChannelOpen(true)`, and `refreshContextEvents` (`main.tsx:206-239,715-720`).
  - Pulse nodes display pulse id/status/subscriber metadata and Pulse-to-Context subscriber edges when both endpoint refs are present (`floe-web\src\scope-projection.ts:147-155,174-184`).
  - React Flow canvas preserves node selection and drag in the projection surface Playwright test (`floe-web\tests\field-substrate.spec.ts:144-168`).
- Behaviors that must remain unchanged:
  - Field list/open/create/rename remains Scope-backed and must still avoid active legacy `/v1/workspaces/:workspace_id/fields*` calls.
  - Context node `Open` continues to use the existing conversation/sidebar path; do not add an inline conversation UI inside the canvas.
  - Context participant metadata remains attached to Context node data; participants must not become actor containment nodes.
  - Pulse refs remain top-level scoped primitives; Pulse-to-Context subscriber relationships remain visible when the Pulse and Context are both in the opened Scope.
  - React Flow pan, zoom, selection, drag, node labels/icons/handles, MiniMap, Controls, Background, rename affordance, connection affordances, and Block Library drag/drop affordances remain intact unless explicitly redesigned.
- Runtime or UX evidence:
  - `FieldItemNode` uses React Flow `Handle` components and one shared `fieldItem` custom node type, so reducing projected node kinds should not require replacing the canvas (`main.tsx:206-245`).
  - Playwright already watches `legacyFieldRequests` and asserts no old Field endpoint calls in active Scope Projection flows (`floe-web\tests\scope-projection.spec.ts:13-84`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - `buildScopeProjection(store, workspaceId, scopeId)` is the correct single bus-side insertion point for changing what is Field-visible. Keep the HTTP route shape stable.
  - Existing bus stores should remain the data sources:
    - `contextStore.listContextsForScope` and `getFirstMessagePreview` for Context refs.
    - `listPulses({ workspace_id, scope_id })` and `getPulseSubscribers` for Pulse refs and subscriber relationships.
    - Event and telemetry stores may still be consulted for Context summaries if needed, but must not emit Field-level Event/Activity refs for context history/telemetry.
  - `projectionToReactFlow` is the correct FloeWeb insertion point for ensuring only Context and Pulse nodes are rendered from the corrected projection.
  - Existing `FieldItemNode` should remain the custom node shell; use its existing label/subtitle/open affordance and React Flow handles instead of adding parallel node components.
  - Existing Playwright route helpers and `ScopeProjection` fixture type in `floe-web\tests\helpers.ts` should be updated to the near-term contract while keeping backwards-compatible empty arrays.
- Relevant docs or library capabilities:
  - `CONTEXT.md:21-27,127-143` and ADR-0004 define Scope/Field/Projection/Layout boundaries.
  - Prior issue #29 brief explicitly left Event/Activity rendering open and allowed temporary nodes; the resolved domain language now supersedes that temporary recommendation (`docs\implementation-reviews\issue-29-floeweb-consumes-scope-projection-architecture-integration.md:115-118,228-229`).
  - React Flow should continue to provide native pan/zoom/selection/drag/handles/edges/MiniMap/Controls/Background.
- Existing examples in this codebase:
  - Bus projection HTTP tests in `floe-bus\src\scope-projection.test.ts` are the right contract tests to update (`:133-179`, `:231-256`, `:258-317`, `:319-357`).
  - FloeWeb adapter tests in `floe-web\src\scope-projection.test.ts` are the right unit tests to update for node/edge mapping.
  - Playwright `field-substrate.spec.ts` and `scope-projection.spec.ts` are the right live-surface regression tests for visible nodes, edges, Context-open, React Flow interactions, and no legacy `/fields` calls.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass bus Scope Projection by deriving Field membership in FloeWeb from `/contexts`, `/events`, `/delivery`, `/runtime/telemetry`, `/pulses`, or any future primitive API.
  - Do not duplicate or replace React Flow. Use existing React Flow graph/canvas features before hand-rolling interactions.
  - Do not duplicate the conversation/sidebar. Opening a Context node must use the existing Context conversation path.
  - Do not replace the Block Library drag/drop surface with a toolbar-only path. Toolbar shortcuts may supplement canvas flows, not silently replace them.
  - Do not introduce `.floe/blocks`, Field-owned item lists, Field-owned connection lists, or client-side membership caches.
- Shortcuts or parallel paths to avoid:
  - Do not "fix" visual clutter only by hiding Event/Activity nodes in FloeWeb while leaving context-owned Events/telemetry as top-level bus projection refs. The bus contract itself must be corrected so future layout keys do not include obsolete refs.
  - Do not delete Events or telemetry from the substrate; they remain Context history/runtime data and are still used by conversation/runtime paths.
  - Do not model raw runtime telemetry as Work Log. Future committed Work Log projection requires a deliberate Work Log contract.
  - Do not fabricate Field edges for Event ownership after removing Event refs.
  - Do not create a second Projection or adapter path just for #35.
- Invariants:
  - Scope is substrate; Field is FloeWeb rendering/projection of Scope.
  - Context/thread is the Field-level conversation/work node.
  - Events/messages inside a Context are history and inherit Scope from that Context; they are not Field-level blocks.
  - Context-owned runtime Activity/telemetry is below the Context/Turn level and is not a raw Field node.
  - Substrate-backed behavior must integrate into the existing Field/canvas model, not create a separate path.
  - Performance regressions in navigation, pan, zoom, or drag are blockers.
  - Existing working affordances require regression tests before refactor.

## Integration plan

- Insert the change at:
  1. **Bus contract: `floe-bus\src\scopes\projection.ts`**
     - Continue returning `refs.contexts` for scoped Contexts, with participant-derived relationships and message summary fields (`last_event_at`, `first_message_preview`) intact.
     - Continue returning `refs.pulses` and `relationships.pulse_subscribers` for scoped Pulses.
     - Stop adding context-owned Events/messages to `refs.events`.
     - Stop adding context-owned runtime telemetry to `refs.activity`.
     - Stop emitting `relationships.event_context_ownership` for context-owned Events, because those Events are not Field-level refs.
     - Preserve the response keys `refs.events`, `refs.activity`, and `relationships.event_context_ownership` as empty arrays for now. This is the safest near-term contract: it avoids breaking typed clients/fixtures while preventing obsolete Event/Activity layout keys before the #31 layout sidecar.
  2. **Bus tests: `floe-bus\src\scope-projection.test.ts`**
     - Rewrite the Context/Event contract test so a scoped Context with multiple messages yields exactly one Context ref, zero Event refs, zero Activity refs, and no Event ownership edges.
     - Keep/update stale denormalized Event-scope test to assert the owning Context still controls Context inclusion, but Event refs remain empty.
     - Rewrite runtime telemetry test to assert context-owned telemetry does not appear as `refs.activity`.
     - Keep empty Scope error/shape tests; expect `events: []`, `activity: []`, and `event_context_ownership: []`.
     - Keep Pulse tests green and add/retain assertion that subscriber relationships survive.
  3. **FloeWeb adapter: `floe-web\src\scope-projection.ts`**
     - Remove Event and Activity node creation from active mapping, or leave type compatibility but ignore those arrays for node creation.
     - Remove mapping of `event_context_ownership` to Field edges.
     - Keep Context participant metadata and Pulse subscriber edge creation.
     - Consider narrowing `ScopeProjectionNodeKind` to `"context" | "pulse" | "unsupported"` only if all call sites compile; otherwise keep `"event" | "activity"` in types temporarily but never produce those nodes.
  4. **FloeWeb UI/Inspector: `floe-web\src\main.tsx`**
     - Keep active Field open/render path unchanged structurally.
     - Update Inspector labels/counts so it does not present hidden context history/telemetry as Field-level "Events" and "Activity" counts. Recommended near-term: show Contexts, Pulses, Unsupported; omit Events/Activity from Opened Field. If counts remain for debugging, label them explicitly as "Projected event refs" / "Projected activity refs" and they should be zero.
  5. **FloeWeb tests/fixtures**
     - Update `floe-web\src\scope-projection.test.ts`, `floe-web\tests\scope-projection.spec.ts`, `floe-web\tests\field-substrate.spec.ts`, and `floe-web\tests\helpers.ts` fixtures so covered scenarios seed Context/Pulse refs only, with empty `events`, `activity`, and `event_context_ownership`.
     - Add explicit negative assertions that no node with message/Event type label and no runtime telemetry label is visible for Context history.
- Why this is the correct integration point:
  - Bus Scope Projection is the single ownership boundary for Field membership. Correcting only FloeWeb would leave the contract wrong for future clients and would pollute layout sidecar keys.
  - `projectionToReactFlow` is the thin renderer adapter already responsible for converting substrate refs to React Flow nodes/edges.
  - `main.tsx` should only need count/label cleanup; canvas architecture should remain stable.
- Alternatives considered and rejected:
  - **FloeWeb-only hiding of Event/Activity nodes:** rejected because obsolete refs would remain in the bus contract and could still become persistent layout keys.
  - **Removing `events`/`activity` keys from the response:** rejected for #35 because it risks avoidable client/test breakage. Empty arrays communicate the corrected contract while preserving response shape.
  - **Rendering Events inside Context nodes:** rejected for this slice; Event history belongs to the existing conversation/sidebar path, not as Field-level blocks.
  - **Promoting runtime telemetry to Work Log nodes:** rejected; raw telemetry is not Work Log and needs a future deliberate Work Log projection contract.

## Regression checklist

- Bus Scope Projection:
  - A scoped Context with multiple messages appears once in `refs.contexts`.
  - Context-owned message Events do not appear in `refs.events`.
  - Context-owned runtime telemetry does not appear in `refs.activity`.
  - `relationships.event_context_ownership` is empty for context-owned Event history.
  - Pulse refs remain visible in `refs.pulses`.
  - Pulse-to-Context subscriber relationships remain visible in `relationships.pulse_subscribers`.
  - Empty Scope and existing 404 error shapes remain unchanged.
  - Projection remains read-only and free of React Flow/Field membership vocabulary.
- FloeWeb Field:
  - Covered scenario renders Context and Pulse nodes only.
  - No Event/message or Activity/telemetry React Flow nodes appear for Context history.
  - Pulse-to-Context edge remains visible.
  - Context node `Open` still opens the existing conversation/sidebar.
  - Active Field list/open/render path still does not call legacy `/fields` endpoints.
  - React Flow pan, zoom, selection, drag, node labels/icons/handles, MiniMap, Controls, Background, connection affordances, rename, and Block Library affordances remain intact.
  - Unsupported refs are not rendered as ordinary nodes.

## Test plan

- Existing tests to keep green:
  - `npm run test --workspace floe-bus -- scope-projection`
  - `npm run test:unit --workspace floe-web -- scope-projection`
  - Relevant Playwright tests:
    - `npm run test:e2e --workspace floe-web -- scope-projection.spec.ts`
    - `npm run test:e2e --workspace floe-web -- field-substrate.spec.ts`
  - Before final merge, run repository-relevant builds/tests: `npm run build --workspace floe-bus`, `npm run build --workspace floe-web`, and the targeted web/bus tests above. Run broader workspace tests if time permits.
- New tests to add before/with implementation:
  - Bus: "projects scoped Context as a single Field-level ref even with multiple Events" with assertions for one Context, zero Events, zero Activity, zero Event ownership relationships.
  - Bus: "does not project Context-owned runtime telemetry as Field Activity" with telemetry tied to a delivery and `refs.activity` still empty.
  - Bus: "keeps Pulse refs and context subscriber relationships" with both Pulse and Context in the same Scope.
  - Web adapter: projection fixture containing Context, Pulse, and stale Event/Activity arrays should produce only Context/Pulse nodes and only Pulse subscriber edges. This protects compatibility if older servers return non-empty arrays during mixed-version development.
  - Playwright: Field surface fixture with Context multiple-message history and telemetry should show Context/Pulse only, no Event/Activity labels, one Pulse-to-Context edge, and `legacyFieldRequests === []`.
  - Playwright: Context node `Open` still opens sidebar and displays Context conversation content through the existing path.
  - Playwright: React Flow selection/drag still works after removing Event/Activity nodes.
- Live proof required:
  - Start FloeWeb against a bus or mocked Playwright route and open a Scope with one Context, multiple messages, a Pulse subscribed to the Context, and runtime telemetry tied to the Context delivery.
  - Capture proof that the canvas shows exactly the Context and Pulse nodes, the Pulse-to-Context relationship, Context participant metadata, no Event/Activity nodes, and no legacy `/fields` requests.
  - Exercise Context `Open`, pan/zoom/drag/select, rename, Controls/MiniMap/Background visibility, and Block Library drag/drop affordance presence.

## Risk assessment

- Risk: removing Event refs from bus projection could break clients/tests that still type or render `refs.events`.
  - Mitigation: keep `refs.events` as an empty array in the response shape for now, update tests, and optionally make FloeWeb ignore stale non-empty arrays defensively.
- Risk: removing Activity refs could be confused with losing runtime telemetry.
  - Mitigation: clarify in code/tests that telemetry remains in runtime/conversation paths; it is only no longer a Field-level projection ref.
- Risk: Pulse subscriber edges may disappear if adapter over-filters relationships after Event/Activity cleanup.
  - Mitigation: keep/add tests asserting Pulse-to-Context edge generation when both node ids exist.
- Risk: duplicate Pulse-to-Context edge ids if both context and endpoint subscribers include the same `context_id`.
  - Mitigation: dedupe by `(pulse_id, context_id)` or include subscriber kind/index in edge ids while preserving one user-visible relationship as appropriate.
- Risk: Inspector counts could imply hidden Events/Activity still exist as Field-level projection refs.
  - Mitigation: omit or relabel Event/Activity counts in the Opened Field Inspector.
- Risk: React Flow behavior regresses if node types or handlers are refactored unnecessarily.
  - Mitigation: keep `FieldItemNode`, `fieldNodeTypes`, existing handlers, and Playwright selection/drag checks.
- Risk: future Work Log projection gets conflated with runtime telemetry.
  - Mitigation: explicitly leave Work Log out of #35 and document that it needs a future deliberate Work Log projection contract.

## Decision confidence

- Confidence: high
- Reasons:
  - The current code locations and tests are clear: bus contract generation is centralized in `buildScopeProjection`, and FloeWeb rendering is centralized in `projectionToReactFlow`.
  - The current glossary and resolved user decisions directly contradict current Event/Activity projection, so the architectural direction is unambiguous.
  - Keeping empty `events`/`activity`/`event_context_ownership` arrays preserves API shape while satisfying the corrected Field-level contract and avoiding obsolete layout keys.
  - Existing tests already cover the exact layers that need updating: bus contract, adapter mapping, Playwright Field surface, Context open, no legacy `/fields`, and React Flow interactions.
- Open questions:
  - None blocking #35.
  - Future deliberate design remains needed for committed Work Log projection and for any non-Context Event source that should become a top-level scoped artifact. Do not solve those in #35.
