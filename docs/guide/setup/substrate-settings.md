# Substrate settings

**Substrate settings are machine-level: they apply to this install of floe, not to any one workspace.**

A workspace's own settings live in its `.floe/` directory (see [[Workspace config]]) and travel with the repo. Substrate settings live on your machine, under `~/.floe/`, and apply across every workspace you attach. The split matters: credentials, daemon ports, and the model registry are properties of *your machine*, not of any project — committing them to a repo would leak secrets and hard-code someone else's local paths.

Substrate settings cover:

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
| Authentication | Real — desktop reads and writes credentials; browser reads only (see [[Providers and auth]]) |
| Runtime | Real — shows and edits the bridge's runtime adapter |
| Model Registry | Stub — disabled, "coming soon" |
| MCP Manager | Stub — disabled, "coming soon" |
| Workspace Catalog | Stub — disabled, "coming soon" |
| Diagnostics | Stub — disabled, "coming soon" |

Be honest with yourself about this: clicking a stub tab does nothing. The model registry, MCP servers, and workspace catalogue are all real concepts in the substrate, but there is no settings UI for them yet — you manage them through `~/.floe/auth/models.json`, `.floe/mcp/`, and `floe-cli` directly.

## Implementation

- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — tab list (`auth`, `runtime` real; `models`, `mcp`, `workspaces`, `diagnostics` marked `isStub`), `AuthenticationPillar`, `RuntimeAdapterPillar`
- `floe-cli/src/config.ts` — `~/.floe/config.yaml` schema (`bus`, `bridge`, `app`, `library`, `runtime` sections)
- `floe-cli/src/auth.ts` — `~/.floe/auth/` (credentials, models, profiles)

See [[Glossary]] for term definitions.
