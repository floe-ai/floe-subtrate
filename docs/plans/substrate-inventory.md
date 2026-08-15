# Substrate Inventory: Everything the Substrate Can Show, Change and Destroy

**Ticket:** [#167](https://github.com/floe-ai/floe-subtrate/issues/167) — child of [#166](https://github.com/floe-ai/floe-subtrate/issues/166)
**Researched from:** `floe-bus/src`, `floe-bridge/src`, `floe-app/src`, `floe-cli/src`, `.floe/floe.yaml`, `docs/adr/*.md`, `CONTEXT.md`, `MISSION.md`
**Date:** 2026-08-15

---

## Critical Storage-Side Distinction

Two structurally different kinds of substrate state exist. This matters for every "can the UI configure this?" answer:

| Storage location | Written by | Runtime mutability | UI change path |
|---|---|---|---|
| **Bus SQLite** (`~/.floe/data/floe-bus.sqlite`) | Bus daemon | Full CRUD via HTTP API | Call a bus endpoint |
| **`.floe/floe.yaml` + `agents/*.md` + `skills/**` + `mcp/**`** | Human, committed to git | **READ-ONLY at runtime** (invariant: clean boot leaves `git status --porcelain` empty) | Write file directly (Tauri IPC or agent tool) — dirtied git requires a commit |
| **`.floe/extensions/NAME/extension.json`** | Human, committed to git | READ-ONLY at runtime | Write file directly |
| **`~/.floe/auth/profiles.yaml` + `auth.json` + `models.json`** | Human, local (not committed) | Writable via Tauri IPC (ADR-0005) | Tauri IPC only — never via bus HTTP endpoints |
| **`~/.floe/config.yaml`** | Human, local (not committed) | Writable via Tauri IPC | Tauri IPC only |

**The invariant stated in the task:** `.floe/floe.yaml` and the files in `.floe/agents/`, `.floe/skills/`, `.floe/mcp/`, `.floe/extensions/` are human-authored committed config. A clean bus boot must leave `git status --porcelain` empty. This means:

- A bus HTTP endpoint must NOT write to `.floe/` files.
- The only sanctioned runtime write paths into `.floe/` are: (a) direct file writes by the human operator via Tauri IPC in `floe-app`, and (b) agent tool calls within the workspace filesystem boundary (`floe-bus/src/fs/`).
- **"Configurable from the UI"** has two structurally different meanings depending on which side of the line a primitive falls on.

Primitives marked **🟡 floe.yaml-side** below: UI configurability requires writing `.floe/` files. Those marked **🟢 SQLite-side**: UI configurability requires calling a bus HTTP endpoint. Those marked **🔵 ~/.floe-side**: UI configurability requires Tauri IPC.

---

## Inventory

### 1. Workspace

**Definition (CONTEXT.md terminology):** The top-level boundary. Contains Actors, Contexts, and Scopes. Identified by a stable `workspace_id` derived from the SHA-256 of its filesystem locator path.

**State location:** 🟢 **Bus SQLite** — `workspaces` table (`workspace_id`, `name`, `locator`, `status`, `init_authorized`, `active_config_hash`, `selected_at`, `created_at`, `updated_at`).

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list) | `GET /v1/workspaces` |
| READ (config status) | `GET /v1/workspaces/:workspace_id/config-status` |
| CREATE / register | `POST /v1/workspaces/register` |
| SELECT (make active) | `POST /v1/workspaces/:workspace_id/select` |
| DELETE | `POST /v1/workspaces/:workspace_id/delete` |
| UPDATE (name/metadata) | **NONE** |
| PAUSE | **NONE** (not applicable) |

**Visible in floe-app today:** Yes — `WorkspaceSwitcher.tsx` lists workspaces; `WorkspaceSettings.tsx` shows name/locator. The `DefaultInspector` (`ScopeInspector.tsx`) shows name+locator in the right panel when no scope is selected.

**Configurable / deletable today:** Deletable via `POST /v1/workspaces/:workspace_id/delete` (called from `WorkspaceSwitcher.tsx`). **No rename endpoint** — `name` can only be set at registration time (`POST /v1/workspaces/register`).

**GAP:** No `PATCH /v1/workspaces/:workspace_id` endpoint exists. An operator cannot rename a workspace from the UI after registration without re-registering.

---

### 2. Scope

**Definition (CONTEXT.md terminology):** An intentional substrate organising boundary inside a Workspace for connected, event-driven, or operational work. Not a universal fallback bucket; `scope_id = "default"` is reserved and blocked.

**State location:** 🟢 **Bus SQLite** — `scopes` table (`workspace_id`, `scope_id`, `title`, `description`, `created_at`, `updated_at`). Source: `floe-bus/src/scopes/store.ts`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list) | `GET /v1/workspaces/:workspace_id/scopes` |
| READ (projection) | `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` |
| CREATE | `POST /v1/workspaces/:workspace_id/scopes` |
| UPDATE (title/description) | `PATCH /v1/workspaces/:workspace_id/scopes/:scope_id` |
| DELETE (empty scopes only) | `DELETE /v1/workspaces/:workspace_id/scopes/:scope_id` |
| PAUSE | **NONE** (not applicable) |

