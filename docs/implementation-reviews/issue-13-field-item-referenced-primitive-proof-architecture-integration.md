# Architecture Integration Brief: issue-13-field-item-referenced-primitive-proof

## Existing ownership

- Package/component/module/library:
  - `@xyflow/react` owns Field canvas selection, node/edge focus, Delete/Backspace intent, handles, edge gestures, `onBeforeDelete`, `onEdgesDelete`, `onReconnect`, pan, zoom, drag, Controls, and MiniMap (`floe-web\src\main.tsx:206-225,2065-2095`; `docs\implementation-reviews\issue-12-field-item-delete-confirmation-architecture-integration.md:5-9`).
  - `floe-web\src\fields.ts` owns Field semantic transforms and edit rules. `fieldToReactFlow()` maps Field Items to deletable React Flow nodes, and `buildSemanticUpdate(..., { type: "remove_item" })` removes only the field-local item plus touching Field Connections (`floe-web\src\fields.ts:165-205,263-348`).
  - `floe-web\src\main.tsx` owns FloeWeb Field/canvas wiring, save orchestration, `handleFieldBeforeDelete`, Field Item add flows, Field Connection handlers, root/show-all filtering, nested open/back provenance, and whole-Field delete UI (`floe-web\src\main.tsx:400-426,949-966,1087-1207,1593-1710,1797-1835,1991-2140`).
  - `floe-web\src\fields-api.ts` owns FloeWeb's Field HTTP client. FloeWeb must use bus APIs such as `putFieldSemantic`, `putFieldLayout`, `getField`, `listFields`, and `deleteField`, not direct workspace file writes (`floe-web\src\fields-api.ts:169-229`).
  - `floe-bus\src\fields-store.ts` owns `.floe\fields\*.yaml` validation, file I/O, parent-count derivation from `field:<id>` refs, and whole-Field semantic/layout deletion (`floe-bus\src\fields-store.ts:122-153,165-196,222-288,290-380`).
  - `floe-bus\src\server.ts` owns endpoint registration/listing APIs used to prove Actor preservation (`POST /v1/endpoints/register`, `GET /v1/workspaces/:workspace_id/endpoints`) (`floe-bus\src\server.ts:501-529`).
- Current owner rationale:
  - `CONTEXT.md` defines Field semantic YAML as source of truth; Field Items are field-local references to existing substrate primitives; Nested Fields remain sibling files and are not owned by parents (`CONTEXT.md:78-101`).
  - ADR 0003 rejects block storage duplication and says FloeWeb is only one renderer/editor over bus-owned Field files (`docs\adr\0003-field-substrate-primitive.md:15-21,30-35`).
  - #12 already integrated deletion through React Flow-native `onBeforeDelete` and `buildSemanticUpdate(remove_item)`; #13 should prove those invariants, not invent a second delete path.
- Source evidence:
  - #12 implementation is present at `112c264 Add field item deletion confirmation`; current `main` has no product diff except pre-existing untracked `.scratch\`.
  - Current tests already cover mocked selected Field Item deletion confirmation/cascade and mocked nested Field Item preservation, but the nested preservation proof is not real bus/file-backed and does not cover Actor endpoint preservation or post-delete navigation/filtering (`floe-web\tests\field-substrate.spec.ts:386-523`).
  - Current real bus/file-backed tests cover create/delete Field, rename, add Actor/nested Field Items, and external YAML live rendering, but not deletion preservation for referenced primitives (`floe-web\tests\field-substrate.spec.ts:641-934`).

## Existing interaction model

