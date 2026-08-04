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

Extensions are not part of this repository. They are independent repositories
that build against the substrate contract.

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
- A declared view whose component is unavailable renders `PlaceholderExtensionView`.

### Extension loader test isolation

- When writing test fixtures that need `.floe/` structure, use a **separate** workspace dir from the extensions dir (e.g. `join(tempDir, "workspace")` for the workspace and `join(tempDir, "extensions")` for extensions). Mixing them causes `loadExtensions` to treat `.floe/` as an extension directory.

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

Four generic, extension-agnostic substrate primitives landed in this PR. All are in `floe-bus/` and `floe-bridge/`.

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
- `ContextStore.wouldCreateCycle(startId, candidateId)` — walks the parent chain from `startId`; returns `true` if `candidateId` appears (bounded to 100 hops).
- Index `idx_contexts_parent ON contexts(parent_context_id, created_at)`.
- Guards on `POST /v1/workspaces/:ws/contexts`:
  - Self-reference (`parent_context_id === own id`) → 400 `invalid_request`.
  - Non-existent parent → 404 `parent_context_not_found`.
  - Cycle (parent chain already reaches own id) → 400 `invalid_request`.
- `BusClient.createContext` accepts optional `parent_context_id?: string | null`.
- `CreateContextInput` (stub bus client) gains optional `parent_context_id?: string | null`.
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

## Context isolation invariant (fm/floe-ctx-iso)

**A turn is built from exactly ONE context — the delivery's origin context. No bleed from other contexts.**

### Typed origin reference (D-A/D-B fix)

- `BeforeTurn` hook payload now carries `origin?: { id: string; kind: "context" | "thread" }` — a typed reference symmetric with the emit `destination` (`{kind, id}`). Set from the trigger event's `context_id` (kind=`"context"`) or `thread_id` (kind=`"thread"`).
- Source: `floe-bridge/src/hooks.ts` `HookPayloadByName.BeforeTurn`; set in `floe-bridge/src/adapters/pi-agent-core-adapter.ts` before firing the hook.

### Emit defaults to origin context (D-B fix)

- The `emit` tool in `pi-agent-core-adapter.ts` now defaults `context_id` to `turn.context_id` (the delivery origin context) when no explicit `context_id` is provided. This ensures replies land in the same context thread they came from.
- Explicit `context_id` in the tool call still overrides for deliberate cross-context emits.
- `current_delivery_context_id` is still always forwarded as observability metadata (unchanged).

## Per-context session isolation (fm/floe-ctx-session-iso)

**Structural fix for session-level bleed: one pi Agent session per (agent, context), ephemeral.**

### Session vocabulary (LOCKED)

- **Session** — a pi construct (one per (agent, context)). Holds the agent's PRIVATE tool/reasoning memory. EPHEMERAL: not persisted. On restart = cold start = empty session + re-inject.
- **Context** — a substrate node (bus SQLite). Shared across actors.
- **Thread** — the context's ordered emit stream (OUTPUTS only, never tool calls). Durable.
- **World (files)** — durable truth. Agents re-observe each turn.

### Session key (C-1)

- Session map key in `pi-agent-core-adapter.ts` changed from `bundle.endpoint_id` to `${bundle.endpoint_id}:${context_id}` where `context_id = bundle.events[0]?.context_id ?? "no-context"`.
- Each (agent, context) pair has an isolated pi `Agent` instance with independent message history.
- `SessionState` carries `contextId: string` and `threadCursor: string | null` (ephemeral, never persisted).
- Error-path `sessions.delete(...)` uses the same compound key.

### Thread-slice injection and ephemeral cursor (C-2/C-3)

- Before each `session.agent.prompt(...)`, the adapter fetches context events since `session.threadCursor` via `bus.listContextEvents(context_id, since)`.
- Cold start (`threadCursor = null`) → cursor absent → full thread backfill.
- Warm continue → cursor set from last turn → only the delta is fetched.
- Trigger events (already in `deliveryToPrompt`) are excluded from the slice by event_id.
- Injection order: `[extension overlay]\n\n[thread slice]\n\n[trigger]`.
- After SUCCESSFUL turn completion: `session.threadCursor = next_cursor` from the fetch.
- Failed turn: cursor stays where it was (re-fetches same history on next attempt).
- `endpoint_watermarks` (human-facing "read up to here" cursor) is NOT touched.