**Visible in floe-app today:** Yes — `HomeView.tsx` renders `ScopeCard` components for all scopes; `ScopeInspector.tsx` shows scope name, description, context/pulse counts, and delete action; `ScopeDetail.tsx` shows the scope's context list.

**Configurable / deletable today:** Yes — create via `CreateScopeTile` (`HomeView.tsx`); update title/description via `PATCH` (client calls exist in `client.ts`); delete via `ScopeInspector.tsx` (blocked with 409 if non-empty, shows context/pulse counts). **No update UI in floe-app yet** — the `updateScope` call exists in `client.ts` but no inline-edit affordance is wired in any component.

**GAP:** No scope rename/redescribe UI (endpoint exists, UI not wired). Cannot delete a non-empty scope without first removing its contexts and pulses — the error message names the counts but provides no bulk-remove affordance.

---

### 3. Context

**Definition (CONTEXT.md terminology):** A bounded stream in which stream entries (Events) occur. A Context is anchored by actor participants, a Scope, or both. Never a hidden default bucket.

**State location:** 🟢 **Bus SQLite** — `contexts` table (`context_id`, `workspace_id`, `scope_id`, `parent_context_id`, `created_by_endpoint_id`, `created_at`, `title`). Also: `context_participants` table and `context_subscriptions` table. Source: `floe-bus/src/contexts/store.ts`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list by workspace) | `GET /v1/workspaces/:workspace_id/contexts` |
| READ (list by participant) | `GET /v1/contexts?participant=:endpoint_id` |
| READ (single) | `GET /v1/contexts/:id` |
| READ (events) | `GET /v1/contexts/:id/events` |
| READ (children) | `GET /v1/contexts/:id/children` |
| READ (subscriptions) | `GET /v1/contexts/:id/subscriptions` |
| CREATE | `POST /v1/workspaces/:workspace_id/contexts` |
| ASSIGN SCOPE | `POST /v1/workspaces/:workspace_id/contexts/:context_id/assign-scope` |
| DELETE | `DELETE /v1/contexts/:id` |
| UPDATE (title/metadata) | **NONE** |
| PAUSE | **NONE** (not applicable) |
| ADD participant | `POST /v1/contexts/:id/participants` |
| REMOVE participant | `DELETE /v1/contexts/:id/participants/:endpoint_id` |
| ADD subscription | `POST /v1/contexts/:id/subscriptions` |
| REMOVE subscription | `DELETE /v1/contexts/:id/subscriptions/:endpoint_id` |
| BATCH subscriptions | `POST /v1/contexts/:id/subscriptions:batch` |
| COMPACT history | `POST /v1/contexts/:id/compact` |
| CLEAR history | `POST /v1/contexts/:id/clear-history` |

**Visible in floe-app today:** Yes — `ScopeDetail.tsx` renders context rows for a selected scope; `DirectContexts.tsx` lists unscoped contexts; `ContextConversation.tsx` shows events inside a context; `ContextInspector.tsx` shows participants, scope, created-at, and delete action.

**Configurable / deletable today:** Delete context: yes, via `ContextInspector.tsx`. Add participant: yes, via `ActorContexts` in `ActorInspector.tsx` (creates context + adds participants). Assign scope: endpoint exists, no UI. Compact/clear-history: endpoints exist, **no UI affordance in any component today**. Update title: **no endpoint, no UI**.

**GAP:** No context title PATCH endpoint. No compact/clear-history UI. No assign-scope UI (endpoint exists). Subscriptions (the set of event types an endpoint receives within a context) have no UI beyond what participant-add does implicitly.

---

### 4. Actor / Endpoint

**Definition (CONTEXT.md terminology):** An Endpoint is an addressable participant/interface in the substrate. An Actor is a workspace-scoped Endpoint participant that may communicate through Events. Humans, agents, webhooks, and extensions are all Endpoints.

**State location:** 🟢 **Bus SQLite** — `endpoints` table (`endpoint_id`, `workspace_id`, `name`, `agent_id`, `bridge_id`, `status`, `metadata_json`, `created_at`, `updated_at`). The endpoint's **identity** (name, agent_id, status) lives here. Its **behaviour** (instructions body, skills, extensions, runtime config, scope paths, MCP) lives in `.floe/agents/<id>.md` — 🟡 **floe.yaml-side**. Source: `floe-bus/src/store.ts:endpoints`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list global) | `GET /v1/endpoints` |
| READ (list by workspace) | `GET /v1/workspaces/:workspace_id/endpoints` |
| READ (resolve by ref) | `GET /v1/workspaces/:workspace_id/resolve-endpoint?ref=` |
| CREATE / UPSERT | `POST /v1/endpoints/register` |
| DELETE | `DELETE /v1/endpoints/:endpoint_id` |
| SET STATUS | `POST /v1/endpoints/:endpoint_id/status` |
| UPDATE (name, metadata) | `POST /v1/endpoints/register` (upsert via same endpoint) |
| UPDATE (behaviour = instructions/skills/extensions) | **NONE — file write required** |
| PAUSE | **NONE** (status can be set but no dedicated pause) |

