# Architecture Integration Brief: issue-29-floeweb-consumes-scope-projection

> Scope: switch FloeWeb's **active** Field list / open / render path to consume the bus-owned Scope Projection (`GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection`) and the existing Scope list (`GET /v1/workspaces/:workspace_id/scopes`). Render the projection through a thin renderer adapter into the existing React Flow canvas without re-deriving membership client-side, and open Context nodes through the existing conversation/sidebar path. Do **not** extend `.floe/fields/*` semantic files or introduce `.floe/blocks`. Old Field semantic APIs must not be removed in this slice; they must be bypassed on the active list/open/render path (legacy removal belongs in #32).

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns the Scope Projection contract and the Scope list:
    - `GET /v1/workspaces/:workspace_id/scopes` (`floe-bus\src\server.ts:163-169`).
    - `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` (`floe-bus\src\server.ts:171-187`), producing `{ projection: { workspace_id, scope_id, generated_at, refs: { contexts, pulses, events, activity }, relationships: { context_participants, pulse_subscribers, event_context_ownership }, unsupported } }` (`floe-bus\src\scopes\projection.ts:1-189`).
    - `POST /v1/workspaces/:workspace_id/scopes` (create) and `PATCH /v1/workspaces/:workspace_id/scopes/:scope_id` (rename / re-describe) (`floe-bus\src\server.ts:189-247`). Default Scope is auto-ensured at workspace registration; deletion is not exposed.
  - `floe-bus` owns the legacy Field file APIs at `/v1/workspaces/:workspace_id/fields*` and `field.upserted`/`field.deleted` WebSocket events (used today by `fields-api.ts`, `fields-store.ts`, `fields-watcher.ts`). These remain superseded and must be left in place by this slice.
  - `floe-bus` owns Context creation, participants, scope inheritance, and the conversation event surface (`floe-bus\src\contexts\store.ts`, `/v1/contexts*`, `/v1/events/emit`, `/v1/events/stream`). The Context node "open" affordance must route through these existing endpoints.
  - `floe-web` owns the Field rendering surface in `floe-web\src\main.tsx`, the pure Field transform layer in `floe-web\src\fields.ts` (`fieldToReactFlow`, `reactFlowToLayout`, `applyNodeChangesToLayout`, layout key types), the legacy HTTP client `floe-web\src\fields-api.ts` (`listFields`, `getField`, `putFieldSemantic`, `putFieldLayout`, `deleteField`, `subscribeToFieldEvents`), and the conversation/sidebar (`renderChannel`, `setChannelOpen`, `setSelectedContextId`, `setDraftMode`, `sendFloeMessage`).
  - `@xyflow/react` (React Flow) owns canvas behaviour (pan, zoom, selection, drag, handles, edges, MiniMap, Controls, Background, drop targets). `lucide-react` owns node iconography.
- Current owner rationale:
  - Issue #28 (closed at commit bd536cd) made the bus the single derivation point for what belongs in a Scope. Per ADR-0004 and the slice-5 PRD, FloeWeb is a renderer of Scope Projection; it must consume bus output, not fan out across Context, Pulse, Event, telemetry, Work Log, or future primitive APIs.
- Source evidence:
  - Bus contract: `floe-bus\src\scopes\projection.ts:49-65` defines `ScopeProjection` with substrate refs and typed relationships only (no React Flow vocabulary, no Field membership).
  - Bus route: `floe-bus\src\server.ts:171-187` returns 404 `workspace_not_found` / `scope_not_found` and is read-only (no broadcast).
  - Tests covering projection: `floe-bus\src\scope-projection.test.ts` (HTTP), `scopes-server.test.ts` (Scope CRUD), `scope-propagation.test.ts`, `pulse-scope-propagation.test.ts`.
  - Domain rules: `CONTEXT.md:21-27` (Scope/Field/Projection/Layout definitions, ban on `.floe/blocks` and field-owned membership), `docs\adr\0004-scope-as-substrate-organising-boundary.md`, `docs\scope-substrate-slice-prd.md:27-31, 83-100`.
  - FloeWeb today: `floe-web\src\main.tsx:73-81` imports `listFields`/`getField`/`putFieldSemantic`/`putFieldLayout`/`deleteField`/`subscribeToFieldEvents`; `main.tsx:925-949, 1338-1363, 1806-1812` drive the active list/open/refresh path against the **old** Field semantic API.
  - Conversation/sidebar path: `main.tsx:1556-1586, 2417-2696` (`startNewConversation`, `setSelectedContextId`, channel rendering, `sendFloeMessage`).

