## Objective

Deliver end-to-end objectives through functional vertical slices.

Prioritise the smallest change that achieves the agreed outcome.

Avoid horizontal plumbing, broad refactors, speculative abstractions, cosmetic polish, or unrelated improvements unless explicitly requested.

---

## Project state: pre-release

This repository is pre-release. Nothing depends on it yet; there are no external consumers and no production data.

- **No backward compatibility.** Do not keep old code, schemas, or APIs working for their own sake. When a shape is wrong, change it outright.
- **No migration paths.** Do not write data migrations, compatibility shims, dual-read/dual-write, or deprecation cycles. Replace the old thing and delete it.
- **Config is not migrated.** `~/.floe/config.yaml` follows the current schema only. Breaking schema changes are expected in early development, and there is deliberately no config migration. An incompatible on-disk config fails fast — never migrate it. Delete only the config file and re-run setup:

  ```bash
  rm ~/.floe/config.yaml   # deletes only the config file
  floe setup
  ```

  If you need a full factory reset (wipes all workspace history and credentials — cannot be undone):

  ```bash
  rm -rf ~/.floe           # destroys event history, auth credentials, logs, skills, extensions
  floe setup
  ```

  Note: credentials (`~/.floe/auth/`) are the only data that must survive a maintenance action. Once they move out of the configuration root, the narrow instruction above becomes narrower still.
- **Zero tech-debt accumulation.** Leave every change at the quality you would want to inherit. If a change would add debt "to clean up later," do the clean version now or stop and flag it — "later" does not exist here.

This licenses deletion and replacement. It does **not** license sloppiness: the bar is *higher*, because there is no legacy excuse for mess.

---

## Evaluate, don't inherit

The repository records past decisions; it is not proof they were right. Existing code, conventions, patterns, and structure may be sound or may be debt.

- When you touch an area, judge its existing approach against first principles, `CONTEXT.md`, and `MISSION.md` — do not adopt a pattern merely because it is present.
- If the surrounding convention is sound, match it. If it is poor, fix it within scope or flag it explicitly — never propagate it silently.
- Leave each area better than you found it. Consistency with a bad pattern is not a virtue.

This pairs with the Source of Truth tiers: code is authoritative for *what the system currently does*, never for *what it should do*.

---

## Core Principle

Route before reasoning; build before theorising.

Do not broadly explore the repository before determining where the work belongs, and do not reason at length about a thing you could have run.

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

Within repository documentation, authority is tiered:

1. **Canonical** — `CONTEXT.md` (terminology and invariants) and accepted ADRs in `docs/adr/`. Where a newer ADR corrects an older statement, the correction governs.
2. **Working** — PRDs and open plans in `docs/plans/`. These express direction and working order as of when they were written. Where they conflict with a canonical doc, the canonical doc wins. Never edit a canonical doc to match a working doc.
3. **Historical** — worklogs, evidence folders, QA artifacts, closed plans, and **issue, PR and Wayfinder map prose**. Point-in-time records; never treat them as current. A decision is not canonical because a ticket says it was accepted — it is canonical when it is in an ADR or `CONTEXT.md`. If a ticket claims a decision that no committed document carries, the decision has not landed: say so rather than acting on it.

New knowledge routes into living documents; do not create new Markdown files by default:

- Terminology, definitions, invariants → edit `CONTEXT.md` in place.
- Lasting decisions → a new ADR in `docs/adr/` (append-only, `NNNN-kebab-slug.md`).
- Slice plans → `docs/plans/`; disposable — delete once executed (worklog and commits are the record).
- Retiring a term → `CONTEXT.md` `_Avoid_` list AND a rule in `floe-bus/src/docs-vocabulary.test.ts`, same change.
- Anything else needs explicit operator approval; `floe-bus/src/docs-structure.test.ts` fails on unregistered standing documents.

Surface conflicts immediately.

Never silently resolve contradictions.

---

## Required Workflow

**Build to learn. Grill what exists.**

A question about something that already runs is worth asking — you can check the answer. A question about something that does not exist yet is a guess, and guesses compound: enough of them in a row and the thing gets built on a chain of theory nobody tested. When you cannot settle a question by discussion, that is the signal to build the smallest thing that answers it, not to discuss it harder.

