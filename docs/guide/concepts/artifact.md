# Artifact

**An artifact is what travels between nodes — either on the wire or as a file.**

## Two carriers

| Carrier | What it's for |
|---|---|
| **wire** | The [[Event]]'s `content` — small, ephemeral, disappears into history like any other event |
| **file** | Large, durable, human-reviewable, or needed across [[Scope]] boundaries |

Pick wire for anything that only needs to reach the next step. Pick a file for
anything a person will open later, anything too large for an event payload, or
anything another scope needs to read independent of the context that produced it.

## Default to emitting everything

A node does not have to declare outputs to produce them. The default is to emit
everything it has. Declared outputs (on a [[Command]]) *narrow* what gets mapped onto
named results — they never *gate* what's allowed to be emitted. A command with no
declared outputs still emits its raw execution facts in full.

## Why there's no summariser and no blackboard

Two designs were considered and rejected:

- **Auto-summarisation between steps** — compressing an event's content before the
  next node sees it. Rejected: it throws away information the next step might need,
  silently, before anyone can decide it's safe to lose.
- **A shared blackboard / global memory** — a place every actor reads and writes
  regardless of context. Rejected: it re-introduces exactly the cross-wiring the
  [[Command]] return path was built to prevent, and nobody can tell what wrote what.

**Wires are the context.** What travels on the event *is* the shared state between
steps — nothing implicit sits behind it.

## Implementation

- `floe-bus/src/scope-graphs.ts` — `ScopeGraphCommandOutput`, `buildCommandResultContent` in `floe-bridge/src/command-runner.ts` (outputs narrow, raw facts still available when none declared)
- `floe-bus/src/fs/agentFiles.ts`, `floe-bus/src/fs/browseDir.ts` — the file carrier's storage
- `floe-bus/src/server.ts` — `GET`/`PUT /v1/workspaces/:workspace_id/fs/file` for reading and writing a file artifact, plus `GET /v1/workspaces/:workspace_id/fs/media` for safe raster preview

See [[Glossary]].
