# Architecture Integration Brief: issue-16-replace-workspace-and-field-native-popups

Scope: parent #14 PRD "FloeWeb global dialog system and Field deletion safety", slice 2
(issue #16). Migrate the remaining non-Field-deletion native popup flows into the global
dialog foundation shipped in #15:

- missing-directory creation confirmation (workspace register retry),
- workspace deletion (currently a chained `window.confirm` + `window.confirm`) collapsed
  into one danger dialog with an explicit "also delete folder from disk" opt-in,
- root Field creation (currently `window.prompt`),
- nested Field creation (currently `window.prompt`).

Field Item delete (`main.tsx:1179`) and whole-Field delete (`main.tsx:1751`) are explicitly
out of scope here; they belong to the Field deletion safety slices (#17/#18) under #14.

## Existing ownership

- Package/component/module/library:
  - `floe-web\src\main.tsx` still owns every UI handler this slice touches:
    - `registerWorkspace(createDirectory = false)` at `main.tsx:1332-1363` — owns the
      directory-not-found recovery via `window.confirm` at `main.tsx:1356`.
    - `deleteWorkspace(workspaceId)` at `main.tsx:1375-1395` — owns the chained
      `window.confirm` pair at `main.tsx:1378` and `main.tsx:1380-1382`, then
      `POST /v1/workspaces/:id/delete` with `{ delete_locator }`.
    - `promptCreateField()` at `main.tsx:1765-1769` — wraps `window.prompt("New field
      name?")` and calls `createField(name)`.
    - `createField(name?)` at `main.tsx:1720-1738` — substrate path:
      `slugifyFieldId` → `emptyFieldSemantic` → `putFieldSemantic(..., { ifAbsent: true })`
      → `refreshFields` → `setView({ kind: "field", fieldId })`.
    - `promptCreateNestedFieldItem(position?)` at `main.tsx:1641-1646` — wraps
      `window.prompt("New nested field name?")` and calls `createNestedFieldItem`.
    - `createNestedFieldItem(name, position?)` at `main.tsx:1648-1718` — substrate path:
      child `putFieldSemantic(..., { ifAbsent: true })` → parent `putFieldSemantic` of the
      updated parent semantic via `buildSemanticUpdate({ type: "add_item", ... })` → optional
      `putFieldLayout` at the drop position → `refreshFields`.
  - Triggers live in `main.tsx`:
    - "Create Workspace" button at `main.tsx:1887-1890` (calls `registerWorkspace()`),
      with `Workspace folder` and `Name` labelled inputs at `main.tsx:1862-1878` and the
      `Allow .floe/ initialization when needed` checkbox at `main.tsx:1879-1886`. Sidebar
      version uses `.rail-new input` / `.rail-new button` (referenced in
      `tests\workspace-management.spec.ts:42,53,79,86`).
    - `.workspace-delete-button` at `main.tsx:2614` (hover-revealed) → `deleteWorkspace`.
    - "Add field" `primary-action full` at `main.tsx:1932-1935` → `promptCreateField`.
    - Field primitive drag/drop and click in the Block Library at
      `handleFieldPrimitiveClick` (`main.tsx:1771-1777`) and
      `handleFieldPrimitiveDragStart` (`main.tsx:1779…`). When the canvas is open this calls
      `promptCreateNestedFieldItem` after click; drag-drop also reaches
      `createNestedFieldItem` with a `position`. The drag/drop path also currently uses
      `window.prompt` indirectly via a `page.once("dialog", ...)` accept in
      `tests\field-substrate.spec.ts:127-177` (the drop handler in the live app prompts
      for a name on drop too — see "Conflicts" below).
  - Global dialog foundation is `floe-web\src\dialog\dialog.tsx` (public `confirm(req)` and
    `<DialogHost />`, mounted at `main.tsx:2695`) backed by
    `floe-web\src\dialog\dialog-controller.ts`. The current public surface is:
    `ConfirmDialogRequest = { title, body, confirmLabel?, cancelLabel?, variant?, onConfirm? }`
    with `confirm(request): Promise<boolean>`. It exposes no text input, no checkbox,
    and no per-request body-state slot.
  - Substrate APIs are stable: `POST /v1/workspaces/register` (with
    `create_directory: true` retry semantics), `POST /v1/workspaces/:id/delete` with
    `{ delete_locator: boolean }`, `PUT /v1/workspaces/:id/fields/:fieldId?if_absent=true`
    (via `putFieldSemantic`), and `PUT /v1/workspaces/:id/fields/:fieldId/layout/floeweb`
    (via `putFieldLayout`). None of these change.
- Current owner rationale:
  - All four popup flows are direct `main.tsx` handler logic with no extracted owner; the
    cleanest integration is to call the existing global `confirm`/new sibling helpers from
    the same handler.
  - The dialog module already owns the modal lifecycle (focus trap, Escape, backdrop
    cancel, focus return, inline error, loading state). Issue #16 must extend that owner,
    not stand up a parallel one.
- Source evidence:
  - Issue #16 acceptance criteria (parent #14): single global danger dialog for workspace
    deletion with opt-in checkbox; text-entry dialog with validation for both Field
    creation flows; native `window.prompt` removed from migrated flows; no one-off modal.
  - Issue #15 brief (`docs\implementation-reviews\issue-15-global-dialog-foundation-architecture-integration.md`)
    documents the "one global dialog primitive" invariant and explicitly anticipates
    `prompt(...)` / `open(...)` siblings landing in later slices.
  - Existing Playwright coverage that must be rewritten against the new in-app dialogs:
    `tests\workspace-management.spec.ts:6-91` (directory-not-found accept/dismiss),
    `tests\workspace-management.spec.ts:93-189` (workspace delete with and without
    `delete_locator`), `tests\field-substrate.spec.ts:579-606` (create field — uses
    `page.once("dialog", d => d.accept("My New Field"))`),
    `tests\field-substrate.spec.ts:641-704` (live bus stack create + delete field, also
    uses `page.once("dialog", ...)` accept),
    `tests\field-substrate.spec.ts:127-177` (nested-field drop creates a Field with a
    name from a native prompt).

## Existing interaction model

- User/system behaviors that already exist:
  - **Missing directory**: user fills the workspace path and Name fields and clicks
    "Create Workspace" (`main.tsx:1887`) or hits Enter in the path input
    (`main.tsx:1867`). `registerWorkspace()` calls `POST /v1/workspaces/register`. When
    the bus returns `400` with `{ error: "directory_not_found", locator }`, the handler
    prompts via `window.confirm("Directory does not exist:\n<locator>\n\nCreate it?")`.
    Accept → `registerWorkspace(true)` retries with `create_directory: true`. Dismiss →
    no further calls, no state change. Any non-`directory_not_found` error rethrows
    (caller currently does not wrap in `setError`).
  - **Workspace delete**: hover a `.workspace-row` to reveal `.workspace-delete-button`.
    Click runs `deleteWorkspace(workspaceId)`. Two sequential native confirms:
    1. "Delete workspace \"<label>\"? This removes the workspace from Floe. You can
       choose whether to keep or delete the folder next." — cancel aborts everything.
    2. "Remove the workspace folder from disk too?<locator>\n\nChoose OK to delete the
       folder and its files. Choose Cancel to keep files and only remove it from Floe." —
       OK ⇒ `delete_locator: true`, Cancel ⇒ `delete_locator: false`. **Both branches
       always call** `POST /v1/workspaces/:id/delete` (the second confirm is *not* a
       cancel of the whole delete — it only chooses the opt-in). After the call, if the
       deleted workspace is selected, selection/endpoints/events/telemetry are cleared and
       `refresh()` runs.
  - **Root Field creation**: user clicks "Add field" (`.primary-action.full`,
    `main.tsx:1932`). `promptCreateField` runs `window.prompt("New field name?")`. `null`
    (Cancel) aborts; any string (including `""`) reaches `createField(name)` which:
    derives `nextName = name?.trim() || `Field ${fieldSummaries.length + 1}`, derives
    `id = slugifyFieldId(nextName)` (lowercased, non-`[a-z0-9]+` → `-`, fallback
    `field-<base36 timestamp>` if empty), builds `emptyFieldSemantic(id, nextName)`,
    calls `putFieldSemantic(..., { ifAbsent: true })`, refreshes the field list, clears
    editing state, and navigates `setView({ kind: "field", fieldId: id })` to open the
    new Field.
  - **Nested Field creation (click path)**: when the user is inside an open Field
    canvas and clicks the Field block in the Block Library,
    `handleFieldPrimitiveClick` (`main.tsx:1771`) calls `promptCreateNestedFieldItem()`
    which `window.prompt("New nested field name?")`. `null` aborts; otherwise
    `createNestedFieldItem(name)` derives `title`, `fieldId`, `itemRef = "field:<id>"`,
    rejects duplicates with `setError("That Field is already in this Field.")`, writes
    the child semantic, writes the updated parent semantic, optionally writes the layout
    at `position`, and refreshes the field list.
  - **Nested Field creation (drag-drop path)**: `handleFieldPrimitiveDragStart` +
    canvas `drop` (covered by `tests\field-substrate.spec.ts:127-177`). The current live
    behavior also asks for a name via `window.prompt` on drop and then calls
    `createNestedFieldItem(name, position)`. The issue calls out "Nested Field
    creation" without distinguishing click vs drop; both code paths reach the same prompt
    layer and both should land on the new text-entry dialog so behavior stays consistent.
- Behaviors that must remain unchanged:
  - Triggers and accessible names: `.workspace-delete-button`, `Add field` button,
    `Create Workspace` button, `Workspace folder` / `Name` inputs, the Field block in the
    Block Library, drag/drop affordance on the canvas. No relocation, no relabeling
    beyond what is needed to launch a dialog.
  - Substrate calls: `POST /v1/workspaces/register` body shape including
    `create_directory: true` on retry; `POST /v1/workspaces/:id/delete` with exactly
    `{ delete_locator: boolean }`; `PUT /v1/workspaces/:id/fields/:fieldId?if_absent=true`
    with `{ id, title, ... }`; `PUT /v1/workspaces/:id/fields/:fieldId/layout/floeweb`
    body shape from `reactFlowToLayout` and `markLocalLayoutWrite` ordering.
  - "Cancel writes nothing" invariant on every dialog. Specifically: cancelling the
    missing-directory dialog must not retry; cancelling the workspace-delete dialog must
    not call `/delete`; cancelling either Field-creation dialog must not call
    `putFieldSemantic`.
  - Existing behaviors for non-migrated popups (Field Item delete at `main.tsx:1179`,
    whole-Field delete at `main.tsx:1751`) keep working unchanged in #16. They migrate
    in #17/#18.
  - React Flow canvas (pan, zoom, drag, selection, handles, node icons/labels,
    rename/open, connection create/label/delete, MiniMap, Controls), Block Library
    drag/drop and the Field primitive icon, Inspector behavior, workspace rail behavior,
    `.error-bar` global error display.
  - `slugifyFieldId` derivation rules, the empty-name fallback (`Field N` / `field-<ts>`)
    and the duplicate-nested-Field guard message
    `"That Field is already in this Field."` (preserve text or move it inline into the
    nested dialog as an inline error).
  - Post-create navigation: root Field creation must still call `setView({ kind: "field",
    fieldId: id })` to open the new Field; nested Field creation must keep the parent
    Field open and reflect the new node on canvas at `position` when supplied.
- Runtime or UX evidence:
  - Native dialog assertions in `workspace-management.spec.ts` (lines 46-50, 82-84,
    129-139, 177-188) currently encode the message text and the order of the chained
    confirms; the new dialog must let these be re-expressed as in-app `role="dialog"`
    assertions against title/body/checkbox/buttons and the resulting `delete_locator`
    request payload.
  - `field-substrate.spec.ts:579-606` and 641-704 currently exercise
    `page.once("dialog", d => d.accept("My New Field"))` — equivalent in-app behavior is
    "open dialog, type name, click Create".
  - The existing `app-dialog` shell already supports: title, body (`React.ReactNode`),
    confirm/cancel labels, danger variant, loading on confirm, inline error from
    `onConfirm` rejection, focus trap, Escape, backdrop cancel, focus return. CSS tokens
    already include `.check-row` for the opt-in checkbox styling.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - **Extend** `floe-web\src\dialog\dialog.tsx` rather than fork. Two additions are
    required for #16 and both fit inside the existing `confirm` request type and `<DialogHost />`
    portal:
    1. **Optional checkbox row** in `ConfirmDialogRequest` for the workspace-delete
       opt-in. Recommended shape:
       ```ts
       checkbox?: {
         label: React.ReactNode;
         defaultChecked?: boolean; // default false
         testId?: string;          // e.g. "dialog-delete-locator-checkbox"
       };
       onConfirm?: (result: { checked: boolean }) => Promise<void>;
       ```
       and resolve the `confirm` promise with `{ confirmed: boolean; checked: boolean }`
       — or, to keep `Promise<boolean>` shape, expose a separate
       `confirmWithOptions(req): Promise<{ confirmed: boolean; checked: boolean }>` and
       keep the existing `confirm`. Either is acceptable as long as exactly one
       implementation owns the dialog.
    2. **Text-entry input** for both Field-creation flows. Recommended shape:
       ```ts
       input?: {
         label: React.ReactNode;
         placeholder?: string;
         initialValue?: string;
         autoFocus?: boolean;       // default true; overrides cancel-button autofocus
         validate?: (value: string) => string | null; // inline error per keystroke / on submit
         testId?: string;           // e.g. "dialog-text-input"
       };
       onConfirm?: (result: { value: string }) => Promise<void>;
       ```
       and a sibling `prompt(req): Promise<{ confirmed: boolean; value: string }>` helper
       (or extend `confirm` to return the value). Empty-string is allowed by the existing
       `createField` flow (it falls back to `Field N`); validation must not reject empty
       unless the implementer also changes `createField`/`createNestedFieldItem` to
       require it. Recommendation: do not require non-empty in the dialog; preserve the
       fallback derivation in `createField`/`createNestedFieldItem`. The "validation"
       called out in the AC is the duplicate-nested-Field guard
       (`That Field is already in this Field.`) and any slug-collision check — both
       belong in the `onConfirm` handler and should surface via the dialog's existing
       inline-error path (rejected promise from `onConfirm`).
  - Reuse `app-dialog`, `app-dialog-body`, `app-dialog-actions`, `app-dialog-error`,
    `primary-action`, `primary-action.danger`, `ghost-action`, and `.check-row` from
    `floe-web\src\styles.css`. Add at most two new selectors (`.app-dialog-checkbox` and
    `.app-dialog-input`) reusing existing tokens. Do not introduce new color tokens.
  - Reuse existing focus-trap, Escape, backdrop, and focus-return logic in
    `DialogHost`. The added input element must be picked up by the trap's
    `querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), ...')`
    already at `dialog.tsx:90-94`. Initial focus should move from the cancel button to
    the text input when `request.input` is present.
  - Keep using `slugifyFieldId` and `emptyFieldSemantic` (`main.tsx:2842-2858`),
    `putFieldSemantic` / `putFieldLayout` from `fields-api.ts`, `buildSemanticUpdate`,
    `nextFieldItemId`, `reactFlowToLayout`, `markLocalLayoutWrite`, and existing
    `refreshFields` / `refresh` / `ensureOperator` flows.
  - Continue calling `api(busUrl, ...)` for `register` and `/delete`.
- Relevant docs or library capabilities:
  - `docs\implementation-reviews\issue-15-global-dialog-foundation-architecture-integration.md`
    — "small request API, one approved path, `prompt`/`open` siblings later" decision.
  - `PRODUCT.md` — restrained register; the workspace-delete combined-with-opt-in dialog
    must read calm even though it is destructive.
  - `CONTEXT.md` — Field / Nested Field / Field Item / Workspace terminology and the rule
    that nested-Field references take the form `field:<id>`; preserve in copy.
  - Issue #14 PRD — explicitly lists optional checkbox and optional text input as part of
    the dialog shell capabilities; #16 is the slice that exercises both.
- Existing examples in this codebase:
  - `deleteConversation` at `main.tsx:1512-1536` is the reference pattern for migrating
    a destructive `window.confirm`: build the request inline, pass `onConfirm` that
    performs the bus call so loading state and inline error work, run post-confirm side
    effects after `await confirm(...)` resolves `true`.
  - Existing Playwright assertions against the in-app dialog at
    `tests\context-rendering.spec.ts:835-840` (`getByRole("dialog", { name: "..." })`,
    `aria-modal="true"`, body text, confirm/cancel buttons by role) are the template for
    all #16 tests.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not introduce a second dialog/modal mechanism (no per-feature
    `WorkspaceDeleteModal`, `CreateFieldModal`, `CreateNestedFieldModal`,
    `MissingDirectoryModal`). Extend `floe-web\src\dialog\dialog.tsx` once.
  - Do not call `window.confirm` or `window.prompt` from any migrated handler. Do not
    add any new native-popup callsites anywhere.
  - Do not introduce a feature-scoped React context, store, or hook layer for these
    dialogs. The imperative `confirm(request)` / `prompt(request)` API is the contract.
  - Do not replace or wrap the substrate endpoints. `POST /v1/workspaces/register` and
    `POST /v1/workspaces/:id/delete` keep their current request shapes; `delete_locator`
    must still be the boolean derived from the opt-in checkbox.
  - Do not bypass `putFieldSemantic` / `putFieldLayout` or change their if-absent
    semantics; the `ifAbsent: true` guard on the root and nested create paths is the
    duplicate protection at the substrate boundary.
  - Do not move duplicate-detection out of `createNestedFieldItem` into the dialog UI;
    surface the existing check as an inline error, do not change the rule.
