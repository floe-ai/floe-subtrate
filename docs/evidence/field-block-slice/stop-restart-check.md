# Stop, external edit, restart check

1. Stopped the real Vite/FloeWeb preview process on `http://127.0.0.1:52700`. Evidence: `screenshots/08-floeweb-stopped.png`.
2. Edited `examples\sample-project\.floe\fields\inbound-pr-review.yaml` outside FloeWeb while the bus watcher was still running.
3. The edit changed the title to `Inbound PR Review - external edit` and added connection `actor-to-inbox-external` from `actor-floe` to `context-inbox`. Evidence: `screenshots/09-external-yaml-edited.png` and `file-diffs.md`.
4. Observed a real `field.upserted` event with `source: "watcher"` and `changed: "semantic"` in `bus-log-excerpts.md`.
5. Restarted FloeWeb and reopened the sample workspace. FloeWeb rehydrated from the bus/disk state and rendered the edited Field title plus the connection. Evidence: `screenshots/10-floeweb-restarted-shows-edit.png`.
