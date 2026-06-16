# Tech Debt — removal queue

Per AGENTS.md "Project state: pre-release": zero tech-debt accumulation, no
migration paths. This file is a **removal queue**, not a parking lot. Entries are
scheduled deletions, not deferred maybe-laters — burn them down; do not let this
list grow.

## Migration / back-compat scaffolding in floe-bus

`floe-bus/src/store.ts` carries data-migration and backward-compatibility
machinery that the pre-release rule says we do not need (no external data, no
consumers — local dev databases can simply be recreated):

- `relaxEventScopeColumn()` and the `events_next` table rebuild
- `addColumnIfMissing()` calls and the `backfill*` methods
  (`backfillEventDestinationJson`, `backfillEventResponseJson`,
  `backfillEventScopeId`)
- legacy `NULLIF(scope_id, 'default')` / reserved-id cleanup paths
- the `is_default` `DROP INDEX` cleanup added during Slice 2

**Action:** collapse the schema to a single authoritative `CREATE TABLE` set and
delete the migration/backfill paths; recreate local databases rather than
migrate them.

**When:** after the three UI substrate gaps land, so the schema changes once,
cleanly — not piecemeal before. Recorded by operator decision 2026-06-14.

## Remove the `Thread` primitive (approved 2026-06-14)

`thread_id` is vestigial — "legacy field retained for storage compatibility
only; no new flow reads it." Contexts are the real stream primitive.

**Action:** remove `thread_id` from the events schema, `EventCommand`,
`submitEvent` (it currently writes the resolved `context_id` into `thread_id` to
satisfy a NOT NULL constraint), `pending_responses`, and the `thread_affine`
response mode. Bundle with the schema-collapse above so the events table is
rewritten once.

