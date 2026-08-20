# ADR-0011: Workspace identity and person identity

**Status:** accepted (2026-08-10)

## The decision

A workspace is identified by an identifier stored inside the workspace. Path is demoted from identity to a lookup hint. A person is a claim carried in, not a shared identity record.

## Workspace identity

Today a workspace is identified by its absolute folder path (`workspaces.locator`), which means it can only ever exist where it currently sits — it cannot be hosted elsewhere, moved, or reached by a second machine, because its name is its location. This is the same defect as welding workspace and role into an actor identity.

Once the identifier lives inside the workspace:

- Moving a folder keeps the same workspace.
- The ledger can live anywhere and clients find it rather than assume it.
- A clone on another machine becomes a client of the same ledger home, not a new workspace.

## One home, many clients

A workspace's ledger has one home. Everything else is a client of it. Local-only today means the home is this machine. A server later means a laptop and a desktop are both clients of the same ledger. One writer, no sync, no divergence.

This dissolves the multi-machine synchronisation problem rather than deferring it. An append-only log with a total order has exactly one writer by definition; two writers means two divergent pasts. So there are never two writers. Migration becomes "move the home and repoint the clients."

## Person identity

The same human can hold the same actor identifier across several workspaces while those workspaces know nothing of each other. Identity is a claim carried in, not a record those workspaces share. The same identifier is asserted in both; neither needs a directory of the other's people.

Each workspace records that actor's activity under its own qualified reference, independently. Seeing everything one person did across projects is served by the application reading across ledgers — the viewer pattern from ADR-0010 — not by a shared identity registry.

This is the same shape as the workspace identifier: a name carried, not a location occupied.

---

Recorded from [#148](https://github.com/floe-ai/floe-subtrate/issues/148). Cited as ADR-0010 in that ticket's resolution; see the numbering correction in [ADR-0009](0009-ledger-location-and-durability.md).
