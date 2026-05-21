# Architecture Integration Brief: issue-12-field-item-delete-confirmation

## Existing ownership

- Package/component/module/library:
  - `@xyflow/react` owns canvas selection, focus, keyboard deletion intent, `deleteKeyCode`, `onBeforeDelete`, `onEdgesDelete`, `onNodesDelete`, and `deleteElements` (`node_modules\@xyflow\react\dist\esm\types\component-props.d.ts:132-138,214-217,269-275`; `node_modules\@xyflow\react\dist\esm\index.mjs:1225-1234`).
  - `floe-web\src\fields.ts` owns Field semantic transforms and semantic edit rules, including `remove_item` cascade and `remove_connection` (`floe-web\src\fields.ts:100-106,263-348`).
  - `floe-web\src\main.tsx` owns FloeWeb React Flow wiring, selection state, confirmation prompts, semantic save orchestration, layout save orchestration, nested Field navigation, and the Inspector (`floe-web\src\main.tsx:944-961,1012-1159,1664-1679,1989-2017`).
  - `floe-web\src\fields-api.ts` owns bus HTTP persistence; FloeWeb must use `putFieldSemantic`, not direct file writes (`floe-web\src\fields-api.ts:185-202`).
  - `floe-bus\src\fields-store.ts` owns workspace `.floe\fields\*.yaml` validation and file I/O (`floe-bus\src\fields-store.ts:222-345`).
- Current owner rationale:
  - `CONTEXT.md` and ADR 0003 define Field semantic YAML as the source of truth; FloeWeb is only a renderer/editor (`CONTEXT.md:78-101`; `docs\adr\0003-field-substrate-primitive.md:15-21`).
  - React Flow already owns native delete intent. Rebuilding Delete/Backspace with document-level key handlers or toolbar-only actions would create a parallel canvas interaction path.
  - The semantic helper already has the exact cascade shape required by #12; duplicating cascade calculation for writes in `main.tsx` risks drift.
- Source evidence:
  - Issue #12 requires selected Field Item Delete/Backspace confirmation, cascade removal of touching Field Connections in one semantic update, no semantic write on cancel, and #9 edge deletion regression.
  - Parent #10 PRD comment narrows the scope to Field Item deletion and says referenced primitives must remain untouched.
  - `fieldToReactFlow` currently marks nodes `deletable: false` as the #9 guard (`floe-web\src\fields.ts:180-185`), and Playwright currently asserts selected Field Item nodes do not cascade-delete (`floe-web\tests\field-substrate.spec.ts:386-434`).

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace home shows Root Fields by default and can Show all Fields; nested Fields are normal sibling semantic files referenced by `field:<id>` Field Items (`CONTEXT.md:82-86`; `floe-web\src\main.tsx:399-425,1840-1874`).
  - Field Items render as React Flow custom nodes with target/source handles and visible labels (`floe-web\src\main.tsx:206-225`).
  - Existing Field Connections render as React Flow edges with edge-local label editing (`floe-web\src\main.tsx:227-305,658-681`).
  - Creating, deleting, and reconnecting Field Connections uses React Flow handlers and `buildSemanticUpdate` + `saveOpenFieldSemantic` (`floe-web\src\main.tsx:1070-1159`).
  - Node drag and viewport movement write only the layout sidecar (`floe-web\src\main.tsx:1012-1068`).
  - Block Library click/drag creates root or nested Fields without bypassing the Field API (`floe-web\src\main.tsx:1557-1634,1687-1719`).
  - Double-clicking a nested Field item opens the child Field with back-stack provenance (`floe-web\src\main.tsx:1721-1759`).
  - Inspector `Delete field` deletes the whole Field semantic file via the bus; this is different from deleting a Field Item reference (`floe-web\src\main.tsx:1664-1679,2054-2062`).
