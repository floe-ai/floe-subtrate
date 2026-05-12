# ADR-0001: Pulse as unified scheduled event delivery

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
Pulse is a single bus-owned scheduling primitive. For this implementation, only scheduled triggers (cron, one-off) are built. Idle-based pulse is deferred as a separate lifecycle concern.

### Portable definitions, ephemeral runtime state
- **Pulse definitions** are stored in `.floe/floe.yaml` under a `pulses:` array — committed, portable with the workspace.
- **Pulse runtime state** (next fire time, last fired) is stored in bus SQLite — local, ephemeral, rebuilt on workspace attachment.

This mirrors the agent model: definitions in `.floe/`, runtime state in bus.

### Event-driven scheduler (not polling)
The bus uses a priority queue sorted by `next_fire_at` with a single active `setTimeout` pointing at the nearest upcoming pulse. No polling interval. Zero CPU cost when no pulses are approaching. Recalculates on CRUD operations and process restart.

Rejected alternative: `setInterval` polling loop — inconsistent with the subscription/push model used elsewhere in Floe.

### Subscriber model
Each pulse has a subscriber list. When a pulse fires, it creates independent deliveries for each subscriber (like broadcast fan-out). Endpoints subscribe/unsubscribe via tools.

### system:pulse as source
Pulse events are emitted with `source_endpoint_id: "system:pulse"` — a synthetic system endpoint. The pulse_id and creator are carried in event metadata.

### New thread per fire
Each pulse fire creates a new thread (`pulse:<pulse_id>:<timestamp>`), keeping each execution independent and avoiding unbounded thread growth.

## Consequences
- Agents get `create_pulse`, `list_pulses`, `update_pulse`, `cancel_pulse`, `subscribe_pulse`, `unsubscribe_pulse` tools
- Bus gains a `pulses` SQLite table and priority-queue scheduler
- Bridge reads pulse definitions from `.floe/floe.yaml` and registers them in bus during workspace attachment
- Bridge writes pulse definitions to `.floe/floe.yaml` when agents create pulses via tools
- Idle pulse and pending response timeout are explicitly deferred as separate concerns
