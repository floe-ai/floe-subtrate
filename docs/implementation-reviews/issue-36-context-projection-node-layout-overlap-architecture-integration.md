# Architecture Integration Brief: issue-36-context-projection-node-layout-overlap

## Existing ownership

- Package/component/module/library:
  - `floe-web\src\scope-projection.ts` owns the pure Scope Projection-to-React Flow adapter. It currently assigns each projected substrate ref a React Flow `fieldItem` node and falls back to `defaultLayout(index)` when no `FieldLayoutFloeweb` item exists (`scope-projection.ts:92-112,115-171`).
  - `floe-web\src\fields.ts` owns the shared renderer layout metadata shape and default grid helper. `FieldLayoutFloeweb.items` is keyed by stable rendered ids and `defaultLayout(index)` spaces nodes at `x: 80 + (index % 4) * 260`, `y: 80 + floor(index / 4) * 160` (`fields.ts:66-79,141-146`).
  - `floe-web\src\main.tsx` owns the active Field/canvas shell, use of `projectionToReactFlow`, selected-node decoration, Context `Open` callback, React Flow handler wiring, and in-memory projection layout updates (`main.tsx:715-755,1106-1205,1415-1480,2210-2268`).
  - `FieldItemNode` in `main.tsx` owns the Context node's visible hit target and `Open` button. The button calls `onOpenContext`, which routes through `openProjectedContext` (`main.tsx:206-239,715-720`).
  - `@xyflow/react` owns canvas hit testing, node stacking, pointer-event dispatch, handles, edges, pan, zoom, drag, selection, Controls, MiniMap, Background, and drop handling (`main.tsx:27-48,2230-2260`).
  - `floe-web\src\styles.css` owns node sizing and action styling. `.canvas-field-node` uses inline-flex, `min-width: 150px`, no max width, and `.canvas-node-action` is the small `Open` button target (`styles.css:829-891`).
- Current owner rationale:
  - The live failure is a renderer layout/hit-target problem: the bus projection already returns one Context, one Pulse, no Event/Activity refs, and a Pulse-to-Context relationship. The failure occurred when Playwright clicked `[data-id="context:<id>"] button[name=Open]` and a later Pulse React Flow node intercepted pointer events.
  - `CONTEXT.md` defines Scope Projection as substrate-derived refs/relationships, Field as FloeWeb rendering, and Field Layout as renderer-specific arrangement keyed by stable projected refs, not membership (`CONTEXT.md:17-27,127-143`).
  - Issue #35 already corrected the model to Context/Pulse-only projection and requires FloeWeb to ignore stale Event/Activity arrays defensively (`docs\implementation-reviews\issue-35-context-only-scope-projection-architecture-integration.md:85-120`).
- Source evidence:
  - `projectionToReactFlow` creates Context nodes first, then Pulse nodes, using `nodes.length` as the fallback index (`scope-projection.ts:133-152`). With the shared 260px horizontal grid and unconstrained node labels, a long Context preview and/or long Pulse id can overlap on the same row.
  - The #36 live QA harness seeds a fresh real workspace, one Context with multiple messages, one scoped Pulse subscriber, then clicks the Context `Open` button and checks conversation history and no `/fields` calls (`issue36-context-projection-live-qa.mjs:173-180,209-226,232-235`).
  - Existing Playwright tests already assert Scope-backed Field list/open, Context/Pulse-only nodes, one edge, Context `Open`, React Flow selection/drag, and no legacy `/fields` calls (`floe-web\tests\scope-projection.spec.ts:12-96`; `floe-web\tests\field-substrate.spec.ts:74-118,147-172`).

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace Home lists Scopes as Fields and opens a Scope by fetching `/v1/workspaces/:workspace_id/scopes/:scope_id/projection`, not legacy `/fields` endpoints (`main.tsx:1001-1045`; `scope-projection-api.ts:37-50`).
  - Opening a Scope-backed Field renders `projectionToReactFlow(...)` output inside the existing React Flow canvas (`main.tsx:722-755,2230-2260`).
  - Context nodes show first-message preview, participant count, and an `Open` button. `Open` sets selected Context, exits draft mode, opens the channel/sidebar, and fetches `/v1/contexts/:context_id/events` (`main.tsx:206-239,700-720`).
  - Pulse nodes show pulse id and subscriber count, and Pulse-to-Context subscriber relationships remain visible as React Flow edges (`scope-projection.ts:143-168`).
  - React Flow-native selection and dragging are allowed for projection nodes without semantic writes (`main.tsx:1106-1205`; `field-substrate.spec.ts:147-172`).
  - The same Field canvas shell preserves toolbar, rename, Block Library drop surface, MiniMap, Controls, Background, pan, zoom, drag, selection, handles, and edge affordances (`main.tsx:1950-1966,2210-2260`).
