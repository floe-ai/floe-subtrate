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

### Update-safety invariant (fm/state-hygiene-p6)

**`.floe/floe.yaml` is human-authored, committed project config — treat it as read-only at runtime.**

- Bundled/extension agents are registered **in memory** directly from the loaded extension manifest, never persisted to `.floe/floe.yaml` or `.floe/agents/`.
- `provisionBundledAgents()` has been removed. Its replacement `loadBundledAgentsInMemory()` reads instructions from the extension's `instructions_path` and returns `LoadedBundledAgent[]` (includes `body: string`) — no disk writes.
- `daemon.ts` `attachWorkspace()` iterates `ext.bundledAgents` after loading extensions and calls `bus.registerEndpoint()` + stores in `endpointRuntime` — the same path used for project-declared agents, but sourced entirely from memory.
- After a clean boot, `git status --porcelain` in the workspace repo must be empty (no tracked file dirtied).

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

### Extension HTTP relay — IMPLEMENTED (fm/integrate-board-i4)

- `floe-bridge/src/extension-relay.ts` provides a Node.js HTTP relay server started at workspace attach time.
- The relay listens on port 5378 (falls back to OS-assigned if taken).
- Per-extension relay URL includes extension name as path prefix: `http://127.0.0.1:5378/{extName}`. This ensures the bus proxy correctly routes `GET /v1/extensions/{name}/{path}` → `http://127.0.0.1:5378/{name}/{path}`.
- Handler signature (real interface): `(req: { method, path, query, body }) => Promise<{ status, body }>`. Handlers must NOT use `req.url` (legacy pattern); use `req.query` instead.
- `relay_url` is `null` when an extension has no HTTP handlers.

### ScopeDetail dynamic tabs

- `contextLabel` prefers `title` over `first_message_preview`.
- Tabs are dynamic: built-in `["Contexts", "Ops"]` + extension views from `GET /v1/extensions`.
- Contexts list now calls `listContextsForScope` (server-side index) instead of client-side filter.
- Placeholder stub view validates registry without importing the extension package.
- Integration join COMPLETE (fm/integrate-board-i4): `PlaceholderExtensionView` replaced by `SnowballBoard` from `"floe-ext-snowball/BoardView"` via `COMPONENT_REGISTRY` keyed on `v.component`. Fallback to `PlaceholderExtensionView` for unknown extension components.

### Extension loader test isolation

- When writing test fixtures that need `.floe/` structure, use a **separate** workspace dir from the extensions dir (e.g. `join(tempDir, "workspace")` for the workspace and `join(tempDir, "extensions")` for extensions). Mixing them causes `loadExtensions` to treat `.floe/` as an extension directory.

---

## floe-ext-snowball (extension package)