- Shortcuts or parallel paths to avoid:
  - Do not split workspace deletion into two sequential `confirm(...)` calls in the new
    system; the AC requires *one* dialog. The opt-in must be a checkbox in the same
    danger dialog and the `delete_locator` boolean must be read from that checkbox.
  - Do not migrate the root Field-creation prompt while leaving the nested Field-creation
    prompt on `window.prompt` (or vice versa). Both must land on the same `prompt`
    helper.
  - Do not migrate the nested Field-creation **click** path while leaving the
    **drag-drop** path on `window.prompt`. The drop handler in `main.tsx` (referenced by
    `tests\field-substrate.spec.ts:127-177`) must also call the new dialog.
  - Do not add a toast/notification layer. Inline `app-dialog-error` is the surface for
    per-action failures.
  - Do not gate the dialog on a feature flag or per-route mount; `<DialogHost />` is
    already mounted at `main.tsx:2695`.
  - Do not introduce ancestor stacking-context, wheel/pointer capture, or document-level
    keydown listeners that bleed into the React Flow canvas when no dialog is open.
  - Do not change `aria-label`s of triggers; tests locate the workspace-delete button
    via `.workspace-delete-button` and Field creation via `getByRole("button", { name:
    /Add field/i })`.
- Invariants:
  - One global dialog primitive owns every confirmation/prompt in FloeWeb. After #16,
    only Field Item delete (`main.tsx:1179`) and whole-Field delete (`main.tsx:1751`)
    may still call `window.confirm`, and only because they belong to a later slice.
  - Cancelling any dialog never calls the bus and never mutates substrate-backed local
    state.
  - Confirming a destructive action runs the existing substrate path exactly as it does
    today, including post-confirm `refresh*` and selection clearing.
  - The dialog renders inside the FloeWeb app shell, dims the background, traps focus,
    closes on Escape, closes on backdrop click when no work is in flight, returns focus
    to the trigger on close.
  - React Flow Field canvas and Block Library behaviors do not regress: pan, zoom, drag,
    selection, handles, icons/labels, rename/open, connection create/label/delete,
    Controls, MiniMap, the Field primitive drag/drop into canvas. Opening the new
    nested-Field dialog must not abort an in-flight drag, must not steal the canvas
    focus while no dialog is mounted, and must not change the existing
    `createNestedFieldItem` substrate sequence (child PUT → parent PUT → optional layout
    PUT with `markLocalLayoutWrite` bracketing).
  - Inline error display lives in the dialog body (`.app-dialog-error`) for action-scoped
    failures; the page-level `.error-bar` remains the surface for ambient errors.