- User/system behaviors that already exist:
  - Workspace home defaults to Root Fields (`parent_count` missing/zero) and has a Show all toggle that reveals nested Fields with a `nested` marker (`floe-web\src\fields.ts:161-163`; `floe-web\src\main.tsx:400-405,1919-1947`).
  - A Field referenced by `field:<child-id>` stays a normal sibling `.floe\fields\<child-id>.yaml`; parent/nested status is derived from current references, not paths or ownership metadata (`CONTEXT.md:82-92`; `floe-bus\src\fields-store.ts:263-284`).
  - Field Items render as React Flow custom nodes with visible labels and target/source handles; Field Connections render as React Flow edges with labels and reconnect affordances (`floe-web\src\main.tsx:206-225,227-305,2065-2095`).
  - Field Item deletion is selected-node Delete/Backspace through `onBeforeDelete`, confirms with copy stating referenced primitives are preserved, saves through `buildSemanticUpdate(remove_item)`, refreshes Field summaries, and returns `false` so React Flow does not locally diverge from substrate state (`floe-web\src\main.tsx:1151-1207`).
  - Field Connection create/label/delete/reconnect flows are React Flow-native intent handlers that persist semantic YAML through `saveOpenFieldSemantic` (`floe-web\src\main.tsx:1087-1149,1209-1237,1530-1568`).
  - Double-clicking a nested Field item opens the child with `backStack` provenance; Back uses that provenance and must not infer parents for direct/root opens (`floe-web\src\main.tsx:1797-1835,1991-1999`).
  - Adding Actor and Field Items uses toolbar flows over currently loaded endpoints and Field summaries; nested Field drag/drop uses the Block Library drag/drop surface (`floe-web\src\main.tsx:406-426,1593-1710,1763-1795`).
- Behaviors that must remain unchanged:
  - Use existing React Flow graph/canvas features before hand-rolling interactions.
  - Preserve Block Library drag/drop unless explicitly redesigned.
  - Preserve node icons, labels, handles, selection, pan, zoom, drag, rename, open, connection, edge label, delete, and reconnect affordances.
  - Substrate-backed behavior must integrate into the existing Field/canvas model, not create a separate path.
  - Toolbar shortcuts may supplement canvas flows, not silently replace them.
  - Performance regressions in navigation, pan, zoom, or drag are blockers.
  - Existing working affordances require regression tests before refactor.
  - Deleting a Field Item removes a reference from one parent Field and cascades only touching parent Field Connections; it must not call whole-Field delete, unregister endpoints, delete child Field files, or mutate layout as a semantic side effect.
