## Objective

Deliver end-to-end objectives through functional vertical slices.

Prioritise the smallest change that achieves the agreed outcome.

Avoid horizontal plumbing, broad refactors, speculative abstractions, cosmetic polish, or unrelated improvements unless explicitly requested.

---

## Core Principle

Route before reasoning.

Do not broadly explore the repository before determining where the work belongs.

Use deterministic tooling whenever possible.

Prefer:

* architecture lookup
* architecture bootstrap
* reconciliation scripts
* ast-grep
* symbol search
* dependency analysis
* tests and logs

over:

* large-scale repository exploration
* architectural guesswork
* reading large numbers of files

Every step should reduce agent cognition and token consumption.

---

## Architecture Philosophy

Architecture maps are curated, not authored.

Use deterministic tooling to discover and maintain architecture wherever possible.

Use LLM reasoning to:

* review architecture
* refine ownership boundaries
* resolve ambiguity
* reconcile drift

Do not manually reconstruct repository structure from scratch when deterministic tooling can derive it.

The architecture map is:

* a routing system
* an ownership system
* a dependency system

It is not:

* a code index
* a function catalogue
* a complete representation of the codebase

The architecture map must remain significantly smaller and slower-changing than the codebase it describes.

---

## Source of Truth

Resolve conflicts using this order:

1. Current code and runtime behaviour
2. Tests and logs
3. Architecture map
4. Repository documentation and ADRs
5. Product requirements
6. Prior assumptions or memory

Surface conflicts immediately.

Never silently resolve contradictions.

---

## Required Workflow

### Phase 1: Architecture State

Before planning, implementation, or refactoring:

1. Run Architecture Enforcer.

2. Determine repository state:

   * mapped
   * brownfield-bootstrap-required
   * greenfield

3. If brownfield-bootstrap-required:

   * run architecture bootstrap
   * review the generated draft architecture map
   * refine ownership where required

4. If greenfield:

   * create an initial architecture map from the provided template

5. Continue only once an architecture map exists.

Do not perform broad repository discovery before this phase completes.

---

### Phase 2: Architecture Routing

Once an architecture map exists:

1. Resolve:

   * Cluster
   * Cell
   * Module

2. Determine:

   * ownership boundaries
   * write authority
   * allowed dependencies
   * recommendation type:

     * modify-existing-module
     * add-module-in-existing-cell
     * add-cell

Architecture routing should identify the smallest valid ownership boundary for the work.

Do not perform broad repository discovery before this phase completes.

---

### Phase 3: Implementation Discovery

Once the target module is known:

Use deterministic discovery tools to inspect only the relevant implementation area.

Prefer:

* ast-grep
* symbol search
* code search
* targeted file reads

The architecture map is a routing system, not a code index.

Do not extend architecture discovery into function-level modelling.

---

### Phase 4: Planning

Determine the smallest vertical slice required to achieve the objective.

When useful:

* invoke discovery workflows
* generate PRDs
* generate issue breakdowns

Planning should occur after architecture routing, not before.

---

### Phase 5: Implementation

Implement the agreed slice.

Prefer:

* red-green-refactor
* incremental commits
* preserving existing ownership boundaries
* extending existing modules before creating new cells

A new Cell should only be introduced when new mutable-state ownership or a new external contract owner is required.

---

### Phase 6: Validation

Before completion:

* run tests
* run architecture validation
* verify ownership boundaries
* verify dependency legitimacy
* update invariants if structural contracts changed

No task is complete until validation passes.

---

### Phase 7: Reconciliation

Before completion:

Run Architecture Enforcer reconciliation.

Review:

* ownership drift
* dependency drift
* structure drift
* suggested patches

If ownership, dependencies, or module structure changed, update the architecture map as part of the same task.

Architecture maps that are not reconciled will drift and lose value.

---

## Delegation

The primary agent owns:

* routing
* planning
* validation
* reconciliation
* final review

Implementation work may be delegated after architecture routing is complete.

Delegated work should be scoped to the selected module and its immediate dependencies.

Delegation exists to reduce context size, not to bypass review.

---

## Architecture Rules

A Cell is:

> The smallest unit that owns mutable state or an external integration contract.

Most growth should occur through:

* existing modules
* new modules within existing cells

Avoid creating new Cells unless ownership genuinely changes.

Ownership is more important than file layout.

Write authority is more important than read access.

---

## Quality Bar

Every completed slice must provide:

* working code or artefacts
* passing validation
* passing tests
* preserved ownership boundaries
* reconciled architecture map
* updated documentation where required
* no fake-only success paths
* no leaked secrets, credentials, or tokens

