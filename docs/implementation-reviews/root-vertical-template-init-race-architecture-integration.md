# Architecture Integration Brief: root-vertical-template-init-race

## Existing ownership

- **Workspace template initialization (canonical `.floe` scaffold)** is owned by the **bridge**, in `floe-bridge/src/project.ts` via `ensureProjectTemplate(workspacePath, workspaceName)`. It is invoked by:
  - `floe-bridge/src/daemon.ts:201` inside `attachWorkspace()` (gated on `workspace.init_authorized` and `workspace_access.local_paths`), and
  - `floe-bridge/src/project.ts:225` inside `materializeSavedConfig()` before writing user agents.
- **Field watcher sidecar directory (`.floe/fields/`)** is owned by the **bus**, in `floe-bus/src/fields-watcher.ts` (`FieldsWatcherRegistry.watchWorkspace()` at line 67–68 does `mkdirSync(fieldsDir(locator), { recursive: true })`). It is invoked on the workspace HTTP lifecycle in `floe-bus/src/server.ts:313` (`/v1/workspaces/register`) and `:320` (`/v1/workspaces/:id/select`), and at boot for all stored workspaces (`server.ts:115`).
- **CONTEXT.md** (lines 79, 86, 98) treats `.floe/fields/<field-id>.yaml` and `.floe/fields/<field-id>.layout.<renderer>.yaml` as workspace-local primitives owned by the bus's Field substrate. Template scaffolding (`floe.yaml`, `agents/floe.md`, `extensions/`, `skills/`, `mcp/`, `state/`) is bridge-owned and is the only thing the bridge writes during initial attach.
- Rationale for split: bus owns durable routing + Field index and reacts to workspace lifecycle events synchronously; bridge owns runtime adaptation including filesystem materialization of the agent/skills/extensions template. This boundary is reiterated in the bundled `substrate-build` skill body in `project.ts:128-131`.

Source evidence:
- `floe-bridge/src/project.ts:43-45` – the bug seam: `if (existsSync(floeDir)) return;` short-circuits all template writes.
- `floe-bus/src/fields-watcher.ts:67-68` – unconditional creation of `.floe/fields/` on every register/select.
- `floe-bus/src/server.ts:312-320` – register and select both call `fieldWatchers.watchWorkspace(...)` synchronously after `store.registerWorkspace()` / `store.selectWorkspace()`, before the bridge daemon's attach loop runs.
- `floe-bridge/src/daemon.ts:186-202` – bridge attach is asynchronous and reads the (now-existing) `.floe` directory.

## Existing interaction model

User/system behaviors that already exist and **must remain**:
1. **Register-or-select-then-attach lifecycle.** A workspace is created via `POST /v1/workspaces/register` with `init_authorized: true`, optionally selected via `POST /v1/workspaces/:id/select`, and the bridge's polling attach loop calls `ensureProjectTemplate` → `loadProject` → optional config snapshot import. The first attach for a fresh workspace must materialize the full template; tests rely on `.floe/agents/floe.md` appearing after register+select (`tests/src/vertical-slice.test.ts:97, 197, 276, 455`).
2. **Field watcher pre-creates `.floe/fields/`.** This is necessary so chokidar can attach a watcher even before any field is written, and so the directory is available to FloeWeb / actor field tools. This must continue.
3. **Template idempotency.** `floe-bridge/src/project.test.ts:86-99` requires `ensureProjectTemplate` to **not overwrite** user-modified canonical files on subsequent calls (the test modifies `agents/floe.md` indirectly by re-reading after a second call and asserting bytewise equality).
4. **No `endpoint_id` / `auth_profile` leakage** into the template (`project.test.ts:39-99`, `vertical-slice.test.ts:99-100`).
5. **`materializeSavedConfig` depends on the scaffold.** It calls `ensureProjectTemplate` first, then reads `floe.yaml` and writes into `agents/`. It currently silently relies on those directories existing after the call.
6. **Auto-reimport on drift.** `daemon.ts:208-230` recomputes `config_hash` from disk and reimports if drift is detected. Any new file the template writes on a "fill-missing" pass must be deterministic so the hash remains stable.

Runtime / UX evidence:
- Direct probe reproduces the race: a workspace containing only `.floe/fields/` + `ensureProjectTemplate(...)` → `hasAgentFile: false`.
- `tests\src\vertical-slice.test.ts -t "initializes .floe"` times out waiting for `.floe template`.
- Bus boot path (`server.ts:115`) re-creates `.floe/fields/` for every stored workspace at every bus start, so the race is not limited to first-time registration — any restart leaves a "fields-only" `.floe` that the bridge would skip if the prior attach failed.

## Existing extension points