**Visible in floe-app today:** Yes — actor list in left nav (`App.tsx`); `ActorView.tsx` shows conversations + configure tabs; `ActorInspector.tsx` shows endpoint_id, name, status, agent_id, runtime bindings; `ActorDeleteSection` provides delete with name-confirm.

**Configurable / deletable today:**
- **Name**: editable inline in `ActorInspector.tsx` → calls `registerEndpoint` (upsert via `POST /v1/endpoints/register`). **SQLite-side, works today.**
- **Instructions body, skills, extensions, runtime engine, scope paths, MCP**: editable via `ActorFileSection` → writes to `.floe/agents/<id>.md` via `writeWorkspaceFile` (Tauri IPC or bus fs route). **⚠️ floe.yaml-side. Editing from the UI dirtied git — this collides with the read-only invariant if strict.** The current implementation treats it as intentional human editing (like editing the file in a text editor). The bridge re-reads the file on its ~30s drift-sync cycle.
- **Delete**: yes, name-confirm dialog → `DELETE /v1/endpoints/:endpoint_id`.
- **Create new actor**: `NewActorForm.tsx` — calls `POST /v1/endpoints/register` for the SQLite row and writes a new `.floe/agents/<id>.md` file. **Dual write — SQLite + floe.yaml-side.**

**GAP:** Actor behaviour editing writes `.floe/` files — **this is the primary floe.yaml collision point.** The substrate has no API-level concept of an actor's ordered binding list (skills, extensions, MCP) — these live entirely in the agent frontmatter file. If a UI wants to add a skill without file access, there is no bus endpoint. Agent creation (`NewActorForm`) also writes `floe.yaml`'s `agents:` array via `busWriteFile` — this requires that the workspace filesystem is accessible and dirtied git.

---

### 5. Actor Bindings (ordered: role, instructions, skill, mcp)

**Definition (CONTEXT.md / `floe-bus/src/bindings.ts`):** Material that shapes an actor's behaviour without being welded into the primitive's structure. An actor has an ordered list of bindings typed by `kind`. Today only `instructions` (free-form text) is implemented at the binding level. `role`, `skill`, and `mcp` are referenced in agent frontmatter as file paths, not as typed substrate bindings.

**State location:**
- **instructions binding** on a **ScopeGraph actor node**: 🟢 **Bus SQLite** — stored as `bindings` JSON within `scope_graphs.nodes_json`.
- **Actor identity's instructions text (body)**: 🟡 **floe.yaml-side** — in `.floe/agents/<id>.md` body.
- **skills**: 🟡 **floe.yaml-side** — `skills: [...]` in agent frontmatter, resolved to `.floe/skills/*/SKILL.md` files.
- **extensions**: 🟡 **floe.yaml-side** — `extensions: [...]` in agent frontmatter.
- **mcp**: 🟡 **floe.yaml-side** — `mcp: [...]` in agent frontmatter.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (on ScopeGraph node) | `GET /v1/workspaces/:workspace_id/graphs/:graph_id` |
| CREATE/UPDATE (on ScopeGraph node) | Via `POST /v1/workspaces/:workspace_id/scopes/:scope_id/graphs` (whole graph) |
| READ (actor file bindings) | `GET /v1/workspaces/:workspace_id/fs/file?path=.floe/agents/<id>.md` |
| UPDATE (actor file bindings) | `PUT /v1/workspaces/:workspace_id/fs/file` |
| CREATE / DELETE / REORDER standalone binding | **NONE — no binding CRUD API** |

**Visible in floe-app today:** Partially — `ActorFileSection` (`ActorInspector.tsx`) shows skills, extensions, MCP, engine, scope paths as editable text fields. ScopeGraph node bindings are not visible in the UI.

**GAP:** There is no bus-level binding CRUD API (no `POST /v1/endpoints/:id/bindings`). The substrate type `Binding` exists in `floe-bus/src/bindings.ts` but only as a type — no table, no CRUD routes. For actor-file bindings, editing requires file write access. ScopeGraph actor node bindings are only settable at graph creation time (no update endpoint).

---

### 6. Scope Graph

**Definition (CONTEXT.md / `floe-bus/src/scope-graphs.ts`):** A prescriptive authored graph whose nodes cause work (contrast with Scope Projection, which is descriptive). Has exactly one Context (the "wiring") and three node kinds: `trigger` (emits an event type), `actor` (endpoint wired as participant+subscriber), `command` (shell command node). No stored edge records — wiring is realised through Context participant/subscription state.

