# Architecture Integration Brief: issue-17-field-item-and-nested-field-deletion-safety

## Scope boundary (issue #17 vs #18)

- In scope for issue #17:
  - Migrate the Field Item deletion confirmation (the React Flow
    `onBeforeDelete` flow in `handleFieldBeforeDelete`) from `window.confirm`
    to the global dialog module.
  - Optional cleanup of a referenced Nested Field when removing a Nested Field
    Item leaves the referenced Field unused. This cleanup is offered as a
    checkbox inside the Field Item deletion dialog and, if opted in, calls the
    existing `deleteField` bus API directly after the parent semantic PUT
    resolves. It does NOT route through, render, or modify the Inspector
    whole-Field delete UI.
- Explicitly out of scope for issue #17 (belongs to issue #18 — "Slice 4:
  Referenced whole-Field delete warning and no-native-popup closeout", which is
  blocked by #17):
  - `deleteOpenField` in floe-web/src/main.tsx:1781–1796 and its
    `window.confirm` call. This is the Inspector's whole-Field deletion path
    (delete the entire open Field from Workspace Home / Inspector). It remains
    a known residual `window.confirm` in FloeWeb after #17 lands and will be
    migrated to the global dialog (with the referenced-field warning) in #18.
  - Any "this Field is referenced by N other Fields" warning surface on the
    whole-Field delete path.
- Why the split is safe:
  - The two paths share no UI code. `handleFieldBeforeDelete` operates on a
    selected canvas node inside an open Field; `deleteOpenField` operates on
    the Field itself from the Inspector. Migrating one does not change the
    other. The optional cleanup in #17 reuses the bus-level `deleteField` API
    only — not the Inspector dialog — so #18 remains free to define the
    Inspector dialog's copy, variant, warning, and checkbox semantics
    independently.

## Existing ownership

- Package/component/module/library:
  - FloeWeb Field canvas owns Field Item deletion through React Flow's
    `onBeforeDelete` callback wired in `floe-web/src/main.tsx`:
    - `handleFieldBeforeDelete` (floe-web/src/main.tsx:1152–1208) currently calls
      `window.confirm(...)` (line 1179), applies `buildSemanticUpdate({type:"remove_item"})`,
      and persists via `saveOpenFieldSemantic`.
    - Wired on `<ReactFlow ... onBeforeDelete={handleFieldBeforeDelete} ...>` at
      floe-web/src/main.tsx:2122.
  - Global dialog primitive owns user-facing confirmation/prompt/checkbox flows:
    `floe-web/src/dialog/dialog.tsx` exports `confirm`, `confirmWithOptions`,
    `prompt`, and `DialogHost`. Controller in `dialog-controller.ts`.
  - Bus-backed semantic + sidecar deletion owns the file-level cleanup of a Field:
    `fields-store.deleteField` (floe-bus/src/fields-store.ts:383–403) deletes
    `<fieldId>.yaml` and every matching `<fieldId>.layout.*.yaml` sidecar; exposed via
    `DELETE /v1/workspaces/:wsId/fields/:fieldId` and called from the web through
    `deleteField` in `floe-web/src/fields-api.ts:221–229`.
  - Field usage / reference counts are derived in the bus:
    `parent_count` is computed per-Field from refs in `listFields`
    (floe-bus/src/fields-store.ts:263–286). FloeWeb already keeps these in
    `fieldSummaries` state (floe-web/src/main.tsx:340, refreshed by `refreshFields`
    at ~line 924).
