# Workspace

**A workspace is the outer boundary of all work for a product.**

One repo, one folder. It holds the four citizens — [[Actor]], [[Command]], [[Context]] and [[Scope]] — plus the files and settings that let them run.

## What lives in git

Everything that defines what the workspace *is* lives in `.floe/` and is committed:

- `.floe/agents/<id>.md` — actor definition files
- `.floe/floe.yaml` — the list of actors, event sources, commands, and workspace settings
- nodes and their connections — authored in the scope, stored alongside the workspace
- extensions the workspace depends on

`.floe/floe.yaml` is human-authored, committed config. Treat it as read-only at
runtime — the bridge reads it, actor-management tools patch it on disk, but nothing
in the substrate treats it as a place to record what's happening right now.

## What lives in the bus

Everything that describes what is *happening right now* lives in the bus's SQLite
store, not in git:

- [[Context]]s and their history
- whether an [[Endpoint]] is paused, idle or busy
- a node's on-canvas position (layout)

## The rule

**What the workspace IS lives in git. What is HAPPENING RIGHT NOW does not.**
If you'd expect to `git diff` it, it's in `.floe/`. If it's a live status or a
running conversation, it's in the bus.

## Multiple workspaces

A machine can attach more than one workspace. Attaching registers the workspace
with the bus so its actors, scopes and extensions load and its events start
flowing.

## Implementation

- `floe-bus/src/server.ts` — `POST /v1/workspaces/register`, `GET /v1/workspaces`, `POST /v1/workspaces/:workspace_id/select`, `POST /v1/workspaces/:workspace_id/delete`
- `floe-bus/src/server.ts` — `GET /v1/workspaces/:workspace_id/config-status`, `POST /v1/workspaces/:workspace_id/config-snapshot`, `POST /v1/workspaces/:workspace_id/apply-config`
- `floe-bridge/src/project.ts` — reads `.floe/floe.yaml` and `.floe/agents/*.md` on attach
- `floe-bridge/src/tools/actor-tools.ts` — writes `.floe/agents/<id>.md` and patches `.floe/floe.yaml` on actor create/update

See [[Glossary]].
