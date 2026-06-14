# Plan: Slice 2 Remainder — Scope-backed Field projection and block representation

**Produced:** 2026-06-13  
**Author:** Floe (Floe building Floe)  
**Status:** Proposed — awaiting operator approval before any implementation

---

## Background

ROADMAP.md Section 2 defines nine proof points for the Scope-backed Field projection slice. The status note says "in progress." This plan audits all nine proof points against the current working tree and proposes what remains.

---

## Audit: nine proof points vs. current code

### PP1 — default Scope creation for every Workspace

**Status: CONFLICT — proof point is superseded by ADR-0004 (2026-05-29).**

The ROADMAP says: *"default Scope creation for every Workspace."*

ADR-0004 (corrected 2026-05-29) says: *"Default Scope is not a product concept and should not be preserved as product behaviour. New code must not create, require, or route through a hidden Default Scope."*

The current code implements the corrected ADR position:

- `scopes-server.test.ts:50` — "registering a workspace does not create a Default Scope" — asserts `{ scopes: [] }` after workspace registration.
- `scopes-server.test.ts:208` — "does not create a Default Scope across register, select, and server restart."
- `RESERVED_DEFAULT_SCOPE_ID = "default"` is reserved to prevent user creation of the old id.

**Resolution required:** ROADMAP proof point 1 should be corrected to read:
*"workspace registration does not create a hidden Default Scope; `scope_id = 'default'` is reserved and creation-rejected."*

No implementation is needed. What is needed is a ROADMAP.md edit to reconcile proof point 1 with the ADR. This is a one-line doc fix.

---

### PP2 — substrate APIs to list Scopes and scoped primitives

**Status: Mostly done. Gap: `refs.events` and `refs.activity` are always empty.**

What works:
- `GET /v1/workspaces/:workspace_id/scopes` — lists all Scopes ✅
- `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` — returns `{refs: {contexts, pulses, events, activity}, relationships: {...}}` ✅
- `refs.contexts` — populated from `ContextStore.listContextsForScope()` ✅
- `refs.pulses` — populated from `BusStore.listPulses({scope_id})` ✅
- `GET /v1/events?workspace_id=&scope_id=` — works (events table has `scope_id`) ✅

Gaps:
- `refs.events` — `buildScopeProjection()` returns `events: []` (hardcoded empty). The `events` table has a `scope_id` column and the event listing API supports a `scope_id` filter, but `buildScopeProjection()` never queries it.
- `refs.activity` — returns `activity: []` (hardcoded empty). `runtime_telemetry` has no `scope_id` column. Per the issue-28 implementation review design, activity should be derived via a join: `runtime_telemetry → delivery_bundles → events.scope_id`. That join was accepted in the design but not implemented.

---

### PP3 — strict Scope deletion safety

**Status: Not done. No deletion endpoint exists at all.**

What exists:
- No `DELETE /v1/workspaces/:workspace_id/scopes/:scope_id` endpoint.
- No `ScopeDeletionForbiddenError` or `ScopeNotEmptyError` types.
- `store.ts:881` deletes all scopes for a workspace only as part of full workspace purge (internal use).

What's needed:
- A `DELETE /v1/workspaces/:workspace_id/scopes/:scope_id` HTTP endpoint.
- Safety rules enforced in `ScopeStore.deleteScope()`:
  1. Reject if `scope_id === RESERVED_DEFAULT_SCOPE_ID` (`"default"`) — reserved id is never a real Scope, but protects against stale records.
  2. Reject if `is_default === true` — a Scope explicitly flagged as default cannot be deleted (the `is_default` flag exists in the schema; the unique index `idx_scopes_one_default_per_workspace` enforces at most one).
  3. Reject if the Scope is non-empty — i.e., it has Contexts or Pulses still referencing it. Check `ContextStore.listContextsForScope()` and `BusStore.listPulses({scope_id})` before deletion.
- New error classes: `ScopeDefaultDeletionError`, `ScopeNotEmptyError`.
- Tests: prove each rejection case and prove empty non-default Scope can be deleted.