- Behaviors that must remain unchanged:
  - Scope remains substrate; Field remains the FloeWeb projection/rendering of Scope; Context remains the top-level Field conversation/work node; Events/messages and runtime Activity remain Context history, not Field-level nodes (`CONTEXT.md:127-143`).
  - Context node `Open` must continue through the existing conversation/sidebar path. Do not add an inline canvas conversation UI or a separate route.
  - The canvas must continue to use React Flow for hit testing, stacking, pan, zoom, selection, drag, handles, edges, Controls, MiniMap, Background, and drop handling.
  - Block Library drag/drop and toolbar shortcuts must remain available; toolbar shortcuts may supplement canvas flows, not silently replace them.
  - Node labels, handles, selection, dragging, rename/open affordances, and connection affordances must remain unless explicitly redesigned.
  - Active rendering must continue to use Scope APIs and must not call legacy `/v1/workspaces/:workspace_id/fields*` endpoints.
- Runtime or UX evidence:
  - The live harness reached the correct Context/Pulse-only canvas before failing on the button click, so this is not a missing Scope Projection contract or missing conversation path.
  - The bug appears only when real label widths and React Flow pointer hit testing combine with the current fallback layout; mocked tests use shorter labels and do not currently protect the non-overlap invariant.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - `projectionToReactFlow(projection, layout?)` is the correct pure adapter insertion point for default projection node placement when no renderer layout exists. It can keep using `FieldLayoutFloeweb` positions when supplied and change only fallback placement for projected refs.
  - `FieldLayoutFloeweb.items[ref]` remains the extension point for explicit user/layout positions. An existing layout entry must override any default/fallback spacing.
  - React Flow node `position`, `width`, and `height` are the library-aligned layout metadata. Use these through existing Node objects and layout helpers; do not invent DOM overlays or custom pointer routing.
  - `styles.css` may be used only for narrow sizing constraints if needed, but CSS changes affect every Field node and should be secondary to fixing the projection fallback layout.
  - Existing test hooks should be used: React Flow nodes expose `data-id="<node.id>"`, `.react-flow__node`, `.react-flow__edge`, and role/name lookup for the `Open` button.
  - Existing live QA hook remains the session harness path: `C:\Users\jfenech\.copilot\session-state\550f4e57-e2f7-4b7f-9df7-506521059e7f\files\issue36-context-projection-live-qa.mjs`.
- Relevant docs or library capabilities:
  - React Flow already handles node placement, hit testing, stacking, selection, pan/zoom, and drag from the `nodes` array and node positions. The correct fix is to provide non-overlapping default positions, not to override pointer events.
  - `CONTEXT.md` and the issue #29/#35 briefs establish that layout is renderer metadata and Scope Projection must remain substrate refs/relationships, not React Flow state (`CONTEXT.md:21-27`; `issue-29...md:48-72`; `issue-35...md:85-120`).
