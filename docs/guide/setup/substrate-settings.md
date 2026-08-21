# Substrate settings

**Substrate Settings is the secondary developer observatory for machine-level Floe state. Normal provider and workspace model choices live together in Floe Settings.**

A workspace's own settings live in its `.floe/` directory (see [[Workspace config]]) and travel with the repo. Substrate settings live on your machine, under `~/.floe/`, and apply across every workspace you attach. The split matters: credentials, daemon ports, and the model registry are properties of *your machine*, not of any project — committing them to a repo would leak secrets and hard-code someone else's local paths.

The developer view covers:

- auth credentials ([[Providers and auth]])
- daemon runtime (which adapter the bridge, see [[Services]], uses to run actors)
- the model registry ([[Models and thinking level]])
- MCP server configuration
- the catalogue of workspaces this machine knows about
- diagnostics

This is a short, deliberate list — not a dumping ground. Anything that describes what a *workspace* is (its agents, extensions, per-project settings) belongs in `.floe/`, not here.

## What's real today

The Substrate Settings view in floe-app has six tabs. Only two are implemented:

| Tab | Status |
|---|---|
| Authentication | Real, developer/advanced — inspect profiles and manage API-key profiles; browser reads only (see [[Providers and auth]]) |
| Runtime | Real, developer/advanced — inspect or force test versus live provider runtimes |
| Model Registry | Stub — disabled, "coming soon" |
| MCP Manager | Stub — disabled, "coming soon" |
| Workspace Catalog | Stub — disabled, "coming soon" |
| Diagnostics | Stub — disabled, "coming soon" |

Normal ChatGPT connection is intentionally absent from this view. It belongs in first-use onboarding and the Settings gear beside the workspace name. Clicking a stub tab does nothing. The model registry, MCP servers, and workspace catalogue are real substrate concepts, but there is no settings UI for them yet.

## Implementation

- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — tab list (`auth`, `runtime` real; `models`, `mcp`, `workspaces`, `diagnostics` marked `isStub`), `AuthenticationPillar`, `RuntimeAdapterPillar`
- `floe-cli/src/config.ts` — `~/.floe/config.yaml` schema (`bus`, `bridge`, `app`, `library`, `runtime` sections)
- `floe-cli/src/auth.ts` — `~/.floe/auth/` (credentials, models, profiles)

See [[Glossary]] for term definitions.