**Note on "Default Scope" in the context of ADR-0004:** Since workspaces no longer have an automatically created Default Scope, rule 2 (`is_default === true`) protects only Scopes that were explicitly created via an API call with `is_default` set. The `createScope` API currently sets `is_default = 0` for all user-created scopes. The rule can be simplified to: only reject deletion of a scope with `is_default = 1`; since none are created with `is_default = 1` today, this is a forward-safety guard.

---

### PP4 — `scope_id` on Context and Pulse at minimum

**Status: Done. ✅**

- `contexts` table: `scope_id TEXT` column, nullable, with migration guard (`addColumnIfMissing`).
- `pulses` table: `scope_id TEXT` column, nullable, with migration guard.
- Propagation tested in `scope-propagation.test.ts` (18 tests covering Context/Event scope derivation) and `pulse-scope-propagation.test.ts` (covering Pulse scope creation, query, and delivery-context scope inheritance).

No work needed.

---

### PP5 — Pulse Persistence terminology replacing old Pulse "scope" wording in public docs/API language

**Status: Done in code and main documents. ✅ Minor doc audit recommended.**

What's already clean:
- `PulsePersistence = "workspace" | "local"` in `store.ts:158`.
- `persistence` field throughout API and store code.
- `CONTEXT.md:44–51` has a dedicated "Pulse Persistence" section.
- `CONTEXT.md:161` explicitly notes the resolved rename: *"'Scope' previously appeared in Pulse APIs and docs to mean workspace-backed versus local/runtime-backed storage. Resolved: use Pulse Persistence for storage/lifecycle location."*
- `create_pulse` tool description in agent system prompt uses "workspace" / "local" language correctly.

Recommended: a single grep pass over `docs/` to confirm no implementation-review or ADR still uses "Pulse scope" to mean storage. Based on the current audit, none do.

No code work needed. Optional doc audit pass only.

---

### PP6 — explicit event/work-log propagation rules

**Status: Partially done. Gap: work-log/activity propagation not implemented.**

What works:
- Context/Event scope propagation: `scope-propagation.test.ts` covers scoped event indexing, unscoped-actor events remaining null-scoped, and cross-scope isolation.
- Pulse scope propagation: `pulse-scope-propagation.test.ts` covers persistence+scope on pulse creation, scope derivation from active delivery context, and rejection of unknown scopes.
- Webhook scope rules: tested in `server.test.ts:284` — "webhook ingress rejects routes without configured Scope instead of using Default Scope."
- Legacy migration: `store.ts` migrations null-out `scope_id = 'default'` on both `events` and `pulses` tables.

Gaps:
- Work-log/activity scope derivation: `runtime_telemetry` has no `scope_id`. `buildScopeProjection()` returns `activity: []`. Per issue-28 design, the intended path is a `delivery_id` → `delivery_bundles` → `event_id` → `events.scope_id` join. If `events.scope_id` matches the queried scope, the telemetry row should appear in `refs.activity`.
- No test proves activity refs appear in projection when telemetry can be resolved through a scoped event.

**Decision needed before implementation:** Issue-28 explicitly deferred activity refs as out-of-scope for that slice. The projection shape already has the `activity` array placeholder. The plan recommends implementing the delivery-join derivation, but this is the least-certain remaining item. The owner should confirm whether activity derivation belongs in this slice or is explicitly deferred again.

---

### PP7 — FloeWeb lists Scopes as Fields and renders the selected Scope from substrate queries

**Status: Done. ✅**

- `listScopes()` is called in `refreshFields()` and the workspace selection flow.
- `scopeToFieldSummary()` converts `ScopeRecord` to `FieldSummary` for the sidebar list.
- `getScopeProjection()` is called when a Field/Scope is opened; the result drives the React Flow canvas.
- `getScopeProjectionLayout()` loads renderer-only position/dimension metadata.
- `scope-projection-api.test.ts` covers all API client paths without calling legacy field endpoints.

No work needed.

---

### PP8 — Field layout persists as renderer metadata only

**Status: Done. ✅**