- Runtime or UX evidence:
  - Automated Playwright already exercises node/edge render, viewport restore, Block Library drop, nested Back, connection create/label/delete/reconnect, Field create/delete, real bus/file-backed persistence, rename, add Actor/nested Field Items, and watcher-driven live YAML edits (`floe-web\tests\field-substrate.spec.ts:46-934`).
  - `saveOpenFieldSemantic()` refreshes `fieldSummaries` after PUT, so parent-count/root-filtering should update after deleting a `field:<child-id>` item (`floe-web\src\main.tsx:949-966`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Existing Playwright e2e file: add the smallest #13 proof beside the current real bus stack Field tests in `floe-web\tests\field-substrate.spec.ts`, reusing `createBusServer`, `defaultConfig`, `makeFieldSemantic`, `YAML`, and file inspection patterns already present there (`floe-web\tests\field-substrate.spec.ts:641-934`).
  - Existing bus endpoint registration/list APIs: register a real Actor endpoint through `POST /v1/endpoints/register` and assert it remains through `GET /v1/workspaces/:workspace_id/endpoints` after deleting its Field Item (`floe-bus\src\server.ts:501-529`; `floe-web\tests\field-substrate.spec.ts:801-862`).
  - Existing Field item add UI: use `Add actor item` / `Add field item` for the proof instead of seeding only final state, so the test covers current user-visible creation paths (`floe-web\src\main.tsx:2035-2051`; `floe-web\tests\field-substrate.spec.ts:830-844`).
  - Existing React Flow deletion and connection gestures: use selected node Delete/Backspace, handle drag for Field Connection creation, and current dialog handling (`floe-web\tests\field-substrate.spec.ts:223-274,386-479`).
  - Existing root/show-all/nested marker assertions and navigation assertions should be extended after deletion (`floe-web\tests\field-substrate.spec.ts:195-220`).
  - Existing live QA prior art may be adapted from the session-state #12 script, but it must remain outside product code unless explicitly promoted.
- Relevant docs or library capabilities:
  - ADR 0003: semantic Field files are authoritative and Field Items reference existing primitives; renderer layout is a sidecar (`docs\adr\0003-field-substrate-primitive.md:15-21`).
  - Glossary: `Field Item Ref` may point at `actor:<id>` or `field:<field-id>`; the substrate does not pre-validate resolvability, so Actor preservation proof should query the endpoint registry rather than assume ref validity (`CONTEXT.md:88-92`).
- Existing examples in this codebase:
  - Real bus add-items test registers `actor:${workspace.workspace_id}:floe`, adds it through the UI, verifies the full ref is not leaked, verifies parent YAML refs, and verifies endpoint list still contains the Actor (`floe-web\tests\field-substrate.spec.ts:778-862`).
  - Mocked deletion test verifies `remove_item` cascades touching connections and writes no layout PUT (`floe-web\tests\field-substrate.spec.ts:386-479`).
  - Mocked nested deletion test verifies no `DELETE /fields/child-field` request and that the child appears when Show all is enabled after parent reference deletion (`floe-web\tests\field-substrate.spec.ts:481-523`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not add document-level key handlers, toolbar-only delete, Inspector-only Field Item delete, direct React state node removal, or direct DOM manipulation to prove #13.
  - Do not bypass React Flow selection/focus/delete, handles, edge gestures, pan/zoom/drag, or MiniMap/Controls.
  - Do not bypass `buildSemanticUpdate(remove_item)` for cascade semantics.
  - Do not bypass `saveOpenFieldSemantic` / `putFieldSemantic` / bus persistence from FloeWeb.
  - Do not bypass `floe-bus\src\fields-store.ts` for semantic validation or parent-count derivation.
  - Do not bypass endpoint registration/listing APIs when proving Actor preservation.
- Shortcuts or parallel paths to avoid:
  - Do not call `deleteFieldApi` / `DELETE /fields/:fieldId` for Field Item deletion.
  - Do not unregister or delete endpoints when deleting `actor:<id>` Field Items.
  - Do not delete `.floe\fields\<child-id>.yaml` or layout sidecars when deleting a parent `field:<child-id>` item reference.
  - Do not introduce `parent_id`, nested directories, hidden flags, ownership metadata, or layout-driven hierarchy.
  - Do not implement a broad primitive-kind matrix in #13; prove Actor endpoint + nested Field file because they cover the risky existing substrate and navigation behaviors.
  - Do not create a separate "proof mode" UI, test-only product branch, or custom file-backed path around the current UI/API owners.
- Invariants:
  - Field Item ids remain field-local `item_id`; Field Connections point to item ids, not refs.
  - A nested Field is derived from current `field:<id>` references and can become a Root Field immediately after the last parent reference is removed.
  - Direct/root opens do not infer a parent; only nested opens from a parent node carry `backStack`.
  - Semantic source of truth is `.floe\fields\<id>.yaml`; layout remains `.layout.floeweb.yaml`.
  - Performance regressions in navigation, pan, zoom, or drag are blockers.

## Integration plan

- Insert the change at:
  - Add one focused real bus/file-backed Playwright test in `floe-web\tests\field-substrate.spec.ts`, adjacent to the current real bus add-items/deletion tests. It should use the existing `createBusServer`/workspace setup style and current UI flows, not product-code-only helper shortcuts.
  - Optionally add a small unit assertion in `floe-web\src\fields.test.ts` only if implementers find a missing pure-helper invariant. Current `remove_item` coverage already asserts touching connections are removed and unrelated connections preserved (`floe-web\src\fields.test.ts:310-328`), so unit work is likely unnecessary.
  - Produce live QA evidence outside product code (for example under the active session-state files directory or a non-product QA artifact location) by adapting the #12 live QA script and capturing screenshots plus a summary artifact with inspected semantic YAML paths.
- Why this is the correct integration point:
  - The requested slice is a hardened regression/proof slice. Product code changes are likely unnecessary because #12 already implemented the behavior and existing owners have the required hooks.
  - Playwright real bus/file-backed coverage is the narrowest way to prove the integrated UI → bus API → YAML → summary/navigation chain.
  - Keeping #13 proof in the existing Field substrate spec preserves regression coverage for the exact user-visible paths: add item, connect, nested open/back, delete via React Flow, inspect YAML, reload/open from home.
- Recommended automated proof shape:
  - Start a real bus with a real workspace, register a real Actor endpoint, create/seed a parent Field and sibling child Field semantic YAML under `.floe\fields\`.
  - Add the Actor Field Item and child Field Item through FloeWeb UI where practical; create a Field Connection touching the child item through React Flow handles.
  - Before deletion, assert root view hides child, Show all reveals child with `nested`, parent-open → child double-click → Back returns parent.
  - Delete the nested Field Item through selected-node Delete/Backspace confirmation; assert parent YAML no longer contains `field:<child-id>`, parent connections no longer contain any connection touching that item, child YAML still exists as `.floe\fields\<child-id>.yaml`, `GET /fields/<child-id>` still loads, and no child Field DELETE request occurred.
  - After deletion, assert default root view now shows both parent and child as Roots, Show all has no stale nested marker for child, direct/root opening child shows Back target `Workspace Home`, and Back returns home.
  - Delete the Actor Field Item through the same canvas delete path; assert parent YAML no longer contains the Actor item and `GET /v1/workspaces/:workspace_id/endpoints` still contains the registered Actor endpoint.
- Alternatives considered and rejected:
  - Broad primitive matrix: rejected because #13's selected scope is "Harden with tests + live QA" and Actor/nested Field cover endpoint registry and Field file/navigation risk without overbuilding.
  - Product code change first: rejected unless the proof test exposes a real gap; current #12 code path already matches the invariant.
  - Direct YAML mutation from FloeWeb or test-only product API: rejected because it bypasses the bus/FloeWeb interaction path the slice is proving.
  - Only mocked Playwright: rejected because acceptance requires real bus/file-backed QA.

## Regression checklist

- Behavior: deleting an Actor Field Item writes only the parent Field semantic file and does not unregister or remove the referenced Actor endpoint.
- Behavior: deleting a nested `field:<child-id>` Field Item writes only the parent Field semantic file and does not delete `.floe\fields\<child-id>.yaml`.
- Behavior: deleting the nested Field Item removes the parent `field:<child-id>` item and every parent Field Connection touching that field-local item id.
- Behavior: child Field remains a sibling file, remains loadable through the bus, and can be opened from home after the parent reference is gone.
- Behavior: root/default home, Show all visibility, `nested` marker, and `parent_count`-derived display update from current references after deletion.
- Behavior: nested-open Back returns to parent before deletion; direct/root open after deletion shows `Workspace Home` and does not infer a parent.
- Behavior: selected-edge Backspace deletion, connection create/label/delete/reconnect, Field Item creation, Field rename, Block Library drag/drop, node handles/labels/icons/selection, pan, zoom, drag, viewport restore, and prior Field slice tests remain green.
- Behavior: deletion writes no layout sidecar unless a separate pan/zoom/drag event actually occurs.
- Behavior: no whole-Field delete endpoint is called for Field Item deletion.

## Test plan

- Existing tests to keep green:
  - `floe-web\src\fields.test.ts` semantic transform/update tests, especially node deletability, layout no-op on remove/select, `remove_item` cascade, and connection validation.
  - `floe-web\tests\field-substrate.spec.ts` mocked canvas tests for rendering, viewport restore, Block Library drag/drop, nested navigation, connection create/label/delete/reconnect, Field Item deletion confirmation/cascade, mocked nested Field preservation, Field create/delete, real bus persistence, rename, add items, and watcher live rendering.
  - `floe-bus\src\fields-store.test.ts` and `floe-bus\src\fields-server.test.ts` Field file I/O, parent_count derivation, whole-Field delete, and HTTP route behavior.
- New tests to add before/with implementation:
  - Add one new real bus/file-backed Playwright test for #13 in `floe-web\tests\field-substrate.spec.ts` that covers both Actor Field Item deletion endpoint preservation and nested Field Item deletion child-file/navigation/root-filtering preservation in the smallest coherent scenario.
  - Prefer using current UI flows for add/delete/open/back and current bus/file reads for proof; only seed initial parent/child semantic files where that reduces brittle UI setup without bypassing the deletion behavior under test.
  - Assert exact YAML contents/paths after deletion: parent semantic path, child semantic path, remaining parent `items`, remaining parent `connections`, and endpoint list response.
  - Add screenshots/attachments only if doing so does not make CI brittle; the mandatory screenshot/summary evidence belongs to live QA.
- Live proof required:
  - Run a real bus + real FloeWeb live QA path (manual or session-state script) that creates or seeds a parent Field, child Field, registered Actor endpoint, Actor item, nested Field item, and touching Field Connection.
  - Capture screenshots for: before deletion parent canvas, nested child open with Back-to-parent, home root view before deletion, Show all before deletion with nested marker, parent after nested item deletion, home root/show-all after deletion, direct child open after deletion with Workspace Home back target, Actor item deletion/endpoint still present.
  - Write a summary artifact naming inspected paths, at minimum: parent semantic YAML, child semantic YAML, any parent layout sidecar, endpoint GET response/proof, and screenshots. Include observed item/connection arrays before/after deletion.
  - Verify no product secrets/tokens are captured in screenshots or artifacts.

## Risk assessment

- Risk: the current mocked nested deletion test can pass while real bus watcher, parent-count derivation, file persistence, or endpoint registry behavior regresses.
- Risk: deleting a `field:<child-id>` item could be confused with whole-Field deletion because the Inspector also has a `Delete field` button in the open Field view.
- Risk: after deleting a child reference, stale `fieldSummaries` could leave the child hidden or marked nested until refresh.
- Risk: test setup could accidentally prove only seeded YAML mutation rather than the actual UI delete path.
- Risk: adding screenshots/artifacts to committed tests could introduce brittle output or repo noise.
- Risk: existing tests use Node temp workspace patterns; implementers must keep artifacts outside product code unless intentionally committed and avoid polluting the repository.
- Mitigation:
  - Use React Flow selected-node deletion in the proof, then inspect bus-backed YAML and endpoint APIs.
  - Assert no `DELETE /fields/<child-id>` request, child file existence, bus `GET` loadability, and endpoint list preservation.
  - Assert post-delete root/show-all UI state after `saveOpenFieldSemantic()` refreshes summaries.
  - Keep live QA screenshots/summary as session artifacts unless a specific committed artifact is requested.
  - Do not alter product code unless the proof fails for a real product gap; if it fails, stop and re-scope the implementation to the existing owners above.

## Decision confidence

- Confidence: high
- Reasons:
  - The current architecture already implements the required semantics: Field Items are refs, `remove_item` removes only the item and touching connections, whole-Field deletion is a separate API, and root/nested status derives from current `field:<id>` refs.
  - The requested slice is explicitly proof/regression hardening, and existing Playwright real bus setup already demonstrates the necessary workspace, endpoint, YAML, and UI patterns.
  - #12's integration point is already React Flow-native and should be preserved rather than reworked.
- Open questions:
  - Whether CI should retain screenshots from the automated Playwright test. Recommendation: no; keep CI assertions deterministic and capture screenshots in the live QA artifact.
  - Whether the live QA script should be committed. Recommendation: no for this slice unless requested; adapt the existing session-state #12 script and store artifacts outside product code.
  - No current doc/code conflict was found. If implementation evidence shows stale `fieldSummaries` after deletion, treat that as a product bug in the existing save/refresh path and stop for architecture review before adding a parallel refresh path.