- Behaviors that must remain unchanged:
  - Selected-edge Backspace deletion from #9 must still delete only the selected Field Connection and preserve endpoint Field Items (`floe-web\tests\field-substrate.spec.ts:331-384`).
  - Block Library drag/drop, node handles, labels, selection, pan, zoom, drag, rename, nested open/back, root/show-all filtering, connection creation/label/delete/reconnect, and layout/semantic separation must remain unchanged.
  - Deleting a Field Item removes only the field-local item reference and touching connections; it must not delete the referenced Actor, child Field, Context, file, or other substrate primitive.
- Runtime or UX evidence:
  - Tests already cover rendering nodes/edges, viewport restore, Block Library drop, nested navigation, connection creation/label/delete/reconnect, whole-Field delete, and live bus/file-backed Field persistence (`floe-web\tests\field-substrate.spec.ts:46-81,83-177,195-488,519-615`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - React Flow `deleteKeyCode`, set explicitly to `["Delete", "Backspace"]` for #12 because React Flow defaults to `Backspace` only (`node_modules\@xyflow\react\dist\esm\types\component-props.d.ts:269-275`).
  - React Flow `onBeforeDelete` is the correct confirmation gate: it runs before `onEdgesDelete`/`onNodesDelete` and may abort deletion by returning `false` (`node_modules\@xyflow\react\dist\esm\types\component-props.d.ts:214-217`; `node_modules\@xyflow\react\dist\esm\index.mjs:1109-1133`).
  - React Flow's `getElementsToRemove` filters out nodes with `deletable === false` before `onBeforeDelete`, and auto-includes edges connected to matched nodes (`node_modules\@xyflow\system\dist\esm\index.mjs:496-532`). Therefore Field Item nodes must become React Flow-deletable for the selected-node intent to reach `onBeforeDelete`.
  - Use existing `fieldToReactFlow` node mapping for `id = item_id` and visible labels (`floe-web\src\fields.ts:165-205`).
  - Use existing `buildSemanticUpdate(prev, { type: "remove_item", item_id }, now)` for the semantic cascade (`floe-web\src\fields.ts:285-290`).
  - Use existing `saveOpenFieldSemantic` for semantic persistence and summary refresh (`floe-web\src\main.tsx:944-961`).
- Relevant docs or library capabilities:
  - `OnBeforeDelete` receives `{ nodes, edges }` and resolves to `boolean | { nodes, edges }`; `false` returns empty delete sets (`node_modules\@xyflow\system\dist\esm\types\general.d.ts:280-286`; `node_modules\@xyflow\system\dist\esm\index.mjs:525-532`).
  - React Flow calls `onEdgesDelete` and applies remove changes only after `getElementsToRemove` returns non-empty sets (`node_modules\@xyflow\react\dist\esm\index.mjs:1118-1128`).
- Existing examples in this codebase:
  - `handleFieldEdgesDelete` already treats React Flow edge deletion as intent, then writes a semantic `remove_connection` update (`floe-web\src\main.tsx:1114-1132`).
  - `applyNodeChangesToLayout` ignores select/remove changes, so deletion must be semantic-driven, not layout-driven (`floe-web\src\fields.ts:230-260`; `floe-web\src\fields.test.ts:273-280`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not add document-level `keydown` listeners, toolbar-only delete buttons, or Inspector-only Field Item delete flows as the primary path.
  - Do not bypass React Flow selection/focus/delete intent.
  - Do not bypass `buildSemanticUpdate` for cascade semantics.
  - Do not bypass `putFieldSemantic` / bus persistence or write `.floe\fields\*.yaml` directly from FloeWeb.
  - Do not call whole-Field `deleteFieldApi` for Field Item deletion.
- Shortcuts or parallel paths to avoid:
  - Do not let React Flow locally remove a node and then try to reconcile later.
  - Do not use `onNodesDelete` as the first confirmation point; it fires after `onBeforeDelete` has already allowed deletion.
  - Do not delete `field:<child-id>` semantic files, Actor endpoints, or any referenced primitive. Child issue #13 will deepen proof, but #12 must preserve this invariant.
  - Do not update the layout sidecar as part of the semantic deletion cascade.
  - Do not change Field YAML schema, item refs, connection shape, layout schema, root/nested derivation, or navigation model.
- Invariants:
  - Field Item ids are field-local `item_id` values; Field Connections point to item ids, not refs (`CONTEXT.md:88-95`).
  - Confirmed deletion is one semantic Field update that removes the item and every connection whose `from` or `to` equals the deleted `item_id`.
  - Cancelling confirmation leaves semantic state, canvas state, and persisted YAML unchanged.
  - Performance regressions in pan/zoom/drag/navigation are blockers.

## Integration plan

- Insert the change at:
  - In `floe-web\src\fields.ts`, remove `deletable: false` from Field Item nodes or set it to true so React Flow selected-node deletion reaches `onBeforeDelete`.
  - In `floe-web\src\main.tsx`, add a memoized `handleFieldBeforeDelete` near `handleFieldEdgesDelete`/`handleFieldReconnect`.
  - Pass `onBeforeDelete={handleFieldBeforeDelete}` and `deleteKeyCode={["Delete", "Backspace"]}` to the existing Field `<ReactFlow>`.
  - Keep `onEdgesDelete={handleFieldEdgesDelete}` unchanged for edge-only deletion.
- Why this is the correct integration point:
  - `onBeforeDelete` is the React Flow-native pre-delete interception point. It can show confirmation before any React Flow local removal or semantic write.
  - Returning `false` after handling confirmed node deletion prevents React Flow from also firing `onEdgesDelete` for the connected edges, avoiding duplicate semantic writes.
  - Edge-only deletion can return `true` so #9 behavior continues through `handleFieldEdgesDelete` unchanged.
- Recommended `handleFieldBeforeDelete` behavior:
  - If `nodes.length === 0`, return `true` so selected-edge deletion remains intact.
  - If `nodes.length !== 1`, return `false` and surface a non-destructive message; multi-node deletion is outside #12's singular Field Item scope.
  - Resolve the selected Field Item from `loadedFieldRef.current.semantic.items` by `node.id`.
  - Compute cascade count from `semantic.connections.filter(c => c.from === item_id || c.to === item_id).length` for confirmation copy only.
  - Build the display label from existing node data label, then item ref, then item id as stable fallback.
  - `window.confirm`: include the Field Item label/id and exact count of Field Connections that will be removed.
  - On cancel, return `false` before calling `saveOpenFieldSemantic`.
  - On confirm, call `buildSemanticUpdate(current.semantic, { type: "remove_item", item_id }, now)`, then `await saveOpenFieldSemantic(next)`; return `false` either way so React Flow waits for controlled state refreshed from persisted semantic data.
  - Clear connection label/editing state if the deleted item touches the selected/editing connection.
- Alternatives considered and rejected:
  - Keep nodes `deletable: false` and listen for keyboard events manually: rejected because React Flow filters non-deletable nodes before `onBeforeDelete`, and manual key handling bypasses native canvas behavior.
  - Use `onNodesDelete` to persist deletion: rejected because confirmation must happen before any delete and because connected edges would also route through `onEdgesDelete`.
  - Return modified `{ nodes, edges }` from `onBeforeDelete`: rejected for #12 because it allows React Flow local remove callbacks; returning `false` after semantic save is safer in a controlled, substrate-backed renderer.

## Regression checklist

- Behavior: selected Field Item Delete and Backspace open confirmation before any semantic PUT.
- Behavior: confirmation names the item using visible label with stable fallback and states the exact touching-connection count.
- Behavior: cancel writes no semantic PUT, writes no layout PUT, and leaves node/edge counts unchanged.
- Behavior: confirm writes one semantic PUT that removes the item and all touching connections, preserves unrelated items/connections, and writes no layout PUT.
- Behavior: deleting a nested `field:<child-id>` item does not delete `.floe\fields\<child-id>.yaml` and does not use the whole-Field delete endpoint.
- Behavior: selected-edge Backspace deletion still removes only the edge and preserves endpoint items.
- Behavior: Block Library drag/drop, add actor item, add field item, rename Field, nested open/back, root/show-all filtering, connection create/label/reconnect, viewport restore, node drag, pan, zoom, Controls, and MiniMap remain unchanged.
- Behavior: Field summaries and inspector item/connection counts refresh after confirmed deletion.

## Test plan

- Existing tests to keep green:
  - `floe-web\src\fields.test.ts` semantic helper and transform tests.
  - `floe-web\tests\field-substrate.spec.ts` tests for node/edge rendering, viewport restore, Block Library drag/drop, nested navigation, connection create/label/delete/reconnect, Field creation/deletion, live bus/file-backed persistence.
  - `floe-bus\src\fields-store.test.ts` and server tests for semantic validation, parent counts, and file persistence.
- New tests to add before/with implementation:
  - `fields.test.ts`: strengthen `remove_item` cascade to assert unrelated items and unrelated connections are preserved and no remaining connection points at the removed `item_id`; keep `remove_connection` idempotency test.
  - Playwright: selected node + Backspace opens confirmation; cancelling causes no semantic PUT, no layout PUT, nodes/edges remain, reload preserves them.
  - Playwright: selected node + Delete confirms deletion; exactly one semantic PUT removes the item and every touching connection, preserves unrelated item/connection, no layout PUT, canvas and inspector counts refresh, reload persists.
  - Playwright: confirmation copy includes visible label/fallback and count of touching connections.
  - Playwright regression: selected-edge Backspace still deletes only that Field Connection and preserves both endpoint items.
  - Replace or invert the existing guard test `selected Field Item nodes do not cascade-delete connections`; after #12 it should prove no silent deletion without confirmation, not permanent non-deletability.
- Live proof required:
  - For #12: run a real bus/file-backed Playwright/manual path with a Field containing at least three items and mixed touching/untouched connections; cancel once and inspect unchanged YAML; confirm once and inspect `.floe\fields\<field-id>.yaml` for item removal plus cascaded connections; verify no `.layout.floeweb.yaml` write occurred and selected-edge deletion still works.
  - For #12: include a nested Field Item case and verify the child Field YAML file remains present after deleting the parent Field Item reference.
  - Deferred to #13: broader referenced primitive preservation across all primitive kinds with live bus/file-backed QA and actor/file tooling proof.

## Risk assessment

- Risk: current `fieldToReactFlow` sets `deletable: false`, so `onBeforeDelete` will receive no selected nodes until that guard is relaxed.
- Risk: returning `true` for node deletion would cause React Flow to fire `onEdgesDelete` for auto-included connected edges, creating duplicate or split semantic writes.
- Risk: async confirmation/save inside `onBeforeDelete` can feel delayed; keep the handler small, avoid layout work, and return `false` after semantic save so controlled state refresh remains authoritative.
- Risk: counting connections in UI code could drift from helper cascade if future cascade rules change.
- Risk: deleting a `field:<child-id>` item could be mistaken for deleting the child Field primitive.
- Mitigation:
  - Use UI-side connection count only for confirmation text; use `buildSemanticUpdate(...remove_item...)` for the actual mutation.
  - Add tests for no layout PUT, single semantic PUT, edge-delete regression, and child Field file preservation.
  - Do not introduce new APIs or schema; keep all writes through existing bus semantic PUT.

## Decision confidence

- Confidence: high
- Reasons:
  - React Flow exposes the exact pre-delete hook needed (`onBeforeDelete`) and can abort deletion.
  - The existing semantic helper already implements item deletion cascade.
  - Existing #9 implementation already established the React Flow-native edge deletion path to preserve.
  - The change can be inserted surgically in `fieldToReactFlow` and the existing Field `<ReactFlow>` wiring.
- Open questions:
  - Whether multi-node deletion should be supported now. Recommendation: reject/abort multi-node deletion in #12 and keep the slice singular unless product explicitly broadens it.
  - Whether confirmation should be `window.confirm` or a custom modal. Recommendation: use existing `window.confirm` pattern for parity with current destructive actions, unless a design-system modal already exists before implementation.
