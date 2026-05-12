# PRD: Pulse — Scheduled Event Delivery

## Status
Accepted — ready for implementation

## Problem Statement

Floe's substrate can process events through the full delivery lifecycle (emit → route → deliver → process → ack), but it has no mechanism for time-based event delivery. Users cannot schedule recurring automation ("check the backlog every morning") or one-off reminders ("remind me to check email in one minute"). Agents cannot create scheduled events without manual file editing. There is no scheduling infrastructure in the bus.

The substrate needs a bus-owned scheduling primitive that emits events at configured times through the normal delivery path, so that scheduled automation and reminders work exactly like any other event — no special handling, no extensions required.

## Solution

Introduce **Pulse** as a bus-owned scheduled event emission primitive. A pulse definition declares a schedule (cron or one-off), content, and subscriber list. When a pulse fires, the bus creates a canonical `pulse.fired` event and delivers it to each subscriber through the normal event/delivery path.

Pulse definitions support two scopes:
- **workspace** — stored in `.floe/floe.yaml`, committed and portable with the repository
- **local** — stored in bus SQLite, private to the user/machine

Agents get dedicated tools (`create_pulse`, `list_pulses`, `pause_pulse`, `resume_pulse`, `cancel_pulse`) to manage pulses without editing files.

The first live proof: user asks Floe "Schedule a reminder for me in one minute saying: check email." Floe uses `create_pulse`. The bus schedules it. After one minute, the bus emits `pulse.fired`. The human endpoint receives the reminder in FloeWeb. No extension required. No heartbeat/keepalive introduced.

## User Stories

1. As a human operator, I want to ask Floe to schedule a one-off reminder, so that I receive a notification at the scheduled time without setting up external tools.
2. As a human operator, I want to ask Floe to schedule a recurring daily reminder, so that I get a nudge at the same time every workday.
3. As an agent, I want to create a scheduled pulse that wakes another agent at a recurring time, so that automated work cycles happen on a schedule.
4. As a human operator, I want to list all active pulses in my workspace, so that I can see what is scheduled.
5. As a human operator, I want to pause a pulse without deleting it, so that I can temporarily stop a recurring schedule and resume it later.
6. As a human operator, I want to resume a paused pulse, so that the schedule restarts from where it was paused.
7. As a human operator, I want to cancel a pulse permanently, so that it stops firing and is removed.
8. As a workspace collaborator, I want workspace-scoped pulse definitions to be committed to the repository, so that when I check out the repo I get the same scheduled automation.
9. As a human operator, I want to create a personal/local pulse that is not committed to the repository, so that my private reminders don't pollute the shared workspace config.
10. As an agent processing a pulse event, I want to inspect, use tools, and produce work log entries without being required to emit a message, so that pulse-triggered work is recorded but does not generate noise.
11. As an agent processing a pulse event, I want to emit events only when communication or state publication is needed, so that I follow the substrate principle of explicit communication.
12. As a human operator, I want pulse events to appear in FloeWeb as delivered events, so that I can see scheduled reminders and pulse activity through the normal event view.
13. As a workspace collaborator, I want pulse definitions to include timezone information for recurring schedules, so that "every day at 9am" fires at 9am in the right timezone regardless of server location.
14. As a developer, I want each pulse fire to create an independent thread, so that daily pulse activity doesn't accumulate into one unbounded conversation thread.
15. As a developer, I want pulse events to have `source_endpoint_id: "system:pulse"`, so that pulse-generated events are clearly identifiable as system-scheduled, not sent by a specific actor.
16. As an agent, I want each subscriber to a pulse to get an independent delivery lifecycle, so that one subscriber failing doesn't block others.
17. As a developer, I want the bus to use an event-driven scheduler (priority queue + setTimeout), so that there is zero CPU cost when no pulses are approaching and no polling loops.
18. As a developer, I want pulse runtime state to be rebuilt from definitions on process restart, so that the scheduler recovers cleanly after bus restart.
19. As a developer, I want overdue pulses (missed during downtime) to fire immediately on restart, so that scheduled events are not silently lost.
20. As a developer, I want one-off pulses to be automatically removed after they fire, so that expired schedules don't accumulate.

## Implementation Decisions

### Pulse definition schema (in `.floe/floe.yaml`)

```yaml
pulses:
  - id: daily-email-check
    scope: workspace
    trigger:
      type: cron
      schedule: "0 15 * * *"
      timezone: "Australia/Sydney"
    content:
      text: "Check email"
    subscribers:
      - endpoint_ref: "user:operator"
```

```yaml
pulses:
  - id: one-minute-reminder
    scope: local
    trigger:
      type: once
      at: "2026-05-12T15:40:00+10:00"
    content:
      text: "Check email"
    subscribers:
      - endpoint_ref: "user:operator"
```

### Bus SQLite schema

- `pulses` table: `pulse_id`, `workspace_id`, `scope` (workspace|local), `trigger_json`, `content_json`, `status` (active|paused|cancelled|completed), `created_by`, `created_at`, `updated_at`, `next_fire_at`, `last_fired_at`
- `pulse_subscribers` table: `pulse_id`, `subscriber_json` (destination selector), `created_at`

### Bus Pulse Scheduler

