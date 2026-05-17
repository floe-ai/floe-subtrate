# Floe Substrate — Domain Context

## Glossary

### Pulse
Bus-owned scheduled event creation. A pulse fires at a configured time and creates the canonical `pulse.fired` event for its subscribers. Pulse is NOT heartbeat, keepalive, runtime wait-refresh, or inherently actor activation.

### Pulse Scope
Pulse supports two scopes:
- **workspace** — portable, stored in `.floe/floe.yaml` under `pulses:`. Committed with the repository. Workspace automation should use this scope.
- **local** — private/personal, stored in bus SQLite or `~/.floe` state. Personal reminders use this scope unless the user explicitly wants the pulse committed.

### Pulse Definition
A portable or local declaration of a scheduled pulse, including its schedule, `pulse.fired` event payload, and subscribers.

### Pulse Runtime State
Ephemeral scheduling state (next fire time, last fired, active/paused) stored in bus SQLite. Rebuilt from definitions on workspace attachment. Not portable — local to each bus instance.

### Scheduled Pulse
A pulse with a clock-based trigger: either a cron expression with timezone (recurring) or an ISO 8601 timestamp (one-off). Created by agents via `create_pulse` tool or declared in `.floe/floe.yaml`.

### Pulse Subscriber
A target that receives the created `pulse.fired` event when the pulse fires. Subscriber kind determines whether the event is appended for rendering or delivered for endpoint processing.

### Context Subscriber
A pulse subscriber that appends the `pulse.fired` event to an existing context for rendering only. It does not create endpoint delivery or activate an actor.

### Endpoint Subscriber
A pulse subscriber that delivers the `pulse.fired` event to an endpoint, optionally scoped to an existing context. Endpoint delivery may activate only if the endpoint has a processor.

### Endpoint
An addressable participant/interface in the substrate. Humans, agents, webhooks, extensions, schedulers, and future actors are all endpoints. No endpoint type is privileged.

### Event
The communication primitive. All coordination passes through canonical events routed by the bus. A pulse firing produces an event like any other.

### Emit
The universal substrate publish operation. All endpoints use emit to create canonical events on the bus.

### Delivery
An event made available to a specific endpoint for processing. Context subscribers do not create deliveries.

### Work Log
A committed Markdown activity record for human audit. Located at `.floe/agents/<agent_id>/worklogs/YYYY-MM-DD.md`. Runtime output and tool activity — NOT communication.

### Turn
An endpoint's processing cycle for delivered events. Turn end means "this endpoint has finished processing." It is NOT a message.

### Extension
A substrate addition that provides tools, pulse declarations, and/or programmatic Extension Hooks to agents. Lives in `.floe/extensions/NAME/` with an `extension.json` manifest and a TypeScript entry point. Discovered and loaded by the bridge at workspace attach time.
_Avoid_: Plugin, module, add-on

### Extension Manifest
A JSON file (`extension.json`) declaring extension metadata, capabilities, and optional pulse schedules. Schema-versioned (`floe.extension.v1`).

### Extension Entry Point
A TypeScript file that exports a factory function receiving `ExtensionContext` and returning an array of `AgentTool` objects. Loaded via dynamic `import()` under tsx.
_Avoid_: Pi extension factory (different lifecycle scope)

### Extension Tool Prefix
Extension tool names are auto-prefixed with the extension name to prevent collisions. Extension declares `name: "add"`, agent sees `todo_add`.

### Extension Hook
A substrate lifecycle point with a real firing path that an Extension can observe or contribute to by registering a TypeScript handler through `ExtensionContext.hooks.on(...)`.

### Hook Registration
The load-time act of attaching an Extension handler to a named Extension Hook; registration alone does not mean that hook is fired by the current bridge/runtime path.

### Hook Firing
The bridge/runtime act of invoking registered handlers for an implemented lifecycle point.

### Observation Hook
An Extension Hook whose handler can observe payloads and perform side effects without changing routing, delivery, or runtime input.

### BeforeTurn Injection
The implemented behaviour-changing Extension Hook result where `BeforeTurn` handlers return `inject` data that is rendered into runtime prompt context.

## Relationships

- An **Extension** provides **Tools**, optional **Pulse** declarations, and optional **Extension Hooks**
- An **Endpoint** (agent) declares which **Extensions** it uses via frontmatter `extensions: []`
- The bridge loads **Extensions** at workspace attach alongside **Endpoints** and **Pulses**
- Extension-declared **Pulses** are registered as normal **Pulses** — the bus is unaware of extensions
- An **Extension** registers **Extension Hooks** programmatically when its entry point is loaded
- **Hook Registration** and **Hook Firing** are separate: a registered hook only runs when the bridge/runtime fires that lifecycle point
- Most active **Extension Hooks** are **Observation Hooks**; **BeforeTurn Injection** is the current implemented behaviour-changing hook result
- A **Pulse** creates a canonical **Event** with type `pulse.fired`
- A **Context Subscriber** appends `pulse.fired` to a **Context** without creating a **Delivery**
- An **Endpoint Subscriber** creates a **Delivery** for an **Endpoint** and may activate that endpoint's processor

## Deferred Concepts

### Idle Pulse
An idle-time-based pulse that fires after an endpoint has been idle for a configured duration. Deferred — it is a lifecycle/keepalive concern, not scheduled event delivery. The config fields in `floe.yaml` (`pulse.after_idle`, `pulse.min_interval`) remain as declared schema but are not implemented.

### Pending Response Timeout
A timeout mechanism for stale `response.expected: true` states. Separate lifecycle concern from pulse. Agents wait indefinitely; timeouts are optional lifecycle management to be designed separately.