**State location:** 🟢 **Bus SQLite** — `scope_graphs` table (`graph_id`, `workspace_id`, `scope_id`, `context_id`, `nodes_json`, `created_at`, `updated_at`). Source: `floe-bus/src/scope-graphs.ts:applyScopeGraphSchema`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (by scope) | `GET /v1/workspaces/:workspace_id/scopes/:scope_id/graphs` |
| READ (by workspace) | `GET /v1/workspaces/:workspace_id/graphs` |
| READ (single) | `GET /v1/workspaces/:workspace_id/graphs/:graph_id` |
| CREATE | `POST /v1/workspaces/:workspace_id/scopes/:scope_id/graphs` |
| UPDATE | **NONE** |
| DELETE | **NONE** |
| FIRE trigger node | `POST /v1/workspaces/:workspace_id/graphs/:graph_id/nodes/:node_id/fire` |

**Visible in floe-app today:** **No.** No component in `floe-app/src/` reads or renders scope graphs. The ScopeDetail tabs show Contexts and Pulses (via Ops.tsx) but not graphs.

**Configurable / deletable today:** Cannot update or delete a graph from any interface today. Create exists in the API but no UI. Fire trigger exists in the API but no UI.

**GAP:** No UPDATE endpoint (to add/remove/edit nodes, change graph context). No DELETE endpoint. No floe-app UI for any graph operation. A graph created incorrectly cannot be fixed or removed via any HTTP call — only by direct SQLite manipulation or workspace re-registration.

---

### 7. Scope Graph Node Kinds (trigger / actor / command)

**Definition (CONTEXT.md / `floe-bus/src/scope-graphs.ts`):** Nodes within a Scope Graph. `trigger`: declares an event_type it emits when fired. `actor`: an endpoint participant with event_type subscriptions and optional bindings. `command`: a shell command endpoint wired identically to actor.

**State location:** 🟢 **Bus SQLite** — stored as JSON within `scope_graphs.nodes_json`. Not a separate table; nodes are a sub-array of the graph record.

**Bus HTTP endpoints:** Inherited from Scope Graph (create graph = set initial nodes). No individual node CRUD.

**Visible in floe-app today:** **No.**

**GAP:** All of the above. Node-level CRUD (add node, remove node, edit node) does not exist at the API layer — the only mutation path is recreating the entire graph. No UI.

---

### 8. Folder Watcher

**Definition (CONTEXT.md / `floe-bridge/src/project.ts`):** A deterministic monitor declared in `.floe/floe.yaml` under `watchers:`. Observes a filesystem path and fires an existing Scope Graph trigger node when a file arrives or changes. Not a new wake mechanism — a config entry for the existing `fireScopeGraphTrigger` path.

**State location:** 🟡 **floe.yaml-side** — declared under `watchers:` in `.floe/floe.yaml`. Each watcher has `id`, `graph_id`, `node_id`, and `path` (relative to workspace root). Loaded by `floe-bridge/src/project.ts:loadProject`. The bridge (`floe-bridge`) starts filesystem watchers at workspace attach time from this config.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ | **NONE** — watchers are not exposed via any bus endpoint |
| CREATE | **NONE** |
| UPDATE | **NONE** |
| DELETE | **NONE** |
| PAUSE / RESUME | **NONE** |

**Visible in floe-app today:** **No.** No bus endpoint exists to list watchers; no UI component reads or displays them.

**Configurable / deletable today:** Only by editing `.floe/floe.yaml` directly and triggering workspace reattachment. No UI path exists.

**GAP:** Complete gap. To expose watchers in a UI, a bus endpoint would need to either: (a) read and expose the watcher config from the project loader, or (b) move watcher config into SQLite. Both are substrate decisions. Writing `floe.yaml` from the UI to add/remove watchers would dirty git.

---

### 9. Extension (manifest, bundled agents, views, HTTP handlers)

**Definition (CONTEXT.md terminology):** A substrate addition providing tools, Pulse declarations, and Extension Hooks to agents. Lives in `.floe/extensions/NAME/` with `extension.json` manifest and TypeScript entry point. Discovered at workspace attach time.

**State location:**
- **Manifest + entry + bundled agent instructions**: 🟡 **floe.yaml-side** — `.floe/extensions/NAME/extension.json` + referenced files.
- **Runtime registration (reported capabilities, views, relay_url)**: 🟢 **Bus SQLite** (in-memory extension registry keyed by `workspace_id + name`, managed via `POST /v1/extensions/report`).

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list registered) | `GET /v1/extensions?workspace_id=` |
| REPORT (bridge→bus) | `POST /v1/extensions/report` |
| RELAY GET | `GET /v1/extensions/:name/*` |
| RELAY POST | `POST /v1/extensions/:name/*` |
| CREATE (install) | **NONE** |
| UPDATE (manifest) | **NONE** |
| DELETE (uninstall) | **NONE** |
| PAUSE | **NONE** |

**Visible in floe-app today:** Partially — `ScopeDetail.tsx` calls `GET /v1/extensions?workspace_id=` and renders declared `scope-detail-tab` views as placeholder tabs (runtime dynamic loading is not implemented; renders `PlaceholderExtensionView`). The extension name appears as a tab label.