Planning is a step, not a phase gate. Spend it in proportion to what you do not know.

### Step 1: Route (only if you do not already know where the work goes)

If the target module is obvious, skip this. Otherwise use Architecture Enforcer to resolve the smallest valid ownership boundary — cell, module, write authority, allowed dependencies — and whether the work modifies an existing module, adds one, or genuinely needs a new cell.

Do not perform broad repository discovery in place of routing. Use deterministic tooling — architecture lookup, ast-grep, symbol search, dependency analysis, tests and logs — over reading large numbers of files.

### Step 2: Size the slice

Determine the smallest vertical slice that achieves the objective end to end. A slice that leaves the loop no shorter is deferred by default (see `MISSION.md`).

Generate PRDs or issue breakdowns only when the work is genuinely too large to hold. They are a tool for big work, not a required artefact.
### Step 3: Implementation

Implement the agreed slice.

Prefer:

* red-green-refactor
* incremental commits
* preserving existing ownership boundaries
* extending existing modules before creating new cells

A new Cell should only be introduced when new mutable-state ownership or a new external contract owner is required.

---

### Step 4: Validation

Before completion:

* run tests
* run architecture validation
* verify ownership boundaries
* verify dependency legitimacy
* update invariants if structural contracts changed

No task is complete until validation passes.

---

### Step 5: Reconciliation

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


---

## Build Tool (developer / dogfooding only)

`npm run build` at the repo root is a **selectable build** — a dev workshop tool, not a product feature. It is never part of the `floe` CLI.

Entry point: `scripts/build.mjs`

### Targets

| ID | Workspace | Build command |
|----|-----------|---------------|
| `bus` | `floe-bus` | `tsc -p tsconfig.json` |
| `bridge` | `floe-bridge` | `tsc -p tsconfig.json` |
| `cli` | `floe-cli` | `tsc -p tsconfig.json` |
| `app` | `floe-app` | `tsc -b && vite build` |

> The Tauri / exe build (`tauri:build`) is intentionally excluded. Run it manually inside `floe-app` when needed.

### Usage

```bash
# Interactive multi-select (TTY) — all pre-ticked, Space to toggle, Enter to confirm
npm run build

# Build all targets (non-interactive)
npm run build -- --all

# Build specific targets
npm run build -- bus app

# Help
npm run build -- --help
```

**Non-TTY (agent / CI):** when stdin is not a TTY and no targets are given, all four targets are built automatically — the script never hangs waiting for input.

### Rules
- Do NOT add a `build` command to the `floe` CLI (`floe-cli/src/**`).
- Do NOT include the Tauri desktop build in this picker.
- Keep the script zero-dep (no new `npm` dependencies).

---

## Standing substrate invariants

Rules, not descriptions. Everything else about how the substrate works is read from the code — that is Source of Truth tier 1, and a prose copy of it here would only rot.

- **The substrate is push-only.** No recurring polling anywhere: no reconcile timers, no liveness pings, no interval scans. Delivery rides the bridge↔bus WebSocket; recovery is a one-shot resync on reconnect; lease expiry uses a single scheduled timer, never a scan.
- **A turn is built from exactly one context** — the delivery's origin context. No bleed from any other.
- **A session is ephemeral and per (actor, context).** It holds private reasoning; it is never persisted. A restart is a cold start, and that is safe by design — an actor re-derives from the world (files) and the context. Sessions are released on restart; they are not evicted by count or LRU, because any cap would be an arbitrary number.
- **Tool calls and tool results are private.** The context carries outputs, not scratch. Backfill is therefore lossy on purpose.
- **`.floe/floe.yaml` is human-authored, committed project config — read-only at runtime.** Bundled and extension agents register in memory from the loaded manifest; nothing is written to disk on boot. After a clean boot, `git status --porcelain` in the workspace must be empty.
- **There is no human/agent distinction anywhere.** No `actor_kind`, no stored backing label; delivery is gated on runtime attachment. A peer cannot tell what backs an actor, and no surface may reveal it.
- **Extensions are independent repositories** building against the substrate contract (ADR-0006). They are not vendored here.