## Integration plan

- Insert the change at:
  - **`floe-web\src\dialog\dialog.tsx`** (and `dialog-controller.ts` if needed):
    - Extend `ConfirmDialogRequest` with optional `checkbox` and `input` slots as typed
      above. Render the checkbox above `.app-dialog-actions` using a new `.check-row`
      inside the dialog body or a sibling `.app-dialog-checkbox` block. Render the text
      input inside `.app-dialog-body` with a labelled `<input>` and inline validation
      message wired through the existing `.app-dialog-error` slot (or a new
      `.app-dialog-field-error` if per-field error placement is preferred — reuse tokens
      either way).
    - Add a `prompt(request): Promise<{ confirmed: boolean; value: string }>` helper and
      (optionally) `confirmWithOptions(request): Promise<{ confirmed: boolean; checked:
      boolean }>`. Both go through the same `dialogController` so the focus/Escape/
      backdrop/loading machinery is shared. Resolve `confirmed: false` on cancel,
      backdrop, Escape, and Esc-while-loading-disabled-by-trap behavior identical to
      today.
    - When `request.input` is present, initial focus moves to the input instead of the
      cancel button, but the cancel button is still in the trap order and Escape still
      cancels.
    - When `request.checkbox` is present, the local checkbox state lives in
      `DialogHost`'s `useState` and is reset on `dialog.id` change. The current state is
      passed into `onConfirm({ checked })` and returned in the resolved value.
    - Add a `data-testid="dialog-text-input"` and `data-testid="dialog-checkbox"` so
      Playwright tests can locate them reliably even before final visual design.
  - **`floe-web\src\main.tsx`**:
    - `registerWorkspace` (`main.tsx:1332-1363`): replace `window.confirm` at
      `main.tsx:1356` with `await confirm({ title: "Create directory?", body: <>The
      folder <strong>{locator}</strong> does not exist. Create it and register the
      workspace here?</>, confirmLabel: "Create folder", cancelLabel: "Cancel",
      variant: "default" })`. On `true`, `return registerWorkspace(true)`. On `false`,
      return. Optionally move the retry call into `onConfirm` to get loading state, but
      that is a polish; the existing AC is met with the post-`await` retry.
    - `deleteWorkspace` (`main.tsx:1375-1395`): replace both confirms with a single
      `await confirm({ title: "Delete workspace", body: <>Remove
      <strong>{label}</strong> from Floe. {locator && <>The workspace folder is
      <code>{locator}</code>.</>}</>, confirmLabel: "Delete", cancelLabel: "Cancel",
      variant: "danger", checkbox: { label: <>Also delete the workspace folder and its
      files from disk</>, defaultChecked: false, testId: "dialog-delete-locator-checkbox"
      }, onConfirm: async ({ checked }) => { await api(busUrl,
      `/v1/workspaces/${id}/delete`, { method: "POST", body: { delete_locator: checked
      } }); } })`. After the promise resolves `true`, run the existing selection/events/
      telemetry reset and `refresh()`. Cancel ⇒ no API call, no state change.
    - `promptCreateField` (`main.tsx:1765-1769`): replace `window.prompt` with
      `const { confirmed, value } = await prompt({ title: "New Field", body: "Give the
      new Field a name.", input: { label: "Field name", placeholder: "e.g. Onboarding",
      autoFocus: true, testId: "dialog-text-input" }, confirmLabel: "Create",
      cancelLabel: "Cancel" })`. On `confirmed`, `createField(value)` (preserving the
      existing empty-name fallback inside `createField`).
    - `promptCreateNestedFieldItem` (`main.tsx:1641-1646`) and the canvas drop handler
      (the one currently expecting `page.once("dialog", ...)` in
      `tests\field-substrate.spec.ts:127-177`): replace `window.prompt` with a `prompt`
      call. Inline-validate duplicate refs by routing the duplicate guard from
      `createNestedFieldItem` (`main.tsx:1658-1661`) into the dialog `onConfirm`
      rejection so the existing
      `"That Field is already in this Field."` message surfaces as
      `.app-dialog-error`. After the dialog resolves `true`, call
      `createNestedFieldItem(value, position)` with the existing substrate sequence
      intact.
  - **No new files** are required outside the dialog module. CSS additions, if any,
    appended to `floe-web\src\styles.css` under the existing `/* dialog */` region near
    line 524.
