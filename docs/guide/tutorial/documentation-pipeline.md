# The documentation pipeline

**A complete worked example: a note lands from a folder source, a writer and reviewer argue over a draft, a command runs a real test, and an approver writes the file.**

This is the proving case for the whole model. It uses no primitive beyond what [[Concepts]] already describes: an [[Event]] source wakes on a folder, two [[Actor]]s take part in a shared [[Context]], a [[Command]] runs deterministic work, and the result comes back to the run that asked for it. `scripts/prove-docs-pipeline.mjs` runs this for real against a live bus, bridge, and model — this page walks the same steps and is honest about which of them still expose old storage vocabulary.

The terminal is still the headless route. Today the broader substrate steps below are real calls against the [[Bus API]] on `http://localhost:5377`.

## 1. Register and select the workspace

```bash
curl -X POST http://localhost:5377/v1/workspaces/register \
  -H "content-type: application/json" \
  -d '{"locator": "C:/path/to/floe", "init_authorized": true}'
# -> { "workspace": { "workspace_id": "..." } }

curl -X POST http://localhost:5377/v1/workspaces/$WORKSPACE_ID/select
```

## 2. Give the actors a generic identity

The pipeline needs three [[Actor]]s: `writer`, `reviewer`, `approver`. Each one needs a generic `.floe/agents/<name>.md` identity file — the real task lives on the [[Node]], not the actor, so these files say nothing about documentation:

```
# writer

Follow the instructions bound to whichever node you are acting as in the active scope.
```

Write one for each of `writer`, `reviewer`, `approver`. There's no API to create these — the bridge discovers `.floe/agents/*.md` at workspace attach. This is the file-based part of the model: what an actor *is* lives in git; what it's *doing right now* is bound per-node.

## 3. Bind a model and auth profile

```bash
curl -X POST http://localhost:5377/v1/runtime/bindings \
  -H "content-type: application/json" \
  -d '{
    "scope": "workspace_default",
    "workspace_id": "'"$WORKSPACE_ID"'",
    "auth_profile": "your-profile",
    "model": "gpt-5-mini",
    "thinking_level": "medium"
  }'
```

Then poll until the actors' [[Endpoint]]s exist and are idle:

```bash
curl http://localhost:5377/v1/workspaces/$WORKSPACE_ID/endpoints
```

## 4. Create the scope

```bash
curl -X POST http://localhost:5377/v1/workspaces/$WORKSPACE_ID/scopes \
  -H "content-type: application/json" \
  -d '{"scope_id": "docs-repro", "title": "Documentation pipeline (reproduction)"}'
```

This is the scope the four pieces of work below are placed on. There's no separate graph primitive — "graph" is only the current storage vocabulary for what's placed on a scope.

## 5. Place and connect the nodes

One call creates all four nodes and their wiring at once:

```bash
curl -X POST http://localhost:5377/v1/workspaces/$WORKSPACE_ID/scopes/docs-repro/graphs \
  -H "content-type: application/json" \
  -d '{
    "nodes": [
      { "node_id": "note_arrived", "kind": "trigger", "event_type": "docs.note.landed" },
      { "node_id": "writer_node", "kind": "actor", "endpoint_id": "'"$WRITER_ID"'",
        "event_types": ["docs.note.landed"],
        "bindings": [{ "kind": "instructions", "text": "Draft the requested doc, then emit it to the reviewer." }] },
      { "node_id": "reviewer_node", "kind": "actor", "endpoint_id": "'"$REVIEWER_ID"'",
        "event_types": [],
        "bindings": [{ "kind": "instructions", "text": "Critique the draft; when approved, emit review.approved to the checker." }] },
      { "node_id": "check_node", "kind": "command", "endpoint_id": "'"$CHECKER_ID"'",
        "event_types": ["review.approved"], "result_event_type": "command.result",
        "command": "npx vitest run floe-bus/src/docs-structure.test.ts",
        "outputs": [
          { "name": "passed", "from": "passed" },
          { "name": "exit_code", "from": "exit_code" }
        ] },
      { "node_id": "approver_node", "kind": "actor", "endpoint_id": "'"$APPROVER_ID"'",
        "event_types": ["command.result"],
        "bindings": [{ "kind": "instructions", "text": "If passed, write the approved file." }] }
    ]
  }'
# -> { "graph": { "graph_id": "...", "context_id": "..." } }
```