## Existing interaction model

- User/system behaviors that already exist and that this slice MUST consume rather than rebuild:
  - Workspace Home lists Fields and opens one with a click/double-click (`main.tsx:2004-2072`). The list count, "Add field" button, "Show all/Root fields" toggle, and empty-state are existing affordances that must continue to function (now backed by Scopes).
  - Opening a Field shows a React Flow surface with toolbar, back affordance, rename, Block Library drop target, MiniMap, Controls, Background, pan/zoom/drag/selection (`main.tsx:2106-2221`).
  - Block Library drag/drop and click create a new Field (and, when inside a Field, a nested Field item) via `handleFieldPrimitiveClick`, `handleFieldPrimitiveDragStart`, `handleLibraryDropSurface` (`main.tsx:1878-1910, 2307-2340`). The Block Library is the canonical creation affordance.
  - The conversation/sidebar opens through `setChannelOpen(true)` + `setSelectedContextId(ctx)` + `refreshContextEvents(ctx)`; `selectedAgent` drives the actor panel; `sendFloeMessage` posts to `/v1/events/emit` with `context_id` (`main.tsx:1525-1586, 2417-2696`). This is the only conversation surface and must remain the only one.
  - Inspector shows Workspace / Opened Field details and runtime config (`main.tsx:2223-2305`).
  - WebSocket `/v1/events/stream` triggers `queueRefresh()`; Field-only frames are filtered via `parseFieldStreamMessage` (`main.tsx:809-840, 1279-1299`). Stream-driven refresh of workspace/endpoint/event/telemetry state must continue.
  - React Flow handlers wired today: `onNodesChange`, `onEdgesChange`, `onBeforeDelete`, `onEdgesDelete`, `onMoveEnd`, `onNodeDragStop`, `onNodeDoubleClick`, `onEdgeDoubleClick`, `onConnect`, `onReconnect`, `onDrop`, `onDragOver`, `deleteKeyCode`, `defaultViewport`, `edgesReconnectable`, `panOnDrag`, `zoomOnScroll`, `minZoom`/`maxZoom` (`main.tsx:2180-2210`). All of these are existing React Flow-native interactions that must remain working.
- Behaviors that must remain unchanged:
  - React Flow pan, zoom, selection, drag, handles, MiniMap, Controls, Background, drop target, viewport restore (`main.tsx:1301-1336, 2180-2210`).
  - Block Library palette and drag/drop create flow.
  - Node icons / labels / handles (`FieldItemNode` + `fieldNodeTypes`, `main.tsx:208-227`).
  - Rename affordance for the open Field (now: rename Scope).
  - Conversation/sidebar path — `setChannelOpen`, `setSelectedContextId`, `setDraftMode`, `sendFloeMessage`, the existing channel rendering and composer.
  - Workspace switching, Inspector, Settings, runtime binding, error bar, refresh button, stream-triggered refresh.
  - Default Scope is auto-ensured and never deletable.
  - Old Field file APIs remain reachable (not removed in this slice) but are not invoked on the active list/open/render path.
