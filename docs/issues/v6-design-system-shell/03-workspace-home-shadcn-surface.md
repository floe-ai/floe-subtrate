# Slice 3 - Workspace Home shadcn Surface

> **Type:** AFK after Slice 2 and Architecture Integration Gate

## Parent

`docs/v6-design-system-shell-prd.md`

## What to build

Rebuild Workspace Home on top of the new shadcn/Tailwind component foundation while preserving its current substrate-backed behavior. Home should remain a Workspace index showing workspace settings, actor summaries, named Scope cards, recent Activity, and Workspace-level Contexts from real bus-backed data.

This slice replaces bespoke Home UI implementation with reusable primitives. It must not fetch Scope Projection until a named Scope is opened and must not introduce mock data or new substrate semantics.

## Acceptance criteria

- [ ] Workspace Home uses shadcn/Tailwind primitives for its generic controls, panels, lists, actions, and status displays.
- [ ] Workspace settings show location, attachment/init status, runtime readiness, runtime adapter, and configured defaults where available.
- [ ] Actor summaries show participation and runtime summary without treating Actors as Blocks or Field nodes.
- [ ] Scope cards open named Scopes through the existing Field/Scope opening path.
- [ ] Recent Activity is derived from existing Event, telemetry, Context, Endpoint, and Scope data.
- [ ] Workspace-level Contexts with `scope_id: null` remain visible and openable/inspectable without a Default Scope fallback.
- [ ] Home does not call Scope Projection APIs before opening a named Scope.
- [ ] Home does not call legacy Field endpoints.
- [ ] No visible Default Scope, Default Field, Home Scope, Thread, `.floe/blocks`, or actors-as-Blocks terminology appears.
- [ ] Existing Home view-model unit tests and V6 Workspace Home Playwright tests pass.
- [ ] FloeWeb build passes.

## Blocked by

- Slice 2 - V6 Shell Componentization
- Fresh Architecture Integration Gate for `v6-workspace-home-shadcn-surface`
