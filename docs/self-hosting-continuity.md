# Floe self-hosting continuity

Purpose: lightweight continuity source for **building Floe with Floe**.

This document is **repo-operating guidance**, not automatic product doctrine.
It exists so Floe and the operator can recover the current direction even when live context is thin or lost.

## Boundary rule

We are working in two layers at once and must keep them separate.

### 1. Self-hosting development layer
What we need in order to build Floe safely in this repository right now.

Examples:
- current build direction
- active phase goals
- repo-specific handoff notes
- temporary continuity aids used during development

These items are **for this repository/workstream** unless later promoted.

### 2. Floe product/substrate layer
What should exist for arbitrary future workspaces, actors, scopes, and operators.

These items must be:
- actor-neutral
- portable where appropriate
- consistent with bus / bridge / web boundaries
- useful beyond Floe developing itself

## Promotion rule

A self-hosting aid becomes a candidate for Floe proper only if it remains valuable when:
- the workspace is not this repository
- the default actor is not Floe
- the operator is not Justin
- the workflow is not “build Floe with Floe”

Until then, treat it as repo-operating support, not substrate truth.

## Current big picture

We are not trying to prescribe how all work should happen inside Floe.
We are trying to preserve coherent forward motion while Floe is still being built.

The near-term sequence is:
1. stabilize the operator ↔ Floe working loop
2. make continuation deterministic without relying on context compression
3. enable safe bounded delegation to other actors
4. improve the operator surface (likely TUI / better interaction path)
5. only then broaden capability loading such as external skill folders

## Active phased goals

### Phase 1 — working loop stability
Goal: make it practical for operator and Floe to keep working together without losing the thread.

Success signs:
- the current objective is easy to restate
- the next step can be recovered from durable artifacts
- progress is not trapped inside one overloaded live context
- broken/awkward interface friction does not fully block work

### Phase 2 — deterministic continuity
Goal: let Floe recover where it is without pretending memory exists where it does not.

Success signs:
- current state, active decisions, and immediate next goal are written down
- recovery does not depend on summarization/compression alone
- continuity artifacts are lightweight, explicit, and easy to refresh
- ephemeral runtime context is not mistaken for durable project truth

### Phase 3 — safe delegation
Goal: use other actors for bounded work without risking project coherence.

Success signs:
- delegated tasks have explicit scope and handoff context
- actor responsibilities remain clear
- important decisions return to shared durable artifacts
- specialists hold local detail without becoming hidden single points of memory

### Phase 4 — operator surface improvement
Goal: improve the human working surface after continuity is reliable enough to support it.

Success signs:
- operator interaction is less fragile than the current broken interface
- the surface helps inspection, continuation, and routing
- the surface does not bypass substrate principles

### Later — generalized capability loading
Goal: expand what Floe can load/use only after the working loop is stable.

Examples:
- external skill folders
- richer operator-shell integrations
- broader memory/evaluation capabilities through proper seams

This is intentionally later work.

## How to use this document

When context is thin, recover in this order:
1. read this file
2. identify the current phase
3. restate the phase goal in one sentence
4. choose the smallest step that advances that goal
5. check whether the step is repo-operating support or a real Floe product candidate

## Current operating note

Right now the priority is **Phase 1 moving into Phase 2**:
- keep operator and Floe aligned
- establish lightweight durable continuity
- avoid prematurely turning self-hosting aids into universal Floe features