**Configurable / deletable today:** Extension manifest editing = file write (no bus endpoint). Installing a new extension requires adding files to `.floe/extensions/` and reattaching. Bundled agents are read-only in the UI (`ActorFileSection` shows a read-only note: "This actor is provided by the <extensionName> extension").

**GAP:** No install/uninstall/update bus endpoints. Declared views are shown as placeholders — runtime dynamic loading of extension UI components is not implemented (`extension-loader.ts` notes this). No UI for extension manifest editing.

---

### 10. Extension Hook

**Definition (CONTEXT.md terminology):** A substrate lifecycle point that an Extension can observe or contribute to by registering a TypeScript handler through `ExtensionContext.hooks.on(...)`. Hook names: `SessionStart`, `BeforeTurn`, `TurnEnd`, `BeforeToolUse`, `AfterToolUse`, `ToolUseFailed`, `SessionResume`, `SessionEnd`, `Pulse`, `WebhookReceived`, `Error`, `ContextCompacted`, `ContextHistoryCleared`, `ParticipantAdded`, `ParticipantRemoved`. Source: `floe-bridge/src/hooks.ts`.

**State location:** **In-memory only** — hook registrations are transient TypeScript closures in the bridge process. Not persisted anywhere. Rebuilt when the bridge loads extensions at workspace attach time.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list registered hooks) | **NONE** |
| CREATE / UPDATE / DELETE | **NONE** (registration is via TypeScript API, not HTTP) |

**Visible in floe-app today:** **No.** No component reads or displays registered hooks.

**Configurable / deletable today:** No. Hook registrations are code — they change only when the extension's TypeScript entry point changes (file edit → reattach).

**GAP:** Complete visibility gap. An operator has no way to know which hooks are registered for which extensions without reading the extension source code. No bus endpoint exposes the hook registration map.

---

### 11. Pulse

**Definition (CONTEXT.md terminology):** Bus-owned scheduled event creation. A pulse fires at a configured time and creates the canonical `pulse.fired` event for its subscribers. Has `status` (active/paused/cancelled) and `persistence` (workspace = declared in `.floe/floe.yaml`; local = SQLite-only).

**State location:**
- **Pulse definition for workspace-backed pulses**: 🟡 **floe.yaml-side** — declared under `pulses:` in `.floe/floe.yaml`. Loaded by `floe-bridge/src/project.ts:loadProject` and registered in bus SQLite at attach time.
- **Pulse definition for local pulses**: 🟢 **Bus SQLite** — `pulses` table only.
- **Pulse runtime state (next_fire_at, last_fired_at, fire_count, status)**: Always 🟢 **Bus SQLite** — `pulses` table, regardless of persistence. Source: `floe-bus/src/store.ts:pulses`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list) | `GET /v1/pulses?workspace_id=&status=&scope_id=` |
| CREATE | `POST /v1/pulses` |
| PAUSE | `POST /v1/pulses/:pulse_id/pause` |
| RESUME | `POST /v1/pulses/:pulse_id/resume` |
| CANCEL (soft delete) | `POST /v1/pulses/:pulse_id/cancel` |
| ADD subscriber | `POST /v1/pulses/:pulse_id/subscribe` |
| REMOVE subscriber | `POST /v1/pulses/:pulse_id/unsubscribe` |
| UPDATE (schedule/content) | **NONE** |
| HARD DELETE | **NONE** (cancel is the closest; row persists for audit) |

**Visible in floe-app today:** Yes — `Ops.tsx` in `floe-app/src/scope/` shows pulses for a scope: `pulse_id` as primary display name (with `content.text` as subordinate), status badge, trigger summary (cron or once-at), subscriber list, pause/resume/cancel buttons, subscribe/unsubscribe controls.

**Configurable / deletable today:** Create (local): yes, from `Ops.tsx`. Pause/resume/cancel: yes. Add/remove subscriber: yes. **No update** (cannot change schedule or content after creation). No hard delete. For **workspace-backed pulses** (declared in `.floe/floe.yaml`): the runtime state (status, fire times) is in SQLite and is manageable via API; but changing the schedule/content requires editing `floe.yaml` directly — **floe.yaml-side collision**.

**GAP:** No pulse UPDATE endpoint. A pulse created with the wrong schedule cannot be fixed without cancelling and recreating. Workspace-backed pulse definitions cannot be changed from the UI without file write. Hard delete is not supported.

---

### 12. Pulse Subscriber

**Definition (CONTEXT.md terminology):** A target that receives the `pulse.fired` event. Two kinds: `context` (appends event to a context, no delivery) and `endpoint` (creates a Delivery for an endpoint, may activate it).

**State location:** 🟢 **Bus SQLite** — `pulse_subscribers` table (`pulse_id`, `subscriber_json`). Stable delivery contexts stored in `pulse_delivery_contexts`. Source: `floe-bus/src/store.ts`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ | Via `GET /v1/pulses` (subscribers included in pulse record) |
| ADD | `POST /v1/pulses/:pulse_id/subscribe` |
| REMOVE | `POST /v1/pulses/:pulse_id/unsubscribe` |
| UPDATE | **NONE** (remove + add) |
| PAUSE | **NONE** |

