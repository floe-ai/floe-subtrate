# V6 Design System and Shell Migration PRD

## Problem Statement

FloeWeb is already moving toward the V6 substrate direction, but the interface work is accumulating as a large custom React and CSS implementation. The current branch has passing V6 tests and preserves important substrate semantics, yet delivery remains fragile because most UI behavior and styling live in one large application file and one bespoke stylesheet.

The operator needs the V6 migration to continue without letting the web interface become harder to reason about. The next slice must make interface delivery easier by introducing Tailwind and shadcn/ui as the production UI system, while preserving React Flow as the Field graph/canvas owner and preserving the current bus-backed Workspace, Scope, Context, Event, Activity, Inspector, and Channel semantics.

## Solution

Introduce a dedicated V6 design-system foundation for FloeWeb, then extract the production shell into component boundaries that can be migrated surface by surface. The first implementation tranche should not redesign the graph and should not broaden substrate behavior. It should:

- install and configure Tailwind for the Vite React app;
- initialize shadcn/ui with Floe V6 theme tokens;
- keep the existing React Flow graph/canvas path;
- replace shell-level custom controls with shadcn/Tailwind components;
- extract the topbar, Workspace switcher, left navigation, main surface framing, and right Inspector shell from the application monolith;
- keep behavior equivalent to the currently passing V6 tests;
- leave later V6 surface migrations as separate slices once the design-system and shell foundation are stable.

The accepted interpretation of "no custom CSS/JS for UI" is: no large bespoke UI stylesheet and no hand-built generic UI controls where shadcn/Tailwind components are available. Narrow global theme CSS, Tailwind imports, shadcn theme variables, and React Flow integration styles remain allowed.

## User Stories

1. As a Floe operator, I want Workspace switching to remain in the top shell, so that I can change workspaces without interpreting the left navigation as a workspace list.
2. As a Floe operator, I want Workspace creation to continue using the existing bus-backed registration flow, so that opening a Workspace does not bypass substrate services.
3. As a Floe operator, I want Workspace Home to remain a Workspace index, so that I do not mistake Home for a Scope or Field.
4. As a Floe operator, I want named Scopes to remain openable as Fields, so that I can enter a React Flow map for connected operational work.
5. As a Floe operator, I want unscoped actor Contexts to remain visible from Workspace Home and Actor inspection, so that direct actor communication does not require a fake Default Scope.
6. As a Floe operator, I want Activity to remain a real workspace stream, so that I can inspect Events and runtime activity without relying on mock data.
7. As a Floe operator, I want the right Inspector to keep showing metadata for the current Workspace, Actor, Scope, Context, Event, or Activity selection, so that inspection is separate from conversation.
8. As a Floe operator, I want the Channel to keep sending through the existing event substrate, so that messaging Floe or another Actor does not create a direct runtime path.
9. As a Floe operator, I want the Field graph to keep React Flow pan, zoom, drag, handles, selection, layout, open, and connection affordances, so that the graph remains usable while the surrounding interface changes.
10. As a Floe operator, I want V6 controls to look and behave consistently, so that dropdowns, buttons, dialogs, selects, filters, and panels do not each have custom interaction code.
11. As a Floe operator, I want keyboard-visible focus and accessible names on shell controls, so that Workspace navigation, Inspector controls, Activity filters, and Channel actions are operable without a mouse.
12. As a Floe maintainer, I want Tailwind and shadcn configured as an explicit migration slice, so that future UI work does not smuggle in an unreviewed styling system.
13. As a Floe maintainer, I want Floe V6 theme tokens mapped into shadcn semantics, so that the V6 mock direction can be ported mechanically.
14. As a Floe maintainer, I want the application monolith split into prop-fed shell components, so that future work can change one surface without re-reading every state transition.
15. As a Floe maintainer, I want pure view-model helpers to remain the source of Home, Activity, Context, and Inspector summaries, so that components render behavior rather than reimplementing substrate rules.
16. As a Floe maintainer, I want existing tests to stay green during the migration, so that visual refactoring does not silently change substrate semantics.
17. As a Floe maintainer, I want no production import of V6 mock HTML, CSS, or JS, so that the mock remains a reference and not a runtime owner.
18. As a Floe maintainer, I want no visible Default Scope, Default Field, Home Scope, Thread terminology, `.floe/blocks`, or actor-as-graph-node leakage, so that the V6 substrate model remains intact.
19. As a Floe maintainer, I want the design system to limit custom CSS to theme and integration bridges, so that future interface delivery uses reusable primitives.
20. As a future implementation agent, I want clear component and test boundaries, so that I can migrate Home, Activity, Context, Inspector, and Scope surfaces in small vertical slices.