- `PUT /v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/floeweb` stores layout as a file sidecar via `upsertScopeProjectionLayout()`.
- `scope-projection-layout-store.ts` handles file-backed layout storage (not DB).
- Layout schema is `floe.field.layout.floeweb.v1`; it records only positions, dimensions, and viewport — no membership.
- `scope-projection-layout-store.test.ts` proves round-trip, missing-layout null, legacy sidecar fallback, and validation.
- `floe-web/src/fields.ts` — layout helpers do not contain membership semantics.

No work needed.

---

### PP9 — no Field-owned item list, connection list, or `.floe/blocks` substrate is introduced

**Status: Done. ✅**

- No `fields-*.ts` files exist in `floe-bus/src/`.
- No `.floe/blocks` directory exists anywhere in the workspace.
- `floe-web/src/fields.ts` contains only ref parsing and layout-transform helpers, no membership writes.
- The Scope Projection is derived read-only from substrate primitives; it does not write back.

No work needed.

---

## Summary matrix

| # | Proof point | Status | Work needed |
|---|---|---|---|
| 1 | Default Scope per workspace | ❌ Conflict with ADR-0004 | Edit ROADMAP.md proof point 1 to reflect corrected ADR |
| 2 | Substrate APIs: list Scopes + scoped primitives | ⚠️ Partial | Implement `refs.events` and `refs.activity` in `buildScopeProjection()` |
| 3 | Scope deletion safety | ❌ Missing | Add DELETE endpoint with default-guard + non-empty-guard |
| 4 | `scope_id` on Context and Pulse | ✅ Done | — |
| 5 | Pulse Persistence terminology | ✅ Done | Optional docs audit pass |
| 6 | Event/work-log propagation rules | ⚠️ Partial | Implement activity derivation via delivery-join (decision needed on scope) |
| 7 | FloeWeb lists Scopes as Fields | ✅ Done | — |
| 8 | Field layout as renderer metadata only | ✅ Done | — |
| 9 | No Field-owned item list / `.floe/blocks` | ✅ Done | — |

Five of nine proof points are fully done. Two are partial. One (PP1) is a doc/ROADMAP reconciliation. One (PP3) is a complete gap.

---

## Proposed work items

### Item A — Correct ROADMAP.md proof point 1 (doc fix, trivial)

Edit proof point 1 in `docs/ROADMAP.md` from:
> *"default Scope creation for every Workspace"*

To:
> *"workspace registration does not create a hidden Default Scope; `scope_id = 'default'` is reserved and rejected on explicit creation"*

This aligns the ROADMAP with ADR-0004 (2026-05-29) and the actual tested behavior.

**Risk:** None. Test baseline already confirms this behavior.

---

### Item B — Populate `refs.events` in `buildScopeProjection()` (floe-bus)

**File:** `floe-bus/src/scopes/projection.ts`

Add a `listEventsForScope(workspaceId: string, scopeId: string)` method to `BusStore` (or use the existing `listEvents({scope_id})` accessor). Populate `refs.events` with `ScopeProjectionEventRef` rows matching the queried scope.

**Touches:** `floe-bus/src/scopes/projection.ts`, `floe-bus/src/store.ts` (may need a narrow accessor), `floe-bus/src/scope-projection.test.ts` (currently asserts `events: []` — these tests must be updated to assert actual events when a scoped event exists).

**Risks:**
- Tests in `scope-projection.test.ts` that currently assert `refs.events = []` will need updating, specifically lines 185, 349, 377. These test scenarios where the event hasn't been explicitly assigned scope_id via the direct DB manipulation at line 362 — check each test to understand whether the emitted events in those tests actually carry scope_id from Context.scope_id propagation or remain null-scoped.
- Event rows are scope-derived from their Context; some events in tests may be unscoped (null Context or unscoped actor Context). Be precise about which events qualify.

---

### Item C — Implement Scope deletion safety (floe-bus)

**Files:** `floe-bus/src/scopes/store.ts`, `floe-bus/src/server.ts`, `floe-bus/src/scopes-server.test.ts`

