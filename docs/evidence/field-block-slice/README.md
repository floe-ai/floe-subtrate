# Field block slice live closeout evidence

Live pass git SHA: `162f03fd949b75869d53e880ac965f3bc293ef0f`
Workspace fixture: `examples\sample-project`
Runtime provider/model: `github-copilot/gpt-4.1` (profile id and credentials redacted)

## Artefacts

- `screenshots/01-floeweb-empty.png`
- `screenshots/02-field-created.png`
- `screenshots/03-actor-item-added.png`
- `screenshots/04-layout-saved.png`
- `screenshots/05-chat-actor-inspect.png`
- `screenshots/06-chat-actor-edit.png`
- `screenshots/07-floeweb-rerendered-after-actor-edit.png`
- `screenshots/08-floeweb-stopped.png`
- `screenshots/09-external-yaml-edited.png`
- `screenshots/10-floeweb-restarted-shows-edit.png`
- `transcript.txt` - operator prompts, model replies, and read/edit tool telemetry.
- `file-diffs.md` - Field semantic/layout YAML evidence at each step.
- `bus-log-excerpts.md` - raw `field.upserted` event-stream excerpts from the real bus.
- `stop-restart-check.md` - stop/edit/restart proof steps.
- `test-runs.md` - automated preflight and regression results.

## Acceptance checklist

| Criterion | Evidence |
| --- | --- |
| FloeWeb attaches `examples\sample-project` and starts with no Field cards for this proof field | `screenshots/01-floeweb-empty.png` |
| FloeWeb creates Field `inbound-pr-review` through the bus API and writes `floe.field.v1` YAML | `screenshots/02-field-created.png`, `file-diffs.md`, `bus-log-excerpts.md` source=api changed=semantic |
| FloeWeb adds a Floe Actor Item using the existing picker | `screenshots/03-actor-item-added.png`, `file-diffs.md` |
| React Flow move writes only `.layout.floeweb.yaml`, preserving semantic bytes and mtime | `screenshots/04-layout-saved.png`, `file-diffs.md` |
| Runtime-backed Floe actor inspects the Field via ordinary `read` tool | `screenshots/05-chat-actor-inspect.png`, `transcript.txt` |
| Runtime-backed Floe actor edits the Field via ordinary `edit` tool; no Field-specific tool is used | `screenshots/06-chat-actor-edit.png`, `transcript.txt`, `file-diffs.md` |
| Bus watcher observes actor edit and FloeWeb re-renders without manual refresh | `screenshots/07-floeweb-rerendered-after-actor-edit.png`, `bus-log-excerpts.md` source=watcher changed=semantic |
| Stopping FloeWeb, externally editing YAML, and restarting rehydrates the Field from disk/bus state | `screenshots/08-floeweb-stopped.png`, `screenshots/09-external-yaml-edited.png`, `screenshots/10-floeweb-restarted-shows-edit.png`, `stop-restart-check.md` |
| Automated suites and build are green on the live-pass commit | `test-runs.md` |
| ROADMAP §2 can now move from required first slice to first slice complete | This evidence package plus the companion `docs\ROADMAP.md` update |
