# Architecture Integration Brief: issue-9-field-connections

## Existing ownership

- Package/component/module/library:
  - `@xyflow/react` owns canvas gestures, handles, edges, selection, keyboard deletion, labels, and reconnection.
  - `floe-web\src\fields.ts` owns Field semantic to React Flow transforms and semantic operations.
  - `floe-web\src\fields-api.ts` owns bus HTTP/WS Field persistence.
  - `floe-web\src\main.tsx` owns FloeWeb Field UI wiring only.
- Current owner rationale:
  - Field YAML is source of truth; FloeWeb is a renderer/editor, not substrate storage.
  - React Flow already owns edge creation interaction primitives; duplicating them created the rejected bad path.
- Source evidence:
  - `CONTEXT.md`, `docs\adr\0003-field-substrate-primitive.md`
  - `floe-web\src\fields.ts` maps semantic Fields to React Flow nodes/edges and validates semantic connection ops.
  - `floe-web\src\fields-api.ts` persists semantic/layout updates through the bus.
  - `floe-web\src\main.tsx` wires the open Field surface to React Flow.

## Existing interaction model

- User/system behaviors that already exist:
  - Field Items render as React Flow custom nodes with target/source handles.
  - Existing semantic connections render as React Flow edges.
  - Node drag updates layout sidecar only.
  - Viewport is uncontrolled during pan/zoom and restored from persisted layout on open.
  - Block Library Field drag/drop into an open Field creates a nested Field item.
  - Double-clicking a nested Field node opens that Field.