- Existing examples in this codebase:
  - `fields.ts` and `fields.test.ts` demonstrate pure layout transform tests for fallback positions and layout override behavior (`fields.ts:141-146,181-220`; `fields.test.ts:104-123`).
  - `scope-projection.test.ts` is the unit-test home for adapter mapping and layout merge behavior (`scope-projection.test.ts:68-119`).
  - `field-substrate.spec.ts` is the Playwright home for Context `Open` and React Flow interaction regressions (`field-substrate.spec.ts:103-118,147-172`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not create custom overlay click routing, synthetic click forwarding, or DOM hit-test hacks around React Flow.
  - Do not bypass or replace React Flow node hit testing, stacking, drag, pan, zoom, selection, handles, edge rendering, Controls, MiniMap, Background, or drop handling.
  - Do not create Event/message/Activity nodes to "spread out" the graph. Events and Activity remain Context history.
  - Do not create Field-owned membership, Field-owned connection storage, `.floe/blocks`, or client-side projection membership caches.
  - Do not route around the existing conversation/sidebar for Context `Open`.
  - Do not disable pan, zoom, drag, selection, rename, Block Library drag/drop, handles, or connection affordances to make the button clickable.
  - Do not revive legacy `/fields` calls in the active Scope Projection list/open/render path.
- Shortcuts or parallel paths to avoid:
  - Do not fix the live harness by manually moving nodes in the test; #36 needs a product-code default that works for fresh real workspaces.
  - Do not solve this with `pointer-events: none` on non-Context nodes; that would break selection/drag and React Flow-native interaction.
  - Do not rely on z-index ordering to make overlapped nodes clickable; overlap remains a visual and interaction regression.
  - Do not change the bus projection contract; #35 already established the correct Context/Pulse-only projection contract.
- Invariants:
  - Use existing React Flow graph/canvas features before hand-rolling interactions.
  - Preserve Block Library drag/drop unless explicitly redesigned.
  - Preserve node icons, labels, handles, selection, pan, zoom, drag, rename, and connection affordances.
  - Substrate-backed behavior must integrate into the existing Field/canvas model, not create a separate path.
  - Toolbar shortcuts may supplement canvas flows, not silently replace them.
  - Performance regressions in navigation, pan, zoom, or drag are blockers.
  - Existing working affordances require regression tests before refactor.

## Integration plan

- Insert the change at:
  1. **Primary fix: `floe-web\src\scope-projection.ts` fallback placement.**
     - Keep explicit `layout?.items[ref]` behavior unchanged.
     - Replace the projection adapter's default fallback for projected Context/Pulse nodes with a projection-specific non-overlapping layout helper, or call an expanded projection fallback rather than shared `defaultLayout(index)`.
     - Prefer vertical or larger-spaced placement for the minimal Context/Pulse projection: for example, put Context and Pulse on separate rows or use a horizontal gap large enough for current node labels and the `Open` action. The Pulse-to-Context edge remains visible either way.
     - Keep this helper pure and unit-tested; it should not read DOM measurements or mutate layout.
  2. **Tests: `floe-web\src\scope-projection.test.ts`.**
     - Add a regression fixture with a long Context first-message preview and a long Pulse id similar to the live harness (`issue36_context_projection_<runId>`).
     - Assert that default positions for Context and Pulse are separated by a safe distance, while a supplied `FieldLayoutFloeweb` still wins by stable refs.
  3. **Tests: `floe-web\tests\field-substrate.spec.ts` or `scope-projection.spec.ts`.**
     - Add/update a Playwright assertion that the Context `Open` button is clickable in a Context+Pulse fixture with long labels and exactly one edge.
     - Keep existing assertions for no Event/Activity nodes, no legacy `/fields` calls, and React Flow selection/drag.
- Why this is the correct integration point:
  - The failing behavior is caused by the projection adapter's default node positions combined with real label width. The adapter is the first renderer-owned point that knows the node sequence and can choose safe placement without touching substrate projection semantics.
  - It preserves React Flow ownership of interaction and uses React Flow's intended node-position input rather than bypassing pointer dispatch.
  - It leaves `FieldLayoutFloeweb` as the explicit layout override and keeps layout metadata separate from membership.
  - It limits risk to Scope Projection fallback placement. Changing shared `defaultLayout` would affect legacy/superseded Field semantic rendering and Block Library-created nested Fields; changing CSS would affect all node kinds and could truncate labels or alter hit targets globally.
- Alternatives considered and rejected:
  - **Shared `defaultLayout` change in `fields.ts`:** possible but broader than necessary; it affects old Field semantic rendering and tests that assert `defaultLayout(1)`. Use only if the team wants a global canvas spacing policy.
  - **CSS node dimensions/max-width:** could reduce overlap by constraining long labels, but it affects all Field nodes and may hide useful labels. It can supplement later, but should not be the primary architectural fix.
  - **z-index or pointer-events tweak:** rejected because it masks overlap, risks breaking selection/drag/hit testing, and bypasses React Flow-native interaction.
  - **Test/harness manual positioning:** rejected because the live UX blocker appears in the product default path for fresh workspaces.
  - **Bus/projection contract change:** rejected because the projection content is already correct for #36 after #35.

## Regression checklist

- Behavior: A fresh Scope-backed Field with one Context and one scoped Pulse subscriber renders non-overlapping nodes; the Context `Open` button is clickable.
- Behavior: Context `Open` uses the existing conversation/sidebar and shows Context message history from `/v1/contexts/:context_id/events`.
- Behavior: The canvas still shows one Context node, one Pulse node, and the Pulse-to-Context relationship.
- Behavior: Event/message and Activity/telemetry arrays remain ignored as Field-level nodes, including stale arrays from mixed-version fixtures.
- Behavior: Explicit `FieldLayoutFloeweb.items["context:<id>"]` / `items["pulse:<id>"]` positions still override default placement.
- Behavior: React Flow pan, zoom, selection, drag, handles, MiniMap, Controls, Background, edge rendering, and Block Library drag/drop remain working.
- Behavior: Rename/open affordances and connection affordances are preserved.
- Behavior: Active Scope Projection list/open/render path still makes Scope API calls and no legacy `/fields` calls.

## Test plan

- Existing tests to keep green:
  - `npm run test:unit --workspace floe-web -- scope-projection`
  - `npm run test:unit --workspace floe-web -- fields`
  - `npm run test:e2e --workspace floe-web -- scope-projection.spec.ts`
  - `npm run test:e2e --workspace floe-web -- field-substrate.spec.ts`
  - Before final acceptance, `npm run build --workspace floe-web`; broader workspace tests if time permits.
- New tests to add before/with implementation:
  - Unit: default Scope Projection layout separates a long-label Context node and a long-id Pulse node enough that their fallback positions cannot overlap under current `.canvas-field-node` sizing assumptions.
  - Unit: supplied `FieldLayoutFloeweb` positions still win over projection default positions by stable substrate ref.
  - Playwright: a mocked Scope Projection fixture matching the live failure (long Context preview, long Pulse id, Context subscriber edge) can click the Context node `Open` button and sees the sidebar message history.
  - Playwright: keep/extend checks that only Context/Pulse nodes appear, no message/Event/Activity nodes appear, one edge appears, React Flow selection/drag still works, and `legacyFieldRequests` remains `[]`.
- Live proof required:
  - Re-run the #36 live QA harness against a built bus/web app after the fix.
  - Capture proof that the fresh real workspace canvas shows exactly one Context node and one Pulse node with one relationship, the Context `Open` button is clickable, the sidebar shows all seeded messages, and no legacy `/fields` requests occur.
  - Capture screenshots/log summary under the existing #36 evidence path, preserving the harness's network summary and projection counts.

## Risk assessment

- Risk: increasing spacing only for projections could make small Scope canvases look sparse.
  - Mitigation: scope the change to fallback placement only; user/renderer layout overrides still apply after drag.
- Risk: vertical stacking could make the Pulse-to-Context edge less immediately legible than side-by-side placement.
  - Mitigation: keep one visible edge with React Flow handles; choose a moderate offset/gap and verify in Playwright/live screenshots.
- Risk: a CSS-only change could unintentionally affect legacy Field semantic nodes or truncate important labels.
  - Mitigation: avoid CSS as the primary fix; if used, add visual/click tests for Context, Pulse, and legacy node labels.
- Risk: z-index/pointer-event changes could regress selection, drag, and handles.
  - Mitigation: do not use them for this fix.
- Risk: changing shared `defaultLayout` could break tests and behavior for old Field rendering.
  - Mitigation: prefer a projection-specific fallback helper in `scope-projection.ts`.
- Risk: existing in-memory projection layout captured before a code change could preserve overlapping positions during a single hot-reload session.
  - Mitigation: final live proof should use a fresh page/session or clear in-memory app state; product persistence for projection layouts is not currently used.

## Decision confidence

- Confidence: high
- Reasons:
  - The ownership boundary is clear: substrate projection content is correct; fallback renderer node placement is the failing layer.
  - The exact adapter path and tests are centralized in `scope-projection.ts` / `scope-projection.test.ts`, and the existing Field/canvas path already delegates hit testing and interactions to React Flow.
  - A projection-specific fallback layout is the smallest product-code change that fixes the real UX blocker while preserving Scope Projection semantics, React Flow-native behavior, Context sidebar opening, and no-legacy-Field behavior.
- Open questions:
  - The implementer should choose the exact projection fallback geometry (larger horizontal gap vs separate rows) based on the smallest passing unit + Playwright + live QA proof. Either is acceptable if it avoids overlap and preserves edge readability.
