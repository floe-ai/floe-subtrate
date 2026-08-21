# floe-app

**floe-app is the visual surface on top of the [[What floe is|substrate]] — a window onto the [[Services|Bus]], never a second brain.**

## The governing rule

floe-app does not invent substrate behaviour. Workspace operations call real [[Bus API]] routes. Host-local responsibilities that must not cross the bus — credentials and native filesystem access — go through the Tauri desktop boundary defined by ADR-0005.

This matters because the app is optional. A [[Workspace]] runs fine with no UI open at all — [[Actor]]s deliver over the bridge↔bus WebSocket regardless of whether anyone is looking. The app is a way of looking, not a way of working that only it can do.

## What the UI actually adds

The substrate does not get easier to use just because it has a UI. What changes is the cost of looking:

- **Seeing what exists without composing a query.** [[Scope]]s, [[Context]]s and [[Actor]]s render as lists and cards instead of `GET` responses you have to shape yourself.
- **Watching work happen live.** The substrate is push-only — no polling anywhere. floe-app rides the same event stream the [[Services|Bridge]] does, so a [[Context]] you have open updates the moment a [[Delivery and Turn|Delivery]] lands, with no refresh.
- **Reading a conversation as a conversation.** A [[Context]]'s events render as a message list with actor names, not raw JSON envelopes.
- **Editing an actor without hand-writing YAML.** An [[Actor]]'s [[Binding]] — auth profile, model, thinking level — is a form, not a file you edit and hope you got the shape right.

None of this is a new substrate primitive. It is the same bus and the same local configuration contracts, presented through a friendlier surface.

## First use

The desktop app opens its shell immediately while it waits for local Floe services. A clean installation is guided through three product steps:

1. connect a model provider;
2. choose or create a workspace;
3. enter the Floe conversation.

The provider step offers the subscription providers supported by the packaged Pi runtime. The browser sign-in, device-code feedback, provider profile, model choice, and workspace binding are completed inside floe-app; no terminal command is part of first use.

The normal Floe conversation repeats the workspace's provider, model, and reasoning-effort choice at the point of use. Its composer is disabled until a provider and model are saved, preventing an unserviceable message from being accepted and deferred.

## One server, one UI

There is one bus (port `5377`) and one UI surface (port `5379`). That UI surface is a plain web app — open it in any browser and it works. The Tauri desktop shell does not run a second copy: it opens a native window attached to the same running `5379` frontend. `floe start` runs the services with no window; `floe desktop` starts the services if needed and then opens the desktop window on top.

## What only the desktop can do

Two things are gated to the desktop shell, not the browser:

- **Provider setup.** Per ADR-0005, provider setup is desktop/CLI only. Normal ChatGPT setup is available from onboarding and Floe Settings. The browser can read configured profiles but cannot connect an account.
- **Native filesystem access.** Reading and writing files in a [[Workspace]]'s folder (for example, an actor's agent file) uses Tauri's native filesystem APIs, unavailable to a plain browser tab.

Everything else — scopes, contexts, actors, conversations, settings reads — works identically in browser and desktop.

See [[Glossary]].

## Implementation

- `floe-app/src/App.tsx` — the shell, workspace bootstrap, WebSocket subscription
- `floe-app/src/features/onboarding/OnboardingFlow.tsx` — provider → workspace → chat first-use flow
- `floe-app/src/providers/ProviderAccess.tsx` — normal subscription-provider surface
- `floe-app/src/workspace/FloeModelControl.tsx` — conversation-level provider/model/effort selection and readiness gate
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — secondary developer observatory and advanced API-key profiles
- `floe-app/src/fs/workspaceFs.ts` — `isTauri()`, native file read/write
- `floe-cli/src/desktop.ts` — `floe desktop` command, cargo preflight
- Bus WebSocket: `GET /v1/events/stream` (also used by the bridge)