## Implementation Decisions

- Treat the current CoPilot branch as the investigation baseline because it already contains passing V6 behavior, Scope-as-substrate correction work, V6 tests, Activity and Home view models, and React Flow Scope Projection integration.
- Introduce Tailwind and shadcn/ui as a dedicated design-system migration, not as incidental styling during another feature slice.
- Use the current Tailwind Vite integration and shadcn Vite setup flow. Tailwind should be wired through the Vite plugin path, and shadcn should create the project component registry/configuration needed for reusable UI primitives.
- Map Floe V6 tokens into shadcn theme variables. Preserve the V6 dark "linear calm" direction, sage-slate accent, tinted neutrals, radius discipline, and border treatment.
- Keep React Flow as the only graph/canvas implementation. The V6 mock's hand-authored SVG map and mock data must not be ported into production.
- Keep App-level state and bus API ownership initially. Components should be extracted as typed, prop-fed React components before moving stateful logic.
- Extract shell primitives first: application shell, topbar, Workspace switcher, left navigation, main surface frame, right Inspector frame, and common status/empty/filter controls.
- Prefer shadcn components for generic controls: Button, Dropdown Menu, Select, Dialog, Tabs, Scroll Area, Sheet or Resizable Panel where suitable, Card-like panels only when they represent repeated items or real framed tools.
- Use lucide-react icons consistently inside icon buttons and navigation rows.
- Keep existing dialog behavior semantically equivalent while migrating its UI implementation to shadcn primitives in a controlled slice.
- Keep existing pure helper modules for Workspace Home, Activity, Inspector, Context labels, Scope Projection, Field layout, and Pulse subscriber behavior.
- Do not add new Workspace, Scope, Context, Event, Activity, Runtime, or Field substrate APIs in this PRD unless a component migration exposes a true missing read contract. Missing contracts should become separate architecture-gated slices.
- Do not implement broad visual redesign of the React Flow graph. Styling may improve contrast and fit the V6 shell, but graph layout, interaction, ownership, and semantic nodes/edges remain unchanged.
- Do not create a new product artifact persistence model in this slice.

## Testing Decisions

- Tests should cover external behavior and substrate contracts, not component internals or class-name implementation details.
- Existing unit tests for Home, Activity, Inspector, Contexts, Scope Projection, Field layout, and dialogs must remain green.
- Existing V6 Playwright tests must remain green: shell frame, Workspace Home, feature shell, Scope Field map, Activity content, and Channel preservation.
- Add focused tests for the design-system migration where behavior changes are possible: Workspace dropdown accessibility, shadcn dialog/menu keyboard behavior, no mock imports, and no legacy terminology leakage.
- Add smoke coverage that verifies Tailwind/shadcn setup does not break production build output.
- Add live QA after the shell migration: run the Vite app, open Workspace Home, switch/create Workspace, open a named Scope, use React Flow pan/zoom/drag/selection, open Activity, open a Context/Channel path, and capture screenshots plus console/network evidence.
- Preserve network assertions: no legacy Field endpoints, no mock file imports, no direct browser file writes, and expected bus endpoints for Workspace, Scope Projection, Context events, Events, runtime bindings, and telemetry.

## Out of Scope

- Full V6 visual completion of every surface.
- Scope graph redesign or replacing React Flow.
- New event diamonds, fake map data, or unreviewed Scope Projection expansion.
- New product artifact persistence under `.floe/`.
- Extension authoring, marketplace, trust center, memory UI, or broad runtime/profile redesign.
- Removing the transitional Channel before a dedicated Context main-surface slice proves the replacement path.
- Changing substrate semantics for Workspace, Scope, Context, Event, Pulse, Endpoint, Actor, Delivery, or Work Log.

## Further Notes

- Current build and unit tests pass on the investigation baseline.
- Targeted V6 Playwright tests pass on the investigation baseline.
- Prior architecture briefs rejected Tailwind/shadcn as a side effect. This PRD supersedes that for the narrow purpose of a dedicated design-system foundation slice.
- Any non-trivial implementation under this PRD still requires a fresh Architecture Integration Gate before code changes, because introducing Tailwind/shadcn changes project architecture and UI ownership.