- Runtime or UX evidence:
  - Existing Playwright suite under `floe-web\tests\` (`field-substrate.spec.ts`, `context-rendering.spec.ts`, `channel-activity.spec.ts`, `actor-neutral-ui.spec.ts`, `no-actor-bleed.spec.ts`, `pulse-e2e.spec.ts`) exercises these flows; `floe-web\src\fields.test.ts` covers the pure transform layer.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Bus reads:
    - `GET /v1/workspaces/:workspace_id/scopes` to populate the Field list (substrate Scopes as Fields).
    - `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` to populate the open Field canvas.
  - Bus writes (for "Add field" / rename, only when the user explicitly creates or renames a Field):
    - `POST /v1/workspaces/:workspace_id/scopes` (creating a Field creates a Scope).
    - `PATCH /v1/workspaces/:workspace_id/scopes/:scope_id` (rename).
  - Existing layout sidecar transport (`putFieldLayout` / `getField.layout`) is the only viable layout-persistence channel in this codebase today and may continue to be used **provided** layout is keyed by stable projected substrate refs (e.g., `context:<id>`, `pulse:<id>`, `event:<id>`, `activity:<telemetry_id>`) and never used to derive membership. Per CONTEXT.md, layout writes must not change Scope membership. If wiring layout against the legacy Field semantic file would re-extend the superseded model, prefer a renderer-only in-memory layout for this slice and surface that limitation; do not introduce a new sidecar storage path.
  - WebSocket `/v1/events/stream`: continue the existing `queueRefresh()` loop to detect projection changes (Context/Pulse/Event/Scope events already broadcast on this stream). Add a projection refetch when a relevant event arrives for the open Scope.
  - React Flow primitives already imported (`main.tsx:27-48`): `ReactFlow`, `ReactFlowProvider`, `Background`, `BackgroundVariant`, `Controls`, `MiniMap`, `Handle`, `Position`, `BaseEdge`, `EdgeLabelRenderer`, `getBezierPath`, `useReactFlow`. Reuse `FieldItemNode` and the existing `nodeTypes`/`edgeTypes` registries; introduce projection-aware node/edge data, not new container components.
  - Existing pure transform pattern in `floe-web\src\fields.ts` (`fieldToReactFlow`, `parseFieldRef`, `deriveLabel`, `defaultLayout`, `applyNodeChangesToLayout`, `reactFlowToLayout`) is the precedent for a thin renderer adapter. Add a sibling `floe-web\src\scope-projection.ts` (or similarly named) that translates `ScopeProjection` + a layout map keyed by substrate refs into `Node[]` / `Edge[]`, exercised by vitest. Reuse `parseFieldRef`/`deriveLabel` where the projected ref kinds overlap.
  - Existing HTTP client conventions in `fields-api.ts` (typed `request<T>`, `FieldsApiError`, encoded path params) are the precedent for a new `floe-web\src\scope-projection-api.ts` that exposes `listScopes`, `getScopeProjection`, `createScope`, `renameScope`.
  - Conversation/sidebar open path: reuse `setChannelOpen(true)` + `setSelectedContextId(contextId)` + `refreshContextEvents(contextId)` from `main.tsx:1556-1586, 2417-2696`. Wire React Flow `onNodeDoubleClick` (and a clear primary affordance — e.g., click for selection, double-click or an in-node "open" button for the conversation) to this path for Context nodes only.
- Relevant docs or library capabilities:
  - `CONTEXT.md:21-27` (Scope, Default Scope, Scope Projection, Field, Field Layout, Block, Derived Relationship).
  - `docs\scope-substrate-slice-prd.md` and `docs\adr\0004-scope-as-substrate-organising-boundary.md`.
  - `docs\implementation-reviews\issue-28-scope-projection-contract-architecture-integration.md` (binding contract; FloeWeb is the consumer it designs for).
  - React Flow custom node/edge docs (`@xyflow/react`): use existing `nodeTypes`, `edgeTypes`, `Handle` positions, and `selected`/`deletable` flags rather than re-implementing selection/drag.
- Existing examples in this codebase:
  - `floe-bus\src\scope-projection.test.ts` shows a complete projection HTTP payload that the renderer adapter can mock against.
  - `floe-web\src\contexts.ts` + `contexts.test.ts` show the established "pure helpers + vitest, no React/DOM/fetch" pattern.
  - `floe-web\tests\helpers.ts` + `field-substrate.spec.ts` show the Playwright `page.route(...)` mocking pattern for bus endpoints; the new Playwright work should mock `/scopes` and `/scopes/:id/projection` the same way.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - The bus Scope Projection. FloeWeb must call `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` and derive nothing about Scope membership from `/v1/contexts`, `/v1/events`, `/v1/pulses`, `/v1/runtime/telemetry`, or any future primitive endpoint. Existing FloeWeb calls to `/v1/contexts`, `/v1/events`, `/v1/runtime/telemetry`, `/v1/endpoints`, `/v1/runtime/bindings` for workspace/conversation/runtime concerns must remain, but must not be used to assemble Scope membership.
  - React Flow. Do not hand-roll pan, zoom, drag, selection, edge labels, MiniMap, Controls, Background, drop targets, or viewport restore.
  - The existing conversation/sidebar surface. Do not invent a second conversation UI inside the Field canvas for Context nodes; "open" routes to `renderChannel` via the existing state setters.
  - The existing Block Library palette and drag/drop. Do not replace it with a toolbar-only or modal-only create flow.
  - The existing layout transform module (`floe-web\src\fields.ts`). Reuse `parseFieldRef`, `deriveLabel`, `defaultLayout`, `applyNodeChangesToLayout`, `reactFlowToLayout` patterns; do not fork them.
  - The existing icon vocabulary (`lucide-react`); reuse the same icons already used per kind (e.g., `LayoutPanelLeft` for fields, `MessageSquare` for conversation, `CircleDot` for actor/pulse identity) for visual continuity.
- Shortcuts or parallel paths to avoid:
  - Do **not** extend `.floe/fields/<id>.yaml` semantic files, do **not** introduce `.floe/blocks`, do **not** create new Field-owned membership or connection storage.
  - Do **not** use Field Item ids (`item_id`) as layout keys. Layout keys must be stable substrate refs derived from projection refs (e.g., `context:<context_id>`, `pulse:<pulse_id>`, `event:<event_id>`, `activity:<telemetry_id>`). This is the CONTEXT.md invariant.
  - Do **not** delete or hard-disable `/v1/workspaces/:workspace_id/fields*` routes, `floe-bus\src\fields-store.ts`, `fields-watcher.ts`, or the `field.upserted`/`field.deleted` stream events. Bypass them on the active list/open/render path; legacy removal belongs in slice #32 per the parent #25 closeout gate.
  - Do **not** keep importing `listFields`, `getField`, `putFieldSemantic`, `deleteField`, `subscribeToFieldEvents` in the active list/open/render code paths in `main.tsx`. The acceptance criterion "tests prove FloeWeb does not call old Field semantic APIs for active list/open/render paths" must hold — either remove those imports from the active path or guard them so that no production code path exercises them when consuming projection. Add a unit/Playwright assertion that the legacy endpoints are not requested during list/open/render.
  - Do **not** derive Context participants as actor containment (no Actor-as-Field-item rendering). Render participants as a presence/relationship affordance on the Context node or as a sidecar list, per the PRD's actor-neutrality rule.
  - Do **not** render `unsupported` projection entries as ordinary nodes. Either omit them or render an explicit "unsupported" affordance with the stable reason string.
  - Do **not** fabricate edges between projection refs beyond the three relationship lists the bus returns (`context_participants`, `pulse_subscribers`, `event_context_ownership`).
  - Do **not** add a second WebSocket subscription; reuse the existing `queueRefresh()` socket and refetch projection inside that handler when relevant events arrive.
  - Do **not** silently replace the Block Library drag/drop with a toolbar-only "Add field" affordance. Toolbar shortcuts may supplement, not replace.
  - Do **not** introduce per-node imperative state mutations that bypass React Flow's `onNodesChange`/`onEdgesChange` lifecycle (it will regress selection/drag performance).
  - Do **not** schema-mutate the projection response client-side and re-cache it as if it were Field semantic; treat projection as ephemeral derived state per fetch.
- Invariants:
  - A Field === a Scope. The Field list is the Scope list. The Default Scope must appear and must never be deletable from the UI.
  - Projection is the only derivation point for Scope membership in FloeWeb.
  - Layout is renderer metadata only and never changes membership. Layout is keyed by stable substrate refs.
  - Context node "open" routes through the existing conversation/sidebar (`setChannelOpen` + `setSelectedContextId` + `refreshContextEvents`) — no new conversation UI.
  - React Flow-native pan/zoom/selection/drag/handles/labels/icons/MiniMap/Controls/drop targets remain working.
  - Unsupported projection entries are omitted or rendered honestly as unsupported.
  - "Add field" → creates a Scope (`POST /scopes`), then opens it. Rename Field → `PATCH /scopes/:id`.
  - No `.floe/blocks`, no Field-owned item list, no Field-owned connection list extended.

## Integration plan

- Insert the change at:
  1. **New HTTP client module** `floe-web\src\scope-projection-api.ts`:
     - `listScopes(busUrl, workspaceId)` → `ScopeSummary[]` from `GET /v1/workspaces/:workspace_id/scopes`.
     - `getScopeProjection(busUrl, workspaceId, scopeId)` → `ScopeProjection` from `GET .../projection`.
     - `createScope(busUrl, workspaceId, { scope_id?, title, description? })`.
     - `renameScope(busUrl, workspaceId, scopeId, { title?, description? })`.
     - Mirror `fields-api.ts` conventions (typed `request<T>`, error class, encoded params).
  2. **New pure renderer adapter** `floe-web\src\scope-projection.ts` (or `field-projection.ts`):
     - `projectionToReactFlow(projection: ScopeProjection, layout?: ScopeLayout): { nodes: Node[]; edges: Edge[]; unsupported: UnsupportedEntry[] }`.
     - Map `refs.contexts → context node`, `refs.pulses → pulse node`, `refs.events → event node` (or attach as edges where the PRD prefers), `refs.activity → activity node` (or omit until later if rendering is not yet defined).
     - Map `relationships.context_participants → presence/relationship data attached to the context node` (not edges to actor nodes; do not create actor nodes from participants).
     - Map `relationships.pulse_subscribers → edge from pulse node to the subscriber's owning Context/Endpoint ref` (only when the subscriber resolves to an already-present node ref; otherwise show as a relationship list on the pulse node).
     - Map `relationships.event_context_ownership → edge from event node to context node` when both are present.
     - Use stable refs as node ids (e.g., `context:<id>`).
     - Use existing `parseFieldRef`/`deriveLabel` where applicable; extend kind handling where projection adds new kinds.
     - Return `unsupported` for the UI to render honestly.
     - Layout merge mirrors `fieldToReactFlow`: apply positions keyed by ref; fall back to `defaultLayout(index)`.
  3. **New node/edge types** registered alongside `fieldNodeTypes` / `fieldEdgeTypes` in `main.tsx`:
     - Extend `FieldItemNode` (or add `ContextNode`, `PulseNode`, `EventNode`, `ActivityNode`, `UnsupportedNode`) with kind-specific icons (reuse existing `MessageSquare`, `CircleDot`, `Activity`, `AlertTriangle` icons) and an explicit "Open" affordance for Context nodes that triggers the conversation/sidebar.
     - Keep React Flow `Handle` components (top target, bottom source) so connect/drag affordances visually persist (even if connection editing is not used in this slice).
  4. **Swap the active Field list/open/render path in `main.tsx`** (no removal of the legacy module):
     - Replace `refreshFields` / `refreshOpenField` (`main.tsx:925-949`) with `refreshScopes` / `refreshOpenProjection` that call the new client.
     - Replace the `fieldSummaries` state with `scopeSummaries` (or alias `FieldSummary` to a Scope-derived shape) and the `loadedField` state with `loadedProjection`.
     - `openField(fieldId)` becomes `openField(scopeId)` and fetches the projection.
     - `view.kind === "field"` continues to mean "a Scope is open"; `view.fieldId` becomes `view.scopeId`.
     - `createField` calls `createScope`; `submitRenameField` calls `renameScope`.
     - `deleteOpenField` is **removed from the active path** in this slice (Scope deletion is out of scope per PRD); the inspector "Delete field" button is hidden or replaced with an explanatory disabled state. Legacy `deleteFieldApi` import must not be invoked on the active path.
     - Wire `onNodeDoubleClick` and a primary in-node "Open" affordance for Context nodes to `setChannelOpen(true)` + `setSelectedContextId(contextId)` + `refreshContextEvents(contextId)` (reuse existing setters from `main.tsx:1556-1586`). For non-Context nodes, double-click is a no-op or future-extension hook.
     - `handleFieldConnect`, `handleFieldEdgesDelete`, `handleFieldReconnect`, `handleFieldBeforeDelete`, `handleFieldEdgeDoubleClick`, `beginAddFieldItem`/`submitAddFieldItem` and the connection-label editor are membership-editing flows. In this slice they must be disabled on the projection path (membership is bus-derived). Keep the React Flow event handlers attached as no-ops or guarded early returns so React Flow's internal selection/drag lifecycle is not affected. Remove only the user-facing affordances (toolbar "Add actor item" / "Add field item" buttons in `main.tsx:2149-2176`) and the connection-label create UI — leave selection/drag intact.
     - Update WebSocket handling (`main.tsx:809-840, 1279-1299`): on stream messages, refetch the open projection (and the scope list) when the workspace matches. `parseFieldStreamMessage` filtering can stay (filtering legacy field events out of `queueRefresh`) but the legacy `subscribeToFieldEvents` call site must be removed so FloeWeb no longer reacts to legacy field events.
     - Layout persistence: stop writing the Field semantic file. For this slice, either (a) persist layout via the existing `putFieldLayout` keyed by stable substrate refs as the only on-disk channel (acceptable per PRD as long as keys are projection refs), or (b) keep layout in-memory only for the slice and surface the limitation. Decide in implementation; the brief flags this as the one open layout question. Either choice must not invoke `putFieldSemantic`/`deleteField` on the active path.
  5. **Inspector** (`main.tsx:2223-2305`): replace "Items/Connections" counts with projection-derived counts (Contexts, Pulses, Events, Activity, Unsupported). Show Scope id/title from the Scope list.
  6. **Block Library** (`main.tsx:2307-2340`): keep the existing Field palette item; its click/drag now creates a Scope (`createScope`) and opens it. Nested-field-on-canvas drop is out of scope for the projection model and should be removed or no-op'd in this slice (no nested-Scope semantics defined yet).
  7. **Tests** (see Test plan): add bus-mock Playwright specs and pure-transform vitest specs that fail if any legacy Field semantic endpoint is requested on the active path.
