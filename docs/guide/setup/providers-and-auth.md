# Providers and auth

**A provider connection gives Floe model labour; a profile is the local, non-secret handle used by runtime bindings.**

Floe can route different providers to different runtime adapters. The first normal desktop option is ChatGPT through the official OpenAI Codex app-server. The Pi runtime remains a compatibility option for profiles it supports.

## Connecting ChatGPT in the desktop app

On a clean installation, Floe asks for a provider before asking for a workspace. Choose **Continue with ChatGPT**. The packaged helper speaks to `codex app-server`, which starts or reuses the official ChatGPT login and returns account status and the current model catalogue. Codex owns and refreshes its credentials; Floe does not copy or store the subscription token.

After onboarding, use the gear beside the workspace name and open **Settings → Model providers** to reconnect or refresh the models available to the account. The Floe conversation and Settings both expose the workspace's provider, model, and reasoning-effort choice. They update one shared workspace default; the conversation stays disabled until that choice contains a connected provider and model.

Floe writes a non-secret `chatgpt-codex` profile with provider `openai-codex-app-server` and mirrors current model metadata into the local overlay. The bridge routes that profile to the Codex app-server runtime. Provider credentials never pass through the bus.

## Advanced and compatibility profiles

Developer tools → Substrate Settings retains API-key profile management and profile inspection for testing and compatibility. Those controls are intentionally not the normal sign-in experience.

The Floe CLI continues to expose Pi-supported OAuth and API-key profiles:

```
floe login --provider <provider>
```

`floe login` walks through choosing a provider, picking or creating a profile id, and authenticating through the mechanism that provider supports. API keys can be read from an environment variable with `--api-key-env`; `--model` sets a profile default.

```
floe auth list
floe auth doctor
floe logout
```

These commands list, validate, and remove Floe-managed profiles.

## Where state lives

Floe's local auth metadata lives under `~/.floe/auth/`:

- `auth.json` — credentials for API-key and Pi compatibility profiles; it does not contain Codex subscription credentials
- `models.json` — optional local model catalogue overlays, including non-secret Codex model metadata
- `profiles.yaml` — named provider profiles used by runtime bindings

Codex owns its account and refresh tokens in its own official storage.

## Writes are desktop/CLI only

Per ADR-0005, the bus exposes no auth-write endpoints. Only the Tauri desktop shell and Floe CLI can create or edit local auth state. The normal ChatGPT path delegates credential ownership to Codex and writes only non-secret profile/model metadata through Tauri. Secrets never cross a Floe network port.

The browser build can only read profiles through `GET /v1/auth/profiles`. Account connection and local credential writes require the desktop app or CLI.

## Setup and repair

```
floe setup
```

This creates local Floe configuration if needed, optionally enables autostart, starts services, verifies health, and opens the web UI.

Floe is in early development and breaking config changes are expected. Use `floe reset` or the documented repair command for the affected state rather than deleting the entire Floe home blindly; preserve valuable API credentials. Codex subscription credentials remain owned by Codex and are outside Floe's auth files.

See [[Glossary]] for term definitions.

## Implementation

- `floe-app/src/providers/ProviderAccess.tsx` — normal provider connection surface
- `floe-app/src/features/onboarding/OnboardingFlow.tsx` — first-use provider step
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — developer profile inspection and advanced writes
- `floe-app/src-auth-sidecar/index.ts` — packaged official Codex app-server helper
- `floe-app/src-tauri/src/substrate_commands.rs` — non-secret Codex profile/model sync and advanced provider-keyed writes
- `floe-bridge/src/adapters/provider-runtime-adapter.ts` — profile-provider runtime routing
- `floe-cli/src/cli.ts` — compatibility profile commands
- `docs/adr/0005-file-access-patterns.md` — the desktop/CLI versus bus write boundary
