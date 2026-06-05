# Slice 2 - V6 Shell Componentization

> **Type:** AFK after Slice 1 and Architecture Integration Gate

## Parent

`docs/v6-design-system-shell-prd.md`

## What to build

Extract the V6 application shell into typed React components while preserving the current App-level state and bus API ownership. The shell should use shadcn/Tailwind primitives for generic controls and maintain the current Workspace topbar, left navigation, main surface, right Inspector, and optional Channel behavior.

This is a structural slice. It should reduce the application monolith without changing Workspace, Scope, Context, Activity, Field, or Channel semantics.

## Acceptance criteria

- [ ] The application shell, topbar, Workspace switcher, left navigation, main surface frame, right Inspector frame, and Channel frame are extracted into prop-fed components.
- [ ] Workspace switch/create/select behavior remains bus-backed and stays in the top shell.
- [ ] Left navigation remains Home, Activity, Scopes, New Scope, and Actors where available.
- [ ] Workspace Home remains the default main surface and is not represented as a Scope or Field.
- [ ] Actor selection updates Inspector metadata without opening the Channel or creating React Flow actor nodes.
- [ ] Channel open/send behavior still routes through the existing event submission path.
- [ ] No visible Default Scope, Default Field, Home Scope, Thread, `.floe/blocks`, or actor-as-graph-node terminology appears in V6 shell flows.
- [ ] Existing V6 shell, Home, feature-shell, and Channel preservation Playwright tests pass.
- [ ] FloeWeb unit tests and build pass.

## Blocked by

- Slice 1 - Tailwind and shadcn Design-System Foundation
- Fresh Architecture Integration Gate for `v6-shell-componentization`