Event-driven priority queue with single active `setTimeout`:
- Sorted by `next_fire_at`
- On fire: emit `pulse.fired` event, calculate next fire time (cron) or mark completed (once), update SQLite, reschedule
- On CRUD: insert/remove from queue, recalculate nearest timeout
- On startup: hydrate from SQLite, fire overdue pulses immediately

### Event shape when pulse fires

```json
{
  "type": "pulse.fired",
  "workspace_id": "<workspace_id>",
  "source_endpoint_id": "system:pulse",
  "destination": { "kind": "endpoint", "endpoint_id": "<subscriber>" },
  "thread_id": "pulse:<pulse_id>:<fire_timestamp>",
  "content": { "text": "Check email", "pulse_id": "daily-email-check" },
  "metadata": { "pulse_id": "daily-email-check", "trigger_type": "cron", "schedule": "0 15 * * *", "fire_number": 42 },
  "response": { "expected": false }
}
```

### Bus API endpoints

- `POST /v1/pulses` — create pulse
- `GET /v1/pulses?workspace_id=...` — list pulses
- `POST /v1/pulses/:pulse_id/pause` — pause
- `POST /v1/pulses/:pulse_id/resume` — resume
- `POST /v1/pulses/:pulse_id/cancel` — cancel
- `POST /v1/pulses/:pulse_id/subscribe` — add subscriber
- `POST /v1/pulses/:pulse_id/unsubscribe` — remove subscriber

### Bridge pulse registration

During workspace attachment, the bridge reads `pulses:` from `.floe/floe.yaml` and calls `POST /v1/pulses` for each definition. The bus upserts by `pulse_id + workspace_id`.

### Bridge pulse tools (agent-facing)

- `create_pulse` — creates a pulse via bus API; if workspace scope, also writes to `.floe/floe.yaml`
- `list_pulses` — queries bus API for workspace pulses
- `pause_pulse` — pauses via bus API
- `resume_pulse` — resumes via bus API
- `cancel_pulse` — cancels via bus API; if workspace scope, removes from `.floe/floe.yaml`

### Subscriber selectors

Subscribers are stored as destination selector objects (not bare endpoint IDs) to allow future expansion to broadcast selectors, channel selectors, etc. Initial implementation supports `{ endpoint_ref: "user:operator" }` which is resolved to a full endpoint ID at fire time using `endpoint:<workspace_id>:<ref>`.

### Timezone semantics

Recurring cron schedules include a `timezone` field (IANA timezone string). The scheduler evaluates cron expressions in the specified timezone. One-off (`once`) triggers use ISO 8601 with offset, so timezone is implicit.

### Agents are not required to emit on pulse

When an agent processes a `pulse.fired` event, it is not required to emit a response. Work activity is recorded in the work log. The agent emits only if communication or state publication is needed. This differs from message events where agents must emit a reply.

### Idle pulse and pending response timeout

Explicitly deferred. Not implemented in this slice. The existing `pulse:` config in `floe.yaml` (with `default`, `after_idle`, `min_interval`) remains as declared schema but is not wired to any scheduling logic.

## Testing Decisions

### What makes a good test

Tests should verify external behavior — inputs and observable outputs — not internal implementation details. A test that breaks when you refactor internals without changing behavior is a bad test.

### Modules to test

1. **Pulse Scheduler** — Unit tests with fake timers (vi.useFakeTimers). Test: add pulse → fires at correct time; add multiple → fires in order; remove pulse → doesn't fire; cron → calculates next occurrence correctly; one-off → auto-completes; overdue on startup → fires immediately; pause/resume lifecycle.

2. **Pulse Store** — Unit tests with in-memory SQLite. Test: CRUD operations; subscriber management; status transitions (active→paused→active, active→cancelled, active→completed); workspace_id scoping; upsert behavior for bridge registration.

3. **End-to-end contract test** — Extend the existing `vertical-slice.test.ts` to prove: create pulse via API → scheduler fires → `pulse.fired` event submitted → delivery created → subscriber receives delivery → bus event stream includes pulse lifecycle messages. This test uses real bus/bridge processes (fake runtime adapter).

### Prior art

The existing `tests/src/vertical-slice.test.ts` is the contract test pattern: spin up real bus + bridge processes in temp directories, exercise the full flow through HTTP APIs, verify via event stream and API queries.

## Out of Scope

- Idle pulse (idle-time-based scheduling) — deferred as lifecycle concern
- Pending response timeout — separate lifecycle management
- Extension-triggered pulse behaviors — requires extension substrate (future slice)
- FloeWeb UI for pulse management — substrate-first, UI follows
- Pulse permissions/authorization — local-first trust model is sufficient for now
- subscribe_pulse / unsubscribe_pulse agent tools — subscribers are set at creation for now; subscription tools can be added when multi-agent pulse use cases emerge
- Natural language schedule parsing — agents (LLMs) produce structured cron/ISO 8601

## Further Notes

- The `system:pulse` synthetic endpoint should be auto-registered in the bus on startup (no bridge dependency)
- Cron parsing should use a well-tested library (e.g., `cron-parser` or similar) rather than hand-rolled parsing
- The priority queue can be a simple sorted array for V0 — pulse counts per workspace will be small
- WebSocket broadcast messages should include pulse lifecycle events (`pulse_created`, `pulse_fired`, `pulse_paused`, `pulse_resumed`, `pulse_cancelled`) for FloeWeb reactivity