- `ensureProjectTemplate(workspacePath, workspaceName)` (`floe-bridge/src/project.ts:43`) is already the single funnel for template materialization. Both `daemon.attachWorkspace` and `materializeSavedConfig` call it. The fix belongs **inside this function**.
- `loadProject(workspacePath)` (`project.ts:137`) already enumerates the expected canonical files (`floe.yaml`, `agents/<id>.md`, `extensions/`, `skills/substrate-build/`, `mcp/`, `state/`) and reports them as `validation.errors` when missing. Its existing list of expected paths is the authoritative spec the template must satisfy.
- `hashFloeDir(floeDir)` (`project.ts:272`) already excludes `state/` (except its README+`.gitignore`) and `worklogs/` from the hash. Field files under `.floe/fields/` are **not** excluded; this is fine because field writes already broadcast `field.upserted` and the bridge tolerates drift via auto-reimport.
- Per-file write helpers `writeFileSync` with `{ recursive: true }` `mkdirSync` are the only convention used; there is no shared "write if missing" helper — one should be introduced as a local helper inside `project.ts` (not exported) rather than a new module.

## Do-not-bypass list

- **Do not move template materialization into the bus** or into `fields-watcher.ts`. The bus must remain unaware of bridge-owned template content (agents, skills, extensions, mcp, state). Doing so would duplicate ownership and break the `substrate-build` skill text and CONTEXT split.
- **Do not stop the Field watcher from pre-creating `.floe/fields/`.** That directory must exist before any field is authored so chokidar's `ready` event fires deterministically and so FloeWeb can write the first field without a race.
- **Do not change the `existsSync(floeDir)` guard to `existsSync(floeYaml)`** as a sole replacement — that still leaves stale workspaces where `floe.yaml` exists but `agents/floe.md` (or a directory) is missing in an inconsistent state, which is exactly the class of bug this slice exposes.
- **Do not overwrite any file the user may have edited.** The idempotency test (`project.test.ts:86-99`) and the "user authored content survives" invariant in CONTEXT.md (workspace file is source of truth for Fields, and the `substrate-build` skill text describes preserving the daemon boundary) both require non-destructive behaviour.
- **Do not delete or touch `.floe/fields/`, `.floe/worklogs/`, or any unknown user-authored directories.** The bridge has no business there.
- **Do not introduce a synchronous template write in the bus register/select handler.** The bridge owns this; coupling them would create a second parallel path and would violate workspace `init_authorized` gating which lives in the bridge daemon.

## Integration plan

**Insert the change inside `ensureProjectTemplate()` in `floe-bridge/src/project.ts`.** Replace the early `if (existsSync(floeDir)) return;` with a **fill-missing-only** pass:

1. Always run the `mkdirSync(..., { recursive: true })` calls — they are already idempotent.
2. For each canonical file the template writes (`floe.yaml`, `agents/floe.md`, `extensions/README.md`, `skills/substrate-build/SKILL.md`, `mcp/README.md`, `state/README.md`, `state/.gitignore`), write only if the file does not already exist. A small local helper such as `function writeIfMissing(path, content)` keeps each call site readable.
3. Do not traverse or touch `.floe/fields/` or any directory not in the canonical list.
4. Keep the function signature and call sites unchanged so `daemon.attachWorkspace` and `materializeSavedConfig` get the fix transparently.

**Why this is the correct integration point:**
- It is the single owner of template scaffolding. Both code paths that need the fix already funnel through it.
- It is the lowest-blast-radius change: the bus, server, watcher, daemon, and FloeWeb stay byte-for-byte unchanged.
- It preserves idempotency in a stronger form: not only does it not overwrite a fully initialized `.floe`, it also tolerates any partial `.floe` (fields-only, half-written, manually-curated) by only filling gaps.
- It directly fixes the probe (`hasAgentFile: false` with pre-existing `.floe/fields/`) and the `vertical-slice.test.ts` timeout.

**Alternatives considered and rejected:**
- *Move `.floe/fields/` creation into the bridge / into `ensureProjectTemplate`.* Rejected: violates Field substrate ownership in CONTEXT.md; the bus still needs the directory to exist before chokidar attaches, so this introduces a cross-daemon ordering dependency.
- *Have the bus call `ensureProjectTemplate` before creating `.floe/fields/`.* Rejected: the bus must not depend on bridge code; `init_authorized` gating lives in the bridge; would create a second template-init code path.
- *Make `FieldsWatcherRegistry.watchWorkspace` skip `mkdirSync` when `.floe` does not exist and rely on `awaitWriteFinish` to attach lazily.* Rejected: chokidar without an existing dir is brittle on Windows; would create silent watcher failures and would not fix the broader class of partially-initialized `.floe` directories.
- *Replace `existsSync(floeDir)` with `existsSync(join(floeDir, "floe.yaml"))`.* Rejected: still treats the scaffold as atomic; a partial scaffold (e.g. yaml present but agent file deleted) would silently stay broken.
- *Delete and rewrite the whole `.floe` directory if "incomplete".* Rejected: destroys user-authored fields, agents, and any extensions.

## Regression checklist

