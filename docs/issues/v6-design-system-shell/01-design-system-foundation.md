# Slice 1 - Tailwind and shadcn Design-System Foundation

> **Type:** AFK after Architecture Integration Gate

## Parent

`docs/v6-design-system-shell-prd.md`

## What to build

Introduce Tailwind and shadcn/ui as the explicit V6 interface delivery system for FloeWeb. The slice should configure the Vite React app, establish the Floe V6 theme contract, add the first reusable UI primitives, and prove that production build and existing V6 behavior still work.

This slice is not a visual redesign. It creates the foundation that later slices use to replace bespoke shell controls and large custom UI CSS.

## Acceptance criteria

- [ ] Tailwind is installed and configured for the existing Vite React app.
- [ ] shadcn/ui is initialized with a project configuration suitable for reusable local components.
- [ ] Floe V6 theme tokens are mapped into shadcn-compatible theme variables.
- [ ] The allowed custom CSS surface is documented: Tailwind import/theme variables, narrow global reset if required, shadcn token mapping, and React Flow integration styles.
- [ ] At least one low-risk existing generic control is migrated to a shadcn/Tailwind primitive to prove the wiring works.
- [ ] No production code imports or executes V6 mock HTML, CSS, or JS files.
- [ ] No React Flow graph/canvas behavior changes in this slice.
- [ ] `npm run build` passes in FloeWeb.
- [ ] FloeWeb unit tests pass.
- [ ] Targeted V6 Playwright shell/Home tests still pass.

## Blocked by

Fresh Architecture Integration Gate for `v6-design-system-foundation`.