- Why this is the correct integration point:
  - It reuses the existing React Flow shell, conversation/sidebar, Block Library, Inspector, and stream-refresh loop without forking.
  - It introduces exactly one new client module and one new pure transform module, matching the established `fields-api.ts` + `fields.ts` separation.
  - It honours the parent #25 closeout gate (legacy APIs remain but active path is bypassed; removal deferred to #32).
- Alternatives considered and rejected:
  - **Mutate `fields-api.ts` to wrap the projection.** Rejected: confuses the semantic-file API with the projection, and risks accidental writes to `.floe/fields/<id>.yaml` from projection code paths.
  - **Render a parallel canvas component for projection alongside the legacy Field canvas.** Rejected: violates the "no parallel paths" invariant and would split React Flow state, harming pan/zoom/selection continuity.
  - **Open Context nodes in a new modal or in-canvas conversation UI.** Rejected: would duplicate the existing channel/sidebar; PRD requires the existing conversation path.
  - **Materialise projection into a Field semantic file before rendering.** Rejected: re-extends the superseded model and contradicts the "projection is read-only derivation" invariant.
  - **Remove `/v1/workspaces/:workspace_id/fields*` in this slice.** Rejected: parent #25 explicitly defers legacy removal to #32; doing it here risks regressing unrelated tooling and exceeds slice scope.

