# Actor

**An actor is non-deterministic, backed by a model or a person.**

An actor lives at [[Workspace]] level, not inside a [[Scope]]. It gets assigned
into working space [[Node]]s and appears wherever it's assigned.

## No human node, no human/agent distinction

There is no human node, and there is no human/agent distinction anywhere in the
substrate. An actor is an actor. Peers cannot tell what backs one — a model or a
person looks identical from the outside.

## The agent definition file

An actor is defined by `.floe/agents/<id>.md` — a Markdown file with YAML
frontmatter:

```yaml
---
schema: floe.agent.v1
agent_id: reviewer
label: Code Reviewer
runtime: { engine: pi }
extensions: []
skills: []
mcp: []
pulse: { inherit: true }
scope: { paths: ["./"], services: [] }
---
# Code Reviewer

<the actor's instructions, in Markdown, below the frontmatter>
```

The frontmatter is the actor's identity and runtime config. The body is its
instructions — what it generally is, in this workspace.

## Instructions are never baked in per node

An actor's per-node instructions are a [[Binding]], not part of its identity. A
node's binding says what the actor is doing *as that node* — its role, model
override, thinking level, auth profile — and it's attached to the node's
connection, never written into the actor's own `.md` file. The same actor can be
bound differently on every node it's assigned to.

## Implementation

- `floe-bridge/src/tools/actor-tools.ts` — `create_actor`, `list_actors`, `update_actor` — writes `.floe/agents/<id>.md`, patches `.floe/floe.yaml`
- `floe-app/src/actors/agentFile.ts` — `parseAgentFile`, `serializeAgentFile`, `buildFrontmatter` — the same file shape, used by the desktop UI
- `floe-bus/src/scope-graphs.ts` — `ScopeGraphActorNode.bindings` — per-node bindings, distinct from the actor's own instructions file
- `floe-bus/src/bindings.ts` — the `Binding` type

See [[Glossary]].
