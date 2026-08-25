# Workspace config

**`.floe/` is the committed, human-authored truth of what a [[Workspace]] is.**

Everything that describes a workspace's shape — its actors, extensions, and settings — lives in `.floe/` and is checked into git. Everything about what is *happening right now* (contexts, events, deliveries) lives in the bus instead. See [[Substrate settings]] for the machine-level settings that do NOT belong here.

## `.floe/floe.yaml`

The workspace manifest. Structure:

```yaml
schema: floe.workspace.v1
version: 1
agents:
  - id: floe
    path: ./agents/floe.md
pulse:
  default: "off"
  after_idle: "30m"
  min_interval: "30m"
state:
  path: ./state
```

- `agents` — the list of agent definition files this workspace declares
- `pulses` — workspace-level pulse declarations (schedule sources for [[Event]]s)
- `watchers` — legacy folder-watch configs; new folder sources are stored on the Event node that owns them
- `state` — where ephemeral, non-config runtime state is written

## `.floe/agents/<id>.md`

An agent definition: YAML frontmatter plus a body of free-text instructions.

```markdown
---
schema: floe.agent.v1
agent_id: floe
label: Floe
runtime:
  engine: pi
extensions: []
skills:
  - ../skills/substrate-build
mcp: []
pulse:
  inherit: true
scope:
  paths:
    - ./
  services: []
---
You are Floe, ...
```

Fields: `schema`, `agent_id`, `label`, `runtime.engine`, `extensions` (list of [[Extension]] names bound to this actor), `skills`, `mcp`, `pulse.inherit`, `scope`.

## `.floe/floe.yaml` and runtime composition

This is a hard invariant: `.floe/floe.yaml` is human-authored, committed project config. The bridge treats it as **read-only** once the workspace is running.

Actors may form runtime organisation through the bus without hand-editing this file. `compose_scope`
authors Event, Actor, and deterministic Command nodes together in a scoped Context; `inspect_scopes`
reads that organisation and `fire_scope_event` activates a manual Event node. `connect_folder_to_actor`
remains the common two-node shortcut for a folder-backed Event and one participating actor. Stored
composition is rediscovered by the bridge as soon as it is created and whenever the workspace attaches.
The older top-level `watchers` entries remain readable for existing workspaces but are not the normal
composition path.

Bundled agents contributed by an [[Extension]]'s manifest are registered **in memory** directly from the loaded manifest — they are never written to `.floe/floe.yaml` or `.floe/agents/`. After a clean boot, `git status --porcelain` in the workspace repo must come back empty: attaching a workspace never dirties a tracked file.

## Git behaviour on write

When an actor tool does write to the workspace (creating a new agent file, for example), what happens to the resulting git changes is a workspace setting, not something floe decides for you: leave the change alone, show it to you, or commit it automatically. This distinguishes a genuine tool-driven edit (which the workspace setting governs) from the bundled-agent registration above (which never touches disk at all).

## Implementation

- `floe-bridge/src/project.ts` — `ensureProjectTemplate`, `loadProject`, `.floe/floe.yaml` and `.floe/agents/*.md` parsing, `computeConfigSurface`
- `floe-bridge/src/tools/actor-tools.ts` — agent-creation tool that writes the agent file and updates `floe.yaml`
- `floe-bridge/src/extension-loader.ts` — `loadBundledAgentsInMemory` (bundled agents loaded from the extension manifest, never persisted to `.floe/`)
- `floe-bridge/src/daemon.ts` — `attachWorkspace` iterates `ext.bundledAgents` and registers them in memory via `bus.registerEndpoint`

Git-behaviour-on-write as a workspace setting ("leave it / show it / commit it"): Not built yet.

See [[Glossary]] for term definitions.