**Visible in floe-app today:** Yes — `Ops.tsx` shows subscriber list per pulse (context label or endpoint ref) with remove buttons; "Connect to context" dropdown to add a context subscriber.

**Configurable / deletable today:** Yes for subscribe/unsubscribe. No edit (kind change requires remove+add).

**GAP:** No subscriber UPDATE. Cannot change a context subscriber to an endpoint subscriber without remove+add cycle. Endpoint subscribers can be added via API but `Ops.tsx` only exposes context subscribers in its "Connect to context" UI — endpoint subscriber management has no UI.

---

### 13. Runtime Binding (model / auth profile / thinking level)

**Definition (CONTEXT.md / `floe-bus/src/store.ts`):** A resolved material assignment of auth profile, model, and thinking level to an actor or to workspace/global defaults. Scoped as `agent` (per-endpoint), `workspace_default`, or `global_default`. The resolved binding for a turn uses the most specific non-null scope.

**State location:** 🟢 **Bus SQLite** — `runtime_bindings` table (`binding_key`, `scope`, `workspace_id`, `endpoint_id`, `auth_profile`, `model`, `thinking_level`, `created_at`, `updated_at`). Source: `floe-bus/src/store.ts:runtime_bindings`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list) | `GET /v1/runtime/bindings?workspace_id=` |
| READ (resolved for endpoint) | `GET /v1/runtime/bindings/resolve?workspace_id=&endpoint_id=` |
| UPSERT | `POST /v1/runtime/bindings` |
| CLEAR (delete) | `POST /v1/runtime/bindings/clear` |
| PAUSE | **NONE** (not applicable) |

**Visible in floe-app today:** Yes — `ActorInspector.tsx` shows resolved binding with layer labels (actor/workspace/global) via `resolveRuntimeBinding`; allows selecting profile, model, thinking level per actor, and clearing to fall back to inherited binding.

**Configurable / deletable today:** Yes — fully CRUD from `ActorInspector.tsx` (actor-scope binding). Workspace-default and global-default bindings have no UI today (endpoints exist; no UI component calls them).

**GAP:** No UI for workspace-default or global-default runtime binding management. `SubstrateSettingsView.tsx` has a "Runtime" tab showing the adapter switch but not model/profile defaults.

---

### 14. Auth Profile

**Definition (CONTEXT.md / `floe-bus/src/auth.ts`):** A named named-provider credential reference stored in `~/.floe/auth/profiles.yaml` (version 1 document). Each profile has `id`, `provider`, optional `model`, `label`. Credentials are stored in `~/.floe/auth/auth.json` (api_key or oauth token). Custom model overlays in `~/.floe/auth/models.json`.

**State location:** 🔵 **`~/.floe/auth/` (local, not committed)** — `profiles.yaml`, `auth.json`, `models.json`. Written via Tauri IPC only (ADR-0005). Source: `floe-bus/src/auth.ts`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list profiles) | `GET /v1/auth/profiles` |
| READ (list models) | `GET /v1/auth/models?provider=` |
| CREATE profile | **NONE** (Tauri IPC only) |
| UPDATE profile | **NONE** (Tauri IPC only) |
| DELETE profile | **NONE** (Tauri IPC only) |

**Visible in floe-app today:** Yes — `SubstrateSettingsView.tsx` "🔑 Authentication" tab shows auth profiles, configured models, and OAuth setup (via `AuthenticationPillar` component).

**Configurable / deletable today:** Auth profile add/edit/delete is implemented via Tauri IPC commands (`get_auth_profiles`, `set_api_key`, `delete_auth_profile` etc.) — desktop only. In browser mode: read-only note shown.

**GAP:** No bus HTTP endpoints for auth profile CRUD — by design (ADR-0005 security decision). Remote (non-desktop) operators cannot manage credentials at all today; "securing remote human operations remains a known-unsolved problem" per ADR-0005.

---

### 15. Delivery Bundle

**Definition (CONTEXT.md terminology):** An Event (or batch of Events) made available to a specific Endpoint for processing. Created automatically by the bus when an event matches an endpoint's subscription. Goes through lifecycle states: `pending → delivered_to_bridge → injected_to_runtime / acknowledged / failed / dead_lettered / deferred`.

**State location:** 🟢 **Bus SQLite** — `delivery_bundles` table (`delivery_id`, `endpoint_id`, `workspace_id`, `trigger_event_id`, `events_json`, `state`, `lease_expires_at`, `attempt_count`, `last_error`, `created_at`, `claimed_at`). Source: `floe-bus/src/store.ts:delivery_bundles`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (list) | `GET /v1/delivery?workspace_id=&limit=` |
| CLAIM (bridge consuming op) | `GET /v1/delivery/claim?bridge_id=&limit=` |
| SET STATUS | `POST /v1/delivery/:delivery_id/status` |
| CREATE | **NONE** (auto-created by bus on event routing) |
| DELETE | **NONE** |
| PAUSE | **NONE** |
| CANCEL | **NONE** |

