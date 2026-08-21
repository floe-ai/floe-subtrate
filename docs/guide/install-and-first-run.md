# Install and first run

**Getting from nothing installed to a working Floe: start local services, connect a provider, choose a workspace, and talk to Floe.**

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

Once the native shell opens, it renders a lightweight **Starting Floe…** state immediately and retries the local substrate while it becomes ready. The current development command still starts the services before opening the Tauri development window; making a packaged EXE own the bus/bridge service lifecycle requires packaged service binaries and is not implied by this UI behaviour.

## First-use onboarding

A [[Workspace]] is a repo or folder where Floe works. On a clean desktop installation, opening Floe starts or attaches to its packaged local substrate in the background. The app then offers the subscription providers supported by its packaged Pi runtime, asks for an existing or new workspace folder, applies the chosen model as the workspace default, and opens the Floe conversation. No CLI setup or login is required.

`floe setup` and `floe open` still walk up from the current directory and automatically register an ancestor that already contains `.floe/`. Headless users can register directly against the bus:

```bash
curl -X POST http://localhost:5377/v1/workspaces/register \
  -H "content-type: application/json" \
  -d '{"locator": "C:/path/to/your/repo", "init_authorized": true}'
```

`init_authorized: true` lets the bus create the `.floe/` structure for a directory that doesn't have one yet. See [[Working without floe-app]] for more on driving the bus directly, and [[Workspace config]] for what lands inside `.floe/`.

## What you see when nothing exists yet

A freshly attached workspace lands in the conversation with Floe and asks what outcome you want. It does not require a Scope, Actor inventory, or substrate configuration before that first conversation. The richer developer views remain available under Developer tools.

## If it breaks

`~/.floe/config.yaml` is not migrated automatically. If it is incompatible, use `floe reset` or the repair instruction for the affected state. Do not delete the whole Floe home blindly when it contains valuable subscription or API credentials.

## Implementation

The desktop installer includes the Node runtime used by Floe and one bundled desktop companion script. Together they run the real Floe bus and bridge as the background substrate and perform provider-neutral Pi authentication when requested by the Tauri shell. The window appears immediately while the frontend waits briefly for the local substrate to become ready. If a substrate is already listening, the app attaches to it instead of starting another one.

- `floe-cli/src/cli.ts` — `setup`, `start`, `desktop`, `open` commands; `registerCurrentWorkspace`, `findAncestorWithFloe`
- `floe-cli/src/desktop.ts` — `checkCargoAvailable`, `missingCargoMessage`
- `floe-cli/src/config.ts` — `ensureConfig` (config creation, fail-fast reset message)
- `floe-cli/src/process-manager.ts` — `startAll`/service start/stop
- `POST /v1/workspaces/register` — register a workspace (`floe-bus/src/server.ts:625`)
- `POST /v1/workspaces/:workspace_id/select` — select the active workspace (`floe-bus/src/server.ts:737`)

See [[Glossary]].
