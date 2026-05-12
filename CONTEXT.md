# Floe Substrate — Domain Context

## Glossary

### Pulse
Bus-owned scheduled event emission. A pulse fires at a configured time and emits a `pulse.fired` event through the normal event/delivery path to all subscribers. Pulse is NOT heartbeat, keepalive, runtime wait-refresh, or agent-owned timing. The bus schedules pulse firing; it does not know what a pulse means to the recipient.

### Pulse Scope
Pulse supports two scopes:
- **workspace** — portable, stored in `.floe/floe.yaml` under `pulses:`. Committed with the repository. Workspace automation should use this scope.
- **local** — private/personal, stored in bus SQLite or `~/.floe` state. Personal reminders use this scope unless the user explicitly wants the pulse committed.

### Pulse Definition
A portable or local declaration of a scheduled pulse. Workspace-scoped definitions travel with the repository. Local-scoped definitions are private to the machine/user.

### Pulse Runtime State
Ephemeral scheduling state (next fire time, last fired, active/paused) stored in bus SQLite. Rebuilt from definitions on workspace attachment. Not portable — local to each bus instance.

### Scheduled Pulse
A pulse with a clock-based trigger: either a cron expression with timezone (recurring) or an ISO 8601 timestamp (one-off). Created by agents via `create_pulse` tool or declared in `.floe/floe.yaml`.

### Pulse Subscriber
An endpoint (or subscriber selector) that receives delivery of a pulse event when the pulse fires. A pulse maintains a subscriber list. Each subscriber gets an independent delivery lifecycle. Subscriber selectors leave room for richer addressing beyond endpoint IDs.

### Endpoint
An addressable participant/interface in the substrate. Humans, agents, webhooks, extensions, schedulers, and future actors are all endpoints. No endpoint type is privileged.

### Event
The communication primitive. All coordination passes through canonical events routed by the bus. A pulse firing produces an event like any other.

### Emit
The universal substrate publish operation. All endpoints use emit to create canonical events on the bus.

### Delivery
An event made available to a specific endpoint. The bus creates deliveries by resolving destination selectors. Each subscriber gets its own delivery lifecycle (independent ack/fail).

### Work Log
A committed Markdown activity record for human audit. Located at `.floe/agents/<agent_id>/worklogs/YYYY-MM-DD.md`. Runtime output and tool activity — NOT communication.

### Turn
An endpoint's processing cycle for delivered events. Turn end means "this endpoint has finished processing." It is NOT a message.

## Deferred Concepts

### Idle Pulse
An idle-time-based pulse that fires after an endpoint has been idle for a configured duration. Deferred — it is a lifecycle/keepalive concern, not scheduled event delivery. The config fields in `floe.yaml` (`pulse.after_idle`, `pulse.min_interval`) remain as declared schema but are not implemented.

### Pending Response Timeout
A timeout mechanism for stale `response.expected: true` states. Separate lifecycle concern from pulse. Agents wait indefinitely; timeouts are optional lifecycle management to be designed separately.