**Visible in floe-app today:** **No.** `listDeliveries` exists in `client.ts` but is not called by any component (it is noted as a "consuming operation — only call from bridge-equivalent code; do not use for read-only UI display"). No UI renders delivery bundles.

**Configurable / deletable today:** No operator-facing control over delivery lifecycle. Claiming transitions state; only the bridge does this.

**GAP:** No delivery list UI. An operator cannot see what is pending delivery to an actor, how many attempts have failed, or what the last error was. No retry/cancel affordance.

---

### 16. Endpoint Watermark

**Definition (CONTEXT.md terminology):** A persisted, per-Endpoint Event Cursor marking how far an Endpoint has been carried forward. Generic across all Actors; the operator is one ordinary Endpoint. Advances only when explicitly set.

**State location:** 🟢 **Bus SQLite** — `endpoint_watermarks` table (`workspace_id`, `endpoint_id`, `cursor_created_at`, `cursor_event_id`, `updated_at`). Source: `floe-bus/src/endpoint-watermark-store.ts`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ | `GET /v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark` |
| UPDATE (advance) | `PUT /v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark` |
| DELETE / RESET | **NONE** |
| PAUSE | **NONE** |

**Visible in floe-app today:** **No.** `getWatermark` and `putWatermark` exist in `client.ts` but no UI component calls them or displays watermark state.

**GAP:** No watermark UI. An operator cannot see where any endpoint's event cursor stands, nor manually advance or reset it from the UI.

---

### 17. Webhook (event source / route)

**Definition (CONTEXT.md terminology):** An event source that ingests external input and produces canonical substrate Events. Webhook route config lives in agent frontmatter (`.floe/agents/<id>.md`). Actorless webhook streams must create or use a scoped Context.

**State location:** 🟡 **floe.yaml-side** — webhook route configuration is in agent frontmatter; there is no SQLite table for webhook routes. Ingest endpoint is HTTP.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| INGEST (external) | `POST /v1/webhooks/:workspace_id/:route_id` |
| READ (list routes) | **NONE** |
| CREATE / UPDATE / DELETE route | **NONE** |
| PAUSE / RESUME | **NONE** |

**Visible in floe-app today:** **No.** No component reads or displays webhook routes.

**Configurable / deletable today:** No. Route configuration is file-side only (agent frontmatter). No bus CRUD.

**GAP:** Complete gap. Webhook route management requires editing `.floe/agents/<id>.md` frontmatter. No read endpoint to list active webhook routes, no way for an operator to see which webhooks are configured without reading files.

---

### 18. Scope Projection Layout

**Definition (CONTEXT.md terminology):** Renderer-specific arrangement state for how a Scope projection displays scoped primitives. Keyed by stable projected refs. Not a semantic concept — purely renderer state.

**State location:** 🟢 **Bus SQLite** — `scope_projection_layout` table. Source: `floe-bus/src/scope-projection-layout-store.ts`.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ | `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer` |
| UPSERT | `PUT /v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer` |
| DELETE | **NONE** |

**Visible in floe-app today:** Not exposed as an operator-facing concept. Only called internally for canvas layout persistence.

**GAP:** No delete (layout reset) endpoint. Minor.

---

### 19. Bridge

**Definition:** The process (floe-bridge daemon) that connects a workspace to the bus, loads agents, registers endpoints, and manages the runtime. Not a user-facing primitive per CONTEXT.md but visible as runtime state.

**State location:** 🟢 **Bus SQLite** — `bridges` table (`bridge_id`, `status`, `capabilities_json`, `last_seen_at`, `created_at`).

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ (status) | `GET /v1/runtime/status` |
| REGISTER | `POST /v1/bridges/register` |
| LIVENESS | `POST /v1/bridges/:bridge_id/liveness` |
| DELETE | **NONE** |

**Visible in floe-app today:** Partially — `SubstrateSettingsView.tsx` shows bridge online/offline via `GET /v1/runtime/status`. `ActorInspector.tsx` shows actor status (which reflects bridge state).

---

### 20. Saved Config Snapshot

**Definition:** A named snapshot of workspace agent configuration stored in bus SQLite. Used for configuration management / rollback.

**State location:** 🟢 **Bus SQLite** — `saved_configs` table.

**Bus HTTP endpoints:**

| Operation | Method + Route |
|---|---|
| READ | `GET /v1/configs` |
| CREATE | `POST /v1/configs` |
| APPLY | `POST /v1/workspaces/:workspace_id/apply-config` |
| IMPORT | `POST /v1/workspaces/:workspace_id/import-config` |
| SNAPSHOT | `POST /v1/workspaces/:workspace_id/config-snapshot` |
| DELETE | **NONE** |

**Visible in floe-app today:** **No.** Calls exist in client but no UI component renders them.