## Regression checklist

- React Flow pan, zoom, drag, selection, MiniMap, Controls, Background, viewport restore, `defaultViewport`, `minZoom`/`maxZoom`, `deleteKeyCode` all continue to work on the open Field (now a Scope projection).
- Node icons, labels, and `Handle` placement remain visible and identical in style for the Context, Pulse, Event nodes.
- Block Library palette is present, draggable, and clickable; click/drag still creates a new Field (now a Scope) and opens it.
- Workspace Home Field list renders, shows count, supports "Add field" (now creates a Scope), and the empty-state ("No Fields yet") still renders when no Scopes (other than Default) exist or when an empty-projection view is shown. Default Scope is always listed.
- Rename Field affordance renames the Scope via `PATCH /scopes/:id` and updates the Inspector/Home label.
- Opening a Context node opens the existing conversation sidebar with the right Context selected and events loaded (`setChannelOpen` + `setSelectedContextId` + `refreshContextEvents`).
- `renderChannel` actor selector, conversation list, composer, `sendFloeMessage`, pulse rendering, activity grouping continue to work unchanged.
- Workspace switch, Inspector, Settings, runtime binding, error bar, refresh button all work; switching workspaces clears the open Field and resets state as today.
- Stream-driven refresh: emitting a new Event into the open Scope (or creating a Context / Pulse in it) causes the open Field canvas to refresh from the projection within the existing refresh cadence.
- Layout writes do not change Scope membership; moving a node does not add/remove projection refs.
- `parseFieldStreamMessage` (or its replacement) still filters legacy noise from `queueRefresh()`.
- No call to `/v1/workspaces/:workspace_id/fields*`, no PUT to `.floe/fields/<id>.yaml`, no creation of `.floe/blocks/*` occurs on the active list/open/render path.
- Performance: no perceptible regression in pan/zoom/drag responsiveness; projection refetch debounced under stream load.
- Default Scope is never deletable. The Inspector "Delete field" button is either hidden or visibly disabled with an explanatory tooltip; it must not delete `.floe/fields/<id>.yaml` on the active path.