- Why this is the correct integration point:
  - It satisfies "one global dialog primitive owns every confirmation/prompt" by
    extending the #15 module rather than parallel-implementing.
  - It collapses the workspace-delete two-popup chain into one dialog, which is the
    exact AC and also resolves the existing UX awkwardness called out by the issue.
  - It keeps every substrate path (`register`, `/delete`, `putFieldSemantic`,
    `putFieldLayout`) and every post-confirm side effect inside the same `main.tsx`
    handlers, so the diff is local and the regression surface is small.
  - It exercises both the checkbox and text-entry capabilities anticipated by the #15
    brief and parent PRD #14, paying down the "later slices need this" debt in one slice.
- Alternatives considered and rejected:
  - **Keep two confirms for workspace delete** (translate each `window.confirm` to a
    separate `confirm(...)` call): rejected — AC explicitly requires *one* danger
    dialog with the opt-in inside.
  - **Build feature-scoped components** (`WorkspaceDeleteDialog`,
    `CreateFieldDialog`, `CreateNestedFieldDialog`, `MissingDirectoryDialog`):
    rejected — violates parent #14's "no parallel modal" rule and the #15 invariant.
  - **Skip the drop-path nested-Field migration in #16**: rejected — both code paths
    use the same prompt UI and both have Playwright coverage that asserts native
    dialogs; leaving one on `window.prompt` would split the system.
  - **Use the native HTML `<dialog>` element for the new input shell**: rejected on
    the same grounds as #15 (cross-browser focus/backdrop inconsistency).
  - **Resolve `confirm` with `boolean` only and read checkbox state via a side channel**
    (e.g. a `ref` captured by the caller): rejected — couples callers to dialog
    internals and re-introduces the parallel-state-machine problem #15 just removed.
    Either evolve `confirm` to return a richer result type, or add a sibling
    `confirmWithOptions` / `prompt` helper.

