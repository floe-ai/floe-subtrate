# Providers and auth

**A provider connection gives Floe model labour; a profile is the local handle used by runtime bindings.**

Floe uses its packaged Pi runtime across supported model providers. Normal desktop setup offers the subscription providers Pi currently exposes, including ChatGPT, Claude, and GitHub Copilot. API-key profiles remain available as an advanced option.

## Connecting a subscription in the desktop app

On a clean installation, Floe asks for a provider before asking for a workspace. Choose a provider and model, then continue. The packaged authentication helper runs Pi's provider-neutral OAuth flow, opens the provider's browser sign-in, and returns progress or a device code to floe-app. The user never needs to run `floe login`.

After onboarding, use the gear beside the workspace name and open **Settings → Model providers** to connect another supported subscription. The Floe conversation and Settings both expose the workspace's provider, model, and reasoning-effort choice. They update one shared workspace default; the conversation stays disabled until that choice contains a connected provider and model.

Floe stores the OAuth credential under the provider id and writes a normal provider profile for runtime bindings. The Pi-backed bridge resolves and refreshes that credential. Provider credentials never pass through the bus or web frontend.

## Advanced and compatibility profiles

Developer tools → Substrate Settings retains API-key profile management and profile inspection for testing and compatibility. Those controls are intentionally not the normal subscription sign-in experience.

The Floe CLI continues to expose the same Pi-supported OAuth and API-key profiles for terminal users:

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

- `auth.json` — subscription OAuth credentials and API keys, keyed by provider
- `models.json` — optional local model catalogue overlays
- `profiles.yaml` — named provider profiles used by runtime bindings

## Writes are desktop/CLI only

Per ADR-0005, the bus exposes no auth-write endpoints. Only the packaged desktop helper, Tauri shell, and Floe CLI can create or edit local auth state. Subscription credentials are written directly to Floe's local credential store and never cross a Floe network port or enter the web frontend.

The browser build can only read profiles through `GET /v1/auth/profiles`. Account connection and local credential writes require the desktop app or CLI.

## Setup and repair

```
floe setup
```

This creates local Floe configuration if needed, optionally enables autostart, starts services, verifies health, and opens the web UI.

Floe is in early development and breaking config changes are expected. Use `floe reset` or the documented repair command for the affected state rather than deleting the entire Floe home blindly; preserve valuable subscription and API credentials.

See [[Glossary]] for term definitions.

## Implementation

- `floe-app/src/providers/ProviderAccess.tsx` — normal provider connection surface
- `floe-app/src/features/onboarding/OnboardingFlow.tsx` — first-use provider step
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — developer profile inspection and advanced writes
- `floe-app/src-auth-sidecar/index.ts` — packaged Pi subscription authentication helper
- `floe-app/src-tauri/src/substrate_commands.rs` — desktop authentication orchestration and advanced provider-keyed writes
- `floe-bridge/src/adapters/pi-agent-core-adapter.ts` — multi-provider runtime execution
- `floe-cli/src/cli.ts` — compatibility profile commands
- `docs/adr/0005-file-access-patterns.md` — the desktop/CLI versus bus write boundary
