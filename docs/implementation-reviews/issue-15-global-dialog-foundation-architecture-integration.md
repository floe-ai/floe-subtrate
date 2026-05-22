# Architecture Integration Brief: issue-15-global-dialog-foundation

Scope: parent #14 PRD "FloeWeb global dialog system and Field deletion safety". This brief
covers only slice 1 (issue #15): the reusable FloeWeb global dialog foundation and a single
migrated simple confirmation (conversation deletion). Field/Nested Field deletion safety,
workspace-delete opt-in checkbox, and Field-creation/Nested-Field-creation prompts are out of
scope here and will land in later slices that build on this foundation.

## Existing ownership

- Package/component/module/library:
  - `floe-web\src\main.tsx` is the single React entry and currently owns every confirmation and
    prompt in FloeWeb. All native popups live here:
    - `window.confirm` at lines 1178 (Field Item delete), 1355 (missing directory create),
      1377 / 1379 (workspace delete + delete-local-folder), 1513 (conversation delete),
      1743 (whole-Field delete).
    - `window.prompt` at lines 1635 (new Nested Field) and 1758 (new Field).
  - Conversation deletion specifically is owned by `deleteConversation(contextId, label)`
    in `floe-web\src\main.tsx:1511-1528`: it gates on `window.confirm`, calls
    `DELETE /v1/contexts/:id` via `api(busUrl, ...)`, prunes local `contexts` and
    `pulseLabels` state, clears `selectedContextId` / `draftMode` / events when the
    deleted conversation is active, then `refreshContexts(workspace_id)`.
  - The trigger is a `.channel-context-delete-button` rendered inside the channel context
    list at `floe-web\src\main.tsx:2427-2438`, with
    `aria-label={`Delete conversation ${label}`}` and an `event.stopPropagation()` wrapper.
  - There is no existing modal/dialog/portal infrastructure in FloeWeb. No `createPortal`,
    `role="dialog"`, `aria-modal`, focus trap, or `.modal` / `.dialog` / `.overlay` class
    exists anywhere in `floe-web\src` or `styles.css`. Native `window.confirm` / `window.prompt`
    are the only confirmation/prompt primitives in use.
  - Global error surfacing is owned by a single top-level `error` state rendered as
    `<div className="error-bar">{error}</div>` at `floe-web\src\main.tsx:2646`, with
    `setError(...)` called from every async handler (e.g. lines 727, 928, 1112, 1147, 1159,
    1204, 1232, 1566, 1611, 1629, 1697, 1708, 1727, 1752).
  - The bus owns context deletion: `DELETE /v1/contexts/:id` removes the conversation and
    its events. FloeWeb must continue to call exactly this endpoint; no new bus API is
    needed for #15.
- Current owner rationale:
  - `PRODUCT.md` defines FloeWeb as a restrained product surface ("calm, spatial, durable,
    precise") and forbids browser code from going around `floe-bus` / `floe-bridge`. Native
    browser confirmations break that register and split the visual surface.
  - `main.tsx` already centralises all destructive UI handlers, so a single global dialog
    provider mounted once near the React root can serve every existing confirmation path
    without restructuring components.
  - Parent #14 explicitly forbids parallel modal solutions and requires one architectural
    path for all future confirmations and prompts.
- Source evidence:
  - Issue #15 acceptance criteria: one reusable global dialog system; small public request
    interface; restrained centered app-modal pattern; modal a11y (focus trap, focus return,
    Escape, backdrop cancel); danger variant; loading/disabled/inline-error support;
    conversation deletion migrated end-to-end; no parallel one-off modal solution.
  - Parent PRD #14 implementation decisions: global dialog system as the only approved path
    for confirmations/prompts; tiered confirmation strength in later slices; reuse existing
    FloeWeb styling vocabulary; no broad design-system migration; no toast system.
  - Existing Playwright coverage of conversation delete: `floe-web\tests\context-rendering.spec.ts`
    lines 794-852 install a `page.on("dialog", ...)` handler that asserts `dialog.type() === "confirm"`
    and that the message contains "Delete conversation" / "permanently deletes", then accepts
    or dismisses. These tests will need to be rewritten against the in-app dialog.

## Existing interaction model

- User/system behaviors that already exist:
  - Conversation list lives inside the Channel context list. Each row has a primary "open
    conversation" button and an inline `X` delete button labeled
    "Delete conversation <label>".
  - Clicking the delete button calls `event.stopPropagation()` so the row is not also
    "opened", then runs `deleteConversation(contextId, label)`.
  - `deleteConversation` short-circuits when no workspace is selected, prompts via
    `window.confirm`, calls `DELETE /v1/contexts/:id`, removes the row optimistically from
    local state, clears active selection if it was the deleted conversation, and
    re-fetches contexts.
  - Errors from the bus call propagate as thrown `Error`s from `api(...)`; today
    `deleteConversation` does **not** wrap that call in a try/catch (unlike many other
    handlers), so a failure would surface as an unhandled rejection rather than via the
    `.error-bar`. This is a pre-existing inconsistency the new dialog can fix incidentally
    by surfacing the bus error in the dialog's inline error area before closing.
  - Pan/zoom/drag on Field canvas, Block Library drag/drop, node icons/labels/handles/selection,
    rename/open, and connection affordances are owned by React Flow and unrelated FloeWeb
    components and must remain untouched by #15.
  - The single `.error-bar` global error display is a passive banner, not a modal.
- Behaviors that must remain unchanged:
  - Trigger element and its accessible name ("Delete conversation <label>"), its position
    in the channel context list, its `event.stopPropagation()` semantics, and the fact
    that clicking it does not open the conversation.
  - `DELETE /v1/contexts/:id` call shape (method, path, encoding) and its substrate
    side effects.
  - Optimistic removal from `contexts` and `pulseLabels`, clearing of `selectedContextId`,
    `draftMode`, and events when the active conversation is deleted, and the follow-up
    `refreshContexts` call.
  - "Cancel writes nothing" invariant: dismissing the confirmation must not call the bus
    and must not mutate local state. Existing Playwright test at lines 834-852 enforces
    this and must keep passing in spirit (re-expressed against the new dialog).
  - All other native confirmations/prompts (Field Item delete, missing directory create,
    workspace delete, whole-Field delete, new Field, new Nested Field) keep working
    unchanged in #15. They will be migrated in later #14 slices, not here.
  - React Flow canvas behaviors (pan, zoom, drag, selection, handles, labels, icons,
    rename/open, connection create/label/delete, Controls, MiniMap, Block Library) must
    not regress. A global dialog provider mounted at the React root must not introduce
    overlay layers, keyboard handlers, or focus traps that activate when no dialog is
    open.
- Runtime or UX evidence:
  - `context-rendering.spec.ts` lines 794-852 exercise the confirm-accept and
    confirm-dismiss paths against the native browser dialog.
  - `helpers.ts` boots the app with mocked bus routes; conversation deletion mocking
    lives in `context-rendering.spec.ts` via `world.deleteContextCalls`.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - React 18 is available (`react@^18.3.0`, `react-dom@^18.3.0`) and provides
    `react-dom`'s `createPortal` for mounting the dialog layer outside the main app tree.
    No new dependency is required.
  - The HTML `<dialog>` element + `showModal()` is technically available but has known
    cross-browser focus-trap, scroll-lock, and styling inconsistencies and does not satisfy
    the parent PRD's accessibility bar by itself. Recommendation: use a plain
    `role="dialog" aria-modal="true"` div via `createPortal` with explicit focus
    management, rather than `<dialog>`. (Open question - see Decision confidence.)
  - No headless dialog library (Radix, Headless UI, React Aria, Reach) is installed.
    Parent PRD #14 explicitly rejects "migration to a broad external component library".
    Adding `@radix-ui/react-dialog` (~10kB gzip) would give a battle-tested a11y baseline
    with no design system attached, but it would still be a new runtime dep. Recommendation:
    build a small internal component (estimated ~150 LoC) using existing React + portal
    primitives unless the implementer surfaces a concrete a11y gap during TDD. Either
    choice must be one decision applied globally; do not mix.
  - Existing styling vocabulary in `floe-web\src\styles.css` defines all design tokens
    needed: `--surface-panel`, `--surface-inset`, `--border`, `--border-strong`, `--text`,
    `--text-soft`, `--text-muted`, `--accent`, `--accent-strong`, `--accent-soft`,
    `--danger`, `--danger-soft`, `--shadow`, `--radius`, `--radius-sm`. Existing button
    classes `.primary-action`, `.ghost-action`, `.icon-button` give the action vocabulary
    (see `styles.css` lines 468-512). A focus ring convention exists:
    `button:focus-visible { outline: 2px solid var(--accent); }` (line 104) and is reused
    in `.field-edge-label-button:focus-visible` etc.
  - Existing `.check-row` class (line 456-466) already styles the checkbox row pattern
    needed by the optional-acknowledgement variant that later #14 slices will use.
  - Iconography is `lucide-react`; `AlertTriangle` is already imported in `main.tsx` and
    is the right danger affixed icon.
  - Vitest is configured for node environment with `globals: false` and only matches
    `src/**/*.test.{ts,tsx}` (`floe-web\vitest.config.ts`). There is no jsdom-based React
    component test infrastructure today; current unit tests are pure logic over
    `contexts.ts`, `fields.ts`, `fields-api.ts`. A pure-logic unit test for the dialog
    request controller (open/close/result reducer) is feasible without standing up jsdom.
    User-visible dialog behavior (render, focus trap, Escape, backdrop, action click,
    no-op cancel, single bus call) should be tested via Playwright, consistent with how
    every other UI behavior is tested today.
  - The Playwright pattern for asserting bus calls is in place: `world.deleteContextCalls`
    in `context-rendering.spec.ts`. New tests should keep using it.
- Relevant docs or library capabilities:
  - `PRODUCT.md` - register, brand personality, system typography, restrained color.
  - `CONTEXT.md` - Field/Nested Field/Field Item/Field Item Ref/Field Connection/Workspace
    terminology and the recent rules about reference detachment and broken refs (informs
    later slices, not #15 itself).
  - Issue #14 PRD - dialog shell capabilities (title, body, structured consequence rows,
    optional detail, optional checkbox, optional text input, variant, primary/secondary
    action, disabled/loading, inline error display) - design the public API around these
    even though #15 only exercises confirm + danger + loading + inline error.
- Existing examples in this codebase:
  - `deleteConversation` (line 1511) and the rejected-by-cancel test (line 834) define the
    behavioral contract to preserve.
  - `setError(...)` + `.error-bar` pattern shows the existing global error vocabulary; the
    dialog's inline error area should look at home next to it but live inside the dialog
    body, not in the page-level bar, for action-scoped failures.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not introduce a second dialog/modal mechanism. The new module is the only path.
  - Do not call `window.confirm` or `window.prompt` from any code path that uses the new
    dialog. For #15 that specifically means `deleteConversation` must stop calling
    `window.confirm` at line 1513. Other native popups in `main.tsx` remain in place for
    later #14 slices but no new ones may be added anywhere.
  - Do not replace `DELETE /v1/contexts/:id` or add a new bus endpoint for confirmation
    state - the dialog is a pure UI primitive.
  - Do not bypass the existing `api(busUrl, ...)` helper for the delete request.
  - Do not relocate or restyle the channel context list `X` button beyond what is needed
    to launch the dialog and receive focus return.
  - Do not change `aria-label="Delete conversation <label>"` on the trigger; multiple tests
    locate the button by it.
- Shortcuts or parallel paths to avoid:
  - Do not implement the dialog as a Field- or Channel-scoped local modal; it must be a
    global app primitive mounted once.
  - Do not use the native `<dialog>` element if it forces the implementer to fight
    browser default focus/backdrop behavior to meet a11y; if `<dialog>` is chosen, prove
    focus trap and focus return work the same way across the supported browsers.
  - Do not introduce a toast/notification system or a separate "destructive action banner"
    to surface dialog errors; surface inline in the dialog body.
  - Do not gate the dialog provider on a feature flag or per-route mount; mount it once
    near the React root so any callsite can request a dialog.
  - Do not introduce a global keyboard shortcut layer or document-level keydown listener
    that is active when no dialog is open; key handling must be scoped to an open dialog.
  - Do not change the React Flow canvas mount, props, or wrappers. The dialog portal must
    not introduce ancestor stacking-context changes or wheel/pointer capture that bleed
    into the canvas.
- Invariants:
  - One reusable global dialog module is the only approved confirmation/prompt path going
    forward in FloeWeb. Every future #14 slice migrates a native popup into it.
  - Cancelling a confirmation never calls the bus and never mutates substrate-backed
    local state.
  - Confirming a destructive action runs the existing substrate path exactly as it does
    today.
  - The dialog renders inside the FloeWeb app shell, dims the background, traps focus,
    closes on Escape, closes on backdrop click when no irreversible work is in flight,
    and returns focus to the triggering control on close.
  - The public API is small and request-shaped: a single callable (e.g.
    `confirm({...}): Promise<boolean>`, with room for `prompt(...)` and `open(...)` in
    later slices). Feature code must not own modal state machinery, and the implementation
    must not leak React context-only APIs that force consumers to render JSX they don't
    own.
  - No regression to React Flow Field canvas behaviors (pan, zoom, drag, selection,
    handles, icons, labels, rename, open, connection affordances), Block Library
    drag/drop, Inspector behavior, workspace rail behavior, or the global `.error-bar`.

## Integration plan

- Insert the change at:
  - New module `floe-web\src\dialog\` (suggested files):
    - `dialog.tsx` - typed public request API (`confirm`, exported request types and
      `DialogProvider` if a context-backed implementation is chosen) and the `<DialogHost />`
      portal component that renders the active request.
    - Plus dialog CSS either appended to `styles.css` under a `/* dialog */` section using
      existing tokens, or colocated in `dialog.css` imported from `dialog.tsx`. Either
      placement is acceptable as long as it reuses existing tokens and does not redefine
      any.
  - Mount the host exactly once. Two acceptable shapes:
    1. Imperative store + portal: a module-level event-emitter/store exposes `confirm(req)`
       returning a Promise; `<DialogHost />` is rendered once near the root of the
       FloeWeb tree (just inside the top-level component that already wraps the app in
       `main.tsx`). No React context needed; callers import `confirm` directly.
    2. Provider + hook: a `<DialogProvider>` wraps the app; `useDialog()` returns
       `{ confirm }`. Slightly more idiomatic React, slightly heavier wiring.
    Recommendation: shape (1). It matches the "small request API" requirement, avoids
    threading a hook through a 2700-line `main.tsx`, and keeps non-React modules (none
    today, but plausible later) able to request a dialog.
  - Migrate `deleteConversation` (`main.tsx:1511`) to:
    1. Replace `window.confirm(...)` with `await confirm({...})`.
    2. Pass a danger variant request with title "Delete conversation", body referencing the
       conversation label, primary action "Delete" (danger), secondary action "Cancel",
       and (recommended) a loading-state binding for the bus call so the primary action
       disables and shows a spinner while the DELETE is in flight, with any thrown error
       surfaced inline in the dialog before the dialog closes or stays open on failure.
    3. Preserve every post-confirm side effect verbatim (state pruning, selection clear,
       `refreshContexts`).
- Why this is the correct integration point:
  - It satisfies the "global, reusable, one approved path" requirement in #14 and #15
    while changing exactly one feature handler in #15.
  - Mounting the host once near the React root means later #14 slices can migrate their
    callsites by changing only the handler that owns each native popup, with no
    further plumbing.
  - The conversation-delete handler is a near-perfect tracer: it is a simple yes/no, it
    already has Playwright coverage for both accept and cancel, the substrate path is one
    DELETE call, and the trigger has a stable accessible label.
  - Keeping `deleteConversation` in `main.tsx` (rather than extracting it) means #15
    proves the architecture without an unrelated refactor.
- Alternatives considered and rejected:
  - Use the native HTML `<dialog>` element as the only primitive: rejected as the sole
    mechanism because cross-browser focus-trap, backdrop click semantics, and styling
    consistency cannot be assumed; the parent PRD's a11y bar is explicit and we should
    own the behavior. May still be used internally if the implementer can prove parity.
  - Add `@radix-ui/react-dialog` (or React Aria): rejected as the default per #14's "no
    broad component library" decision, but kept as a fallback if focus trap and screen
    reader semantics prove flaky in the internal implementation during TDD.
  - Build a feature-scoped "ConversationDeleteModal" component: rejected because it
    creates the parallel-modal anti-pattern #14 forbids and forces every future slice to
    invent its own.
  - Migrate all native popups in #15: rejected as scope creep. #15 explicitly does
    foundation + one migration. Other migrations live in separate #14 slices.
  - Use a different tracer (workspace delete, Field Item delete, whole-Field delete,
    missing-dir create, new Field, new Nested Field): rejected. Workspace delete uses a
    two-popup chain that needs the opt-in-checkbox variant - that is exactly the
    surface area later #14 slices need to exercise and is non-trivial. Field Item and
    whole-Field delete are entangled with Field deletion safety (#17/#18) and the
    React Flow canvas, which #15 is supposed to avoid. Missing-dir create and the two
    `prompt` callsites need the text-input variant which is also a later slice.
    Conversation delete is the cleanest single-confirm path with existing Playwright
    coverage on both branches and no canvas dependency.

## Regression checklist

- Behavior: Channel context list still shows the inline `X` delete button per row with
  `aria-label="Delete conversation <label>"`, in the same position, with `event.stopPropagation()`.
- Behavior: Clicking the delete button opens the new in-app dialog (not a browser
  popup); no native `window.confirm` is invoked anywhere in the conversation-delete path.
- Behavior: The dialog renders centered with a dimmed backdrop inside the FloeWeb shell,
  uses existing design tokens, and uses `.primary-action` + `.ghost-action`-equivalent
  action styles; danger primary uses the `--danger` token.
- Behavior: Initial focus lands on a safe non-destructive control (Cancel or the dialog
  container), focus is trapped inside the dialog while open, Escape and backdrop click
  cancel, and focus returns to the originating `X` button on close.
- Behavior: Cancelling (Escape, backdrop, Cancel button) does not call
  `DELETE /v1/contexts/:id` and does not mutate `contexts`, `pulseLabels`,
  `selectedContextId`, `draftMode`, or context events.
- Behavior: Confirming calls `DELETE /v1/contexts/:id` exactly once with the same path
  encoding as today, then prunes local state, clears active selection if the deleted
  conversation was selected, and calls `refreshContexts`.
- Behavior: A failing DELETE surfaces an inline error in the dialog (new) and does not
  silently prune local state. (Bonus correctness; today the unwrapped error rejects.)
- Behavior: Whilst the DELETE is in flight, the primary action is disabled / shows a
  loading state and double-submission is impossible.
- Behavior: All other native confirmations and prompts (Field Item delete at 1178, missing
  directory create at 1355, workspace delete at 1377/1379, whole-Field delete at 1743, new
  Nested Field prompt at 1635, new Field prompt at 1758) continue to work via the
  existing native popups, unchanged. #15 must not partially migrate them.
- Behavior: React Flow Field canvas pan, zoom, drag, selection, handles, icons, labels,
  rename, open, and connection affordances are unchanged. Block Library drag/drop is
  unchanged. Workspace rail behavior is unchanged. Inspector behavior is unchanged. The
  global `.error-bar` continues to render top-level errors.
- Behavior: With no dialog open, no overlay layer, keyboard listener, focus trap, or
  pointer capture is active.

## Test plan

- Existing tests to keep green:
  - All `floe-web/src/**/*.test.ts` Vitest suites (contexts, fields, fields-api).
  - All `floe-web/tests/*.spec.ts` Playwright suites except the two conversation-delete
    cases noted below, which are rewritten in place.
  - `floe-bus` Field store/server tests, repo-wide build.
- New tests to add before/with implementation:
  - Pure-logic Vitest (no jsdom): test the dialog request controller's state transitions:
    open with a request, single active request at a time (or explicit queue semantics if
    chosen), resolve on confirm, resolve on cancel, error capture, loading state guard
    against double-resolve. Test purely against the imperative store / reducer, not React.
  - Playwright (`context-rendering.spec.ts`, replacing the two existing
    `page.on("dialog", ...)` tests):
    - Clicking the conversation `X` opens an in-app dialog with `role="dialog"`,
      `aria-modal="true"`, the conversation label in the body, a danger primary "Delete"
      and a secondary "Cancel".
    - Pressing Escape closes the dialog without calling `DELETE` and leaves the row
      visible (`world.deleteContextCalls` empty).
    - Clicking the backdrop closes the dialog without calling `DELETE`.
    - Clicking Cancel closes the dialog without calling `DELETE`.
    - Clicking Delete calls `DELETE /v1/contexts/<id>` exactly once, removes the row,
      clears the active channel if this conversation was selected, and triggers a
      `refreshContexts`.
    - After close (any path), focus returns to the originating `Delete conversation <label>`
      button.
    - With dialog open, Tab cycles only between dialog focusable elements (focus trap).
    - Initial focus is on a safe control (Cancel) on open.
    - Bus failure path: mock DELETE to 500, click Delete, inline error appears in the
      dialog body, the row is not removed, and the dialog remains open (or recoverable),
      and only one DELETE attempt was made before the error.
  - Playwright (cross-cutting): no `window.confirm` is fired during the conversation
    delete path (assert with `page.on("dialog", ...)` that no native dialog appears in
    the migrated flow).
  - Playwright (regression smoke): a single test that opens the Field canvas, performs a
    pan + zoom + node drag + Block Library drop while a dialog is **not** open, to prove
    the global host does not interfere when idle.
- Live proof required:
  - For #15, yes: run the dev stack (bus + floe-web) against a real workspace with at
    least two conversations, open the Channel, delete one via the new dialog, verify the
    conversation event log on disk is removed, verify cancellation leaves it intact,
    verify Escape/backdrop/Cancel parity, and verify keyboard-only operation
    (Tab/Shift+Tab cycling, Enter on primary, Escape to cancel, focus return on close).
  - Capture a short screenshot or screen-record of the dialog open, dimmed backdrop,
    focused control, and the empty state after deletion. Keep evidence under
    `docs\evidence\` per repo convention.

## Risk assessment

- Risk: Implementer reaches for a small "ConversationDeleteModal" and bypasses the global
  module under time pressure, creating the exact parallel path #14 forbids.
  - Mitigation: brief explicitly rejects this; reviewer checks that the migrated handler
    calls the global `confirm` API and that no per-feature modal component exists.
- Risk: Accessibility regressions vs `window.confirm`: missing focus trap, no Escape, no
  focus return, no `aria-modal`, no labelled-by/described-by wiring, no scroll lock.
  - Mitigation: include explicit Playwright assertions for `role="dialog"`,
    `aria-modal="true"`, focus return, focus trap (Tab cycling), Escape close, backdrop
    close, initial focus target. If the internal implementation cannot be made robust
    in a small footprint, fall back to `@radix-ui/react-dialog` rather than ship a
    broken custom focus trap.
- Risk: Mounting a global portal/host adds an ancestor stacking context, pointer/key
  listener, or scroll-lock that bleeds into React Flow when no dialog is open.
  - Mitigation: when no request is active, render `null` from the host; do not attach
    document listeners or apply `overflow: hidden` to `<body>`. Add a smoke Playwright
    test for canvas interactions with the provider mounted but idle.
- Risk: Dialog `z-index` / `position: fixed` interactions with the existing FloeWeb shell,
  Inspector, and React Flow `Controls`/`MiniMap`. Existing `z-index` usage in `styles.css`
  is sparse (only `z-index: 1` and `z-index: 20` appear in the codebase).
  - Mitigation: pick a single high dialog z-index token (e.g. `--z-dialog: 1000`) and
    document it in the new CSS section; verify Inspector, error-bar, and React Flow
    overlays still behave.
- Risk: Async confirm/await pattern around `deleteConversation` changes error surfacing
  semantics (currently unwrapped; brief proposes inline-in-dialog). This is a behavior
  change, however small.
  - Mitigation: explicitly call it out in the slice PR; assert both the success path and
    the new failure path in tests.
- Risk: Public API shape locks in early. A `confirm()`-only API may be re-shaped when
  later slices add `prompt()` and `open()` for custom structured dialogs.
  - Mitigation: design the request type with discriminated union from day one
    (`{kind: "confirm" | "prompt" | "custom", ...}`), but expose only `confirm` as a
    public callable in #15. Later slices add `prompt`/`open` wrappers around the same
    host without changing the existing signature.
- Risk: Scope creep into later #14 slices, especially Field deletion safety (#17/#18).
  - Mitigation: this brief calls out explicitly that Field Item delete, whole-Field
    delete, workspace delete chain, and the two `window.prompt` callsites are not migrated
    in #15.
- Risk: Test infra divergence: the codebase has no jsdom React component test setup;
  attempting one in #15 invents a new testing pattern.
  - Mitigation: keep dialog logic in a small pure module so Vitest can exercise it as a
    plain reducer/controller, and do user-visible coverage in Playwright as today.
- Risk: Visual register drift if the new dialog invents its own typography/spacing/colour.
  - Mitigation: reuse existing tokens (`--surface-panel`, `--border`, `--text`,
    `--text-soft`, `--danger`, `--accent`, `--radius`, `--shadow`) and existing action
    button vocabulary; danger styling applied only to destructive primary, per #14.

## Decision confidence

- Confidence: high (for both the architectural shape and the choice of conversation
  deletion as tracer); medium (only for the open implementation choice between a
  hand-rolled portal + focus trap vs. adopting `@radix-ui/react-dialog` as a tiny
  a11y-only dependency).
- Reasons:
  - Existing code clearly shows there is no dialog infrastructure today and exactly one
    place (`main.tsx`) owns every native popup; a single global module + mount is the
    obvious shape.
  - Conversation delete is the simplest yes/no destructive flow, with stable Playwright
    coverage on both accept and cancel branches, and no canvas/Inspector entanglement.
  - Reusing existing design tokens and action button vocabulary keeps #15 from morphing
    into a design-system migration, which #14 explicitly forbids.
  - All later-slice variants (checkbox, text input, structured consequence rows, broken-ref
    warnings) can be added without changing the public `confirm()` callsite the migrated
    handler will use.
- Open questions:
  - Hand-rolled portal vs. `@radix-ui/react-dialog`: decide during TDD based on whether
    the in-house focus trap reaches the a11y bar without ballooning code. Either is
    compatible with this brief. Whichever is chosen, it must be the only mechanism.
  - Whether the inline-error / disable-on-loading behavior is in scope for #15 or
    deferred to a later #14 slice. Recommendation: keep both in #15 so the architecture
    is proven end-to-end on a real async destructive call; the alternative (close
    immediately on confirm, surface errors in the global `.error-bar`) is acceptable
    but weaker proof of the foundation.
  - Whether to colocate dialog styles in `styles.css` or a new `dialog.css`. Either is
    fine; pick one and apply consistently.
