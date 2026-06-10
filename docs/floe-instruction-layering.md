# Floe instruction layering

## Purpose

Define where Floe's instructions should live so the default agent stays effective without becoming a giant permanent prompt.

## Current reality

### 1. Substrate-invariant guidance already exists in runtime core
- `floe-bridge/src/runtime-core/guidance.ts`
- Appended to every runtime actor prompt by `buildSystemPrompt(...)`
- Covers actor/event/emit/turn/context semantics
- This is the right place for substrate truths that should apply across workspaces

### 2. Default Floe workspace instructions come from the project template
- `floe-bridge/src/project.ts`
- Seeds `.floe/agents/floe.md` during workspace initialisation
- Current default body is useful but thin: mostly emit/reply discipline

### 3. Workspace-specific Floe instructions live in the workspace
- `.floe/agents/floe.md`
- This is the right place for repo-specific doctrine when Floe is building a particular system

### 4. Skills are declared but not yet acting as runtime instruction layers
- Agent files can declare `skills`
- `RuntimeInstructionSet` has `skill_context` and `extension_profiles` types
- Current runtime prompt assembly appears to use only agent instructions + substrate guidance
- So skills should not yet be treated as a reliable prompt-layer mechanism

## Proposed instruction model

### Layer 1 — Runtime core invariants
Use for:
- actor/event/emit/turn semantics
- neutral actor model
- delivery/context rules
- universal communication rules

Location:
- `floe-bridge/src/runtime-core/guidance.ts`

Rule:
- Keep this small, stable, and identity-neutral

### Layer 2 — Default Floe operating doctrine
Use for:
- token economy
- route before broad exploration
- deterministic tooling first
- first-principles capability design
- codebase stewardship
- explicit responsibility boundaries
- prefer reusable tools over repeated reasoning

Location:
- default Floe agent template in `floe-bridge/src/project.ts`
- reflected into workspace `.floe/agents/floe.md`

Rule:
- Reusable across many workspaces, but specific to Floe as the primary builder/coordinator

### Layer 3 — Workspace doctrine
Use for:
- trusted docs for this repo
- current architecture/product truth
- current development constraints
- local priorities and known deprecations

Location:
- workspace docs and/or `.floe/agents/floe.md`

Rule:
- Keep compact; prefer a minimal trusted working set over broad historical context

### Layer 4 — Task-local context
Use for:
- current objective
- files in scope
- acceptance criteria
- temporary routing details

Location:
- delivery context, task messages, and narrow file reads

Rule:
- Never bake this into permanent instructions

## Design rules

1. Do not try to make Floe all-knowing with one giant prompt.
2. Put stable truths high in the stack and specific truths low in the stack.
3. Bulky or changing knowledge should live in trusted docs/retrieval, not permanent instructions.
4. Deterministic recurring workflows should become tools/scripts, not prompt prose.
5. A smaller trusted corpus is better than a large contradictory corpus.

## Immediate next slices

1. Tighten the default Floe agent template so it includes compact operating doctrine, not just emit discipline.
2. Triage repository docs into trusted / reference / stale sets.
3. Decide whether skill files should remain reference artefacts or become a real injected instruction layer.
4. Keep Floe's workspace-specific instructions lean and current as this repo evolves.
