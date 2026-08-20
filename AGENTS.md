# Working rules

Read `MISSION.md` for why this exists, `CONTEXT.md` for what the words mean, and `docs/adr/` for what has been decided. This file holds only what those cannot tell you and the code cannot show you.

> **This file is an experiment (2026-08-20).** It was 639 lines, then 310, now this. Everything removed was either duplicated from a skill, restated from `MISSION.md`, derivable by running the code, or generic practice worth no tokens. If you find yourself guessing at something a deleted section would have told you, **say so and put it back with the evidence.** Do not restore anything on the grounds that it sounds useful.

---

## How work proceeds

**Build to learn. Grill what exists.**

A question about something that already runs is worth asking — the answer is checkable. A question about something that does not exist yet is a guess, and guesses compound: enough in a row and the thing gets built on a chain of theory nobody tested. When a question cannot be settled by discussion, build the smallest thing that answers it rather than discussing it harder.

Deliver end-to-end vertical slices. Prefer the smallest change that achieves the outcome. Avoid horizontal plumbing, speculative abstraction, and unrelated improvement. Plan in proportion to what you do not know.

Nothing is complete until its tests pass and the documentation it invalidated is corrected in the same change.

---

## Project state: pre-release

Nothing depends on this repository yet. There are no external consumers and no production data.

- **No backward compatibility.** Do not keep old code, schemas, or APIs working for their own sake. When a shape is wrong, change it outright.
- **No migration paths.** No data migrations, compatibility shims, dual-read/dual-write, or deprecation cycles. Replace the old thing and delete it.
- **Config is not migrated.** `~/.floe/config.yaml` follows the current schema only. An incompatible config fails fast — never migrate it. Delete the config file and re-run setup:

  ```bash
  rm ~/.floe/config.yaml   # deletes only the config file
  floe setup
  ```

  A full factory reset — `rm -rf ~/.floe` — also destroys event history, credentials, logs, skills and extensions. It is not the default fix for a config problem. Credentials (`~/.floe/auth/`) are the only data that must survive a maintenance action.
- **Zero tech-debt accumulation.** If a change would add debt "to clean up later", do the clean version now or stop and flag it — "later" does not exist here.

This licenses deletion and replacement. It does **not** license sloppiness: the bar is *higher*, because there is no legacy excuse for mess.

---

## Evaluate, don't inherit

The repository records past decisions; it is not proof they were right.

- Judge an area's existing approach against first principles, `CONTEXT.md` and `MISSION.md` — do not adopt a pattern merely because it is present.
- If the surrounding convention is sound, match it. If it is poor, fix it within scope or flag it — never propagate it silently.
- Code is authoritative for *what the system currently does*, never for *what it should do*.

---

## Source of Truth

Resolve conflicts in this order:

1. Current code and runtime behaviour
2. Tests and logs
3. Repository documentation and ADRs
4. Prior assumptions or memory

Within repository documentation:

1. **Canonical** — `MISSION.md`, `CONTEXT.md` (terminology and invariants), `PRODUCT.md`, and accepted ADRs in `docs/adr/`. Where a newer ADR corrects an older statement, the correction governs.
2. **Working** — PRDs and open plans in `docs/plans/`. Direction as of when written. Where they conflict with a canonical doc, the canonical doc wins. Never edit a canonical doc to match a working doc.
3. **Historical** — worklogs, evidence, QA artifacts, implementation reviews, closed plans, and **issue, PR and map prose**. Point-in-time records; never treat them as current, and never rewrite them to match the present.

**A decision is canonical when it is in an ADR or `CONTEXT.md` — not when a ticket says it was accepted.** If a ticket claims a decision no committed document carries, it has not landed: say so rather than acting on it.

New knowledge routes into living documents; do not create new Markdown files by default:

- Terminology, definitions, invariants → edit `CONTEXT.md` in place.
- Lasting decisions → a new ADR in `docs/adr/` (append-only, `NNNN-kebab-slug.md`).
- Slice plans → `docs/plans/`; disposable — delete once executed.
- Retiring a term → `CONTEXT.md` `_Avoid_` list AND a rule in `floe-bus/src/docs-vocabulary.test.ts`, in the same change as the code that retires it — never ahead of it, or the lint bans vocabulary the code still legitimately uses.
- Anything else needs operator approval; `floe-bus/src/docs-structure.test.ts` fails on unregistered standing documents.

Surface conflicts immediately. Never silently resolve a contradiction.

---

## Standing substrate invariants

Prohibitions, not descriptions — absence cannot be read off the code, which is why these are written down and the rest is not.

- **The substrate is push-only.** No recurring polling anywhere: no reconcile timers, no liveness pings, no interval scans. Delivery rides the bridge↔bus WebSocket; recovery is a one-shot resync on reconnect; lease expiry uses a single scheduled timer.
- **A turn is built from exactly one context** — the delivery's origin context. No bleed from any other.
- **A session is ephemeral and per (actor, context).** Never persisted. A restart is a cold start, and that is safe by design. No count cap and no LRU — any cap would be an arbitrary number.
- **Tool calls and results are private.** A context carries outputs, not scratch. Backfill is lossy on purpose.
- **`.floe/floe.yaml` is human-authored, committed project config — read-only at runtime.** Bundled and extension agents register in memory from the loaded manifest. After a clean boot, `git status --porcelain` in the workspace must be empty.
- **There is no human/agent distinction anywhere.** No `actor_kind`, no stored backing label; delivery is gated on runtime attachment. A peer cannot tell what backs an actor, and no surface may reveal it.
- **Extensions are independent repositories** building against the substrate contract (ADR-0006). They are not vendored here.
- **`npm run build`** (`scripts/build.mjs`) is a developer tool, never a product feature: no `build` command in `floe-cli`, no Tauri build in the picker, and no new dependencies.
