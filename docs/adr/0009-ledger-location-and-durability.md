# ADR-0009: Ledger location and durability tiers

**Status:** accepted (2026-08-10)

## The decision

The canonical event ledger is per workspace, lives outside the git checkout, and never enters version control. The existing single machine-global database is deleted, not migrated.

Two things that sound like one, both settled:

- **Partitioning.** One ledger per workspace. Never one shared file holding several workspaces.
- **Location.** The ledger lives outside the git checkout — not committed, and not inside the working tree even as an ignored file. The checkout is the folder designed to be wiped (`git clean` removes ignored files; a server deploy re-clones), so the permanent record cannot live there.

## Why the ledger cannot live in git

A repository is designed to exist as many simultaneous copies — clones, branches, worktrees, a fresh checkout on a server. A ledger is a single authoritative past. Anything that can legitimately exist in several copies at once cannot hold a single authoritative past, so the two cannot share a container.

Branching as experiment survives this: two experimental paths are two lanes inside one append-only ledger. Recording both is strictly better than keeping two separate ledgers, because the paths stay comparable and a losing lane leaves its evidence behind. A discarded git branch takes its evidence with it.

The disqualifying case is two branches both advancing from a branch point and then merging. That is not a merge conflict — it is two incompatible pasts, and nothing resolves it. Additionally: a binary database has no three-way merge, git stores near-full copies of a growing binary on every commit, a commit taken while the write-ahead log is active captures an inconsistent snapshot, and a tracked ledger dirties the tree on every event, breaking the clean-boot invariant.

The general principle: git holds the things that must be versioned, and never the thing that must never fork.

## Durability tiers

Durable and portable are separate axes. Three tiers:

1. **Travels with the repository** — configuration, actors, their instructions, roles, skills, decisions, and distilled evidence. Text: reviewable, diffable, committed. Clone on a new machine and the setup arrives.
2. **Machine-held, one per workspace** — the event ledger. Does not travel. Never deleted in production.
3. **Machine-held, shared across workspaces** — provider credentials. One login, used everywhere.

Credentials are the only thing that must survive a maintenance action. The durable root sits outside the configuration root so that a configuration reset cannot reach it. This is structural, not a documentation fix — it stops resets forcing re-authentication.

## The ledger is disposable for now

A fresh checkout on a new machine behaves as day zero. There is very little accumulated evidence today, and buying durability now means paying for backup, export, and retention before the shape of the evidence is known.

What makes this safe is the distillation split: the ledger is the high-volume operational stream — replayable, regenerable, outside the checkout, throwable — and anything that must survive is derived out of it into committed text in the workspace (decisions, what was tried, what failed, what changed and what happened to the result). Those travel, diff, review in a pull request, and survive any reset.

**Standing condition: nothing may exist only in the ledger.** The moment a decision, a lesson, or a piece of evidence lives nowhere but the database, the database has silently stopped being disposable — and that will not be noticed until it is wiped. Distillation must be a habit before it is a feature.

**Revisit signal:** the day wiping the ledger causes hesitation, distillation is not keeping up. That signal is more trustworthy than any date guessed now.

## Development versus production

During development, anything can be deleted — obliteration is permitted and useful. In production, nothing is disposed of and there is no reset command. A user wanting a clean start uninstalls or deletes the configuration folder by hand.

---

Recorded from [#148](https://github.com/floe-ai/floe-subtrate/issues/148), landing decisions from [#137](https://github.com/floe-ai/floe-subtrate/issues/137), [#139](https://github.com/floe-ai/floe-subtrate/issues/139) and [#140](https://github.com/floe-ai/floe-subtrate/issues/140).

**Numbering correction.** #148's resolution comment, and map [#153](https://github.com/floe-ai/floe-subtrate/issues/153)'s inherited-constraints list, cite this decision as ADR-0008 and its siblings as 0009 and 0010. Those files were written on a branch that was never merged, and 0008 was taken in the meantime by [ADR-0008: Event is the primitive](0008-event-is-the-primitive.md). This decision is **ADR-0009**, bus topology is **ADR-0010**, and identity is **ADR-0011**. The earlier citations are off by one.