## Regression checklist

- Behavior: Workspace registration with a missing directory still recovers via a single
  confirm-and-retry: the second `POST /v1/workspaces/register` carries
  `create_directory: true` only after the user confirms; dismissing it makes no second
  call (covered by `workspace-management.spec.ts:6-91`, rewritten against the in-app
  dialog).
- Behavior: `.workspace-delete-button` remains hover-revealed on `.workspace-row`,
  triggers one in-app danger dialog, and *never* triggers a native `window.confirm`
  (verified by an assertion that `page.on("dialog", ...)` records zero events during the
  flow).
- Behavior: Confirming workspace delete with the checkbox unchecked sends
  `POST /v1/workspaces/:id/delete` with `{ delete_locator: false }`; with the checkbox
  checked, sends `{ delete_locator: true }`. Cancel sends nothing. Replaces
  `workspace-management.spec.ts:93-189` end-to-end behavior.
- Behavior: After confirmed workspace delete on the currently selected workspace,
  `selectedWorkspaceId` clears, `endpoints`/`events`/`telemetry` clear, and `refresh()`
  is called once. Behavior identical to `main.tsx:1387-1394`.
- Behavior: "Add field" opens a text-entry dialog; submitting with name `"My New Field"`
  sends `PUT /v1/workspaces/:id/fields/my-new-field?if_absent=true` with body
  `{ id: "my-new-field", title: "My New Field", ... }` and then navigates the view to
  the new Field (replaces `field-substrate.spec.ts:579-606`). Submitting empty falls
  back to `Field <N>` per `createField`'s existing rule.
