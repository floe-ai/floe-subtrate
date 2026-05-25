# Architecture Integration Brief: high-confidence-floeweb-pulse-field-fixes

> Scope: triage six user-reported FloeWeb defects covering Pulse↔Context connection, Pulse subscriber wake semantics, generated delivery Context visibility, Pulse configure/edit/delete UI, auto-placement of Chats on the Field canvas, and persistence of node positions in the Scope Projection canvas. Carve out the subset that can land as low-risk, high-confidence vertical fixes without changing substrate semantics (`CONTEXT.md`, ADR-0004, the Pulse subscriber model). Set aside items that would require a fresh design.
>
> Recommended high-confidence subset:
> - **A. Scope Projection Field layout persistence** keyed by stable projected refs, reusing the existing layout sidecar transport without reintroducing Field-owned membership (issue #31 / #26).
> - **B. Manual Pulse → Context connect (and disconnect) from the FloeWeb canvas**, where the React Flow connect/edge-delete handlers write through the **Pulse subscriber list** on the source primitive. Context Subscriber stays render-only per `CONTEXT.md:58-62`.
>
> Set aside (require explicit design work; not implemented in this slice):
> - Issue 2: making Pulse → Context activate an Actor. This contradicts the Context Subscriber definition (`CONTEXT.md:58-62`, `server.ts:1003-1016`). Activation requires an Endpoint Subscriber with a processor (#38/#39).
> - Issue 3: surfacing the generated delivery Context of an Endpoint Subscriber inside actor-sidebar UI. The generated Context already exists (`server.ts:1017-1041`, `store.getOrCreatePulseDeliveryContext`), but the actor sidebar/inbox UX for it has not been designed. Treat as a UX slice, not a fix.
> - Issue 4: full Pulse configure/edit/delete UI and substrate-side Pulse mutation (rename, retarget). Today only pause/resume/cancel/subscribe/unsubscribe exist on the bus (`server.ts:906-953`); there is no `PATCH /v1/pulses/:pulse_id` and no FloeWeb Pulse-inspector affordance. Needs PRD.
> - Issue 5: "Chats only appear in Field after explicit placement". The current model (`CONTEXT.md:131-143`, ADR-0004, issue #28/#29) is that Field renders a Scope Projection and Contexts are *substrate-derived* — not user-placed. Hiding them by default would either need a per-Context "visible in Field" flag (new primitive state) or a sidebar/Field separation rule. This is a model change.
>
> This brief does not modify product code. Implementation must follow the brief; conflicts must be raised via `Question`.
>
> ---

## Existing ownership

- **Layout persistence (today, legacy Field-semantic path)**
  - `floe-bus` owns the renderer layout sidecar at `PUT /v1/workspaces/:workspace_id/fields/:field_id/layout/:renderer` (`floe-bus\src\server.ts:335-362`), backed by `upsertFieldLayout` writing `.floe/fields/<field_id>.layout.<renderer>.yaml` (`floe-bus\src\fields-store.ts:348-381`). The semantic file is **not required to exist** — `upsertFieldLayout` validates body shape and `field_id` only, then writes.
  - `loadField` returns `{ semantic, layout }` only when a semantic file exists (`fields-store.ts:222-239`). There is no current API to fetch a layout sidecar by `scope_id` without a matching semantic file. `loadAllFields` skips files with `.layout.` in the name (`fields-store.ts:241-261`).
  - `fields-watcher.ts` re-broadcasts `field.upserted` with `changed: "layout"` (and `renderer`) when a layout sidecar changes on disk (`fields-watcher.ts:1-30`, server `broadcast` at `server.ts:349-356`).
  - FloeWeb owns the in-memory layout state for projections in `main.tsx` (`loadedProjection.layout`, `loadedProjectionRef`). `scheduleFieldLayoutSave` exists but `sendFieldLayoutSave` only marks a local write window (`main.tsx:1052-1088`) — it does **not** call `putFieldLayout` for the projection path. Field-semantic path does call it (`main.tsx:1158, 1179, 1228, 1442`).
  - Refresh path: `refreshOpenField` (`main.tsx:1011-1040`) preserves `current.layout` across refresh only when the projection ref is the same and stays in memory; it never loads a persisted layout from the bus.
  - Pure transform helpers in `floe-web\src\fields.ts` (`reactFlowToLayout`, `applyNodeChangesToLayout`, `FieldLayoutFloeweb`) and `floe-web\src\scope-projection.ts` (`projectionToReactFlow`, `defaultProjectionLayout`) compose the visible nodes.

- **Pulse subscriber mutation**
  - `floe-bus` owns the Pulse subscriber list. Schema: `PulseSubscriberSchema` (`server.ts:64-74`) — discriminated union of `{ kind: "context", context_id }` and `{ kind?: "endpoint", endpoint_ref, context_id? }`. Mutation: `POST /v1/pulses/:pulse_id/subscribe` and `POST /v1/pulses/:pulse_id/unsubscribe` (`server.ts:937-953`). Storage: `BusStore.addPulseSubscriber` / `removePulseSubscriber` against the `pulse_subscribers` table (`store.ts:1476-1486`). Subscriber JSON is stored verbatim and used at fire time (`server.ts:989-1046`).
  - `BusStore.createPulse` accepts an initial `subscribers: PulseSubscriber[]` array at creation (`server.ts:830-894`).
  - Projection surfaces subscribers as relationships: `relationships.pulse_subscribers: [{ pulse_id, subscriber }]` (`scopes/projection.ts:60-65, 106-114`). FloeWeb already renders Pulse→Context subscriber relationships as React Flow edges (`scope-projection.ts:160-178`).

- **Scope Projection rendering**
  - `floe-bus` owns `buildScopeProjection` (`scopes/projection.ts:84-117`) and `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` (`server.ts:171-187`). Projection is read-only, derived, and excludes Events/Activity (per issue #35 closeout).
  - `floe-web` consumes it via `getScopeProjection` (`scope-projection-api.ts:42-51`) and renders it through `projectionToReactFlow` (`scope-projection.ts:122-179`) using `FieldItemNode` (`main.tsx:206-239`) inside the existing React Flow shell (`main.tsx:2210-2268`).
  - "Open Context" affordance routes through the conversation/sidebar (`main.tsx:setSelectedContextId`, `setChannelOpen`, `refreshContextEvents`).

- **Pulse delivery semantics**
  - `firePulse` in `floe-bus\src\server.ts:979-1062` is the single source of truth.
    - `kind: "context"` subscribers append `pulse.fired` to the configured Context **with `destination` set to a broadcast** to the context's participants and *no endpoint target* — i.e. render-only append; no Delivery is created. (`server.ts:1003-1016`, matches `CONTEXT.md:58-62, 84-86`.)
    - `kind: "endpoint"` subscribers resolve the endpoint, get-or-create a stable delivery Context (one per Pulse + subscriber config, `store.getOrCreatePulseDeliveryContext`, `server.ts:1017-1041`, issue #38/#39 brief), and emit `pulse.fired` targeting that endpoint. Activation only occurs if the endpoint has a processor (per `CONTEXT.md:64-65` and the Pulse PRD).

- **React Flow / library ownership**
  - `@xyflow/react` owns canvas pan/zoom/selection/drag/handles/edges/MiniMap/Controls/Background/drop targets. `lucide-react` owns icon glyphs. None of these may be re-implemented (per `AGENTS.md` Field/canvas invariants and prior briefs #29/#36).

## Existing interaction model

- **Workspace Home** lists Scopes-as-Fields via `listScopes`; clicking opens via `refreshOpenField` (`main.tsx:1001-1045`). Block Library, rename, MiniMap, Controls, Background, pan/zoom/drag/selection are React Flow-native (`main.tsx:2210-2268`).
- **Opening a Scope-backed Field** renders Context and Pulse nodes only (`scope-projection.ts:140-159`), with derived `pulse-subscriber:` edges where the subscriber declares a `context_id` and the Context is in the same Scope (`scope-projection.ts:160-178`).
- **Node drag, viewport pan/zoom, and node-selection** are already handled by `handleFieldNodesChange`, `handleFieldMoveEnd`, `handleFieldNodeDragStop` (`main.tsx:1106-1229`). For the projection branch they currently update `loadedProjectionRef.current.layout` in memory only — no `scheduleFieldLayoutSave` call (compare to the field-semantic branches that *do* call it at 1158, 1179, 1228).
- **Edge creation / reconnect / delete** are gated for projections: `if (loadedProjectionRef.current) return;` blocks them entirely (`main.tsx:1232, 1272, 1278, 1304, 1389`). Today users cannot draw an edge inside a Scope projection.
- **WebSocket stream** filters out `field.*` frames from the general refresh queue (`main.tsx:906`) and uses `hasRecentLocalLayoutWrite` (`main.tsx:1056-1063`) to avoid re-fetching during the 2s window after a local layout write. The infrastructure for "this write is mine, skip refetch" already exists.
- **Open Context** affordance on a Context node opens the conversation/sidebar; this must remain untouched.

## Existing extension points

- **Layout sidecar transport (re-use, don't invent)**
  - `putFieldLayout(busUrl, workspaceId, fieldId, layout)` in `fields-api.ts:204-219` already PUTs `/fields/:field_id/layout/floeweb`. The `field_id` URL segment is constrained by `FIELD_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/`; Scope ids of the form `default` or `scope_<uuid>` satisfy this regex (UUID dashes are allowed).
  - `FieldLayoutSchema` (`fields-store.ts:54-71`) requires `schema: "floe.field.layout.floeweb.v1"`, `field_id`, `viewport`, and `items: Record<string, { x, y, width?, height?, collapsed? }>`. The `items` record key is **not** regex-constrained, so projected refs like `context:<id>` and `pulse:<id>` (already used by `projectionToReactFlow`) are valid layout keys.
  - To **read** a persisted layout when opening a Scope projection there is no projection-aware GET today. Two acceptable options (pick one in the integration plan): (i) add a thin `GET /v1/workspaces/:workspace_id/fields/:field_id/layout/floeweb` that returns the parsed layout sidecar **without requiring a semantic file**, or (ii) extend the projection endpoint response to include `layout: FieldLayout | null`. Option (i) keeps the layout transport orthogonal to Scope Projection and reuses existing files / watcher / broadcast semantics.

- **FloeWeb pure transform layer**
  - `reactFlowToLayout(fieldId, nodes, viewport)` already produces a `FieldLayoutFloeweb` from React Flow state. `applyNodeChangesToLayout(layout, changes)` is the established way to fold pointer drag into layout. Both must be reused on the projection branch — no new branch-specific layout math.

- **Pulse subscriber wire format and HTTP**
  - For B, the existing `POST /v1/pulses/:pulse_id/subscribe` with body `{ "kind": "context", "context_id": "<id>" }` is the correct entry point. No new endpoint required. Symmetric unsubscribe is already available.
  - Membership constraint already enforced by `BusStore` (subscriber JSON is stored as-is); validation happens on the schema.

- **React Flow connect API**
  - `onConnect: (Connection) => void` and `onReconnect: (Edge, Connection) => void` are already wired (`main.tsx:2210-2268`). `onEdgesDelete` and `onBeforeDelete` are already wired. Only the projection-guard early-returns need to change to call the Pulse subscribe/unsubscribe API instead of mutating a Field-semantic file.
  - `Connection.source` / `Connection.target` are the projected node ids (`pulse:<id>`, `context:<id>`); the existing `parseFieldRef` (`floe-web\src\fields.ts`) can split kind/id.
  - Edge ids for the rendered Pulse→Context subscriber edge follow the existing convention `pulse-subscriber:<pulse_id>:context:<context_id>` (`scope-projection.ts:167`), which can be parsed by the delete handler to find the right subscribe row.

- **WebSocket-driven refresh**
  - `parseFieldStreamMessage` (`floe-web\src\fields-api.ts:64-112`) already classifies `field.upserted` frames including `changed: "layout"` and `renderer`. The existing `queueRefresh()` loop and `hasRecentLocalLayoutWrite` window are the integration point for echo-suppression on layout writes. Pulse subscribe/unsubscribe writes do not currently broadcast a substrate event; if the integration wants the canvas to re-fetch projection after a local subscribe, FloeWeb should refetch the projection optimistically (it already does this via `refreshOpenField` on stream activity / refresh button).

## Do-not-bypass list

- Do **not** reintroduce Field-owned semantic item or connection storage (`.floe/fields/<id>.yaml` content) when implementing A or B. Specifically: do **not** call `putFieldSemantic` for projection-backed Fields. The Field semantic file must remain absent for Scope-backed renderings, per ADR-0004 / issue #28-#32.
- Do **not** introduce `.floe/blocks/` or any other new client-derived membership storage.
- Do **not** change `firePulse` Context-subscriber behaviour to create Deliveries / activate Actors. That contradicts `CONTEXT.md:58-62` and would invalidate issue #38/#39's stable-context invariants. Item 2 from the user report is out of scope for this slice.
- Do **not** suppress, gate, or hide Contexts/Pulses returned by the Scope Projection in order to "fix" item 5. The projection contract is substrate-derived; Field render must remain whatever the projection returns.
- Do **not** add a new PATCH/DELETE on `/v1/pulses/:pulse_id` for item 4. There is no existing primitive owner for "edit a Pulse definition" and the substrate model around workspace-backed vs local-backed persistence has not been resolved (`pulse-slice-prd.md`, ADR notes on Pulse Persistence).
- Do **not** bypass React Flow native handlers (`onConnect`, `onEdgesDelete`, `onReconnect`, `onNodeDragStop`, `onMoveEnd`, `onNodesChange`). Wire the new behaviour through them, not through custom DOM listeners or pointer overrides.
- Do **not** break Block Library drag/drop, node icons/labels/handles/selection, rename, or Context "Open" affordances. (Carry forward invariants from briefs #29, #35, #36.)
- Do **not** key layout entries by client-side ids that the projection does not also emit. Keys must be stable substrate refs (`context:<id>`, `pulse:<id>`) as defined by `projectionNode` and `parseFieldRef`.
- Do **not** silently widen `FieldLayoutSchema.items` keys to admit arbitrary characters; today the schema is unconstrained on key shape — confirm and add a unit test pinning that projected-ref keys remain accepted.

## Integration plan (high-confidence subset)

### A. Persist Scope Projection Field layout

1. **Server: layout GET for Scope-backed Fields**
   - Add `GET /v1/workspaces/:workspace_id/fields/:field_id/layout/:renderer` in `floe-bus\src\server.ts`, returning `{ layout }` from a new helper `loadFieldLayoutOnly(locator, fieldId, renderer)` in `fields-store.ts` that reads the sidecar without requiring a semantic file. Returns 404 with `{ error: "field_layout_not_found" }` when the sidecar is absent. Renderer must be `floeweb` (mirror PUT validation at `server.ts:341-344`).
   - Existing PUT endpoint at `server.ts:335-362` and `upsertFieldLayout` already work for the Scope-id-as-field-id case; no server change required for write.
   - Existing `fields-watcher.ts` already broadcasts `field.upserted` with `changed: "layout"` when the file changes; no broadcast change required.

2. **FloeWeb: client read at open time**
   - In `floe-web\src\fields-api.ts` add `getFieldLayoutOnly(busUrl, workspaceId, fieldId): Promise<FieldLayoutFloeweb | null>` (404→null).
   - In `floe-web\src\main.tsx` `refreshOpenField` (`main.tsx:1011-1040`), after fetching projection, call `getFieldLayoutOnly(busUrl, workspaceId, fieldId)` and set `loadedProjection.layout` from the result (instead of the current `null` default at line 1027). Preserve the "in-flight local layout" priority by using `hasRecentLocalLayoutWrite` to ignore stale server reads inside the write window.

3. **FloeWeb: client write on user interaction**
   - Replace the current "projection branch updates layout in memory only" with `scheduleFieldLayoutSave(workspaceId, projection.scope.scope_id, nextLayout)` calls inside `handleFieldNodesChange`, `handleFieldMoveEnd`, and `handleFieldNodeDragStop` (`main.tsx:1131, 1169, 1204`). Continue to call `updateLoadedProjectionLayout` first to keep UI optimistic.
   - In `sendFieldLayoutSave` (`main.tsx:1065-1067`), call `putFieldLayout(busUrl, workspaceId, fieldId, layout)` for both branches. Keep the existing `markLocalLayoutWrite` so the WS echo is suppressed. Add error handling that surfaces via `setError` and does not roll back the optimistic move (consistent with current Field-semantic branch behaviour).

4. **FloeWeb: WS-driven re-read**
   - Extend the existing stream handler (around `main.tsx:905-908`) so that `field.upserted` frames with `changed === "layout"` for the open Scope refetch the layout only (not the full projection), unless `hasRecentLocalLayoutWrite` is true. Use the new `getFieldLayoutOnly` for the refetch path. Cross-client viewport/position propagation falls out for free.

5. **Tests / proof**
   - Unit (server): `fields-store.test.ts` — write a layout sidecar with `field_id` equal to a Scope id (e.g. `default`, `scope_<uuid>`) and items keyed by `context:<id>`/`pulse:<id>`, read back via the new GET, assert no semantic file is created. Confirm that `deleteField` still cleans up sidecars by `field_id` prefix.
   - Unit (FloeWeb): `scope-projection.test.ts` — moving a projected node folds into layout, layout PUT is dispatched (mock), and the next projection load restores positions when layout returns from the bus. Pin invariant: no `putFieldSemantic` call ever occurs for the projection branch.
   - Playwright (`floe-web\tests\scope-projection.spec.ts` or a new `projection-layout-persistence.spec.ts`): drag a Context node, reload the page, assert the node returns to the dragged position. Assert no calls to `/v1/workspaces/*/fields/*` *other than* `.../layout/floeweb` (semantic PUT must stay absent). Assert React Flow drag/pan/zoom/selection still pass the existing assertions from `field-substrate.spec.ts`.
   - Live proof: real workspace, two clients, drag in one client → position appears in the other after the WS `field.upserted` round trip.

### B. Manual Pulse → Context connect/disconnect via Pulse subscriber list

1. **Server**: no API change. Use existing:
   - `POST /v1/pulses/:pulse_id/subscribe` with body `{ "kind": "context", "context_id": "<id>" }` (`server.ts:937-944`).
   - `POST /v1/pulses/:pulse_id/unsubscribe` (`server.ts:946-953`).
   - **Optional but recommended**: add a `pulse.subscriber.changed` (or reuse a Scope-scoped broadcast) so other clients refetch. Today neither subscribe endpoint broadcasts. If broadcast is added, it must be **side-effect only** for FloeWeb refresh, not a substrate semantics change. If broadcast is **not** added in this slice, FloeWeb relies on optimistic local refetch.

2. **FloeWeb client (thin pulse client)**
   - Add `floe-web\src\pulse-api.ts` exporting `subscribePulse(busUrl, pulseId, subscriber)` and `unsubscribePulse(busUrl, pulseId, subscriber)`. Stay symmetric with `fields-api.ts`.

3. **FloeWeb React Flow connect handler**
   - In `handleFieldConnect` (`main.tsx:1231-1259`), replace the `if (loadedProjectionRef.current) return;` early-return with a projection-aware branch:
     - Parse `connection.source` and `connection.target` with `parseFieldRef`.
     - If exactly one endpoint is `kind: "pulse"` and the other is `kind: "context"`, call `subscribePulse(busUrl, pulseId, { kind: "context", context_id })`.
     - On success, optimistically inject the subscriber relationship into `loadedProjectionRef.current.projection.relationships.pulse_subscribers` and re-set state so the new edge renders without waiting for the projection refetch. Then call `refreshOpenField` to reconcile.
     - On 404 or schema error, surface via `setError` and revert.
     - If the pair is anything else (context↔context, pulse↔pulse, endpoint↔anything), bail with a friendly `setError` (do not silently swallow). No Field-semantic write path is allowed.
   - In `handleFieldEdgesDelete` (`main.tsx:1277-1296`) replace the projection early-return with: for each removed edge whose id matches `^pulse-subscriber:(.+):context:(.+)$`, call `unsubscribePulse(busUrl, pulseId, { kind: "context", context_id })`. Optimistically remove from local relationships, then refetch.
   - In `handleFieldReconnect` (`main.tsx:1388-1414`), explicit decision: **disable reconnect for projection edges in this slice** (keep the `if (loadedProjectionRef.current) return;` guard there). Reconnect would require both an unsubscribe and a subscribe with atomicity considerations; do that in a separate slice. Document this with a code comment citing this brief.
   - Do **not** touch `handleFieldEdgeDoubleClick` (label editing). Pulse subscriber edges are derived; the "subscribes" label is static.
   - Keep `handleFieldBeforeDelete` (`main.tsx:1298-1386`) bail-out for nodes in projection — node deletion would mean primitive deletion, which is out of scope.

4. **UX invariants**
   - The drawn edge must look identical to the existing rendered Pulse-subscriber edge (id format, "subscribes" label) so the optimistic edge and the post-refresh edge are indistinguishable.
   - Activation contract: subscribing a Pulse to a Context is **render-only**. This must be reflected in the success affordance copy (no "agent will wake" framing). For an endpoint-side wake, the user must use the (future) Endpoint Subscriber UI, which is out of scope here.

5. **Tests / proof**
   - Unit (FloeWeb): in `scope-projection.test.ts`, validate that parsing a pulse↔context connection yields the correct subscribe body. In a new `main.connect.test.tsx` or by extending existing harness tests, assert that `handleFieldConnect` does not call `putFieldSemantic` and does call the Pulse subscribe API for projection branch.
   - Server (already covered by `pulse-subscribers.test.ts`): add a regression test that after `POST /subscribe { kind: "context", context_id }`, `buildScopeProjection` includes the new relationship without changing membership (no new Context, no new Pulse, no new Event).
   - Playwright: drag from a Pulse handle to a Context node within a Scope projection canvas → assert the new edge appears, the bus subscriber list contains the new record (via projection refetch), and **no `pulse.fired` event is delivered** at connect time (i.e. no actor activation). Conversely, delete the edge and confirm unsubscribe.
   - Live proof: in a real workspace, connect a scheduled or paused Pulse to an existing Context, wait for a fire, confirm a `pulse.fired` event is appended to the Context history (the same as a programmatically-created subscriber). Then delete the edge and confirm subsequent fires no longer append.

## Regression checklist

- React Flow native interactions intact: pan, zoom (`zoomOnScroll`, `minZoom`/`maxZoom`), `panOnDrag`, selection, drag, handles, MiniMap, Controls, Background, drop targets, `deleteKeyCode`. (Verify with `field-substrate.spec.ts` and the projection-layout spec.)
- Block Library drag/drop and toolbar shortcuts unaffected.
- Node icons / labels / handles unchanged; `FieldItemNode` not refactored beyond data plumbing for new edges.
- Context "Open" affordance still routes through `setSelectedContextId` + conversation sidebar.
- Scope Projection contract unchanged: refs and relationships still come from the bus; FloeWeb never derives membership.
- Field semantic API path remains untouched on the projection branch — assert no `putFieldSemantic` call from the projection canvas. (Pin with a test guard.)
- Pulse subscriber semantics: Context Subscriber still appends-only at fire (`server.ts:1003-1016`); Endpoint Subscriber still resolves to its stable delivery Context (`server.ts:1017-1041`). Neither path is altered by this slice.
- Default Scope auto-ensure and non-deletability remain. Scope APIs not modified.
- Layout writes never affect Scope membership: `loadAllFields` continues to ignore `.layout.` files; `buildScopeProjection` ignores layout sidecars; FloeWeb projection consumers never derive membership from layout.
- WebSocket echo-suppression continues to work (`hasRecentLocalLayoutWrite`).
- No `.floe/blocks` introduced; no new sidecar paths.
- Performance: drag/pan/zoom remain at React Flow native frame rate; layout PUT is debounced (already 300ms in `scheduleFieldLayoutSave`).

## Test plan

- **Keep**: `floe-bus\src\fields-store.test.ts`, `fields-server.test.ts`, `scope-projection.test.ts`, `scopes-server.test.ts`, `pulse-subscribers.test.ts`, `pulse-scope-propagation.test.ts`, `delivery-symmetry.test.ts`; `floe-web\src\fields.test.ts`, `scope-projection.test.ts`, `fields-api.test.ts`, `scope-projection-api.test.ts`; Playwright suites under `floe-web\tests\` (esp. `scope-projection.spec.ts`, `field-substrate.spec.ts`, `context-rendering.spec.ts`, `pulse-e2e.spec.ts`).
- **Add (A)**:
  - `fields-store.test.ts`: layout sidecar can be persisted and read when no semantic file exists; items keyed by `context:<id>` / `pulse:<id>` are accepted; `deleteField` removes sidecar even when semantic absent.
  - `fields-server.test.ts` (or new): new GET `…/layout/floeweb` returns 404 when missing and 200+layout when present, accepts `default` and `scope_<uuid>` as field_id, rejects non-`floeweb` renderer.
  - `floe-web\src\scope-projection.test.ts` (or new): projection drag triggers `putFieldLayout` with stable refs as keys; reload restores positions; no `putFieldSemantic` invoked.
  - Playwright: `projection-layout-persistence.spec.ts` covering drag → reload → position retained → React Flow interaction smoke.
- **Add (B)**:
  - `pulse-subscribers.test.ts`: connecting Pulse→Context via API leaves the Pulse subscriber list in the expected shape and is reflected in projection without changing membership.
  - `floe-web\src\scope-projection.test.ts` (or main test harness): pulse↔context connect dispatches `subscribePulse`; pulse-subscriber edge delete dispatches `unsubscribePulse`; non-(pulse,context) pairs are rejected with a user-visible error.
  - Playwright: connect/disconnect on a real bus + assert `pulse.fired` appends only after fire (and not at connect time), and no actor activation occurs.
- **Live proof bundle for the slice**: screenshots of dragged positions surviving reload across two clients; bus log showing a single `field.upserted changed=layout` per drag; bus log showing a single `subscribe` POST per connect and one `unsubscribe` POST per edge delete; a confirmed `pulse.fired` append on the target Context after the pulse fires.

## Risk assessment

- **Layout key collisions or schema drift**: `FieldLayoutSchema.items` currently lets any string key through. If a future change tightens the key shape to `ITEM_ID_PATTERN`, projection refs (which contain `:`) would break. Mitigation: add an explicit unit test pinning that `context:<id>` and `pulse:<id>` keys round-trip through the schema, so any tightening is caught.
- **`field_id` vs `scope_id` ambiguity**: reusing the field-layout endpoint for Scope-backed Fields conflates two namespaces in the URL. Mitigation: code comment in the new client function citing this brief and ADR-0004; live test that a Scope id and a legacy Field id never collide because Scope-backed Fields don't have semantic files and legacy semantic-backed Fields don't use projected refs as layout keys. Long-term, a dedicated `/v1/workspaces/:workspace_id/scopes/:scope_id/layout/floeweb` should supersede it (out of scope).
- **Echo storms**: layout PUT broadcasts `field.upserted` which would normally trigger refresh. `hasRecentLocalLayoutWrite` already exists but is only consulted in two places today. Mitigation: route the layout-only refetch path through the same window and add a unit test for the suppression behaviour.
- **Optimistic edge drift** (B): if `subscribePulse` succeeds but the projection refetch fails or is slow, the optimistic edge may diverge. Mitigation: include `subscriber.context_id` in the optimistic edge id and reconcile via projection on the next refresh; surface a non-blocking error if the API call fails.
- **Disabled reconnect**: leaving `handleFieldReconnect` disabled for projection edges means users see a degraded affordance compared to legacy Field semantic edges. Mitigation: explicit code comment and a follow-up issue. Worth surfacing to user.
- **No broadcast on subscribe**: other clients won't see the new edge until they refresh the projection. Mitigation: either add a `pulse.subscriber.changed` broadcast (recommended), or accept that the WS already broadcasts events created by `firePulse` so projections are eventually consistent. Decide in PRD.
- **Slice creep**: the set-aside items (2,3,4,5) will be tempting to "just fix while we're here". They require model decisions and must stay out of this slice.

## Decision confidence

- **A. Layout persistence for Scope Projection**: **HIGH**. All needed transport already exists; only a thin GET, two FloeWeb wiring changes (load on open, save on drag), and stream echo-suppression are required. The model conflict (Field-owned membership) is explicitly excluded by reusing only the layout sidecar and pinning the no-membership invariant in tests. Aligns 1:1 with issues #31 and #26.
- **B. Manual Pulse→Context connect via Pulse subscriber list**: **HIGH for connect/disconnect**, **medium-deferred for reconnect**. The bus API already exists, the rendered edge already exists, and the semantic interpretation (Context Subscriber, render-only) is already correct in `firePulse`. The only risk is UX expectation (users may believe connecting Pulse→Context wakes an actor — item 2 — which it must not). Reconnect deferred to a follow-up because it requires atomic unsubscribe+subscribe and adds little user value over delete+connect.
- **Set-aside items (2, 3, 4, 5)**: **NOT HIGH CONFIDENCE — set aside**.
  - Item 2 (Pulse wakes actor through Context): contradicts `CONTEXT.md` Context Subscriber definition. Requires either redirecting users to Endpoint Subscriber flow, or a substrate redesign. Needs PRD.
  - Item 3 (generated delivery Context visibility in actor UI): substrate already creates the Context; the issue is purely UX (sidebar/inbox treatment of system-generated Contexts). Needs UX design, not a fix.
  - Item 4 (Pulse configure/edit/delete): no `PATCH/DELETE /v1/pulses/:pulse_id` exists; no FloeWeb inspector exists; Pulse Persistence semantics around editing workspace-backed vs local-backed Pulses are undecided. Needs PRD.
  - Item 5 (Chats only in sidebar until placed in Field): conflicts with current Scope Projection model (`CONTEXT.md:21-27`, ADR-0004). Adding a "Field placement" concept would resurrect the Field-owned membership model that issue #28 explicitly buried. Needs explicit model decision before any implementation.

## Recommendation

Proceed with **A and B as a single vertical slice** (or two tightly coupled PRs in order A → B). Run the Architecture Integration Gate output through TDD (`fields-store.test.ts` and `scope-projection.test.ts` first, then Playwright, then product code). Defer items 2, 3, 4, 5 to discovery / PRD with the rationale captured above.