## Test plan

- Existing tests to keep green:
  - `floe-bus\src\scope-projection.test.ts`, `scopes-server.test.ts`, `scope-propagation.test.ts`, `pulse-scope-propagation.test.ts`, `pulse-subscribers.test.ts`, `server.test.ts`, `delivery-symmetry.test.ts`.
  - `floe-web\src\fields.test.ts`, `fields-api.test.ts`, `contexts.test.ts`, `no-native-popups.test.ts` (the pure transform/HTTP client + dialog suites — even though the legacy Field path is bypassed, the underlying helpers remain in use).
  - `floe-web\tests\context-rendering.spec.ts`, `channel-activity.spec.ts`, `actor-neutral-ui.spec.ts`, `no-actor-bleed.spec.ts`, `pulse-e2e.spec.ts`, `emit-e2e.spec.ts`, `workspace-management.spec.ts`.
  - `floe-web\tests\field-substrate.spec.ts` must be updated, not deleted: rename / rewrite so each scenario seeds Scope and projection mocks instead of Field semantic files. Keep its coverage of "list a Field", "empty state", "open a Field", "render nodes", "pan/zoom/drag/select".
- New tests to add before/with implementation (TDD-friendly):
  - `floe-web\src\scope-projection.test.ts` (pure transform): projection-with-contexts-only → Context nodes; projection-with-pulses-and-subscribers → Pulse node with subscriber relationship data; projection-with-events → events as edges or nodes per chosen mapping; `unsupported` entries surface as unsupported affordance; participants render as presence data, not as Actor nodes; layout merge keyed by substrate refs; `applyNodeChangesToLayout`-style position update preserves substrate ref keys.
  - `floe-web\src\scope-projection-api.test.ts` (HTTP client): URL shape, error mapping, encoded params, 404 on unknown workspace/scope.
  - `floe-web\tests\scope-projection.spec.ts` (Playwright): mock `GET /scopes` + `GET /scopes/:id/projection` (and `POST /scopes`, `PATCH /scopes/:id`) and assert:
    - Field list shows Scopes (including Default Scope).
    - Opening a Scope renders projection nodes with kind-correct icons/labels.
    - Double-click (or in-node "Open") on a Context node opens the conversation sidebar with the right Context selected.
    - Pulse node shows subscriber relationship data.
    - Participants render as relationship/presence data, not as Actor nodes.
    - Unsupported entries render honestly or are omitted, never as ordinary nodes.
    - Pan/zoom/drag/select still respond.
    - Block Library click and drag create a new Scope (assert `POST /scopes` is called) and open it.
    - Rename Field issues `PATCH /scopes/:id`.
  - **Negative-call assertion** (Playwright or vitest with `fetch` spy): during the list/open/render path, no request is made to `/v1/workspaces/*/fields*`, no `PUT` to a `.floe/fields/*` path, and `subscribeToFieldEvents` is not invoked. This directly satisfies the AC "tests prove FloeWeb does not call old Field semantic APIs for active list/open/render paths".
  - Layout regression test: moving a node fires a layout write keyed by substrate ref (or, if in-memory only, no semantic write occurs) and projection refetch returns the same membership set.
