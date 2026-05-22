# ADR-0004: Scope as the substrate organising boundary

**Status:** accepted (2026-05-22)

Floe's earlier Field slice made `.floe/fields/<id>.yaml` own item membership and connections. That proved a useful canvas loop, but it also risked making Field files a second substrate beside actors, contexts, events, pulses, webhooks, extensions, files, tools, and work logs.

We now reserve **Scope** for the substrate-level organising boundary inside a Workspace. Scoped primitives declare or derive a `scope_id`; every Workspace has a Default Scope; and FloeWeb renders a Scope as a **Field**. A Field may have renderer-specific layout metadata, but layout and Field files must not determine membership. Relationships shown in a Field are derived from existing substrate relationships, and edits to those relationships must update the primitive that owns them.

The previous Pulse "scope" language is renamed to **Pulse Persistence**: workspace-backed versus local/runtime-backed storage for a Pulse definition. This avoids overloading Scope, which now means only the workspace organising boundary.

Consequences: ADR-0003 is superseded for future implementation direction; `.floe/blocks` remains rejected; Field Item and Field Connection are superseded terms for new work; the next slice must implement Scope/default-scope metadata and propagation in the substrate before more Field/Block parity work continues.
