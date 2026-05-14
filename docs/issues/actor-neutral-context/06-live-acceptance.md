# Slice 6 — Live Acceptance / Hardening: prove all 9 E2E scenarios in real stack

> **Type:** HITL
> **Acceptance gate:** The feature is **not** complete until all nine scenarios pass live in a real bus + bridge + FloeWeb stack.

## Parent

`docs/actor-neutral-context-slice-prd.md`

## What to build

Verify the full slice end-to-end by running the nine acceptance scenarios from `docs/design-actor-neutral-context.md` §6.2 against a real running stack. Capture proof artefacts (logs, screenshots, event dumps).

The scenarios:

1. **E2E-1 — Fresh workspace creates first context lazily on first emit.** Empty list → select agent → empty state → send → context appears → reload preserves it.
2. **E2E-2 — Two separate contexts with the same two participants do not bleed.** Operator ↔ floe in A; new conversation in B; each renders only its own events.
3. **E2E-3 — A normal reply to a participant stays in the current context.** Floe replies to operator without `context_id`; lands in the same context.
4. **E2E-4 — Emit to non-participant opens a separate context.** Floe consults reviewer without `context_id`; new context B created; reviewer's reply continues there.
5. **E2E-5 — Agent-to-agent messages do not appear in the initiating context.** Operator's view of context A shows only operator's request and floe's direct messages; floe ↔ reviewer exchange not visible there.
6. **E2E-6 — A summary emitted back into the initiating context appears there.** Floe summarises and emits with explicit `context_id=A`; summary appears in A; raw reviewer messages still don't.
7. **E2E-7 — `/v1/contexts/<id>/events` returns only events for that context.** Verified across multiple populated contexts.
8. **E2E-8 — FloeWeb no longer uses workspace-wide event fetch + client-side source filtering for chat.** Network-inspect; confirm only context-scoped fetches; confirm no source filter in chat code.
9. **E2E-9 — Pulse target-only context works without synthetic participants.** Pulse fires for floe; resulting context has only floe as participant; no synthetic system endpoint; trigger metadata only in event metadata.

## Acceptance criteria

- [ ] All 9 E2E scenarios pass live in a real stack (bus + bridge + FloeWeb).
- [ ] Proof artefacts captured for each scenario: relevant event dumps, FloeWeb screenshots, server logs showing context creation and resolver decisions.
- [ ] Network inspection of FloeWeb during chat use confirms `/v1/contexts/:id/events` is the chat fetch path.
- [ ] A demo run is reproducible from a fresh workspace following the documented steps.
- [ ] No regressions to prior slice acceptance tests (pulse, extension substrate, hooks, conditional emit, etc.).
- [ ] Any failures discovered during live verification are fixed (substrate-side, not papered over in the UI).

## Caution

Do not declare the feature complete based on unit/integration tests alone. The product feature is the user-visible isolation in FloeWeb; that is what this slice proves.

## Blocked by

- Slice 3 — Trigger Contexts
- Slice 4 — Runtime Context Awareness
- Slice 5 — FloeWeb Context-Scoped Rendering