- Live proof required:
  - Run `floe-bus` + `floe-bridge` against a real workspace. Create a workspace; verify Default Scope appears as a Field. Create a Context (via existing channel) and a Pulse in the Default Scope; verify both appear as projection nodes in the open Field canvas without any client-side fan-out. Open the Context node from the canvas and verify it opens in the existing conversation sidebar. Emit messages and verify the projection updates via the existing stream refresh. Create a new Field via the Block Library; verify a Scope is created (`POST /scopes`) and the new Field opens. Rename the Field; verify `PATCH /scopes/:id`. Move nodes; reload; verify layout persists and Scope membership is unchanged. Confirm via DevTools Network that the active path never calls `/v1/workspaces/*/fields*`.
  - Capture: screenshots of the Field list with Default Scope, the open Field canvas with Context/Pulse nodes, the conversation sidebar opened from a Context node, and the DevTools Network panel filtered for `/fields` (empty) and `/scopes` (populated).

## Risk assessment

- Risk: silently regressing React Flow interaction performance by re-rendering the canvas on every projection refetch.
  - Mitigation: memoize `projectionToReactFlow` output, key nodes by stable substrate refs, and debounce stream-triggered refetches (reuse the existing `queueRefresh` pattern).
- Risk: leaking legacy Field calls on the active path because `main.tsx` still imports legacy helpers.
  - Mitigation: delete the legacy imports from active code paths (keep them only in code branches that this slice does not exercise, or behind a `legacy-only` boundary), and add the negative-call assertion above.
