# Settings in floe-app

**floe-app has two separate levels of settings — workspace and [[Substrate settings]] — because they answer different questions: what this project is, versus what this machine can do.**

## Why two levels

Workspace settings describe what this [[Workspace]] is: which [[Actor]]s and extensions it has, and how the app behaves when it writes a file back to your git working tree. This is project-level, checked into `.floe/` alongside your code.

[[Substrate settings]] describe the machine underneath every workspace: auth credentials, the daemon runtime, the model registry, MCP, the workspace catalog, and diagnostics. This is machine-level, and lives in `~/.floe/config.yaml` — never checked into any project's git history, and never migrated (a broken config is reset with `rm -rf ~/.floe && floe setup`, not repaired in place).

Keeping them separate means a change to your model registry does not touch any workspace's git history, and a workspace's committed settings never leak machine credentials.

## Workspace settings

Reached via the settings affordance next to the workspace switcher. It currently holds one control: the [[Binding]] new actors inherit by default — profile → model → thinking level — shown alongside the same profile/model constraints used on an individual actor.

## The actor Configure tab

Opening an actor and switching to its **Configure** tab shows its [[Binding]]: auth profile, model (constrained to that profile's provider), and thinking level (`off` / `minimal` / `low` / `medium` / `high` / `xhigh`). It also shows the effective resolved binding with its layer — actor, workspace, or global — so you can see what is actually in effect versus what is set at this level.

This correctly lives on the actor, not in a separate settings drawer: a [[Binding]] is what the actor is doing *as this actor*, and inheritance (actor → workspace → global) only makes sense read from where it resolves. A drawer elsewhere would just be a second, worse place to see the same thing.

## Substrate Settings

Reached from the bottom of the left nav — switches the whole app into machine-level mode. It has six tabs:

| Tab | Status |
|---|---|
| Authentication | Real. Desktop can read and write credentials; browser is read-only (see [[floe-app]]). |
| Runtime | Real. Daemon runtime status/config. |
| Model Registry | Stub. |
| MCP Manager | Stub. |
| Workspace Catalog | Stub. |
| Diagnostics | Stub. |

Stub tabs render a "Pillar Coming Soon" placeholder — no functionality behind them yet.

See [[Glossary]].

## Implementation

- `floe-app/src/workspace/WorkspaceSettings.tsx` — workspace-level default binding
- `floe-app/src/actors/ActorInspector.tsx` — actor Configure tab, binding form, resolved-binding display
- `floe-app/src/features/substrate/SubstrateSettingsView.tsx` — Substrate Settings shell and the six tabs (Authentication/Runtime real; Models/MCP/Workspaces/Diagnostics are stubs)
- `GET /v1/auth/profiles`, `GET /v1/runtime/bindings`, `POST /v1/runtime/bindings` — auth profiles and binding reads/writes
- `GET /v1/runtime/bindings/resolve` — effective resolved binding