- Behavior: Field block click while a Field is open opens a text-entry dialog for nested
  Field creation; submitting writes the child semantic, then the parent semantic with
  the new item, then optionally the layout; substrate sequence and payload shape
  unchanged from `createNestedFieldItem`.
- Behavior: Nested Field drop on canvas opens the same text-entry dialog (not a native
  prompt) with `position` preserved; replaces `field-substrate.spec.ts:127-177`
  expectations.
- Behavior: Duplicate nested-Field name produces inline error
  `"That Field is already in this Field."` inside the dialog without making any PUT.
- Behavior: Cancel on every migrated dialog produces zero bus calls and zero local-state
  mutation; verified by route counters and an empty `page.on("dialog", ...)` recorder.
- Behavior: All non-migrated popups still work: Field Item delete (`main.tsx:1179`),
  whole-Field delete (`main.tsx:1751`). They remain on `window.confirm` until #17/#18.
- Behavior: React Flow canvas (pan, zoom, drag, selection, handles, node icons/labels,
  rename, open, connection create/label/delete, Controls, MiniMap), Block Library
  drag/drop, the Field primitive drag affordance, and the `.error-bar` global error
  display all continue to work.
- Behavior: Conversation-delete dialog (the #15 reference migration) still passes
  `tests\context-rendering.spec.ts:803-865`.

## Test plan

- Existing tests to keep green:
  - `tests\context-rendering.spec.ts:803-865` — conversation delete via in-app dialog
    must continue to pass (extending the dialog must not regress its existing API).
  - `floe-web\src\dialog\dialog-controller.test.ts` — pure controller behaviors
    (open/close/replace) remain; add cases for `checkbox`/`input` state if the
    controller carries them, or keep the controller request-shape-agnostic and exercise
    the new state in jsdom/Playwright instead.
  - All non-migrated Playwright tests: `field-substrate.spec.ts:608-628` (Delete field —
    still uses `window.confirm`), Field Item delete tests, rename, connection, layout,
    Block Library drag/drop tests, conversation rendering tests.
- New tests to add before/with implementation (TDD red phase):
  - **Workspace management** (rewrite `workspace-management.spec.ts`):
    - Missing-directory accept: type a path, intercept `register` to return
      `directory_not_found`, click "Create Workspace", assert in-app dialog with title
      `Create directory?` and body containing the locator, click `Create folder`,
      assert second `register` call has `create_directory: true`, assert
      `page.on("dialog", ...)` recorded **0** events.
    - Missing-directory cancel: as above but click `Cancel`; assert exactly one
      `register` call and no in-app dialog left mounted.
    - Workspace delete keep-files: hover row, click `.workspace-delete-button`, assert
      one `role="dialog"` named `Delete workspace`, checkbox visible and unchecked by
      default, click `Delete`, assert `POST /v1/workspaces/:id/delete` body
      `{ delete_locator: false }`, assert no second dialog.
    - Workspace delete remove-files: as above, click the checkbox, click `Delete`,
      assert body `{ delete_locator: true }`, assert `page.on("dialog", ...)` 0 events.
    - Workspace delete cancel: open dialog, click `Cancel`, assert zero `/delete` calls
      and workspace row still present.
    - Workspace delete focus/escape: Escape closes with no API call; backdrop click
      closes with no API call; focus returns to `.workspace-delete-button`.
  - **Field creation** (extend `field-substrate.spec.ts`):
    - Add-field opens text-entry dialog: click `Add field`, assert
      `role="dialog"` with text input, type `My New Field`, click `Create`, assert
      `PUT /v1/workspaces/:id/fields/my-new-field?if_absent=true` body
      `{ id: "my-new-field", title: "My New Field" }`, assert view navigates to the new
      Field, assert `page.on("dialog", ...)` 0 events.
    - Add-field empty-name fallback: leave input empty, click `Create`, assert id and
      title derived as `field-<N>` per `slugifyFieldId`/`Field <N>` fallback.
    - Add-field cancel: open dialog, press Escape, assert zero PUTs and no view change.
    - Live bus stack create + delete field (`field-substrate.spec.ts:641-704`):
      rewrite to drive the in-app text-entry dialog instead of `page.once("dialog",
      ...)`; assert YAML on disk identical to today.
    - Nested Field click: open a Field, click the Field block in the Block Library,
      assert dialog appears, type `Dropped Field`, click `Create`, assert child PUT,
      parent PUT with `field-dropped-field`/`field:dropped-field` items, assert no
      native dialog.
    - Nested Field drop: rewrite `field-substrate.spec.ts:127-177` to drive the in-app
      dialog (drop, then type name in the new dialog, then `Create`), and assert
      layout PUT happens at the drop coordinates.
    - Nested Field duplicate: pre-seed a parent with `field:dropped-field`, open
      dialog, type `Dropped Field`, click `Create`, assert inline error
      `That Field is already in this Field.` and zero PUTs.
  - **Dialog shell unit/component** (Vitest + jsdom if added, otherwise Playwright):
    - Initial focus moves to text input when `input` is present.
    - Checkbox default state honors `defaultChecked`; toggling is reflected in the
      resolved `{ checked }` value and in `onConfirm({ checked })`.
    - `prompt` resolves `{ confirmed: false, value: "" }` on cancel/Escape/backdrop.
    - `validate` (if implemented) blocks confirm and surfaces inline error without
      calling `onConfirm`.
- Live proof required:
  - Playwright headed run against the real bus stack (mirroring the existing
    `field-substrate.spec.ts:641-704` pattern) showing:
    1. Workspace delete with checkbox unchecked: folder remains on disk; workspace
       removed from FloeWeb; `/delete` payload `{ delete_locator: false }`.
    2. Workspace delete with checkbox checked: folder removed from disk; `/delete`
       payload `{ delete_locator: true }`.
    3. Root Field creation via dialog: YAML appears under `.floe/fields/<id>.yaml`.
    4. Nested Field creation via dialog (click and drop): parent YAML lists the new
       item, child YAML created at `.floe/fields/<child-id>.yaml`, optional layout
       YAML written when dropped at a position.
    5. Cancel paths: no YAML mutation, no HTTP call to the bus.
  - Screenshots of the new in-app dialogs for: missing directory, workspace delete
    (checkbox unchecked and checked), Add Field, nested-Field click, nested-Field drop,
    duplicate-nested inline error.
  - DevTools `Network` capture (or Playwright `route` counters) showing native
    `window.prompt`/`window.confirm` are never invoked on migrated flows.

## Risk assessment

- Risk: Extending `ConfirmDialogRequest` with `checkbox`/`input` changes the resolved
  type of `confirm`, which can silently break the conversation-delete callsite at
  `main.tsx:1514`. Mitigation: keep `confirm(req): Promise<boolean>` backward compatible
  (no `checkbox`/`input`); add a separate `prompt(req)` and either
  `confirmWithOptions(req)` or have `confirm` widen its result only when `checkbox` is
  present (via overloads). Verify by running `context-rendering.spec.ts:803-865` after
  the change.
- Risk: The focus-trap in `dialog.tsx:88-108` skips elements with no `offsetParent`. If
  the input or checkbox is added inside a container that becomes display:none briefly
  during transitions, Tab order could break. Mitigation: render input/checkbox in the
  same `app-dialog-body`/`app-dialog-actions` containers already in the trap; add a
  focus-trap test.
- Risk: The duplicate-nested-Field check currently runs inside
  `createNestedFieldItem` *after* the dialog closes. Moving it into the dialog
  `onConfirm` means the dialog must stay open on rejection — the existing
  `confirmActive` already does this via `setLoading(false)` after `setInlineError`.
  Mitigation: throw `new Error("That Field is already in this Field.")` from `onConfirm`
  before issuing the substrate writes; assert in a Playwright test.
- Risk: The drag-drop nested Field path holds a `DataTransfer` and React Flow drag
  state when the dialog opens. Opening a portal-mounted modal mid-drop could leave
  React Flow in an inconsistent drag state. Mitigation: open the dialog only after the
  `drop` handler has finalized React Flow's drag (i.e. inside the existing async
  follow-up, not inside the synchronous `dragend`); add a Playwright assertion that
  React Flow remains interactive after cancelling the dialog.
