# floe-app

**floe-app is the visual surface on top of the [[What floe is|substrate]] — a window onto the [[Services|Bus]], never a second brain.**

## The governing rule

floe-app never holds logic the substrate lacks. Every button in the app calls a real [[Bus API]] route. Anything you can do in the app you can do by calling that route directly — over `curl`, a script, or another actor. If a feature in the app cannot be traced to a bus route, it is a bug, not a feature.

This matters because the app is optional. A [[Workspace]] runs fine with no UI open at all — [[Actor]]s deliver over the bridge↔bus WebSocket regardless of whether anyone is looking. The app is a way of looking, not a way of working that only it can do.

## What the UI actually adds

The substrate does not get easier to use just because it has a UI. What changes is the cost of looking:

- **Seeing what exists without composing a query.** [[Scope]]s, [[Context]]s and [[Actor]]s render as lists and cards instead of `GET` responses you have to shape yourself.
- **Watching work happen live.** The substrate is push-only — no polling anywhere. floe-app rides the same event stream the [[Services|Bridge]] does, so a [[Context]] you have open updates the moment a [[Delivery and Turn|Delivery]] lands, with no refresh.
- **Reading a conversation as a conversation.** A [[Context]]'s events render as a message list with actor names, not raw JSON envelopes.
- **Editing an actor without hand-writing YAML.** An [[Actor]]'s [[Binding]] — auth profile, model, thinking level — is a form, not a file you edit and hope you got the shape right.

None of this is new capability. It is the same bus, read and written through a friendlier surface.

## One server, one UI

There is one bus (port `5377`) and one UI surface (port `5379`). That UI surface is a plain web app — open it in any browser and it works. The Tauri desktop shell does not run a second copy: it opens a native window attached to the same running `5379` frontend. `floe start` runs the services with no window; `floe desktop` starts the services if needed and then opens the desktop window on top.

## What only the desktop can do

Two things are gated to the desktop shell, not the browser:

- **Auth writes.** Per ADR-0005, writing authentication credentials is desktop/CLI only. The browser can read configured auth profiles but cannot add or edit them — it shows a note to use the CLI or desktop app instead.
- **Native filesystem access.** Reading and writing files in a [[Workspace]]'s folder (for example, an actor's agent file) uses Tauri's native filesystem APIs, unavailable to a plain browser tab.

Everything else — scopes, contexts, actors, conversations, settings reads — works identically in browser and desktop.

See [[Glossary]].

## Implementation

- `floe-app/src/App.tsx` — the shell, workspace bootstrap, WebSocket subscription
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — `isTauri()` branch gating auth writes
- `floe-app/src/fs/workspaceFs.ts` — `isTauri()`, native file read/write
- `floe-cli/src/desktop.ts` — `floe desktop` command, cargo preflight
- Bus WebSocket: `GET /v1/events/stream` (also used by the bridge)
