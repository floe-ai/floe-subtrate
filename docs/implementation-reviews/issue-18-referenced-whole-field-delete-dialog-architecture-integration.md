# Architecture Integration Brief: issue-18-referenced-whole-field-delete-dialog

Scope: parent PRD #14 ("FloeWeb global dialog system and Field deletion safety"),
slice 4 (issue #18). Migrate the Inspector whole-Field deletion from
`window.confirm` to the global dialog, surface a referenced-by warning that
still allows the delete, and close out the no-native-popup rule across FloeWeb
app code. The Field Item / Nested Field path is already migrated by issue #17
and is explicitly not re-touched here.

## Existing ownership

- Package/component/module/library:
  - FloeWeb Inspector owns whole-Field deletion through a single button:
    - `deleteOpenField(fieldId)` in `floe-web/src/main.tsx:1814–1829` —
      currently calls `window.confirm` (line 1817), then `deleteFieldApi`,
      clears open-Field state, returns to home, and `refreshFields`.
    - Trigger: Inspector "Delete field" button at
      `floe-web/src/main.tsx:2219–2222` (only rendered when `view.kind === "field"`).
  - Global dialog primitive owns user-facing confirmation/checkbox/prompt
    surfaces: `floe-web/src/dialog/dialog.tsx` exports `confirm`,
    `confirmWithOptions`, `prompt`, and `DialogHost` (mounted in
    `floe-web/src/main.tsx` at the app root). Controller in
    `floe-web/src/dialog/dialog-controller.ts`.
  - Bus-backed semantic + sidecar deletion owns file-level cleanup:
    `fields-store.deleteField` (`floe-bus/src/fields-store.ts:383–403`) removes
    `<fieldId>.yaml` and every matching `<fieldId>.layout.*.yaml` sidecar;
    exposed via `DELETE /v1/workspaces/:wsId/fields/:fieldId` and called from
    the web through `deleteField` in `floe-web/src/fields-api.ts:221–229`.
    Result shape: `{ semanticDeleted: boolean, layoutsDeleted: string[] }`
    (`floe-web/src/fields-api.ts:11–14`).
  - Field usage / reference counts are bus-derived: `parent_count` is computed
    per-Field from `field:<id>` refs across all loaded Fields in `loadAllFields`
    (`floe-bus/src/fields-store.ts:263–286`). FloeWeb keeps these in
    `fieldSummaries` state (refreshed via `refreshFields`).
  - Pure ref helpers and root/nested classification live in
    `floe-web/src/fields.ts` (`parseFieldRef`, `isRootFieldSummary`,
    `nestedFieldStillUsedElsewhere`, `fieldToReactFlow`).
- Current owner rationale:
  - Whole-Field delete is an Inspector-side affordance (not a canvas
    interaction), so it does not flow through React Flow `onBeforeDelete`. The
    Inspector button is the single entry point — issue #17 deliberately left it
    untouched and routed all canvas/keyboard deletions through
    `handleFieldBeforeDelete`.
  - Dialog module is the single approved confirmation surface (PRD #14, issues
    #15/#16/#17).
  - Cascade to renderer sidecars is already a bus capability — no FloeWeb file
    I/O exists or should be added.
- Source evidence:
  - `floe-web/src/main.tsx:82` — `import { DialogHost, confirm as confirmDialog, confirmWithOptions, prompt as promptDialog } from "./dialog/dialog";`
  - `floe-web/src/main.tsx:1814–1829` (`deleteOpenField`), `2219–2222`
    (Inspector "Delete field" button).
  - `floe-web/src/main.tsx:1153–1241` (`handleFieldBeforeDelete`, the #17
    pattern to mirror for shape — `confirmWithOptions` + `onConfirm` + danger
    variant + optional checkbox).
  - `floe-bus/src/fields-store.ts:263–286, 383–403`.
  - `floe-web/src/fields-api.ts:169–172` (`listFields`), `174–183` (`getField`),
    `221–229` (`deleteField`).
  - `floe-web/src/fields.ts:81–88` (`FieldSummary.parent_count`),
    `161–179` (`isRootFieldSummary`, `nestedFieldStillUsedElsewhere`).

## Existing interaction model

- User/system behaviors that already exist:
  - The Inspector "Delete field" button is only visible while a Field is open
    (`view.kind === "field"`, `floe-web/src/main.tsx:2213–2226`).
  - On click, native `window.confirm("Delete field \"<id>\"?")` runs; on accept,
    `deleteFieldApi(busUrl, workspaceId, fieldId)` issues
    `DELETE /v1/workspaces/:wsId/fields/:fieldId`, then state resets:
    `setLoadedField(null)`, `clearFieldEditingState()`,
    `setView({ kind: "home" })`, then `refreshFields(workspaceId)` repopulates
    `fieldSummaries`.
  - Bus delete removes `.yaml` and every matching renderer layout sidecar
    (`<fieldId>.layout.floeweb.yaml`, `<fieldId>.layout.cli.yaml`, ...) —
    proved by `floe-web/tests/field-substrate.spec.ts` real-bus tests
    ("delete field — sends DELETE and field disappears" at line 792 and the
    "real bus stack persists/deletes" tests at 825/1370).
  - Substrate already permits broken `field:<id>` refs: parents that referenced
    the deleted Field keep their items as plain `field:<deleted-id>` refs.
    `parseFieldRef` returns `{ kind: "field", id, raw }` even when the target
    no longer exists, and `fieldToReactFlow` produces a `fieldItem` node from
    that data — broken refs already render visibly via `deriveLabel`
    (`floe-web/src/fields.ts:115–139, 181–221`). The bus only counts a parent
    when the child exists (`fields-store.ts:268–270`), so after delete the
    child is gone and parents are unaffected on disk.
  - `parent_count` on the open Field's `FieldSummary` reflects how many other
    Fields reference it — this is the exact "referenced-by" signal needed for
    the warning, available without any new bus call.
  - Dialog module supports: title, ReactNode body, variant (`default`/`danger`),
    optional `checkbox`, optional `input`, `onConfirm` (async with inline error
    + loading state + focus restore + Esc/backdrop cancel + focus trap)
    (`floe-web/src/dialog/dialog.tsx:18–145`).
  - Existing precedent for the dialog shape this slice needs: workspace delete
    danger dialog with checkbox (`floe-web/src/main.tsx:1412–1450`), and the
    #17 Field Item dialog (`floe-web/src/main.tsx:1212–1238`).
- Behaviors that must remain unchanged:
  - One Inspector button, one click → one delete intent. No new canvas-side or
    sidebar-side whole-Field delete affordance.
  - Whole-Field `DELETE` semantics: `<fieldId>.yaml` + every renderer layout
    sidecar removed by the bus in a single call. FloeWeb does not perform any
    file I/O.
  - On confirmed delete: `setLoadedField(null)`, `clearFieldEditingState()`,
    `setView({ kind: "home" })`, then `refreshFields(workspaceId)` — exact
    current state-reset sequence.
  - On cancel: no DELETE request, no state mutation, no view change.
  - Parents that referenced the deleted Field retain their `field:<deleted-id>`
    items visibly on the canvas (broken-ref aftermath is a feature, not a bug).
  - Root/nested classification continues to come from `parent_count` /
    `isRootFieldSummary`.
  - React Flow / canvas invariants: Block Library drag/drop, node
    icons/labels/handles/selection, pan/zoom/drag performance,
    rename/open/connection affordances, and the `onBeforeDelete` Field Item
    flow from #17 are untouched by this slice.
- Runtime or UX evidence:
  - `floe-web/tests/field-substrate.spec.ts:792–812` — seeded delete flow.
  - `floe-web/tests/field-substrate.spec.ts:825–897` — real-bus delete proves
    semantic + layout sidecar removal on disk.
  - `floe-web/tests/field-substrate.spec.ts:1370–1470` — real-bus delete proves
    both floeweb and cli layout sidecars are removed.
  - `floe-web/tests/field-substrate.spec.ts:486–524` — #17 dialog cancel/
    confirm pattern (no writes on cancel).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - `confirmDialog` (`confirm`) from `./dialog/dialog` is sufficient for the
    referenced-by path (warn + allow). `confirmWithOptions` is the right call
    if any optional checkbox is added (none required by AC). Either way the
    `onConfirm` async hook should own the actual `deleteFieldApi` call so the
    dialog's `loading` / inline-error UX wraps network failure cleanly
    (`floe-web/src/dialog/dialog.tsx:122–145`).
  - `deleteFieldApi` (re-exported as `deleteField`) from
    `./fields-api` — single bus delete call (already proven to cascade
    sidecars). Do not duplicate.
  - `fieldSummaries` state + `FieldSummary.parent_count` for the referenced-by
    detection. Sufficient and authoritative because it is computed by the bus
    over all on-disk Field semantics — no new endpoint needed.
  - `isRootFieldSummary` / `parent_count > 0` to choose between the
    "no references" and "referenced by N other Field(s)" dialog bodies.
  - `refreshFields(workspaceId)` after delete — already triggered by
    `deleteOpenField`. After delete completes, `parent_count` on any parents
    that still hold a `field:<deleted-id>` ref drops the deleted id from their
    set, but the parents themselves remain on disk and still render the broken
    ref nodes.
  - `loadedField.semantic` + `parseFieldRef` if implementation chooses to
    surface the names of parent Fields in the warning body (optional polish; AC
    does not require listing names). To list parent titles without a new
    endpoint, implementation may iterate `fieldSummaries` and call existing
    `getField` for each candidate (bounded by `parent_count`); recommended only
    if `parent_count <= 5` to avoid N+1 fan-out — otherwise show "N other
    Fields" without names.
  - Inspector "Delete field" button (`floe-web/src/main.tsx:2219`) already
    receives `view.fieldId`; keep that signature.
- Relevant docs or library capabilities:
  - React Flow is not involved in this slice — whole-Field deletion is an
    Inspector affordance, not a canvas-node delete. Canvas invariants must be
    preserved but no React Flow API is invoked.
  - The dialog module already supports async `onConfirm` with inline error and
    a disabled "Working..." button, removing any need for a custom spinner or
    re-entrancy guard.
- Existing examples in this codebase:
  - Workspace delete (danger + checkbox, async `onConfirm`):
    `floe-web/src/main.tsx:1412–1450`.
  - Field Item / Nested Field delete (danger + optional checkbox, async
    `onConfirm`, ReactNode body): `floe-web/src/main.tsx:1212–1238`.
  - Conversation delete (danger): `floe-web/src/main.tsx:1564–...`.
  - Native-popup absence assertion pattern using
    `page.on("dialog", recorder)` and
    `expect(nativeDialogs).toEqual([])` — used widely in
    `floe-web/tests/workspace-management.spec.ts`,
    `floe-web/tests/context-rendering.spec.ts`, and
    `floe-web/tests/field-substrate.spec.ts` (issue #16/#17 closeout pattern).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not call `window.confirm`, `window.prompt`, or `window.alert` from any
    FloeWeb app source after this slice. The acceptance criteria require both
    removal of the residual call and a regression guard. Test-only files may
    keep `page.on("dialog", ...)` recorders; product code must be clean.
  - Do not build a parallel one-off modal/dialog component for whole-Field
    delete. Reuse `confirmDialog` / `confirmWithOptions` from
    `floe-web/src/dialog/dialog.tsx`.
  - Do not introduce a new bus endpoint (e.g. "list parents of field X" or
    "delete-with-confirm"). `listFields` already returns `parent_count`, and
    `getField` already exposes per-Field items if names are needed. PRD #14
    forbids new endpoints unless existing APIs are proven insufficient — they
    are sufficient here.
  - Do not block deletion when the Field is referenced. AC and substrate
    behaviour explicitly allow broken refs; the warning must still allow
    confirm.
  - Do not recursively delete parents, child Fields, or any other primitives.
    The bus call deletes exactly one Field's semantic + its renderer sidecars;
    that is the only file-system effect.
  - Do not mutate parent Field semantics to "scrub" the broken ref. Broken
    refs remain on disk and on the canvas so the workspace owner can repair
    them — that is the explicit substrate contract.
  - Do not perform FloeWeb file I/O; persistence stays bus-backed.
  - Do not move the "Delete field" trigger off the Inspector or add a second
    one (no canvas right-click menu, no sidebar item delete). Single owner.
- Shortcuts or parallel paths to avoid:
  - Resolving the dialog `true` then performing `deleteFieldApi` outside
    `onConfirm`: that loses the dialog's loading / inline-error handling and
    risks double-submits. Use `onConfirm` to own the network call.
  - Reading parent count from stale state. `fieldSummaries` is refreshed by
    `refreshFields` whenever Fields change; ensure the dialog reads the value
    at open time (closure capture) and treats `parent_count ?? 0` as the
    authoritative referenced-by count.
  - Re-deriving parent count from `loadedField.semantic` alone — the open
    Field's own semantic does not know who points at it; only the bus-derived
    `parent_count` does.
  - Hand-rolling a Backdrop/Escape modal — `DialogHost` already provides focus
    trap, Esc, backdrop cancel, focus restore.
- Invariants (FloeWeb Field/canvas seed):
  - Use existing React Flow graph/canvas features before hand-rolling
    interactions; no new canvas-side delete affordance.
  - Preserve Block Library drag/drop unless explicitly redesigned.
  - Preserve node icons, labels, handles, selection, pan, zoom, drag, rename,
    and connection affordances.
  - Substrate-backed behaviour must integrate into the existing Field/canvas
    model — broken-ref nodes already render through `fieldToReactFlow` and
    `deriveLabel`; do not branch on "is broken" anywhere new.
  - Toolbar / inspector shortcuts supplement, not replace, canvas flows.
  - No performance regression in navigation, pan, zoom, or drag (this slice
    touches a click handler and a dialog only).
  - Existing working affordances (whole-Field delete cascade, dialog flows
    from #15–#17) must have regression coverage before/after the refactor.

## Integration plan

- Insert the change at:
  - `floe-web/src/main.tsx` `deleteOpenField` (lines 1814–1829). Replace the
    `window.confirm` block with a `confirmDialog` (or `confirmWithOptions` if
    a future opt-in is anticipated; `confirmDialog` is simpler and matches AC)
    call whose body is selected from the current `FieldSummary.parent_count`
    of the open Field:
    1. `parent_count === 0` (or undefined / root):
       - Title: `Delete Field`
       - Body (ReactNode):
         - `Delete the Field <strong>{title}</strong>?`
         - `This removes <code>{fieldId}.yaml</code> and every renderer sidecar
           (<code>{fieldId}.layout.*.yaml</code>) from the workspace.`
       - `variant: "danger"`, `confirmLabel: "Delete"`,
         `cancelLabel: "Cancel"`.
    2. `parent_count > 0` (referenced elsewhere):
       - Title: `Delete referenced Field`
       - Body (ReactNode):
         - `Delete the Field <strong>{title}</strong>?`
         - `It is currently referenced by {parent_count} other Field(s).
           Deleting it will leave broken <code>field:{fieldId}</code> refs in
           those Fields. Floe will keep showing the broken refs visibly so you
           can repair them.`
         - `This removes <code>{fieldId}.yaml</code> and every renderer sidecar
           (<code>{fieldId}.layout.*.yaml</code>) from the workspace.`
       - `variant: "danger"`, `confirmLabel: "Delete anyway"`,
         `cancelLabel: "Cancel"`.
    3. `onConfirm` performs the existing async sequence verbatim:
       `await deleteFieldApi(busUrl, workspaceId, fieldId)` →
       `setLoadedField(null)` → `clearFieldEditingState()` →
       `setView({ kind: "home" })` → `await refreshFields(workspaceId)`.
       Throw on bus failure so the dialog surfaces the inline error and stays
       open; existing `setError((caught as Error).message)` outside the dialog
       is no longer needed because `onConfirm` already routes errors to the
       dialog's inline error region. (If preferred, also call `setError` as a
       belt-and-braces fallback — both are safe; `onConfirm` is authoritative.)
  - Inspector trigger (`floe-web/src/main.tsx:2219`) is unchanged.
- Why this is the correct integration point:
  - `deleteOpenField` is the single owner of whole-Field deletion in the app
    (single button, single state-reset sequence). Changing it in place
    preserves the open/home transition, sidecar cleanup, and `fieldSummaries`
    refresh exactly. No new component, no new affordance, no canvas coupling.
  - `parent_count` is already computed and already on the `FieldSummary` that
    the Inspector reads — the referenced-by warning needs no new API.
  - Using the dialog's `onConfirm` keeps the existing async flow intact while
    giving free loading/error UX consistent with #15/#16/#17.
- Alternatives considered and rejected:
  - Adding a `referenced_by: string[]` field to the bus list response: rejected
    — `parent_count` already gives the warning signal, AC does not require
    names, and changing the API affects the bus, web, schema, and cli.
  - Two-step modal ("first confirm, then re-confirm broken-ref warning"):
    rejected — single danger dialog with adapted body matches PRD #14
    "single dialog system" and #17 precedent.
  - Auto-scrubbing parent semantics to remove broken refs: rejected — violates
    the substrate contract that broken refs are a visible repair signal.
  - Moving the trigger off the Inspector or wrapping in a custom modal:
    rejected — duplicates ownership and contradicts the Field/canvas
    invariants.
  - Implementing the static / regression guard as a new lint plugin: rejected
    — a focused ripgrep-based Playwright/unit test in `floe-web` is simpler,
    matches existing `nativeDialogs` recorder convention, and is the lowest-
    risk way to satisfy the "static guard" AC.

## Regression checklist

- Inspector "Delete field" button is visible only while a Field is open and
  triggers exactly one bus DELETE on confirm.
- No `window.confirm` / `window.prompt` / `window.alert` is invoked anywhere in
  FloeWeb app source (`floe-web/src/**`, excluding `tests/`).
- Confirm path: bus DELETE issued, semantic file removed, every matching
  renderer layout sidecar removed, view returns to `home`, open-Field state
  cleared, `fieldSummaries` refreshed.
- Cancel path (button, Escape, backdrop): no DELETE issued, no state mutation,
  view remains on the open Field, dialog closes, focus returns to the trigger
  button (focus restore is provided by `DialogHost`).
- Referenced Field delete still succeeds; parent Fields keep their
  `field:<deleted-id>` items and render them visibly via the existing
  `fieldToReactFlow` / `deriveLabel` pipeline.
- `parent_count` on the surviving parent Fields drops by one (the deleted child
  no longer contributes a referent on disk).
- Field Item / Nested Field deletion dialog from #17 is unchanged and still
  green (`field-substrate.spec.ts` Field Item delete cancel/confirm).
- Workspace delete (#16), Field create (#16), nested Field create (#16),
  conversation delete dialogs continue to work and remain native-popup-free.
- Canvas invariants: no observable change to Block Library drag/drop, node
  rendering, selection, pan/zoom/drag, rename, or connection affordances.
- Dialog accessibility: focus trap, Esc, backdrop cancel, focus restore, ARIA
  labelling — covered by `DialogHost` and existing dialog tests.

## Test plan

- Existing tests to keep green:
  - `floe-web/tests/field-substrate.spec.ts`:
    - "delete field — sends DELETE and field disappears" (line 792). Migrate
      from `page.on("dialog", ...)` accept to clicking the new app-dialog
      Delete button.
    - Real-bus delete tests at lines 825–897 and 1370–1470 — migrate the
      `page.once("dialog", ...)` accept to the new app-dialog confirm; keep
      every existing assertion about semantic + layout sidecar removal and
      the home/empty state UI.
    - Field Item delete cancel/confirm tests at 431–524 — unchanged.
    - Nested Field Item preserves child Field test (526–568) — unchanged.
  - `floe-web/tests/workspace-management.spec.ts`,
    `floe-web/tests/context-rendering.spec.ts`, and the unchanged sections of
    `field-substrate.spec.ts` continue asserting
    `expect(nativeDialogs).toEqual([])` after their flows.
  - Vitest suites (`fields.test.ts`, `fields-api.test.ts`, `contexts.test.ts`)
    — no changes expected; whole-Field delete logic in `deleteOpenField` is
    behavioural and not unit-tested separately.
- New tests to add before/with implementation:
  - Playwright in `floe-web/tests/field-substrate.spec.ts` (or a sibling spec):
    1. `whole-Field delete — unreferenced opens app dialog and removes
       semantic + sidecars`: seed a single unreferenced Field, click "Delete
       field", assert the app dialog body mentions removing the semantic and
       renderer sidecars, click Delete, assert DELETE request fires, assert
       view returns to home, assert `nativeDialogs` recorder stays empty.
    2. `whole-Field delete — referenced shows broken-ref warning, allows
       delete, leaves broken refs visible`: seed two Fields where Parent
       contains an item `{ ref: "field:child" }` and Child exists; open Child,
       click "Delete field", assert dialog body mentions broken refs and the
       parent count, click "Delete anyway", assert DELETE fires for Child,
       reopen Parent from the Workspace Home, assert the canvas still renders
       a node labelled `child` (or the broken-ref label produced by
       `deriveLabel`) and that no parent-side PUT was issued. Assert
       `nativeDialogs` recorder stays empty.
    3. `whole-Field delete — cancel keeps the Field`: open a Field, open the
       dialog, press Escape (and a second sub-case: click backdrop / Cancel),
       assert no DELETE request, view still on the open Field, no
       `nativeDialogs`.
    4. (Optional, real-bus) Repeat case 2 against the real bus stack to prove
       the parent semantic on disk is byte-identical before/after the child
       delete and that broken-ref nodes render after reload.
  - Static / regression guard for no-native-popup closeout. Add a single
    Vitest (preferred — runs in unit suite, no Playwright start) in
    `floe-web/src/no-native-popups.test.ts` that ripgrep / `fs.readdirSync`-
    scans `floe-web/src/**/*.{ts,tsx}` (excluding `*.test.*` and the dialog
    module's own type/comment usage if any) and asserts zero matches of
    `/\bwindow\.(confirm|prompt|alert)\s*\(/`. This is the minimal "static
    guard" the AC calls for and matches the existing co-located test style
    in `floe-web/src/`.
- Live proof required:
  - Real-bus Playwright run of the new referenced-delete + broken-ref
    aftermath test (case 2 above) with a workspace on disk; capture
    screenshots of (a) the warning dialog body, (b) the parent canvas after
    delete showing the broken-ref node still visible.
  - Real-bus run of the existing real-bus delete tests after migration to
    confirm semantic + every layout sidecar are still removed.
  - Manual smoke: open a referenced Field, confirm dialog copy, delete, open
    a parent, see broken ref still drawn; cancel path with Esc/backdrop/
    Cancel button all leave state untouched.
  - Evidence artefacts under
    `docs/evidence/issue-18-referenced-whole-field-delete-dialog/` (screenshots,
    test logs).

## Risk assessment

- Risk: `fieldSummaries` is stale at dialog open time (e.g. another client
  edited a parent semantic moments earlier), so `parent_count` understates
  reality.
  - Mitigation: this is acceptable because (a) the bus DELETE always succeeds
    and broken refs are intentional, and (b) refreshing on every dialog open
    would add latency. Optionally `await refreshFields(workspaceId)` inside
    `deleteOpenField` before opening the dialog if we want the warning copy
    to be authoritative; recommended only if cheap. Either way the deletion
    outcome is correct.
- Risk: Implementer fetches every parent Field's semantic to list names,
  causing an N+1 of `getField` calls.
  - Mitigation: AC does not require names; default to count-only copy. If
    listing names is desired, cap at `parent_count <= 5` and fetch in
    parallel; otherwise show "N other Fields".
- Risk: Async dialog `onConfirm` throws (bus 5xx / network) and leaves the
  open Field in an inconsistent UI state.
  - Mitigation: do the state reset (`setLoadedField(null)`,
    `clearFieldEditingState`, `setView`, `refreshFields`) only after
    `deleteFieldApi` resolves; if it rejects, rethrow from `onConfirm` so
    `DialogHost` surfaces the inline error and keeps the dialog open. State
    is unchanged on failure.
- Risk: Deleting the currently open Field while the user is mid-edit (pending
  layout PUT etc.).
  - Mitigation: `clearFieldEditingState()` is already part of the success
    sequence and runs after the DELETE resolves; any pending semantic save
    would target an id the bus has already removed and surface as a normal
    error. The Inspector button is only visible after the Field has loaded,
    so this matches today's behaviour.
- Risk: Broken-ref rendering regresses (parent canvas crashes on
  `field:<deleted-id>` after delete).
  - Mitigation: `parseFieldRef` and `fieldToReactFlow` already handle missing
    targets — there is no lookup of the child semantic in the render path.
    Regression test (case 2) reopens the parent and asserts the node renders.
- Risk: Issue #14 "no native popup" closeout missed because the static guard
  only checks `floe-web/src/`.
  - Mitigation: scope is correct — `floe-web/src/` is the FloeWeb app source
    set the AC refers to ("no FloeWeb app flow"). Tests may continue to use
    `page.on("dialog", ...)` recorders to assert absence. If the guard
    additionally wants to cover `floe-web/index.html` and any inline scripts,
    extend the glob to `floe-web/index.html` (no inline JS today).
- Risk: Renaming the "Delete field" button breaks selectors in real-bus tests
  (`getByRole("button", { name: "Delete field", exact: true })`).
  - Mitigation: do not rename the trigger button label. Only the dialog
    confirm button label changes copy per branch.
- Risk: Parallel dialog (issue 18) implementation accidentally reuses
  `confirmWithOptions` checkbox slot for an off-spec opt-in.
  - Mitigation: AC has no checkbox — use plain `confirmDialog`. If
    `confirmWithOptions` is chosen for consistency, leave `checkbox`
    undefined.

## Decision confidence

- Confidence: high
- Reasons:
  - The change surface is one function (`deleteOpenField`), one button, and
    one async sequence — all already in the codebase and exercised by real-
    bus tests.
  - All needed primitives exist: dialog module with async `onConfirm` +
    danger variant, `deleteFieldApi`, `FieldSummary.parent_count` for the
    referenced-by signal, `fieldToReactFlow` / `deriveLabel` for broken-ref
    rendering.
  - Issue #17 established the exact pattern (`confirmWithOptions` /
    `confirmDialog` + async `onConfirm` + ReactNode body) being mirrored.
  - The no-native-popup closeout is mechanical: one residual call
    (`main.tsx:1817`) plus a one-file static guard.
  - No new bus endpoint, no new component, no canvas changes, no schema
    changes.
- Open questions:
  - Should the warning enumerate parent Field titles when `parent_count` is
    small (≤ 5) for clearer repair guidance, or always show count-only?
    Recommendation: count-only for v1 (AC-compliant, no fan-out); leave the
    named-list as a follow-up polish if user feedback asks for it.
  - Should `deleteOpenField` `await refreshFields` before opening the dialog
    to guarantee `parent_count` freshness? Recommendation: yes if it is
    already fast (single `listFields` round-trip), otherwise accept the
    minor staleness.
  - Confirm-button copy ("Delete" vs "Delete anyway") — minor UX choice; the
    danger variant + body already communicates the risk. Brief recommends
    "Delete anyway" only on the referenced branch.