- Risk: Replacing two sequential native confirms with one dialog changes the order in
  which workspaces are removed visually vs. the bus call. Today the bus call always
  runs after both confirms; in the new flow the bus call runs from `onConfirm` once.
  Mitigation: pass the API call as the dialog's `onConfirm` so loading state is
  visible during the round-trip and post-confirm state updates run after the dialog
  resolves `true`, identical to `deleteConversation`.
- Risk: The current `registerWorkspace` does not wrap the non-`directory_not_found`
  rethrow in `setError`, so an unrelated bus failure surfaces as an unhandled rejection.
  This is pre-existing and out of scope for #16; do not silently change it.
- Risk: Empty-string trim in `createField`/`createNestedFieldItem` falls back to a
  generated name. If the dialog validates non-empty, behavior subtly changes (no more
  default-named Fields). Mitigation: do not validate non-empty; or change the fallback
  too, in agreement with product. Recommendation: keep the fallback.
- Risk: Tests that currently rely on `page.on("dialog", ...)` will silently pass if
  they're left in place after migration (because no native dialog ever fires, and the
  recorder stays empty). Mitigation: explicitly assert
  `expect(nativeDialogs).toEqual([])` in every migrated test, and locate the new dialog
  by `getByRole("dialog", { name: ... })`.