- `floe-bridge/src/project.test.ts` "is idempotent — does not overwrite an existing .floe directory" still passes (the modified agent file must survive a re-call).
- `floe-bridge/src/project.test.ts` "Issue 1" cases still pass (no `provider`, `model`, `auth_profile`, `openai-codex`, `gpt-5.4-mini`, etc., leak into the template; actor-neutral instructions remain).
- `materializeSavedConfig` continues to work on a fresh workspace and on a workspace with pre-existing `.floe/fields/` (it depends on the scaffold being present after `ensureProjectTemplate`).
- `tests/src/vertical-slice.test.ts` "initializes .floe ..." (and the three sibling specs at lines 197, 276, 455) reach the post-template assertions: agent file present, no `endpoint_id`, no `auth_profile: default`, agent endpoint registers.
- Field-specific suites (bus + FloeWeb) remain green; `.floe/fields/` creation by the watcher continues to fire `ready` deterministically.
- `hashFloeDir`-derived `config_hash` is stable across repeated `ensureProjectTemplate` calls on the same workspace (drift auto-reimport in `daemon.ts:208-230` must not loop).
- Bus restart with a pre-existing fully initialized `.floe` still creates `.floe/fields/` if missing and does not disturb other template files.

## Test plan

**Existing tests to keep green:**
- `floe-bridge/src/project.test.ts` — entire file.
- `tests/src/vertical-slice.test.ts` — all four `.floe template` waits and the lifecycle assertions that follow each one.
- All `floe-bus` field-watcher and FloeWeb field tests (no behavioural change expected).

**New tests to add (recommended, bridge-package level):**
1. In `floe-bridge/src/project.test.ts`, add an "initializes template when `.floe/fields/` already exists" case mirroring the probe: pre-create `.floe/fields/`, call `ensureProjectTemplate`, assert `.floe/floe.yaml`, `.floe/agents/floe.md`, `.floe/extensions/README.md`, `.floe/skills/substrate-build/SKILL.md`, `.floe/mcp/README.md`, `.floe/state/README.md`, `.floe/state/.gitignore` all exist and the pre-existing `.floe/fields/` directory is untouched.
2. Add a "fills only missing canonical files" case: pre-create `.floe/floe.yaml` with custom contents, call `ensureProjectTemplate`, assert `floe.yaml` is byte-identical to the user version and the missing `agents/floe.md` is written.
3. Add a "config_hash is stable across repeated calls" case: call `ensureProjectTemplate` twice, run `loadProject` twice, assert the two `config_hash` values match.

**Live proof required:**
- From repo root: `Push-Location tests; npx vitest run src\vertical-slice.test.ts -t "initializes .floe" --reporter=verbose; Pop-Location` passes end-to-end with the bridge+bus daemons.
- Re-run the original probe: `npx tsx -e "..."` from the task brief — must print `{ hasAgentFile: true }`.
- Root `npm test` (the previously failing vertical slice) goes green.

## Risk assessment

- **Risk:** A user who manually deleted a single canonical file (e.g. removed `state/.gitignore` on purpose) would have it re-created on next attach. **Mitigation:** Document the behaviour in the change description; this is consistent with "ensure" semantics in the function name and matches how `materializeSavedConfig` already behaves implicitly. No file we re-create is user-authored content — `agents/floe.md`, `floe.yaml`, and the README/SKILL/`.gitignore` placeholders are all template artefacts.
- **Risk:** `config_hash` flicker if a missing canonical file is added between attaches, triggering an auto-reimport loop in `daemon.ts`. **Mitigation:** The fill-missing pass writes deterministic content, so the hash converges after the first attach and stays stable; covered by recommended test #3.
- **Risk:** Race between the bus pre-creating `.floe/fields/` and the bridge writing `mkdirSync(join(floeDir, "agents"), { recursive: true })` on the same path. **Mitigation:** `mkdirSync` with `recursive: true` is already safe under concurrent creation on both POSIX and Windows; no behaviour change here.
- **Risk:** Future template additions (new canonical files) silently skipped on existing workspaces because nobody updates the fill-missing list. **Mitigation:** The fill-missing list is the same list of `writeFileSync` calls already in the function — adding a new template file in one place automatically participates in the fill-missing behaviour.
- **Risk:** A symlinked or read-only `.floe` directory makes the fill-missing writes throw where today the early return masks the error. **Mitigation:** Surface the error to the daemon attach path, which already wraps the call in try/catch and reports via `reportOnce` (`daemon.ts:186-...`).

## Decision confidence

- **Confidence: high.**
- Reasons:
  - The seam is small, localized, and has a direct repro.
  - The fix preserves both ownership boundaries (bridge owns template, bus owns Field watcher dir) with no cross-package changes.
  - Existing idempotency test pins the non-destructive invariant; the change strengthens it rather than relaxing it.
  - `loadProject` already encodes the canonical file list as its validation contract, giving us an authoritative target.
- Open questions:
  - Should `state/.gitignore` and `state/README.md` be re-created if a user has explicitly removed them? Default position: yes (template invariant). Flag for product confirmation if a user reports unexpected re-creation.
  - Should we add a one-time log line when a partial `.floe` is detected and filled, to aid future diagnosis? Default position: yes, a single `console.log("[bridge] filled missing template files", { workspacePath, written: [...] })` when `written.length > 0`. Non-blocking.
  - Should `FieldsWatcherRegistry.watchWorkspace` additionally `await` the bridge's initial attach before broadcasting field events? Out of scope for this slice; current handlers already tolerate ordering because field events are workspace-scoped and independent of template files.
