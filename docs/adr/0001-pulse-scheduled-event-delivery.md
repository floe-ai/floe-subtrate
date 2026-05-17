# ADR-0001: Pulse as unified scheduled event creation

## Status
Accepted

## Context
The Floe substrate needs a scheduling mechanism for recurring and one-off event delivery (reminders, periodic agent wake-ups, scheduled checks). The north-star defined pulse as "optional bus-owned scheduling" with idle-time-based triggers. The extension/pulse PRD expanded pulse to include clock-scheduled events created by agents.

Two competing models existed:
1. **Idle-based pulse** (north-star §9): fire after endpoint idle time, extension-defined meaning
2. **Scheduled pulse** (PRD §4-5): agent-created, clock-scheduled, CRUD-managed

We also needed to decide on storage, timer mechanism, and delivery model.

## Decision

### Unified pulse primitive
Pulse is a single bus-owned scheduled event creation primitive. For this implementation, only scheduled triggers (cron, one-off) are built. Idle-based pulse is deferred as a separate lifecycle concern.

### Portable definitions, ephemeral runtime state
- **Pulse definitions** are stored in `.floe/floe.yaml` under a `pulses:` array — committed, portable with the workspace.
- **Pulse runtime state** (next fire time, last fired) is stored in bus SQLite — local, ephemeral, rebuilt on workspace attachment.

This mirrors the agent model: definitions in `.floe/`, runtime state in bus.

### Event-driven scheduler (not polling)
The bus uses a priority queue sorted by `next_fire_at` with a single active `setTimeout` pointing at the nearest upcoming pulse. No polling interval. Zero CPU cost when no pulses are approaching. Recalculates on CRUD operations and process restart.

Rejected alternative: `setInterval` polling loop — inconsistent with the subscription/push model used elsewhere in Floe.

### Subscriber model
Each pulse has a subscriber list. When a pulse fires, it creates the canonical `pulse.fired` event for each subscriber. The subscriber kind determines what happens next:

- A context subscriber appends `pulse.fired` to that context for rendering only. It does not create endpoint delivery or activate an actor.
- An endpoint subscriber delivers `pulse.fired` to that endpoint, optionally scoped to a context. Endpoint delivery may activate only if the endpoint has a processor.
- Future subscriber kinds can target blocks, fields, extension handlers, or external integrations without changing the pulse event type.

### No synthetic system actor
Pulse events have `source_endpoint_id: null`. The pulse_id and creator are carried in event metadata. No synthetic system actor or endpoint is introduced as a participant.

### Context association
Context subscribers write into the supplied context. Endpoint subscribers may carry a context_id so actor processing and any later explicit emit can stay associated with the originating context. A pulse firing alone is not an actor message.

## Consequences
- Agents get `create_pulse`, `list_pulses`, `update_pulse`, `cancel_pulse`, `subscribe_pulse`, `unsubscribe_pulse` tools
- Bus gains a `pulses` SQLite table and priority-queue scheduler
- Bridge reads pulse definitions from `.floe/floe.yaml` and registers them in bus during workspace attachment
- Bridge writes pulse definitions to `.floe/floe.yaml` when agents create pulses via tools
- Idle pulse and pending response timeout are explicitly deferred as separate concerns
- Simple reminders use context subscribers; scheduled actor work uses endpoint subscribers scoped to the originating context