`note_arrived`'s `kind` is stored as `"trigger"` in the substrate today — write and think of it as an [[Event]] with a folder source; the stored field name hasn't caught up (see [[Node]]).

The reviewer is deliberately **not** subscribed to `docs.note.landed` (`event_types: []`) — it's only woken by the writer's direct `emit`, never by the folder event's fan-out. This matters: on some platforms a single file arrival can fire the watcher twice, and a reviewer subscribed to the fan-out would start two parallel conversations.

## 6. Wire the folder source

There is **no API to register this folder source.** The reproduction script hand-edits `.floe/floe.yaml` directly:

```yaml
watchers:
  - id: docs_repro_watcher
    graph_id: <graph_id from step 5>
    node_id: note_arrived
    path: .floe/inbox/docs-notes
```

Then re-post the runtime binding from step 3 to make the bridge re-attach and pick up the new folder source (`floe-bridge/src/daemon.ts`, `attachWorkspace`). This is the one step in the pipeline with no clean interface — flagging it rather than papering over it.

## 7. Drop the note and watch it run

```bash
mkdir -p .floe/inbox/docs-notes
echo "# Note: document the build picker tool" > .floe/inbox/docs-notes/note.md
```

The folder source fires the `note_arrived` event. The writer wakes, drafts, and emits to the reviewer inside the [[Context]] created in step 5. They argue back and forth. Once approved, the reviewer emits `review.approved` to the check node.

Watch it happen by reading the context's events:

```bash
curl http://localhost:5377/v1/contexts/$CONTEXT_ID/events
```

## 8. The command runs, and the result returns to the run

The check node runs `npx vitest run floe-bus/src/docs-structure.test.ts` for real and broadcasts `command.result` back into the same context. This is the point the model proves itself: the command node is one declaration, but its result comes back to *this run* — the context created for this particular note — not to some global "last result" slot. Run the same pipeline on five notes at once and each gets its own result, because each call is scoped to the context that made it (see [[Command]]).

## 9. The approver writes the file

Woken by `command.result`, the approver reads the whole context — the writer's draft, the reviewer's approval, the check's `passed: true` — and writes the file with the `write` tool. The pipeline is done: a real file exists on disk, produced entirely through [[Event]], [[Context]], [[Actor]] and [[Command]], with no code written specifically for "documentation."

## Verify

```bash
npx vitest run floe-bus/src/docs-structure.test.ts
```

If it passes with the new file present, the pipeline is proven end to end.

## Cleanup

```powershell
git checkout -- .floe/floe.yaml
Remove-Item .floe/agents/writer.md, .floe/agents/reviewer.md, .floe/agents/approver.md
Remove-Item .floe/inbox -Recurse -Force
```

See [[Glossary]].

## Implementation

- `scripts/prove-docs-pipeline.mjs` — the real, runnable reproduction this page walks
- `docs/plans/documentation-pipeline-e2e-reproduction.md` — prerequisites, the Windows double-fire quirk, and the context-id bug found and fixed while first proving this
- `floe-bus/src/scope-graphs.ts` — current node/storage vocabulary (`trigger`, `actor`, `command`) and the graph/scope storage
- `floe-bridge/src/folder-watcher.ts` — the folder source implementation
- `floe-bridge/src/daemon.ts` — `attachWorkspace`, source registration from `.floe/floe.yaml`, `handleCommandDelivery`
- `floe-bridge/src/command-runner.ts` — command input resolution and execution
- `POST /v1/workspaces/register`, `POST /v1/workspaces/:id/select`, `POST /v1/runtime/bindings`, `GET /v1/workspaces/:id/endpoints`, `POST /v1/workspaces/:id/scopes`, `POST /v1/workspaces/:id/scopes/:scope_id/graphs`, `GET /v1/contexts/:id/events` — `floe-bus/src/server.ts`
- No API for registering this folder source — hand-edit `.floe/floe.yaml` and re-attach. Not built yet.