### Thread slice rendering (`renderThreadSlice`)

- Exported from `pi-agent-core-adapter.ts`: `renderThreadSlice(events: EventEnvelope[]): string`
- Format: `[ActorRef] text` per event; header `[Thread — recent context history]` / footer `[End Thread]`.
- Includes only events with non-empty `content.text`. Caps at 50 most-recent events and 8000 chars total.
- Actor ref from `toNeutralRef(source_endpoint_id)` (falls back to raw id on legacy-ref error).

### Bus client: `listContextEvents`

- Added to `BusClient` in `floe-bridge/src/bus-client.ts`.
- Calls `GET /v1/events?context_id=X&since=Y` — the existing bus endpoint.
- Returns `{ events: EventEnvelope[]; next_cursor: string | null }`.
- Non-fatal in the adapter: if it throws, the thread slice is empty and the cursor is unchanged.

### Session eviction

- **No count cap, no LRU.** Sessions persist for the lifetime of the bridge process.
- Eviction on context-close/terminate is the correct design (event-driven), but no substrate context-close signal exists yet. When one is added, bridge should evict on that signal.
- Until then: sessions are released on bridge restart (cold start = safe; ephemeral design absorbs this).
- Do NOT add a count cap or LRU — that would be arbitrary and wrong per the locked model.

### Backfill is lossy by design

- The thread contains `message` events + domain events (OUTPUTS). Tool calls and tool results are PRIVATE session scratch; they do NOT live in the thread.
- A cold-started session re-derives by reading the world (files) + thread (outputs) + context knowledge. This is by design (session-context-thread-model.md, captain-locked).
- Do NOT add `agent.turn.record` events to the thread. The locked model scrapped that plan.

---

## Peer contexts (fm/remove-thread-primitive)

There is no Thread primitive. A Context is the shared event stream and the session key remains `(agent, context)`.

### Rule 3: cross-actor peer context

- Rule 2: a runtime emit to an existing participant continues the current context.
- Rule 3: a runtime emit to a non-participant creates an independent context containing `{source, destination}`.
- The peer context records `parent_context_id = current_delivery_context_id` as provenance. This temporarily reuses the hierarchical field because the ROADMAP's neutral link and peer-context UI do not exist; revisit when that UI lands.
- UI-originated new contexts have `parent_context_id = null`.
- The bridging actor relays results explicitly between the origin and peer contexts.

`events.thread_id`, `pending_responses.thread_id`, and `thread_affine` remain deferred schema-collapse compatibility storage. New events fall back to their `context_id` when no thread id is supplied.

---

## Inject-once / resolve-live (fm/floe-instruction-inject-once — Slice C)

### Substrate primitive: InjectionBaseline (floe-bridge)

- **F1 — context binding on BeforeTurn**: already resolved. `BeforeTurn` payload carries `origin?: { id: string; kind: "context" | "thread" }`. When `origin.kind === "context"`, `origin.id` IS the context_id. No duplicate `context_id` field was needed.
- **F2 — Inject-once dedup**: `floe-bridge/src/injection-baseline.ts` → `InjectionBaseline` class.
  - Keyed on `(context_id, source)`. Stores FNV-1a hash of last-injected content per key.
  - `applyDedup(contextId, results)` — filters hook results: same hash → strip inject; changed → inject + update; null contextId → always inject.
  - `clearContext(contextId)` — reset baseline for that context (so next turn re-injects into the fresh window).
  - `PiAgentCoreAdapter` holds a single `InjectionBaseline` instance. It lazily registers `ContextHistoryCleared` / `ContextCompacted` handlers into each workspace `HookRegistry` (via `maybeRegisterLifecycleHooks`, tracked with `WeakSet<HookRegistry>`). Extension name `"_substrate_inject_once"` (underscore prefix = substrate internal).
  - `applyDedup` is called after `hookResults = await context.hooks.fire("BeforeTurn", ...)` and before `renderHookInjections(...)`.

### Invariants
- A changed resolved injection is reflected on the next turn without a wake and is injected once.
- Context history cleared/compacted → baseline reset → instructions re-inject into fresh context.
- No stored copy, no drift, no per-turn injection spam.
- The substrate primitive stays extension-agnostic.

### Tests
- `floe-bridge/src/injection-baseline.test.ts` — 13 tests: dedup skips/re-injects/resets, cross-context independence, null contextId always-inject, non-string content passthrough.