---

## Gap Summary

### Gap A — Primitives with NO read endpoint (completely invisible)

| Primitive | Missing |
|---|---|
| Folder Watcher | No `GET /v1/workspaces/:workspace_id/watchers` |
| Extension Hook | No `GET /v1/extensions/:name/hooks` or equivalent |
| Webhook route | No `GET /v1/workspaces/:workspace_id/webhooks` |

### Gap B — Primitives readable via API but NOT visible in floe-app today

| Primitive | Endpoint exists | UI component |
|---|---|---|
| Delivery Bundle | `GET /v1/delivery` | None |
| Endpoint Watermark | `GET /v1/workspaces/.../endpoints/.../watermark` | None |
| Scope Graph | `GET /v1/workspaces/.../graphs` | None |
| Scope Graph Nodes | (via graph record) | None |
| Saved Config | `GET /v1/configs` | None |
| Bridge record | `GET /v1/runtime/status` (partial) | Partial (status only) |
| Workspace-default / global-default runtime binding | `GET /v1/runtime/bindings` | None |

### Gap C — Primitives where UI configurability collides with the floe.yaml read-only invariant

These primitives have their canonical definition in `.floe/` committed files. UI configurability (beyond read-only display) **requires writing `.floe/` files**, which dirtied git and violates the clean-boot invariant if not treated as deliberate human edit:

| Primitive | floe.yaml location | UI edit path today | Invariant collision? |
|---|---|---|---|
| **Actor behaviour** (instructions body, skills, extensions, runtime, MCP, scope paths) | `.floe/agents/<id>.md` | `ActorFileSection` → `writeWorkspaceFile` | ⚠️ **YES** — writes agent file from UI; bridge re-reads on drift-sync |
| **Actor creation** (new agent) | `floe.yaml agents:` array + new `agents/<id>.md` | `NewActorForm` → `busWriteFile` writes `floe.yaml` | ⚠️ **YES** — writes `floe.yaml` from UI |
| **Workspace-backed Pulse** (schedule/content edit) | `floe.yaml pulses:` array | No UI (endpoints exist only for runtime state) | ⚠️ **YES** — schedule change requires `floe.yaml` edit |
| **Folder Watcher** | `floe.yaml watchers:` array | No UI at all | ⚠️ **YES** — any UI would require `floe.yaml` write |
| **Extension manifest** | `.floe/extensions/NAME/extension.json` | No UI | ⚠️ **YES** |
| **Webhook route config** | Agent frontmatter in `.floe/agents/<id>.md` | No UI | ⚠️ **YES** |

**The substrate decision this map must absorb:** For actor behaviour, actor creation, and workspace-backed pulses, the current UI already takes the "write the file" path. This is pragmatic for a local desktop app (Tauri IPC secures the write) but means these operations dirty git. Whether this is acceptable (human operator editing ≡ editing file in text editor) or whether these primitives should be moved to SQLite to allow clean runtime mutability is a substrate-level decision not yet resolved. The `NewActorForm` path in particular writes `floe.yaml` — the workspace manifest itself.

### Gap D — Operations missing endpoints for SQLite-backed primitives

| Primitive | Missing operation |
|---|---|
| Workspace | `PATCH` (rename) |
| Context | `PATCH` (title update) |
| Scope Graph | `PUT/PATCH` (update nodes), `DELETE` |
| Pulse | `PATCH` (update schedule/content), hard `DELETE` |
| Pulse Subscriber (endpoint kind) | No UI (API exists) |
| Context compact/clear-history | No UI (API exists) |
| Scope projection layout | `DELETE` (reset) |
| Saved Config | `DELETE` |

---

## Answer to the Ticket's Question

The substrate today can SEE (via bus HTTP): workspaces, scopes, contexts (with participants, subscriptions, events, children), actors/endpoints, runtime bindings (with layer resolution), pulses (with subscribers and runtime state), scope graphs (read), auth profiles and models, extension registrations (names and declared views), delivery bundles, endpoint watermarks, scope projections, scope projection layouts, bridges (status), and saved configs. It can CREATE, UPDATE, or DELETE most SQLite-backed primitives via HTTP. The material gaps are: (1) three primitives have no read endpoint at all — folder watchers, extension hooks, and webhook routes; (2) seven primitives are readable via API but have no floe-app UI yet — delivery bundles, watermarks, scope graphs, scope graph nodes, saved configs, workspace-default runtime bindings, and the full bridge record; (3) four SQLite-backed primitives are missing critical write operations — workspace rename, context title update, scope graph update/delete, and pulse hard-delete/update; and (4) actor behaviour, actor creation, workspace-backed pulses, watchers, extensions, and webhook routes all live in committed `.floe/` files, meaning "edit from the UI" means "write a committed file," which is a structural collision with the read-only invariant that the map (issue #166) must decide how to resolve — either accept file-write as the sanctioned path for operator configuration, or move these primitive definitions into SQLite so the bus becomes the sole source of mutable truth.