### Conflicts between docs and code

- **Issue text says "Nested Field creation … through the existing bus-backed path"**
  without distinguishing the click and drop entry points. The code has two callsites
  (`promptCreateNestedFieldItem` at `main.tsx:1641` and the drag-drop handler exercised
  by `field-substrate.spec.ts:127-177`). The brief treats both as in scope; flag during
  implementation if product wants the drop path to skip the prompt and auto-name
  instead.
- **Issue text wording on workspace deletion** ("removing workspace from Floe is the
  base action and deleting the local workspace folder is an explicit opt-in") differs
  from today's chained-confirm where neither popup gates the API call — the second
  popup only flips the `delete_locator` flag. The new dialog must continue to *always
  call* `/delete`; only the boolean changes. This matches the AC literally.
- **`issue-15` brief lists `main.tsx:1355` as the missing-directory confirm** but the
  current line is `main.tsx:1356`. Off by one due to subsequent edits; cite line ranges,
  not exact numbers, in implementation comments.

### Parallel-path warnings

- Any implementation that builds a `WorkspaceDeleteDialog.tsx` /
  `CreateFieldDialog.tsx` / `CreateNestedFieldDialog.tsx` component is a parallel path
  around the global dialog owner and must be rejected in review.
- Any implementation that keeps `deleteWorkspace` as two sequential `confirm(...)`
  calls (even if both are in-app) is a parallel path around the AC.
- Any implementation that resolves opt-in state via a `useRef` shared with the caller
  instead of through the dialog's resolved value is a parallel state machine and must
  be rejected.

## Decision confidence

- Confidence: **high**.
- Reasons:
  - The four migrations all reduce to "call `confirm`/`prompt` and run the existing
    handler bodies" — they share a substrate-stable seam.
  - The dialog module already owns the modal lifecycle and only needs two small typed
    additions (`checkbox`, `input`) and one new entry point (`prompt`).
  - Test rewrite is mechanical: every targeted Playwright test today uses
    `page.on("dialog", ...)`; each becomes a `getByRole("dialog", ...)` block with the
    same final API/state assertions.
  - The conversation-delete migration (#15) already proves the integration point and
    the `onConfirm`/inline-error pattern works against the real bus.
- Open questions (low-impact, can be decided during TDD without blocking):
  - Whether to evolve `confirm`'s return type via overloads or to add a sibling
    `confirmWithOptions` / `prompt` helper. Either is acceptable as long as exactly
    one dialog implementation exists.
  - Whether the drag-drop nested-Field path should prompt for a name (preserve today's
    behavior) or auto-name from a default like `Field <N>` and skip the dialog. This
    brief recommends preserving the prompt for consistency with the click path; flip
    only on explicit product call.
  - Whether to add a thin `.app-dialog-input` / `.app-dialog-checkbox` CSS section or
    reuse `.workspace-form label` / `.check-row` directly inside the dialog. Either
    works; reuse existing tokens.
