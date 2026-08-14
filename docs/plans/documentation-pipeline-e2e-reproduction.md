# Documentation pipeline — end-to-end reproduction

Status: Reference / regression check

## What this proves

[Wayfinder ticket #157](https://github.com/floe-ai/floe-subtrate/issues/157) ("The documentation
pipeline runs end to end"), a child of map
[#153](https://github.com/floe-ai/floe-subtrate/issues/153), asked floe to compose and run its own
Scope Graph using only existing primitives: a note lands in a watched folder, a Writer and Reviewer
actor argue over a draft in one Context, a deterministic command node runs one of this repo's own
tests, and an Approver actor writes the file once the check passes.

This was built and run for real against a live bus + bridge and a real LLM. `scripts/prove-docs-pipeline.mjs`
reproduces that run. It is **not** a CI test — it drives the real substrate with a real auth
profile and a real model, so it is meant to be run manually whenever this pipeline's behaviour
needs re-checking (e.g. after touching scope graphs, node bindings, command nodes, or context
resolution).

## What it wires up (no new primitives)

- `note_arrived` — a trigger node, fired by the folder watcher.
- `writer_node` — an actor, woken by the trigger, drafts a Markdown file under `docs/plans/` and
  emits it **directly** to the Reviewer (`emit` always addresses a specific endpoint — there is no
  context fan-out for ordinary actor-to-actor messages).
- `reviewer_node` — an actor, **not** subscribed to the trigger's fan-out (`event_types: []`, so it
  is only ever woken by the Writer's direct emit, never by the trigger firing a second time — see
  "Known quirk" below). Argues back and forth with the Writer, then emits `review.approved`
  directly to the command node.
- `check_node` — a **command** node (not an actor): runs `npx vitest run floe-bus/src/docs-structure.test.ts`
  for real and broadcasts `command.result` into the graph's shared Context.
- `approver_node` — an actor, subscribed to `command.result` via the graph's Context. Sees the
  whole thread (Writer's draft, Reviewer's approval, the command result) and, if the check passed,
  writes the file with the `write` tool.

Each actor node's operational instructions are attached via the **node instructions binding**
mechanism (a generalisation of [#142](https://github.com/floe-ai/floe-subtrate/issues/142)) — the
`.floe/agents/*.md` identity files stay generic; the graph node carries the real task.

## Prerequisites

- `floe start` running against your real `~/.floe/config.yaml`, with a working auth profile (this
  repo's proving run used the `atvi-copilot` profile and `gpt-5-mini`, medium thinking).
- Run from the repo root, in a checkout registered as a floe workspace.

## Running it

```powershell
node scripts/prove-docs-pipeline.mjs
```

Override the auth profile / model via environment variables if needed:

```powershell
$env:FLOE_AUTH_PROFILE = "your-profile"
$env:FLOE_MODEL = "gpt-5-mini"
$env:FLOE_THINKING_LEVEL = "medium"
node scripts/prove-docs-pipeline.mjs
```

The script:
1. Registers this repo as a workspace and sets the runtime binding.
2. Writes scratch `.floe/agents/writer.md`, `reviewer.md`, `approver.md` (generic identity files)
   and authors a fresh Scope Graph under a `docs-repro` scope.
3. Adds a temporary `watchers:` entry to `.floe/floe.yaml` pointing at that graph, and re-attaches.
4. Drops a real note into `.floe/inbox/docs-notes/`.
5. Polls for `docs/plans/build-tool-guide.md` to appear (up to 5 minutes — this is a real LLM
   conversation, not a mock).
6. Runs `npx vitest run floe-bus/src/docs-structure.test.ts` and fails loudly if it doesn't pass
   with the generated file present.

Expected result: the script prints `Pipeline proven end to end.` and exits 0.

## Cleanup

The script does not delete what it created (so you can inspect the run first). Once done:

```powershell
git checkout -- .floe/floe.yaml
Remove-Item .floe/agents/writer.md, .floe/agents/reviewer.md, .floe/agents/approver.md
Remove-Item .floe/inbox -Recurse -Force
Remove-Item docs/plans/build-tool-guide.md
```

## Known quirk worth knowing before re-running this

On Windows, `fs.watch` (`floe-bridge/src/folder-watcher.ts`) commonly fires **twice** for a single
file creation (rename + change events both land). Combined with a Reviewer node that was
subscribed to the trigger's fan-out, this produced two parallel, interleaved Writer/Reviewer
conversations in one run. Keeping the Reviewer's `event_types: []` (as this script does — only
reachable by the Writer's direct emit, never by fan-out) avoids that; the double folder-watcher
fire itself does still occur but is a duplicate arrival "event", not a wiring bug — see the
folder-watcher's own doc comment. Not yet ticketed as its own roadblock; flagging here since it
will visibly double the LLM calls (and cost) if you drop more than one note per run.

## Bug found and fixed while first proving this

`floe-bridge/src/daemon.ts`'s `handleCommandDelivery` originally omitted the top-level `context_id`
on its `command.result` broadcast, so `resolveContext` (`floe-bus/src/contexts/resolver.ts`) never
recognised the intended context and minted a brand-new, single-participant context on every call —
silently breaking the Approver's ability to see the result via context fan-out. Fixed (added the
missing field); see [#164](https://github.com/floe-ai/floe-subtrate/issues/164).