**In `ScopeStore`:**
- Add `ScopeDefaultDeletionError` (is_default scope cannot be deleted).
- Add `ScopeNotEmptyError` (scope still has primitives referencing it).
- Add `deleteScope(workspaceId: string, scopeId: string): void` that:
  1. Calls `getScope()` — throws `ScopeNotFoundError` if not found.
  2. Checks `is_default` — throws `ScopeDefaultDeletionError` if true.
  3. Checks for non-empty primitives via `BusStore.listPulses({scope_id})` and `ContextStore.listContextsForScope()` — throws `ScopeNotEmptyError` with counts if any found.
  4. Executes `DELETE FROM scopes WHERE workspace_id = ? AND scope_id = ?`.

**In `server.ts`:**
- Add `DELETE /v1/workspaces/:workspace_id/scopes/:scope_id`.
- Return 204 on success.
- Map `ScopeDefaultDeletionError` → 403 `scope_default_deletion_forbidden`.
- Map `ScopeNotEmptyError` → 409 `scope_not_empty`.
- Map `ScopeNotFoundError` → 404 `scope_not_found`.

**Tests to add in `scopes-server.test.ts`:**
1. Empty non-default Scope is deletable (204).
2. Non-existent Scope returns 404.
3. Scope with Contexts referencing it returns 409.
4. Scope with Pulses referencing it returns 409.
5. Scope with `is_default = true` returns 403 (forward-safety; may require direct DB insertion to set is_default since the API doesn't expose it).

**Risk:**
- `ScopeStore.deleteScope()` needs access to context and pulse counts. This could be done via `BusStore.deleteScope()` wrapping the ScopeStore call, or by injecting the ContextStore and pulse query into ScopeStore. The cleaner path is to have `BusStore` own the deletion orchestration, delegating to ScopeStore only for the final DELETE, keeping the cross-primitive emptiness check in BusStore where all stores are available.
- The `ScopeStore` constructor currently takes only a `DatabaseSync` — BusStore would be the right orchestration boundary.

---

### Item D — Activity derivation in `buildScopeProjection()` (DEFERRED — operator decision 2026-06-13)

**Status: Deferred by operator amendment. Do not implement in this slice.**

**Open question blocking implementation:** `delivery_bundles` carries both a single `trigger_event_id` and a multi-event `events_json`. The scope-attribution rule for telemetry is therefore ambiguous: should a telemetry row count as scoped activity when the *trigger event* matches the queried Scope, or when *any bundled event* in `events_json` matches? These can disagree when a delivery bundles events from more than one Scope. This needs an operator decision before implementation.

**Original design sketch (for when it is picked up):**

The intended design (per issue-28) is:
- Join `runtime_telemetry.delivery_id → delivery_bundles.delivery_id → delivery_bundles.event_id → events.scope_id`.
- If `events.scope_id = scopeId`, the telemetry row qualifies as scoped activity.

**Files:** `floe-bus/src/store.ts` (new `listTelemetryForScope` method), `floe-bus/src/scopes/projection.ts` (populate `refs.activity`), `floe-bus/src/scope-projection.test.ts` (update assertions).

**Risk:** The join is multi-hop. `delivery_bundles` may not always have a single `event_id` if a delivery can cover multiple events (check schema). The join must handle nulls cleanly and fall back to omitting rather than faking activity records. Low risk if scoped narrowly.

**Recommendation:** Implement in this slice if items A–C are approved; defer if timeline is tight. The `activity: []` placeholder is already in the projection shape, so deferral is safe.

---

## Ordering

If all items are approved:

1. **A** — Doc fix, no tests, trivial. Do first.
2. **C** — Scope deletion safety. Independent of B/D. Test-driven: write tests, then implement.
3. **B** — Event refs in projection. Requires care with existing test assertions. After C.
4. **D** — Activity derivation. After B confirms the projection-extension pattern. Requires explicit approval.

Each item should end with `cd floe-bus && npx vitest run` passing before the next begins.

---

## What this plan does NOT touch

- FloeWeb rendering (PP7, PP8 are already done).
- Pulse propagation tests (already passing, no change needed).
- Extension lifecycle (Slice 3+).
- `.floe/blocks` (confirmed absent; not introduced).
- Legacy field APIs (already bypassed per issue-32 closeout).
