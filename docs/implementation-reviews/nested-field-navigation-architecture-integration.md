# Architecture Integration Brief: nested-field-navigation

## Scope

Fix the FloeWeb Field UX bug where Fields referenced by another Field item (`field:<id>`) appear as workspace-root Fields and Back from an opened nested Field returns to workspace home instead of the parent Field.

This is a navigation/listing integration change only. Do not change Field storage, Field item refs, semantic YAML shape, layout sidecars, or React Flow canvas interaction patterns.

## Existing ownership and source of truth

- **Field semantics:** workspace files under `.floe\fields\<field-id>.yaml` are authoritative. `CONTEXT.md` and ADR 0003 define Fields as workspace-local substrate primitives; bus state is only a derived index; FloeWeb is only a renderer/editor.
- **Field nesting:** there is no directory hierarchy. A Field is nested for UI purposes when some other Field semantic file has an item whose `ref` is `field:<child-id>`.
- **Bus file I/O/index:** `floe-bus\src\fields-store.ts` owns reading/writing Field semantic and layout YAML. `loadAllFields()` currently returns every valid semantic file except layout sidecars.
- **HTTP contract:** `floe-bus\src\server.ts` exposes `GET /v1/workspaces/:workspace_id/fields` by returning `loadAllFields(locator)`. `floe-web\src\fields-api.ts` should remain a thin client and not access `.floe\` directly.
- **FloeWeb UI/navigation:** `floe-web\src\main.tsx` owns home list rendering, opening Fields, nested Field creation, double-click open, and Back. Current `View` is only `{ kind: "home" } | { kind: "field"; fieldId: string }`, so parent provenance is lost.
- **React Flow:** existing canvas gestures, node labels/icons/handles/selection, Block Library drag/drop, pan/zoom/drag performance, connection affordances, and layout persistence must remain untouched.

## Root vs nested visibility plan

Derive workspace-root visibility from Field graph semantics, not paths and not ad hoc title/id conventions:

1. Add a pure derivation over the currently loaded `FieldSummary[]` plus loaded Field semantics where practical: collect every `field:<id>` reference found in every Field's `items`; root Fields are summaries whose `id` is not in that referenced-child set.
2. Prefer doing the root/nested classification in the bus list endpoint or store layer if the implementation can inspect all semantic files while listing. This keeps the home list source-of-truth close to `loadAllFields()` and ensures every client gets the same root list semantics.
3. If preserving the existing `/fields` response as "all fields" is needed for pickers, add an explicit client-side selector in FloeWeb: `rootFieldSummaries` for workspace home and `fieldItemOptions` sourced from all summaries. Do not silently break nested-field picker options.
4. Keep every Field as `.floe\fields\<id>.yaml`; nested child files remain sibling files in `.floe\fields\`. Do not introduce `.floe\fields\parent\child.yaml`, `parent_id` metadata, or layout-driven hierarchy.
5. Workspace home should default to Root Fields for orientation, but must provide an explicit Show all toggle/filter so users can still see every Field in the workspace. When nested Fields are shown, mark them as nested rather than implying they are roots. If a Field summary has no parent metadata, treat it as a Root Field; no known parent must not hide a Field.

Important nuance: a child can be referenced by more than one parent. The brief does not introduce ownership or containment. "Nested" means "referenced by at least one Field item" for workspace-home filtering.

## Back/navigation plan

Represent navigation provenance explicitly in FloeWeb:

- Extend `View` to carry an optional parent/back target, e.g. `{ kind: "field"; fieldId: string; parentFieldId?: string }` or a small stack if deeper nesting is supported immediately.
- Root opens from workspace home and direct opens (including creating a new root Field) set no parent. Back returns to workspace home.
- Nested opens from `handleFieldNodeDoubleClick` set the current Field as parent, e.g. opening child from parent creates `view = { kind: "field", fieldId: childId, parentFieldId: current.semantic.id }`.
- Back checks provenance: if `parentFieldId` exists, clear editing state, load/open that parent Field, and keep the user on the Field surface; otherwise return home.
- For deeper nesting, prefer a navigation stack (`backStack: string[]`) over one parent field if implementation evidence shows chains are common. A single parent is acceptable for the reported bug, but should not block later stack conversion.
- Direct opens of a child Field from URL/dev tooling or any future command without parent provenance should behave as root opens: Back goes home, not to a guessed parent.
- If multiple parents reference the same child, do not infer a parent on direct open. Only the click path supplies the parent.

Toolbar UX should reflect the target: title/aria-label should say "Back to <Parent Title>" when parent provenance exists, and "Workspace Home" otherwise. Avoid adding a side panel or breadcrumb unless explicitly scoped.

## Regression checklist

- Workspace home defaults to root Fields; a Field referenced as `field:<id>` by another Field does not render as a `.field-block` in the default root view.
- Workspace home provides a Show all toggle/filter that reveals nested Fields and marks them as nested.
- Field summaries without parent metadata remain visible as Root Fields.
- Nested child Field files still exist as `.floe\fields\<child-id>.yaml` and can be loaded by id.
- Root Field creation still creates a root Field and opens it.
- Creating/dropping a nested Field in an open Field creates the child semantic file and parent `field:<child-id>` item, then home still shows only the parent/root Fields.
- Double-clicking a nested Field node opens the child Field and preserves canvas behavior.
- Back from nested child returns to the parent Field, not home.
- Back from root-opened or directly-opened Field returns to workspace home.
- Field item picker still permits adding existing Fields as nested refs and excludes the current Field / already-present refs as today.
- React Flow handles, labels, selection, edge creation/deletion/reconnect, node drag, pan/zoom, viewport restore, rename/open affordances, and Block Library drag/drop remain unchanged.

## Tests to add or keep

- `floe-bus\src\fields-store.test.ts`: add a store-level test for deriving/listing root Fields when `parent.yaml` contains item `{ ref: "field:child" }`; child remains loadable via `loadField()`.
- `floe-bus\src\fields-server.test.ts`: assert `GET /fields` behavior matches the chosen contract. If it becomes root-only, assert child omission. If API stays all-fields, document and test the separate root derivation elsewhere.
- `floe-web\src\fields.test.ts`: add a pure helper test for collecting nested Field ids / deriving root summaries if implemented in web helpers.
- `floe-web\tests\field-substrate.spec.ts`: keep/add Playwright coverage for "nested Fields stay out of workspace root list, Show all reveals them, and Back returns to parent". The current file already contains this scenario around lines 195-215; ensure it fails before the fix and passes after.
- Add/keep a companion Playwright test for direct/root open: opening a root Field and pressing Back returns home; directly opening a child without parent provenance also returns home.
- Live QA: with a real bus workspace, create/open parent, drop/create child, verify `.floe\fields\parent.yaml` references `field:child`, `.floe\fields\child.yaml` is a sibling file, home hides child by default, Show all reveals and marks child as nested, nested Back returns parent, root Back returns home.

## Risks

- Filtering `fieldSummaries` globally in FloeWeb can accidentally remove child Fields from the "add Field item" picker or from title lookup for an opened child. Use separate all/root collections or preserve all summaries for non-home uses.
- Moving nesting into paths or metadata would conflict with ADR 0003 and make external YAML edits less portable.
- Guessing a parent for direct opens is ambiguous when a child has multiple parents and can route users to the wrong Field.
- Bus-level root-only list may be a breaking API change if other clients expect all Fields. If uncertain, keep API all-fields and make FloeWeb home filtering explicit until a versioned API contract is agreed.
- Existing mocked Playwright helpers currently summarize all seeded fields; if root filtering moves to bus only, mocked routes must mimic that behavior or web tests will be misleading.

## Do-not-bypass list

- Do not write directly to `.floe\` from FloeWeb; keep using `fields-api.ts` and bus endpoints.
- Do not change Field YAML schema, ref format, item ids, connection ids, or layout sidecar schema.
- Do not use nested directories, `parent_id`, hidden flags, or renderer layout to define hierarchy.
- Do not infer parent from title, id prefix, creation time, or currently selected summary.
- Do not replace React Flow-native canvas behavior or regress node/edge interactions.
- Do not make nested children undeletable/unloadable; hiding from home is not deletion or access control.

## Decision confidence

Confidence: high for deriving nesting from `field:<id>` Field Items and preserving sibling YAML files. Medium on whether root filtering belongs in bus or FloeWeb because current `/fields` returns all valid semantic files and may be used both as a home list and as an all-fields picker source. Recommended implementation: keep all summaries available, introduce an explicit root-summary derivation for the workspace home, and only move the API to root-only if the implementation also provides an all-fields path for pickers.
