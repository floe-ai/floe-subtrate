## Objective

Deliver end-to-end objectives through functional vertical slices.

Prioritise the smallest change that achieves the agreed outcome.

Avoid horizontal plumbing, broad refactors, speculative abstractions, cosmetic polish, or unrelated improvements unless explicitly requested.

---

## Project state: pre-release

This repository is pre-release. Nothing depends on it yet; there are no external consumers and no production data.

- **No backward compatibility.** Do not keep old code, schemas, or APIs working for their own sake. When a shape is wrong, change it outright.
- **No migration paths.** Do not write data migrations, compatibility shims, dual-read/dual-write, or deprecation cycles. Replace the old thing and delete it.
- **Config is not migrated.** `~/.floe/config.yaml` follows the current schema only. Breaking schema changes are expected in early development, and there is deliberately no config migration. An incompatible on-disk config fails fast with a reset instruction — never migrate it. The fix is always to reset and re-run setup:

  ```bash
  rm -rf ~/.floe        # or: rm ~/.floe/config.yaml
  floe setup
  ```
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

Within repository documentation, authority is tiered:

1. **Canonical** — `CONTEXT.md` (terminology and invariants) and accepted ADRs in `docs/adr/`. Where a newer ADR corrects an older statement, the correction governs.
2. **Working** — `docs/ROADMAP.md`, PRDs, and open plans in `docs/plans/`. These express direction and working order as of when they were written. Where they conflict with a canonical doc, the canonical doc wins. Never edit a canonical doc to match a working doc.
3. **Historical** — worklogs, evidence folders, QA artifacts, and closed plans. Point-in-time records; never treat them as current.

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

## Extension Substrate (Track S — ext-substrate-s3)

### Context `title` field

- `ContextRecord` and `ContextListRow` have `title: string | null`.
- SQLite: added via `addColumnIfMissing` AFTER `relaxContextAnchorColumns` (the rebuild otherwise drops it).
- `POST /v1/workspaces/:ws/contexts` accepts optional `title` and `scope_id`. When `scope_id` is present, `participants` may be empty.
- `GET /v1/workspaces/:ws/contexts?scope_id=X` uses the indexed `listContextsForScope` path.

### Extension manifest `views` and `agents`

- `ExtensionManifest` gains optional `views?: ExtensionViewConfig[]` and `agents?: BundledAgentConfig[]`.
- `LoadedExtension` gains `views`, `bundledAgents`, `httpHandlers` (all empty arrays when absent).
- `registerHttpHandler` on `ExtensionContext` stores handlers locally in the bridge; the relay requires `relay_url` reported to the bus.

### Extension HTTP relay

- Bus exposes `POST /v1/extensions/report` (bridge calls after each workspace attach).
- Bus exposes `GET /v1/extensions` (app fetches to discover extension views).
- Bus exposes `GET/POST /v1/extensions/:name/*` — proxies to `relay_url` if registered; returns 503 if not.
- Bridge does NOT expose its own HTTP server in this release. `relay_url` is `null` until a bridge HTTP relay server is implemented.

### ScopeDetail dynamic tabs

- `contextLabel` prefers `title` over `first_message_preview`.
- Tabs are dynamic: built-in `["Contexts", "Ops"]` + extension views from `GET /v1/extensions`.
- Contexts list now calls `listContextsForScope` (server-side index) instead of client-side filter.
- Placeholder stub view validates registry without importing the extension package.
- TODO(integration-join): Replace `PlaceholderExtensionView` with `import { SnowballBoard } from "@floe/ext-snowball/BoardView"` once `snowball-ext-x2` lands.

### Extension loader test isolation

- When writing test fixtures that need `.floe/` structure, use a **separate** workspace dir from the extensions dir (e.g. `join(tempDir, "workspace")` for the workspace and `join(tempDir, "extensions")` for extensions). Mixing them causes `loadExtensions` to treat `.floe/` as an extension directory.

---

## floe-ext-snowball (extension package)

New workspace package added in `fm/snowball-ext-x2` (PR #72).

**Location:** `floe-ext-snowball/` (workspace entry in root `package.json`)

**What it is:** The Snowball Kanban extension — exit-criteria-gated cards, column ownership, and agent routing — implemented as a floe extension that builds against the substrate contract (contract-w7).

**Key invariants:**
- Sidecar schema: `floe.ext.snowball.board.v1` at `.floe/extensions/snowball/boards/<slug>.yaml`
- `slugify(scope_id)` replaces `:`, `/`, `\` with `_` for Windows-safe filenames (R8)
- Column owner uses `agent_id` (not free-form `role`) matching `.floe/agents/<id>.md` (R5)
- Participants are FROZEN — agents connect via `snowball.card.entered_column` routing events, not participant mutation (R1)
- AI `move_card` gate: HARD block when exit criteria unchecked; human `force=true` is soft-warn
- WIP limit: hard block for both human and AI

**Stub seam (§6):** `src/stub/bus-client.ts` provides `BusClient` interface + `StubBusClient` for isolated testing. Integration join: swap when Track S (ext-substrate-s3) exports a real typed client.

**Tests:** `npm test --workspace floe-ext-snowball` — 30 unit tests (sidecar + gate enforcement).

**Board UI entry point:** `floe-ext-snowball/src/ui/BoardView.tsx` exported at `package.json exports['./BoardView']` for Track S's static import into `ScopeDetail.tsx`.
