# Install and first run

**Getting from nothing installed to a working floe: install, `floe setup`, open the UI, attach a workspace.**

## Prerequisites

- Node.js, to run `floe` and its services.
- Rust and `cargo`, only if you want the desktop window (`floe desktop`). The browser UI at `http://localhost:5379` needs neither.

`floe desktop` checks for `cargo` on `PATH` before doing anything else. If it's missing, it fails fast with a link to `https://rustup.rs/` instead of trying to install Rust for you (`floe-cli/src/desktop.ts`, `checkCargoAvailable`).

## Install

```bash
npm install
```

## `floe setup`

```bash
floe setup
```

Run once per machine. It:

- creates `~/.floe/config.yaml` if it doesn't already exist
- optionally enables user-level autostart
- starts the [[Services]] (bus, bridge, frontend)
- verifies they're healthy
- if the current directory (or an ancestor) already has a `.floe/` folder, registers it as a [[Workspace]] with the bus
- opens the web UI, unless you pass `--no-open`

Flags: `--yes` (accept defaults), `--no-autostart`, `--no-open`, `--repair` (reconcile local service records if something's stuck).

## Starting services without setup

```bash
floe start
```

Starts the bus, bridge, and frontend only — no browser window, nothing else. This is the command to use for autostart; it never opens a display. Open the UI yourself at:

```
http://localhost:5379
```

## The desktop window

```bash
floe desktop
```

Starts services if they aren't already running, waits for the 5379 frontend to answer a health check, then opens a native Tauri window attached to that same running frontend — it never starts a second frontend. First launch compiles Rust and takes about 2–5 minutes; the build output streams to your terminal. Later launches are fast.

## Attaching your first workspace

A [[Workspace]] is a repo or folder with a `.floe/` directory in it. `floe setup` and `floe open` both walk up from your current directory looking for one and register it with the bus automatically (`findAncestorWithFloe` in `floe-cli/src/cli.ts`).

If you run `floe setup` or `floe open` from inside a directory that has no `.floe/` folder anywhere above it, nothing gets auto-registered — the CLI has no `floe init` command. You register a workspace directly against the bus instead:

```bash
curl -X POST http://localhost:5377/v1/workspaces/register \
  -H "content-type: application/json" \
  -d '{"locator": "C:/path/to/your/repo", "init_authorized": true}'
```

`init_authorized: true` lets the bus create the `.floe/` structure for a directory that doesn't have one yet. See [[Working without floe-app]] for more on driving the bus directly, and [[Workspace config]] for what lands inside `.floe/`.

## What you see when nothing exists yet

A freshly attached workspace has no [[Scope]]s, no [[Actor]]s beyond a seeded default operator, and no history. floe-app shows an empty workspace home. This is expected: floe doesn't ship example scopes or example work. See [[The documentation pipeline]] for a full worked example built from nothing.

## If it breaks

`~/.floe/config.yaml` is never migrated. If it's incompatible with the version of floe you're running, floe fails fast with a message instead of trying to patch it. The fix is always:

```bash
rm ~/.floe/config.yaml
floe setup
```

## Implementation

- `floe-cli/src/cli.ts` — `setup`, `start`, `desktop`, `open` commands; `registerCurrentWorkspace`, `findAncestorWithFloe`
- `floe-cli/src/desktop.ts` — `checkCargoAvailable`, `missingCargoMessage`
- `floe-cli/src/config.ts` — `ensureConfig` (config creation, fail-fast reset message)
- `floe-cli/src/process-manager.ts` — `startAll`/service start/stop
- `POST /v1/workspaces/register` — register a workspace (`floe-bus/src/server.ts:625`)
- `POST /v1/workspaces/:workspace_id/select` — select the active workspace (`floe-bus/src/server.ts:737`)

See [[Glossary]].