- Current owner rationale:
  - The Field canvas funnels every keyboard/Backspace/programmatic delete through
    React Flow's `onBeforeDelete` (issue #12/#13 invariants). The dialog module
    (issues #15/#16) is the single approved confirmation/prompt surface in FloeWeb.
  - Whole-Field deletion is already a bus capability with cascade to renderer
    sidecars; no FloeWeb file I/O exists.
- Source evidence:
  - floe-web/src/main.tsx:81 imports `DialogHost, confirm as confirmDialog,
    confirmWithOptions, prompt as promptDialog`.
  - floe-web/src/main.tsx:1152–1208 (`handleFieldBeforeDelete`), 1781–1796
    (`deleteOpenField` — separate Inspector whole-Field UI path that also
    still uses `window.confirm`; out of scope for #17, migrated by #18), 2122
    (React Flow wiring).
  - floe-bus/src/fields-store.ts:263–286, 383–403.
  - floe-web/src/fields-api.ts:221–229 (`deleteField`).

## Existing interaction model

- User/system behaviors that already exist:
  - Selecting a Field Item node and pressing Delete/Backspace routes through
    React Flow → `onBeforeDelete` → `handleFieldBeforeDelete`. Returning `false`
    aborts the visual node removal so React Flow does not desynchronise from the
    semantic source (proved in field-substrate.spec.ts:431–524, lines 486–493
    assert no semantic/layout writes on cancel).
  - On confirm, a single `remove_item` op is applied and saved through
    `saveOpenFieldSemantic`; touching connections are dropped inside
    `buildSemanticUpdate` (floe-web/src/fields.ts:285–291). The DOM diff updates
    on the next semantic refresh — no parallel local removal.
  - Referenced primitives are preserved: the current Nested Field test
    (field-substrate.spec.ts:526–568, lines 565) asserts `fieldDeleteRequests`
    stays empty when a Nested Field Item is removed.
  - The dialog module already supports: title, body (ReactNode), variant,
    optional `checkbox`, optional `input`, `onConfirm` async with inline error,
    focus trap, Escape/backdrop cancel, focus restore. Workspace delete uses
    `confirmWithOptions` with a checkbox (main.tsx:1383–1402); Field create uses
    `promptDialog` with `input` (main.tsx:1798–1809, 1658–1674).
- Behaviors that must remain unchanged:
  - React Flow-native delete flow (Delete/Backspace, programmatic selection
    delete). No parallel "custom delete button" path on the canvas.
  - Block Library drag/drop, node icons/labels/handles/selection, pan/zoom/drag,
    rename/open, connection affordances, edge reconnect, edge label edit.
  - Cancel writes nothing — no semantic PUT, no layout PUT.
  - Touching connections cascade only as part of `remove_item`.
  - Non-Field referenced primitives (actor/context/file/...) stay untouched.
  - Whole-Field `DELETE` semantics (sidecar cleanup) remain the single bus path.
- Runtime or UX evidence:
  - field-substrate.spec.ts:431–524 (Field Item delete cancel/confirm).
  - field-substrate.spec.ts:526–568 (Nested Field Item preserves referenced
    child Field).
  - field-substrate.spec.ts:685–700, 1138–1234 (whole-Field delete cascades
    sidecars on disk through bus).
  - field-substrate.spec.ts:127–222 (nested Field create, dialog-based prompt).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - `confirmWithOptions(request)` from `./dialog/dialog` for the Field Item delete
    confirmation. It already returns `{ confirmed, checked }` and supports an
    optional checkbox row — exactly the "opt-in to also delete the referenced
    Field" pattern. It also supports `onConfirm` for async work with inline
    error and disabled state, removing any risk of double-submit.
  - `buildSemanticUpdate(prev, {type:"remove_item", item_id}, now)`
    (floe-web/src/fields.ts:285–291) for the reference-removal semantic op,
    which already cascades touching connections.
  - `saveOpenFieldSemantic` (existing helper used by every Field Item/connection
    edit) for the parent-Field semantic PUT.
  - `deleteField` from `./fields-api` for the optional whole-Field cleanup —
    same path used by `deleteOpenField` and bus-backed Playwright tests, so
    sidecar cleanup is already proven.
  - `fieldSummaries` state + `FieldSummary.parent_count` (already computed by
    the bus in `listFields`) for usage detection. `isRootFieldSummary` in
    fields.ts:161–163 demonstrates the existing convention.
  - For the same-parent duplicate-reference edge case (parent_count === 1 and the
    only parent is the open Field), use `loadedFieldRef.current.semantic.items`
    to count other items whose `ref === "field:<childId>"`. No new bus endpoint
    needed (PRD #14: "Do not introduce a new bus endpoint unless the
    architecture gate proves existing APIs are insufficient.").
  - `parseFieldRef(item.ref).kind === "field"` (fields.ts:115–126) to detect
    Nested Field Items inside the delete handler.
- Relevant docs or library capabilities:
  - React Flow `onBeforeDelete` (already used) is the only supported way to
    intercept Delete/Backspace deletions without forking React Flow internals.
    Returning a promise that resolves to `false` aborts; returning `true` lets
    React Flow proceed. The current handler intentionally always returns
    `false` and drives removal via the semantic round-trip — keep that pattern.
- Existing examples in this codebase:
  - Workspace delete with checkbox + async onConfirm: main.tsx:1379–1402.
  - Conversation delete with danger variant: main.tsx:1529–1538.
  - Field create / nested Field create using `promptDialog`: main.tsx:1798–1809,
    1658–1674.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass React Flow's `onBeforeDelete`. No parallel "delete button on
    the node" or custom keydown listener on the canvas wrapper. Both Delete and
    Backspace must continue to route through `handleFieldBeforeDelete`
    (`deleteKeyCode={["Delete","Backspace"]}` at main.tsx:2132).
  - Do not call `window.confirm` / `window.prompt` / `window.alert` in the
    Field Item deletion flows added/changed by this slice. PRD #14 decision 25
    + issue #17 AC forbid native popups here. (The Inspector whole-Field
    `deleteOpenField` still uses `window.confirm` until issue #18 closes it
    out — that is intentional scope, not a regression.)
  - Do not build a second dialog module. Reuse `confirmWithOptions` /
    `confirmDialog` / `promptDialog`.
  - Do not invent a new `remove_item_and_delete_field` semantic op or a new bus
    endpoint. The two operations are: (a) parent-Field semantic PUT via the
    existing `remove_item` op, (b) `DELETE /v1/workspaces/:wsId/fields/:childId`
    via the existing `deleteField` API.
  - Do not perform recursive Field deletion. Optional cleanup deletes only the
    one referenced Field semantic + its renderer sidecars. Any Fields referenced
    by the deleted Field remain on disk and naturally become Root Fields once
    their last parent reference is gone (parent_count derivation already
    handles this).
  - Do not touch non-Field referenced primitives (actor/context/file/...).
    Reference removal is the only effect for them.
  - Do not write layout sidecars on cancel or as part of reference removal
    (existing assertion at field-substrate.spec.ts:490–491, 517).
  - Do not introduce client-side file I/O. All persistence stays bus-backed.
- Shortcuts or parallel paths to avoid:
  - Adding a custom right-click menu "Delete and clean up" that bypasses the
    dialog. The dialog checkbox is the single opt-in surface.
  - Pre-computing usage from a stale `fieldSummaries` snapshot when the same
    parent has duplicate references. Always also inspect `loadedField.semantic`.
  - Awaiting the child `DELETE` before resolving the dialog without showing
    loading state — use `onConfirm` so the dialog's existing `loading`/inline
    error path handles failures.
- Invariants (FloeWeb Field/canvas):
  - React Flow-native delete flow only; no separate canvas delete path.
  - Block Library drag/drop, node icons/labels/handles/selection, pan/zoom/drag,
    rename/open, connection affordances preserved.
  - No performance regression on canvas interaction; the new delete handler must
    not add per-frame work — it only runs on a delete intent.
  - Cancel writes nothing (semantic + layout).
  - Sidecar cleanup goes through `deleteField` bus API (no FloeWeb file writes).

## Integration plan

- Insert the change at:
  - `floe-web/src/main.tsx` `handleFieldBeforeDelete` (lines 1152–1208). Replace
    the `window.confirm` block with a `confirmWithOptions` call. Decide which of
    three dialog shapes to render based on the selected item:
    1. Non-Field Item (or Field Item whose `ref.kind !== "field"`): existing
       default copy — "Removes this item and N Field Connection(s); referenced
       substrate primitives are preserved." Confirm/Cancel only.
    2. Nested Field Item, referenced Field is still used elsewhere
       (`stillUsedElsewhere === true`): warning body explains only the current
       reference will be removed and the referenced Field remains because it is
       referenced elsewhere. No checkbox.
    3. Nested Field Item, removing this reference leaves the referenced Field
       unused (`stillUsedElsewhere === false`): `confirmWithOptions` with a
       checkbox "Also delete the Field '<title>' from this workspace
       (<fieldId>.yaml and renderer sidecars). Fields it references will be
       preserved." Default unchecked.
  - On `{confirmed: true, checked}`:
    - Always: apply `remove_item` op via `buildSemanticUpdate` and persist via
      `saveOpenFieldSemantic`, then update selection state (existing logic).
    - If `checked` (case 3 only): after the parent-Field PUT resolves, call
      `deleteField(busUrl, workspaceId, childFieldId)`. The websocket
      `field.deleted` event will refresh `fieldSummaries`; no manual cleanup of
      `autoInitializedLayoutRef` is needed beyond what the existing event handler
      at main.tsx:1252–1257 already does.
  - On cancel: return `false` (current behavior); no state writes.
  - Return value to React Flow remains `false` in all branches (current
    invariant — semantic-driven removal, not React Flow-driven).
- Usage detection helper (kept inside the handler or as a small pure helper
  next to `isRootFieldSummary` in fields.ts):
  - `stillUsedElsewhere(childFieldId, currentParentSemantic, removedItemId,
    fieldSummaries)`:
    - Let `summary = fieldSummaries.find(f => f.id === childFieldId)`.
    - If `summary` missing → treat as `false` (be conservative: offer cleanup,
      but only acts on the user's opt-in).
    - If `summary.parent_count > 1` → `true`.
    - Else (parent_count ≤ 1): inspect `currentParentSemantic.items` for any
      item with `ref === "field:<childFieldId>"` and `item_id !== removedItemId`.
      If found → `true`; else `false`.
  - This uses only in-memory data already loaded for the open Field; no extra
    bus round-trip and no new endpoint.
- Out of scope: `deleteOpenField` (main.tsx:1781–1796) still uses
  `window.confirm`. Do NOT migrate it as part of issue #17. That migration is
  the explicit subject of issue #18 ("Slice 4: Referenced whole-Field delete
  warning and no-native-popup closeout") which is blocked by #17. After #17
  lands, the only remaining `window.confirm` in FloeWeb is this Inspector
  whole-Field delete path, and #18 will close it out together with the
  "referenced by N other Fields" warning. Issue #17's "no native popup"
  assertion is scoped to the Field Item deletion flows it introduces.
- Why this is the correct integration point:
  - All existing canvas-delete entry points already converge on
    `handleFieldBeforeDelete`. Centralising the dialog there guarantees one
    delete UX for Delete, Backspace, and any future programmatic selection
    delete that React Flow surfaces via `onBeforeDelete`.
  - Usage data, current Field semantic, and the bus API client are all already
    in scope where the handler runs.
- Alternatives considered and rejected:
  - Adding a new bus endpoint that returns "fields that reference this Field" —
    rejected: `parent_count` + in-memory parent semantic is sufficient and PRD
    forbids unjustified new endpoints.
  - Performing the optional cleanup inside a single bus call (composite
    semantic+delete) — rejected: no such endpoint exists, and combining them
    would invent a new semantic op; the two-step flow is already proved by
    existing tests.
  - Replacing `onBeforeDelete` with a custom keydown handler to drive the
    dialog — rejected: bypasses React Flow's delete pipeline (invariant
    violation) and would break programmatic selection deletes.

## Regression checklist

- Field Item delete cancel writes no semantic and no layout (existing test
  field-substrate.spec.ts:486–491; must continue to pass with dialog cancel).
- Field Item delete confirm cascades touching connections via one semantic PUT
  (field-substrate.spec.ts:495–516).
- Nested Field Item delete with referenced Field preserved when the user does
  NOT opt in (field-substrate.spec.ts:526–568 — `fieldDeleteRequests` stays
  empty; equivalent must hold under the new dialog when checkbox unchecked).
- Whole-Field delete via Workspace Home still issues `DELETE` and removes
  semantic + every renderer sidecar (field-substrate.spec.ts:685–700,
  1138–1234).
- Bus-backed end-to-end test where a nested Field Item is removed and the
  referenced child Field remains on disk (field-substrate.spec.ts:960+).
- React Flow keyboard delete (Delete and Backspace) still triggers the dialog.
- Block Library drag/drop, node icons/labels/handles/selection, pan/zoom/drag,
  rename, open (double-click), connection create/reconnect/label edit unchanged.
- No native browser popup invoked from the Field Item deletion flows after
  this change. (Add a Playwright assertion that `page.on('dialog', ...)` does
  not fire when deleting Field Items via Delete/Backspace.) The Inspector's
  whole-Field `deleteOpenField` path still uses `window.confirm` after #17 and
  is closed out by issue #18 — assertions on that path remain unchanged here.
- `field.deleted` websocket event still resets `autoInitializedLayoutRef` and
  view state (main.tsx:1252–1257).
- Non-Field referenced primitives (actor/context/file) untouched by reference
  removal in all dialog branches.

## Test plan

- Existing tests to keep green:
  - floe-web/tests/field-substrate.spec.ts: 431–524 (cancel/confirm Field Item
    delete), 526–568 (nested Field Item preserves child), 685–700, 718+,
    864+, 960+, 1138+ (bus-backed Field delete + sidecars).
  - floe-web/src/fields.test.ts (semantic op behavior, including
    `remove_item` cascading connections).
  - floe-web/src/fields-api.test.ts (`deleteField` request shape).
  - floe-bus/src/fields-store.test.ts and fields-server.test.ts
    (`parent_count`, `deleteField`, sidecar cleanup).
- New tests to add before/with implementation:
  - Component/unit (vitest) for a new pure helper `nestedFieldStillUsedElsewhere`
    placed near `isRootFieldSummary` in fields.ts. Cases:
    - parent_count = 0 → false.
    - parent_count = 2 → true.
    - parent_count = 1, same parent has another item with same `field:<id>`
      ref → true.
    - parent_count = 1, same parent has no other item with same ref → false.
    - non-field ref or missing summary → safe default (documented).
  - Playwright (field-substrate.spec.ts):
    - Field Item (non-Field) delete shows the global dialog (assert
      `getByRole('dialog')` with expected title/body and N-connections copy);
      cancel writes nothing; confirm cascades touching connections.
    - Nested Field Item, referenced child still used elsewhere (e.g. two parent
      Fields both reference the child, OR same parent has duplicate refs):
      dialog body warns "still used elsewhere", NO checkbox is present, confirm
      removes only the parent reference, NO `DELETE /fields/<child>` request is
      issued, child Field remains in `fieldSummaries`.
    - Nested Field Item, removing leaves child unused: dialog shows checkbox;
      with checkbox unchecked, confirm only updates parent semantic and issues
      no child `DELETE`; with checkbox checked, confirm issues parent semantic
      PUT AND `DELETE /fields/<child>`, and (bus-backed test variant) the child
      `.yaml` and every `.layout.*.yaml` sidecar are gone from disk while any
      grandchild Fields referenced by the deleted child remain on disk.
    - No `page.on('dialog')` native confirm fires in any of the Field Item
      deletion flows above. (The Inspector whole-Field delete path still uses
      `window.confirm` after #17 and is migrated in #18 — existing tests for
      that path are unchanged here.)
  - Do NOT modify `deleteOpenField` tests in this slice; they continue to
    interact with `window.confirm` until issue #18.
- Live proof required:
  - Manual QA in dev: open a Field with (a) a non-Field Item, (b) a nested
    Field used by two parents, (c) a nested Field used only here. Delete each
    via Delete and Backspace. Verify dialog copy, focus trap, Escape/backdrop
    cancel, no semantic writes on cancel, parent semantic written on confirm,
    child Field cleanup only when checkbox opt-in is selected.
  - Verify on disk in a real workspace that the optional cleanup removes
    `<child>.yaml` and every `<child>.layout.*.yaml` and leaves any
    grand-child `.yaml` files untouched.

## Risk assessment

- Risk: Same-parent duplicate references undercount usage if we rely only on
  `parent_count`. Mitigation: usage helper also inspects
  `loadedField.semantic.items`; covered by unit tests above.
- Risk: `fieldSummaries` stale at the moment of delete (refresh hasn't landed
  yet). Mitigation: usage helper is conservative (treats "summary missing" /
  parent_count=0 case correctly), and the optional cleanup is still opt-in, so
  worst case is the user is offered an opt-in they don't take. Optionally
  await `refreshFields(workspaceId)` before opening the dialog if low-cost.
- Risk: Two-step (semantic PUT then child DELETE) leaves a partial state if the
  DELETE fails. Mitigation: use `onConfirm` to run both steps; on failure show
  inline error in the dialog. The parent semantic already correctly no longer
  references the child, which is consistent with the substrate's "broken refs
  allowed" rule (PRD #14). Surface a clear message so the operator can retry
  whole-Field delete from Workspace Home.
- Risk: A future programmatic delete path could bypass `onBeforeDelete`.
  Mitigation: keep delete logic only in `handleFieldBeforeDelete`; do not add
  shortcuts elsewhere.
- Risk: Performance regression on canvas. Mitigation: handler only runs on
  delete intent; usage computation is O(items in open Field) — negligible.
- Risk: Leaving `deleteOpenField`'s `window.confirm` in place after #17 could
  be perceived as an incomplete "no native popups" outcome. Mitigation:
  scope-by-design — issue #18 ("Slice 4: Referenced whole-Field delete warning
  and no-native-popup closeout") is explicitly blocked by #17 and owns that
  migration plus the referenced-by warning. Document this clearly in the #17
  PR description so reviewers do not request the migration here.

## Decision confidence

- Confidence: high
- Reasons:
  - Single, well-bounded React Flow integration point (`onBeforeDelete`) is
    already in use and already proved by prior issues #12/#13.
  - Global dialog primitive already supports every UI shape needed (default
    confirm, danger variant, checkbox opt-in, async `onConfirm` with inline
    error and loading state) — no new dialog plumbing.
  - Usage detection is achievable with in-memory data (`parent_count` +
    open-Field semantic); no new bus surface required.
  - Optional cleanup composes two existing, separately-tested operations
    (`remove_item` semantic PUT + `DELETE /fields/:id` with sidecar cascade).
  - Existing Playwright patterns (field-substrate.spec.ts) cover both cancel
    and confirm semantics and bus-backed disk outcomes; new tests slot in
    next to them.
- Open questions / flags:
  - Residual `window.confirm` after #17: `deleteOpenField`
    (floe-web/src/main.tsx:1781–1796) is the Inspector's whole-Field deletion
    path and intentionally remains on `window.confirm` after this slice. It is
    NOT migrated by #17. Issue #18 ("Slice 4: Referenced whole-Field delete
    warning and no-native-popup closeout") owns that migration together with
    the "referenced by N other Fields" warning UX (PRD #14 stories 8–10).
    Reviewers should not request that migration in the #17 PR; call this out
    explicitly in the PR description so the scope boundary is unambiguous.
  - No implementation idea in this brief creates a parallel path around React
    Flow deletion or the global dialog owner; if implementation diverges from
    the integration point above, stop and re-open this brief.
