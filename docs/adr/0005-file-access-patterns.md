# ADR-0005: File Access Patterns in the Floe Ecosystem

**Status:** accepted (2026-06-19)

As Floe evolves from a browser-based frontend (`floe-web`) to a desktop-native application (`floe-app`), managing how files are read and written across the local disk, the daemon (`floe-bus`), and autonomous agents is a critical security and architectural concern. 

Exposing generic file-writing endpoints over standard HTTP daemon routes can lead to severe security vectors, such as remote directory traversal or unauthorized profile modification. A clear, first-principles policy must define file-system boundaries for every role in the ecosystem.

## Decisions

### 1. Human Operator via Local Desktop App (`floe-app`)
All human-initiated file reads and writes for configuration (such as global auth profiles `profiles.yaml` or credentials `auth.json`) **must** go through the secure **Tauri IPC (Inter-Process Communication) boundary**.
* The desktop application's native Rust layer handles all direct filesystem I/O, utilizing the logged-in user's native system privileges.
* This bypass-routes the daemon (`floe-bus`) completely for local configuration, ensuring that credential secrets are never transmitted over local network ports.

### 2. Autonomous Agent via Daemon (`floe-bus`)
File-system writes initiated by an agent (as part of `tool_code` or workspace actions) **may** write directly to the local disk, provided they are sandboxed and gated by the daemon.
* The daemon is the ultimate supervisor and gatekeeper.
* Agent file writes are restricted purely to paths contained within the authorized workspace `locator` directory. Traversal or access to paths outside the workspace boundary is strictly prohibited.

### 3. Human Operator via Remote Client (`floe-web` / Remote Console)
Direct file-system writing or credential editing via generic, unauthenticated HTTP daemon endpoints is **prohibited**.
* Allowing remote web clients to write directly to the host machine's configuration files via raw REST endpoints opens unsafe remote execution vulnerabilities.
* Securing remote human operations remains a known-unsolved problem and must be addressed in a future design phase. This may involve:
  * Git-based configuration synchronization (e.g. committing and pushing workspace updates).
  * A virtualized, permissioned filesystem abstraction served over TLS.
  * Encrypted, signed cryptographic payloads verified by the daemon.

---

## Consequences

* **Stable Core Daemon**: The core `floe-bus` daemon remains completely stable, decoupled, and free of any bloated front-end configuration handlers.
* **Improved Local Security**: Global credentials and profiles on the host machine are written securely inside native Tauri Rust code, protecting API keys from exposure to network boundaries.
* **Architectural Clarity**: The team has a permanent reference pattern distinguishing the capabilities and boundaries of humans vs. agents and local vs. remote sessions.
