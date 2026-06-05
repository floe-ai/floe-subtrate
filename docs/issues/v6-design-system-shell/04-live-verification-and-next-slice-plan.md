# Slice 4 - Live Verification and Next-Slice Plan

> **Type:** HITL

## Parent

`docs/v6-design-system-shell-prd.md`

## What to build

Verify the design-system and shell migration in a live FloeWeb environment, capture proof, and decide the next V6 surface slice. This slice should not add new product behavior. It closes the first tranche by proving that Tailwind/shadcn integration, shell componentization, Workspace Home, Inspector, Channel, Activity navigation, and React Flow Scope opening still work together.

## Acceptance criteria

- [ ] Run FloeWeb locally in a live environment.
- [ ] Capture screenshots for Workspace Home, actor-selected Home/Inspector, opened named Scope with React Flow, Activity, and Channel/Context open path.
- [ ] Capture browser console evidence showing no relevant runtime errors.
- [ ] Capture network evidence showing no legacy Field endpoints, no mock file imports, no direct browser workspace file writes, and expected bus endpoints.
- [ ] Manually verify Workspace switch/create, Home navigation, Activity navigation, actor selection, Channel open/send where runtime configuration permits, named Scope open, and React Flow pan/zoom/drag/selection/open/handles.
- [ ] Confirm `npm run build`, relevant unit tests, and targeted V6 Playwright tests pass after the migration.
- [ ] Document any differences between the V6 mock and production behavior, separating accepted substrate-driven differences from defects.
- [ ] Produce a recommended next slice: Activity shadcn surface, Context main stream surface, Inspector deep migration, or Scope React Flow visual integration.

## Blocked by

- Slice 3 - Workspace Home shadcn Surface
