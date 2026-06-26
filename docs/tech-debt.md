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

## Remove `migrateWebToApp` config shim

`floe-bus/src/config.ts`, `floe-bridge/src/config.ts`, and `floe-cli/src/config.ts`
each contain a `migrateWebToApp()` function that rewrites on-disk configs still
using the old `web:` / `services.start_web` keys (from before the `app:` rename
in PR #62). The shim is idempotent and becomes a no-op after the first run, but
it is back-compat migration scaffolding that the pre-release rule says we do not
need.

**Action:** once enough time has passed that no local installs carry the old
format, delete `migrateWebToApp` from all three config files and remove the
matching migration tests in `floe-bus/src/config-migration.test.ts` and
`floe-bridge/src/config-migration.test.ts`.

## Remove the `Thread` primitive (approved 2026-06-14)

`thread_id` is vestigial — "legacy field retained for storage compatibility
only; no new flow reads it." Contexts are the real stream primitive.

**Action:** remove `thread_id` from the events schema, `EventCommand`,
`submitEvent` (it currently writes the resolved `context_id` into `thread_id` to
satisfy a NOT NULL constraint), `pending_responses`, and the `thread_affine`
response mode. Bundle with the schema-collapse above so the events table is
rewritten once.