- Behaviors that must remain unchanged:
  - Block Library drag/drop.
  - Handles, labels, selection, pan, zoom, drag, rename/open.
  - Semantic writes through `putFieldSemantic`; layout writes through `putFieldLayout`.
  - No direct `.floe\` access from FloeWeb.
- Runtime or UX evidence:
  - `floe-web\src\main.tsx` `FieldItemNode` renders handles around Field item labels.
  - `floe-web\tests\field-substrate.spec.ts` covers viewport restore, Block Library drag/drop, and nested Field double-click open.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - React Flow `onConnect`, connection validation, edge `label`, edge selection/focus, `onEdgesChange`, `onEdgesDelete`, `onReconnect`, `onBeforeDelete`, and `deleteKeyCode`.
  - Existing `buildSemanticUpdate({ type: "add_connection" | "remove_connection" })`.
  - Existing `saveOpenFieldSemantic`.
  - Existing `fieldToReactFlow` edge mapping.
- Relevant docs or library capabilities:
  - React Flow `onConnect` fires when a connection line completes.
  - React Flow edges support `source`, `target`, `label`, reconnectability, focus, and selection.
  - Keyboard deletion defaults to Backspace for selected edges/nodes.
  - Reconnection should use React Flow's reconnect hooks rather than custom delete-and-recreate controls.
  - `EdgeLabelRenderer` is available for richer edge-local label editing if simple edge labels are insufficient.
- Existing examples in this codebase:
  - `fieldToReactFlow` maps `FieldConnection.from`, `to`, and optional `label` to React Flow edges.
  - `buildSemanticUpdate` rejects unknown connection item ids and duplicate connection ids.
  - `fields.test.ts` covers connection helper behavior.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not replace React Flow edge gestures with custom canvas or toolbar connection flows.
  - Do not bypass `fields.ts` semantic helper validation.
  - Do not bypass `fields-api.ts` bus persistence.
- Shortcuts or parallel paths to avoid:
  - Rejected custom inline confirmation row below the toolbar.
  - Local-only React state edges not persisted to semantic YAML.
  - Direct file writes from FloeWeb.
  - Relationship picker, ontology, or typed labels.
- Invariants:
  - Connections persist `from` and `to` as Field Item `item_id`, never item refs.
  - Label is optional free-form text only.
  - Layout sidecar is unchanged by semantic connection creation.
  - Performance regressions in pan, zoom, or drag are blockers.
  - Current Field nodes render labels and handles; do not worsen this. Icon restoration is separate unless explicitly scoped.

## Integration plan

- Insert the change at:
  - Import React Flow connection/edge types in `floe-web\src\main.tsx`.
  - Add memoized handlers beside existing node/layout handlers:
    - `handleFieldConnect`
    - optional `isValidFieldConnection`
    - `handleFieldEdgesDelete`
    - `handleFieldReconnect`
  - Pass handlers to `<ReactFlow>`.
  - Use `buildSemanticUpdate` and `saveOpenFieldSemantic`.
  - Keep edge label rendering in `fieldToReactFlow`; add label editing through a React Flow-native edge label or selected-edge path, not a toolbar row.
- Why this is the correct integration point:
  - React Flow already owns handles, connections, edge selection, keyboard, reconnection, and labels.
  - `fields.ts` already owns semantic validation.
  - `saveOpenFieldSemantic` already owns successful semantic save and local refresh.
- Alternatives considered and rejected:
  - Custom confirmation row: rejected by user and duplicates React Flow-native edge UX.
  - New API endpoint: unnecessary; semantic PUT already exists.
  - Local-only edge state: violates substrate source of truth.
  - Relationship picker: violates minimal Field Connection model.

## Regression checklist

- Behavior: existing seeded connections still render as `.react-flow__edge`.
- Behavior: Block Library Field drag/drop into open canvas still creates a nested Field at the drop position.
- Behavior: selected-edge deletion removes the semantic connection without deleting items or touching layout.
- Behavior: reconnecting an edge updates semantic `from`/`to` item ids without creating duplicate edges.
- Behavior: pan, zoom, drag, and viewport restore remain smooth and persist only layout sidecar state.

## Test plan

- Existing tests to keep green:
  - `floe-web\src\fields.test.ts`
  - `floe-web\tests\field-substrate.spec.ts`
  - Especially viewport, drag/drop, double-click, rename, add item, and layout sidecar tests.
- New tests to add before/with implementation:
  - Pure helper/id generation test if connection id generation is extracted.
  - Playwright: drag source handle to target handle saves an unlabeled connection.
  - Playwright: labeled connection persists the label and reload renders the edge label.
  - Assert `from`/`to` are item ids, not refs.
  - Assert layout sidecar is unchanged.
  - Playwright: selecting an edge plus Backspace removes the semantic connection and reload keeps it removed.
  - Playwright: reconnecting an edge updates `from`/`to` and reload keeps the new endpoints.
- Live proof required:
  - Real bus/file-backed Field with two items.
  - Create a connection via handles.
  - Delete a selected connection using native keyboard deletion.
  - Reconnect a connection using React Flow reconnection.
  - Inspect `.floe\fields\<id>.yaml`.
  - Reload FloeWeb and verify the edge/label/deleted/reconnected states remain.

## Risk assessment

- Risk: controlled `nodes`/`edges` plus React Flow deletion/reconnection may emit UI changes before semantic save.
- Risk: reintroducing custom label UX around the toolbar recreates the rejected path.
- Risk: issue #9 now overlaps the previously planned issue #10 deletion scope; after #9 is complete, issue #10 should be re-triaged to avoid duplicate delete-connection work.
- Mitigation:
  - Treat React Flow events as intent; persist semantic update, then re-render from loaded Field.
  - Use React Flow edge labels, selection, keyboard, and reconnection primitives first; use custom UI only as edge-local label editing if justified.
  - Keep delete/reconnect scoped to Field Connections only; do not implement Field Item deletion in this slice.

## Decision confidence

- Confidence: high
- Reasons:
  - Current code already maps semantic connections to React Flow edges.
  - React Flow directly supports the missing interaction primitives.
  - Existing helper validation already covers core semantic invariants.
- Scope decision:
  - User chose to include Field Connection delete and reconnect in issue #9.
  - Field Item deletion remains out of scope and should stay with issue #10 or a re-triaged successor.
- Label UX decision:
  - User rejected toolbar label controls and directed that connection work use React Flow events and tooling.
  - Use an edge-local `EdgeLabelRenderer` label editor for selected/new edges; do not add toolbar or inspector label controls.
