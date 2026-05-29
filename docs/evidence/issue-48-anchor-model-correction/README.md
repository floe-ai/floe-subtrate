# Issue 48 anchor model correction proof

Live proof run: 2026-05-29

Artifacts:

- `live-proof.json` - API/runtime output captured from a live Bus server on an isolated config.
- `workspace-home.png` - FloeWeb Workspace Home screenshot captured from the live proof workspace.
- `workspace-home-console.log` - clean browser console capture after FloeWeb was pointed at the live proof Bus.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| Unscoped actor Context works without Default Scope fallback | `live-proof.json` shows `directActorContext.event.scope_id: null`, actor participants, and `listedUnscopedBeforeAssignment` containing that Context. |
| Scoped operational flow creates or reuses a scoped Context | `scopedOperationalPulse` shows two `pulse.fired` events with `scope_id: "research"` and `stableDeliveryContextReused: true`. |
| Actorless + scopeless creation is rejected | `actorlessScopelessRejections.webhookRejected` returns `400 scope_required`; `pulseRejected` returns `400 scope_required`. |
| Explicit Scope assignment works | `explicitScopeAssignment.assigned.audit_event.type` is `context.scope_assigned`; the assigned Context keeps its identity and moves to `scope_id: "research"`. |
| Assigned Context appears through Scope Projection | `scopeProjection.beforeAssignmentContextIds` is empty; `afterAssignmentContextIds` includes the assigned direct Context and `assignedContextVisibleAfter: true`. |
| Workspace Home is not treated as a Scope | `workspace-home.png` shows `Workspace Home` with separate `Fields` and `Workspace-level Contexts` sections. The retained Workspace-level Context has `scope_id: null`, while `scopes` contains only `research` with `is_default: false`. |
| No product-facing Default Scope leakage in the proof data | `defaultScopeLeakageCheck.scopesNamedDefault` is empty; event scopes are only `null` or `"research"`. |

## Architecture invariant cross-check

This proof exercises the invariants from:

- `docs/implementation-reviews/issue-46-scope-projection-workspace-context-discovery-architecture-integration.md`
- `docs/implementation-reviews/issue-47-context-scope-assignment-architecture-integration.md`

The live flow kept Workspace-level actor Contexts discoverable through Workspace Home, kept Scope Projection scoped-only, required Scope for generated operational Pulse delivery, rejected unconfigured operational flow, and used explicit audited assignment instead of a hidden Default Scope.
