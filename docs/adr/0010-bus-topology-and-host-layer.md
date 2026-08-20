# ADR-0010: One bus per workspace and the host layer

**Status:** accepted (2026-08-10)

## The decision

One bus per workspace, each owning its own ledger. A thin machine-level layer — the **host** — provides shared stateless capabilities: credentials, a workspace list, and a port map. The host is a directory of files, not a daemon.

The application is a viewer holding N connections (one per workspace), not a client of one aggregator.

## Why one bus per workspace

The distinction that decides this: sharing a capability is fine, sharing a memory is not. Credentials, a model adapter, compute — these are stateless; two independent workspaces using the same provider credential are not coupled. The ledger is where identity and history live; two workspaces sharing one bus with one memory are no longer independent.

The bus today is both switchboard and filing cabinet. Separating those makes workspace independence structural rather than a discipline maintained by scoping every query and broadcast.

## Rejected alternatives

**One memory-less bus attaching to per-workspace ledgers.** Also works, but makes independence a discipline rather than a structure: every new query and every new broadcast has to remember to scope itself, forever. With one bus per workspace there is no shared channel to scope. The coupling mistake becomes unavailable rather than merely discouraged.

**A central communication layer.** A machine-level service that knows how to talk to every bus in order to present one interface was rejected. It reintroduces a shared channel in a new form, and it would be the only component with legitimate reach into every workspace's memory — the single place where the boundary erodes, and the erosion would arrive as a reasonable feature request every time.

## The host layer

The machine layer holds credentials, the workspace list, and a port map. Files on disk. Each workspace's runtime reads what it needs at start. Nothing machine-wide runs, so there is nothing machine-wide to restart, compromise, or grow features into.

This works because everything shared is a stateless capability. A credential is a fact in a file; it does not need a service to hand it out.

**Do not call this layer the substrate.** Call it the host, or machine configuration. If it is named substrate, things will migrate into it, because the name grants permission.

**The test for any machine-level component:** does it ever hold or interpret an event? If yes, it owns memory, and memory is per workspace — it does not belong in the host. If it only forwards addressed traffic without inspecting it, that is plumbing and is acceptable.

## The application as viewer

The app holds N connections, one per opened workspace. Fan-in happens in the window, not in a service. The distinction is architectural, not visual: a viewer holding N connections versus a client of one aggregator holding N connections. Visually identical, architecturally opposite.

The app can exist without a bus. On a new machine the user installs and opens the app, is taken through onboarding that installs and configures floe, and then loads their first workspace with the default actor. Onboarding is what creates the host directory.

## Lifecycle

Starting a workspace must be a capability the application calls, not one the application uniquely has. The same command must be available to the app, to a boot sequence, and to a service manager. This keeps the bus startable without the GUI present (servers, start-on-boot configurations).

## Do not split bus from log

The database is the log — indexes over an append-only sequence. A separate log file alongside it means two records of the same truth and a permanent question about which is authoritative.

---

Recorded from [#148](https://github.com/floe-ai/floe-subtrate/issues/148). Cited as ADR-0009 in that ticket's resolution; see the numbering correction in [ADR-0009](0009-ledger-location-and-durability.md).