New workspace package added in `fm/snowball-ext-x2` (PR #72).
Foundation Slice 1 shipped in `fm/snowball-found-s1`: **card = markdown file, column = bus Context**.
Slice 2 shipped in `fm/snowball-col-instr-s2`: **column = committed markdown file** (with instructions in body).

**Location:** `floe-ext-snowball/` (workspace entry in root `package.json`)

**What it is:** The Snowball Kanban extension — exit-criteria-gated cards, column ownership, and agent routing — implemented as a floe extension that builds against the substrate contract (contract-w7).

**Key invariants (post fm/snowball-ctx-retire — Slice 6):**
- **No sidecar.** The `.floe/extensions/snowball/runtime/` directory and all `<slug>.yaml` sidecar files are eliminated. There is no `column_contexts` map, no `initBoardContexts`, no `loadSidecar`/`saveSidecar`. The only persistent state is committed board files + card files.
- `slugify(scope_id)` exported from `board-file.ts` (moved from sidecar.ts in Slice 6).
- **Board snapshot** utilities (`buildBoardSnapshot`, `renderCompactBoardSnapshot`) live in `board-snapshot.ts` (relocated from sidecar.ts in Slice 6). `buildBoardSnapshot(workspacePath, scopeId, workspaceId, columns)` — no sidecar param.
- `getUncheckedCriteriaForCard` is in `card-file.ts` (canonical home).
- **`initialized` flag** on board API responses = board file exists (`readBoardFile(...) !== null`). Before `POST /board/init`, `initialized=false`.
- `POST /board/init` = file-ensure only: calls `ensureBoardFile()` to create `board.md` with default columns if absent. Creates **ZERO bus contexts**. Pure file operation.
- No column contexts are created anywhere. Column contexts were retired in Slice 6.
- The overseer is NOT added to any card context (not even a watcher).
- **Card = context**: every card has a `context_id` field in its frontmatter (null for legacy pre-Slice-4 cards). The card context is created at card creation time and its `context_id` written to frontmatter immediately.
- **AssignedActor model** (`assigned_actors: Array<{actor_ref: string, event_types: string[]}>`) on columns. `actor_ref` resolves to `actor:<workspace_id>:<actor_ref>` at runtime. Empty `assigned_actors` = no actors assigned.
- **Handoff** (`floe-ext-snowball/src/handoff.ts`): `applyColumnAssignment()` is the shared helper for both create and move.
- **Routing**: `snowball.card.entered_column` uses `destination:{kind:"context",context_id:<card_context_id>}` — subscription-based routing to the card's context, never endpoint-targeted.
- **UI handler acting actor**: operator endpoint `actor:<workspace_id>:operator`.
- **Built-in operator**: reference `actor:<workspace_id>:operator` — never register a snowball-specific operator.
- AI `move_card` gate: HARD block when exit criteria unchecked; human `force=true` is soft-warn.
- WIP limit: hard block for both human and AI.
- `StubBusClient.createdContexts` captures `CreateContextInput[]` for test assertions.

**Tests:** `npm test --workspace floe-ext-snowball` — 214 unit tests (board-snapshot utilities + gate enforcement + handler + overseer driver + instructions endpoints + board-file + advance-on-conclusion timing + hooks BeforeTurn injection + Slice 4 card-context invariants).

**Slice 4 (fm/snowball-card-context) — card = context, uniform actor assignment:**
- **Card = context**: every card has a `context_id` field in its frontmatter (null for legacy pre-Slice-4 cards). The card context is created at card creation time and its `context_id` written to frontmatter immediately.
- **AssignedActor model** (`assigned_actors: Array<{actor_ref: string, event_types: string[]}>`) replaces the old `owner: {kind:"human"|"agent", agent_id}` model on column files. `actor_ref` is a slug resolved to `actor:<workspace_id>:<actor_ref>` at runtime. Empty `assigned_actors` = no actors assigned (equivalent to old "human"-owned). Any actor — operator or LLM — is handled by identical code.
- **Handoff** (`floe-ext-snowball/src/handoff.ts`): `applyColumnAssignment()` is the shared helper for both create and move. It builds a single `applyContextSubscriptions` batch call: acting actor → `participants_only`, destination column actors → entries with their `event_types`, prior column actors → entries with `event_types:[]` (silent watcher). Then emits `snowball.card.entered_column` into the card context with `destination:{kind:"context"}` if the destination has assigned actors. `createCardContext()` creates a bus context for a card with the creator as first participant.
- **Routing**: `snowball.card.entered_column` uses `destination:{kind:"context",context_id:<card_context_id>}` — subscription-based routing to the card's context, never endpoint-targeted. No column contexts created on moves (only card contexts).
- **UI handler acting actor**: operator endpoint `actor:<workspace_id>:operator`.
- **Tool acting actor**: first assigned actor of the destination column (TODO: use calling agent endpoint when `ExtensionContext` exposes it).
- **Built-in operator**: reference `actor:<workspace_id>:operator` — never register a snowball-specific operator.
- The overseer is NOT added to any card context (not even a watcher).

**Slice 5 (fm/snowball-col-board-s5) — columns inside board file:**
- **Column definitions relocated** from individual `boards/<slug>/columns/<id>.md` files INTO `boards/<slug>/board.md` frontmatter. `column-file.ts` is deleted.
- **`BoardFile.columns: ColumnFile[]`** — board.md frontmatter now has `scope_id` + `columns` array. Body = done protocol unchanged.
- **`ColumnFile` type** moved to `types.ts` (from `column-file.ts`). The `scope_id` field is populated from the board's `scope_id` at read time; not stored per-column in YAML.
- **Board-file.ts** now owns all column I/O: `listColumnsFromBoard`, `readColumnFromBoard`, `writeColumnToBoard`, `updateColumnInBoard`, `updateColumnInstructions`, `deleteColumnFromBoard`, `findBoardScopesForAgentFromFiles`, `defaultColumnFiles`, `generateColumnId`.
- **Column addressability**: column IDs are stable; future cross-board references use `<board_scope_id>/<column_id>`. The board file format does not hardcode single-board assumptions.
- `ensureBoardFile` now creates board.md with default columns if absent.

**Board live refresh (fm/board-refresh-fix, updated fm/floe-card-context-churn):** Human mutations use `withReload()` in `BoardView.tsx` — every mutation calls `reload()` after the POST completes. Agent-driven moves are covered by a WS subscription via `subscribeBusStream()` in `bus-stream.ts` (which provides automatic reconnect with exponential back-off — no reconnect storms). The bus broadcasts `event_submitted` via `store.submitEvent` → `broadcast("event_submitted", { event })` at `floe-bus/src/store.ts:1352`. **`snowball.card.moved`, `snowball.card.created`, `snowball.card.criteria_checked`, and `snowball.card.gate_overridden` broadcast events have been removed** — they used `target: "active_with_delivery_processor"` with no `context_id`, causing the bus resolver to create a throwaway context and trigger an agent-turn delivery for every card mutation. `snowball.card.entered_column` (into the CARD context with `destination:{kind:"context"}`) is now the sole canonical signal for both agent routing and WS-based UI refresh.

**Board routing invariants (fm/floe-e2e-fix, updated fm/snowball-card-context):**
- **All snowball emits must include `scope_id`** so any fallback-created contexts are scoped to the board scope, never stray no-scope contexts.
- **Card contexts are stable**: each card has ONE stable context from creation. Moving a card from column A to column B reuses the same card context. No new context is created on move when `context_id` is already set.
- **Lazy card context creation**: legacy cards (pre-Slice-4, `context_id:null`) get a card context created on first move. Written to frontmatter immediately.
- **Prior actor demotion**: when a card moves from column A (with actors) to column B (with different actors), column A's actors get `event_types:[]` in the batch call — still participants (can emit), never woken again.
- **Endpoint status gate**: the `snowball-overseer` endpoint starts as `runtime_unconfigured` (no auth profile). The bus does NOT create delivery bundles for `runtime_unconfigured` endpoints (`tryCreateDeliveryForEndpoint` returns null). A workspace runtime binding must be set before the overseer can process deliveries.

**Board UI entry point:** `floe-ext-snowball/src/ui/BoardView.tsx` exported at `package.json exports['./BoardView']` for Track S's static import into `ScopeDetail.tsx`.

### Snowball extension installation (dogfooding in this repo)

The extension is pre-installed for this workspace at `.floe/extensions/snowball/extension.json`.
The entry path (`../../../floe-ext-snowball/src/index.ts`) resolves to the source package when this repo IS the workspace.

When bridge loads: `snowball-overseer` agent is registered **in memory only** (no disk write) — its instructions are read from `floe-ext-snowball/overseer-instructions.md` at load time and the endpoint is registered directly with the bus via `registerEndpoint`. No file is written to `.floe/agents/` and `floe.yaml` is not modified at runtime.

**To run live:**
```bash
npm run floe -- setup -- --no-autostart --no-open
# open http://127.0.0.1:5379 and select the workspace; create a Scope; the Board tab appears
```

---

## Web + Desktop architecture (fm/web-desktop-w3)

### One-server, one-UI model
- Architecture: single bus (port 5377) + single UI surface (port 5379 served by vite, browser-accessible AND wrapped by Tauri desktop shell).
- `floe-app` is NOT desktop-only — the same 5379 UI surface works in a plain browser.
- Auth WRITE is desktop/CLI-only per ADR-0005. The bus does not expose auth-write endpoints.

### Service commands
- **`floe start`** = services only (bus + bridge + frontend/vite on 5379). No browser opened, no window. Safe for autostart.
- **`floe desktop`** = start services if needed, wait for 5379 health, then open the Tauri desktop window ATTACHED to the already-running 5379 frontend (never spawns its own vite).

### No-second-vite mechanism
`tauri.conf.json` has `beforeDevCommand: "npm run dev"`. Running `tauri dev` naively would start a second vite → port 5379 collision.
Solution: `floe-app/package.json` has a `tauri:attach` script (`tauri dev --config src-tauri/tauri.attach.conf.json`) that deep-merges `tauri.attach.conf.json` (which sets `beforeDevCommand: ""`) onto the base config, preventing Tauri from running `npm run dev` and attaching directly to the already-running `devUrl` (5379).
**Note:** `--no-dev-server` does NOT suppress `beforeDevCommand` (it only governs Tauri's own static-file server); a config override with an empty `beforeDevCommand` is the correct mechanism.
`floe desktop` invokes `npm run tauri:attach --workspace floe-app`.

### Cargo preflight
`floe desktop` calls `checkCargoAvailable()` (in `floe-cli/src/desktop.ts`) before attempting to launch Tauri. If cargo is not on PATH, it fails fast with a `rustup.rs` install link. First launch compiles Rust (~2–5 min); output is shown in the terminal (stdio: inherit).

### Browser settings view
`SubstrateSettingsView.tsx` uses `isTauri()` from `floe-app/src/fs/workspaceFs.ts` to branch:
- **Browser**: `BrowserAuthPillar` — fetches profiles from bus (`GET /v1/auth/profiles` via `getAuthProfiles()`), shows read-only list with a note to use CLI/desktop for writes.
- **Desktop**: `TauriAuthPillar` — full read/write via Tauri `invoke`. No Tauri calls in the browser path.
The nav "Substrate Settings" item is always visible (useful in both modes).

---

## Card = Context substrate primitives (fm/floe-ctx-primitives, PR #95)

Four generic, extension-agnostic substrate primitives landed in this PR. All are in `floe-bus/` and `floe-bridge/`. No snowball vocabulary.

### Core model invariants (captain-confirmed)
- **Participation ≠ subscription.** Participation = context membership; any participant may ALWAYS emit (resolver rule 1 unchanged). Subscription = which event TYPES wake an actor (trigger a delivery/turn).
- **No role enum.** "Assignee/watcher" is emergent from subscription `event_types`: subscribed to `["*"]` = woken by all events; subscribed to `[]` = silent watcher; no subscription row = not woken.
- **`destination:{kind:"context"}` is the single context-delivery path.** It records the event AND delivers to subscribed actors. Zero subscriptions = zero deliveries (natural record-only outcome). There is no separate `context_fan_out` kind — do not add one.

### Slice 0 — Context compaction + clear-history
- `ContextStore.clearContextHistory(contextId)` — delete all events, keep context row + participants + pulse subscribers. Replicates `deleteContext`'s delivery-bundle cleanup. Do NOT call while `delivery_bundles.state='active'`.
- `ContextStore.compactContext(contextId, summary, beforeEventId?)` — truncate history to watermark, insert synthetic `context.compacted` event.
- Routes: `POST /v1/contexts/:id/compact` `{ summary, before_event_id? }` and `POST /v1/contexts/:id/clear-history`.
- Hook events in `floe-bridge/src/hooks.ts`: `ContextCompacted`, `ContextHistoryCleared`, `ParticipantAdded`, `ParticipantRemoved`.
- Bridge daemon fires these via `fireContextLifecycleHook()` when it receives the bus broadcasts.

### Slice 1 — Dynamic participants + context linking
- `ContextStore.addParticipant(contextId, endpointId)` — idempotent INSERT OR IGNORE; returns bool.
- `ContextStore.removeParticipant(contextId, endpointId)` — idempotent DELETE; returns bool.
- Routes: `POST /v1/contexts/:id/participants {endpoint_id}` and `DELETE /v1/contexts/:id/participants/:endpoint_id`.
- `parent_context_id` is now exposed in `POST /v1/workspaces/:ws/contexts` body (field already existed in schema).
- `ContextStore.listContextsForParent(parentId)` + `GET /v1/contexts/:id/children`.
- Index `idx_contexts_parent ON contexts(parent_context_id, created_at)`.
- Self-reference guard: `parent_context_id === own id` is rejected 400.
- Integration test T10 updated: freeze-guard assertions removed; now positively asserts the dynamic API exists.

### Slice 2 — Per-event-type subscriptions + single context-delivery path
- Table: `context_subscriptions(context_id, endpoint_id, event_types JSON, subscribed_at)` PK `(context_id, endpoint_id)`.
- `ContextStore.subscribeToContext(contextId, endpointId, eventTypes?)` — UPSERT, default `["*"]`.
- `ContextStore.unsubscribeFromContext(contextId, endpointId)` — idempotent.
- `ContextStore.getContextSubscriptions(contextId)` and `isSubscribed(contextId, endpointId, eventType)`.
- **`destination:{kind:"context"}` is the single context-delivery path**: records event in context log AND delivers to actors whose subscription matches the event type. Zero subscriptions = zero deliveries (natural record-only outcome). No separate `context_fan_out` kind.
- `appendContextEvent` (internal history writes) bypasses routing entirely — it never calls `resolveDestinations` or `queueEvent`, so it is always zero-delivery by construction regardless of subscription state.
- Routes: `POST/DELETE/GET /v1/contexts/:id/subscriptions`.

### Batch subscriptions (fm/floe-batch-subs)
- `ContextStore.applyContextSubscriptions(contextId, entries, participantsOnly?)` — applies participant + subscription changes atomically in a single SQLite transaction.
  - `entries`: each endpoint is idempotently added as participant AND has its subscription upserted. `event_types:[]` = silent watcher.
  - `participantsOnly`: endpoints added as participants with NO subscription change (for acting actors who must emit but are not subscribed).
- Route: `POST /v1/contexts/:id/subscriptions:batch` body `{ entries, participants_only? }`.
- Both `floe-bridge/src/bus-client.ts` and `floe-ext-snowball/src/stub/bus-client.ts` expose `applyContextSubscriptions(contextId, entries, participantsOnly?)`.
- `applyColumnAssignment` in `floe-ext-snowball/src/handoff.ts` collapses 6+ sequential bus calls into one batch call + one emit.

### Slice 3 — Runtime-based delivery gate (reworked from actor_kind)
The substrate has exactly ONE actor abstraction. Delivery is gated on runtime attachment (`bridge_id` + `status`), never on a stored backing label. There is **no `actor_kind` column** and no human/agent distinction stored anywhere — peers cannot tell what backs an actor.
- An actor with no live agent runtime (`bridge_id = null`) queues events as readable context history but never receives a delivery bundle. The `tryCreateDeliveryForEndpoint` `!endpoint.bridge_id` gate handles this.
- An actor with a live agent runtime attached gets delivered normally (unchanged behaviour).
- `registerEndpoint()` has no `actor_kind` param. `POST /v1/endpoints/register` has no `actor_kind` field.

### Test files added
- `floe-bus/src/contexts/compaction.test.ts` — 9 tests
- `floe-bus/src/contexts/participants.test.ts` — 12 tests  
- `floe-bus/src/contexts/subscriptions.test.ts` — 19 tests
- `floe-bus/src/contexts/runtime-delivery.test.ts` — 4 tests
- `floe-bus/src/contexts/batch-subscriptions.test.ts` — 8 tests
- `floe-ext-snowball/src/__tests__/handoff.test.ts` — 8 tests

---

## Zero-poll delivery invariant (fm/floe-zeropoll-core)

**The substrate is push-only. No recurring polling anywhere.**

- **Delivery rides the bridge↔bus WebSocket** (`/v1/events/stream`). The bus broadcasts `delivery_bundle_available` with the full `DeliveryBundle` in the payload; the bridge consumes it directly (no HTTP round-trip) when it owns the endpoint.
- **WS reconnect is mandatory** (`floe-bridge/src/daemon.ts` `openEventStream()`). The bridge reconnects with exponential back-off (250ms → 16s cap) on socket close. Cancelled on `stop()`.
- **Recovery is one-shot resync, not a poll.** On the `open` event, the bridge runs `attachKnownWorkspaces()` + `processDeliveries()` exactly once. There is no 30-second reconcile timer.
- **Liveness is socket-presence** (D4). The bridge sends `{ type: "bridge_hello", bridge_id }` as its first WS message; the bus associates the socket with the bridge and removes it from `bridgeSockets` on close. `/v1/runtime/status` checks `bridgeSockets.has(bridge_id) && readyState === 1`. There is no 10-second liveness ping.
- **Lease-expiry requeue uses a scheduled single-shot timer** (D5 / Pulse pattern). `BusStore` maintains one `setTimeout` that fires at the next lease-expiry deadline (queried from the DB). On fire, it calls `requeueExpiredDeliveryLeases` and reschedules for the next deadline. No `setInterval` scan. The timer is seeded via `store.setBroadcast(fn)` (called by the server immediately after creating the broadcast function).
- **`requeueExpiredDeliveryLeases` resets endpoint status** to `idle` (not just requeuing events) so `tryCreateDeliveryForEndpoint` can create a new delivery bundle immediately.
- **Multi-bridge fallback**: when `delivery_bundle_available` carries an endpoint not in `endpointRuntime`, the bridge falls through to `processDeliveries()` (HTTP claim). This handles the multi-bridge / race case only.
- **`processDeliveries()` uses per-endpoint locks** (`processingEndpoints: Set<string>`) so concurrent deliveries to different endpoints are handled in parallel without a coarse global lock.
