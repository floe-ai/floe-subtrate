# Providers and auth

**An auth profile ties a provider account or API key to a name floe can bind [[Actor]]s to.**

Floe talks to models through providers (OpenAI, Anthropic, GitHub Copilot, and others). A provider needs credentials before any actor can use it. Those credentials live in an auth profile.

## Creating a profile

```
floe login --provider <provider>
```

`floe login` walks you through choosing a provider, picking or creating a profile id, and authenticating — either OAuth (a browser flow) or an API key read from an environment variable (`--api-key-env`). You can also set a default model for the profile with `--model`.

```
floe auth list
```

Lists configured profiles, their provider, default model, and whether credentials are actually present.

```
floe auth doctor
```

Validates the whole setup: checks that credential, model registry, and profile files exist and parse, that every profile references a known provider and model, and that every profile actually has usable credentials.

```
floe logout
```

Removes a profile.

## Where credentials live

Auth profiles, credentials, and the model catalogue live under `~/.floe/auth/`:

- `auth.json` — provider credentials (API keys, OAuth tokens)
- `models.json` — the local model registry
- `profiles.yaml` — named auth profiles

## Auth write is desktop/CLI only

Per ADR-0005, the bus exposes **no auth-write endpoints**. Only `floe-cli` and the Tauri desktop shell can create, edit, or remove credentials — both go through native filesystem access, so secrets never cross a network port.

The browser build of floe-app can only **read** auth profiles (`GET /v1/auth/profiles`). When you open Substrate Settings in a plain browser, the Authentication panel shows your configured profiles read-only, with a note to use the CLI (`floe login`) or the desktop app to make changes.

## Setup

```
floe setup
```

Creates `~/.floe/config.yaml` if it doesn't exist, optionally enables autostart, starts services, verifies health, and opens the web UI. Run it once per machine.

## Config is never migrated

Machine config lives at `~/.floe/config.yaml`. Floe is in early development: breaking config changes are expected, and there is deliberately no migration path. If your config is incompatible with the running version of floe, it fails fast with a reset instruction instead of trying to patch itself. The fix is always:

```
rm -rf ~/.floe
floe setup
```

This is intentional, not a bug to work around.

See [[Glossary]] for term definitions.

## Implementation

- `floe-cli/src/cli.ts` — `login`, `auth list`, `auth doctor`, `logout`, `setup` commands
- `floe-cli/src/auth.ts` — profile storage, `authJsonPath`/`modelsJsonPath`/`profilesYamlPath` under `~/.floe/auth/`
- `floe-cli/src/config.ts` — `ensureConfig`, `parseLocalConfig` (fail-fast reset message on incompatible config)
- `GET /v1/auth/profiles` — read auth profiles (`floe-bus/src/server.ts:860`)
- `GET /v1/auth/models` — read models for a provider (`floe-bus/src/server.ts:870`)
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — `BrowserAuthPillar` (read-only) vs `TauriAuthPillar` (read/write)
- `docs/adr/0005-file-access-patterns.md` — the desktop/CLI vs bus write boundary