- Risk: opening a Context node via canvas conflicts with React Flow's default double-click behaviour (zoom-to-fit on node).
  - Mitigation: use the existing `onNodeDoubleClick` handler that already exists in `main.tsx`; add an explicit in-node "Open" button as the primary affordance and keep double-click as a convenience binding.
- Risk: representing pulse subscribers or event_context_ownership as edges where one endpoint is not a present node (e.g., subscriber resolves to an endpoint not in the projection).
  - Mitigation: only draw edges between refs that are both projection nodes; otherwise attach as relationship data on the originating node.
- Risk: layout keyed by substrate refs collides with legacy layout keyed by Field Item ids on the same on-disk sidecar.
  - Mitigation: treat any prior `.layout.floeweb.yaml` data as legacy on the projection path; either ignore it or namespace projection layout (e.g., write to a new sidecar shape) — decide in implementation. Do not migrate by inferring membership.
- Risk: Block Library drop on a non-canvas drop target leaves UX inconsistent.
  - Mitigation: keep the existing `handleLibraryDropSurface` behaviour; in this slice, dropping on the surface creates a new Scope when on Home, and is a no-op on an open Field canvas (since nested-Scope semantics are not defined). Avoid silently changing existing drop behaviour.
- Risk: removing the user-facing "Add actor item" / "Add field item" / connection-label affordances also breaks React Flow's selection or drag because they share state.
  - Mitigation: only remove the UI affordances and the membership-write handlers; keep React Flow's `onNodesChange`/`onEdgesChange` wired (as no-ops for non-layout changes) so selection/drag continue to work.
- Risk: Inspector "Delete field" button accidentally calls legacy `deleteFieldApi`.
  - Mitigation: hide or disable the button this slice; do not call any legacy delete endpoint on the active path.
- Risk: WebSocket subscription duplication.
  - Mitigation: reuse the existing `/v1/events/stream` socket in `main.tsx:809-840`; do not add a second subscriber. Remove the `subscribeToFieldEvents` call site so legacy field events stop driving state.
- Risk: confusing the renderer with FloeWeb-specific data in the projection contract.
  - Mitigation: projection contract is fixed by the bus (`floe-bus\src\scopes\projection.ts:49-65`); the adapter is the only place that introduces React Flow vocabulary.

## Decision confidence

- Confidence: high.
- Reasons:
  - The bus contract is already shipped and tested (`floe-bus\src\scopes\projection.ts`, `scope-projection.test.ts`, `server.ts:171-187`).
  - FloeWeb already has a clean transform/HTTP separation (`fields.ts` + `fields-api.ts`) that the new modules can mirror exactly.
  - The conversation/sidebar open path is a small, well-isolated set of state setters in `main.tsx:1556-1586` that is easy to invoke from `onNodeDoubleClick`.
  - React Flow primitives, Block Library, Inspector, stream refresh, and Playwright mock infrastructure (`floe-web\tests\helpers.ts`) all exist and can be reused without new dependencies.
  - The PRD and parent #25 already permit "freeze (not remove) legacy on the active path" as the right strategy for this slice.
- Open questions:
  - Layout persistence channel: continue to use `putFieldLayout` keyed by stable substrate refs, or keep layout in-memory until #32 introduces a projection-native sidecar? Implementer should choose based on the smallest change that satisfies the "layout never changes membership" invariant and the "no extending legacy" invariant. Default recommendation: in-memory layout for this slice; flag persistent layout as a follow-up.
  - Activity (`refs.activity`) rendering: render as nodes, as a side panel list in the Inspector, or omit until a later slice? Default recommendation: omit nodes; surface count in the Inspector. Decide during implementation based on visual noise.
  - Event rendering: nodes vs. edges-only via `event_context_ownership`? Default recommendation: render Events as small adjunct nodes attached to their Context via the ownership edge; if visual clutter is high, fall back to a per-Context "events" affordance.
  - Whether to hide or visibly disable the Inspector "Delete field" button this slice. Default recommendation: hide on the projection path; restore in a later slice when Scope deletion is in scope.
