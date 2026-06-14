# Floe Substrate - Domain Context

## Glossary

### Scope
An intentional substrate organising boundary inside a Workspace for connected, event-driven, or operational work.
_Avoid_: Field, canvas, block, thread, context, pulse scope, universal fallback bucket.

### Workspace-level Context
A Context with actor participants and no Scope. It is valid for direct actor communication, actor side conversations, actor self-notes, and unsorted/general conversation before it is intentionally attached to scoped work.
_Avoid_: Default Scope, Default Field, orphan stream.

### Scoped Context
A Context with a non-null `scope_id`. Scope is required for actorless Contexts and for work that creates or joins scoped operational flow unless the operation targets an already-valid explicit unscoped actor Context.
_Avoid_: fake default scope, field-owned membership.

### Scoped Primitive
A substrate primitive that declares a non-null `scope_id` or derives one from its owning primitive.
_Avoid_: Field Item, canvas item, block storage.

### Field
A FloeWeb rendering/projection of a Scope.
_Avoid_: substrate primitive, source of truth, item list, connection list.

### Scope Projection
A read-only substrate-derived view of the primitives and relationships visible in a Scope. It returns substrate refs and derived relationships, not React Flow state. Future clients may consume the same projection without knowing FloeWeb internals.
_Avoid_: storage source, Field-owned item list, Field-owned connection graph, client-side membership derivation.

### Field Layout
Renderer-specific arrangement state for how a Field displays scoped primitives and derived relationships. It is keyed by stable projected refs, not old Field Item ids.
_Avoid_: membership, semantic graph, source of truth.

### Block
A representational view of a scoped substrate primitive or derived substrate relationship.
_Avoid_: storage category, substrate primitive, `.floe/blocks`.

### Derived Relationship
A relationship rendered in a Field because it already exists on the underlying substrate primitives.
_Avoid_: Field Connection, relationship ontology, field-owned edge.

### Pulse
Bus-owned scheduled event creation. A pulse fires at a configured time and creates the canonical `pulse.fired` event for its subscribers. Pulse is NOT heartbeat, keepalive, runtime wait-refresh, or inherently actor activation.

### Pulse Persistence
Where and how a Pulse definition is stored or carried.
- **workspace-backed** - portable, stored with the workspace configuration and committed with the repository.
- **local/runtime-backed** - private or runtime-local, stored in bus/local state rather than committed workspace configuration.
_Avoid_: Pulse Scope.

### Pulse Definition
A portable or local declaration of a scheduled Pulse, including its schedule, `pulse.fired` event payload, subscribers, persistence, and Scope or explicit Context anchor where relevant.

### Pulse Runtime State
Ephemeral scheduling state (next fire time, last fired, active/paused) stored in bus SQLite. Rebuilt from definitions on workspace attachment. Not portable - local to each bus instance.

### Scheduled Pulse
A Pulse with a clock-based trigger: either a cron expression with timezone (recurring) or an ISO 8601 timestamp (one-off).

### Pulse Subscriber
A target that receives the created `pulse.fired` event when the Pulse fires. Subscriber kind determines whether the event is appended for rendering or delivered for endpoint processing.

### Context Subscriber
A Pulse Subscriber that appends the `pulse.fired` event to an existing Context for rendering only. It does not create endpoint delivery or activate an Actor.

### Endpoint Subscriber
A Pulse Subscriber that delivers the `pulse.fired` event to an Endpoint. If it declares an explicit `context_id`, delivery uses that Context. If it omits `context_id`, the Pulse requires Scope and uses one stable generated scoped delivery Context for that Pulse + Endpoint Subscriber configuration, reused across fires and recreated on a later fire if deleted. Endpoint delivery may activate only if the Endpoint has a processor.

### Endpoint
An addressable participant/interface in the substrate. Humans, agents, webhooks, extensions, schedulers, and future actors are all endpoints. No endpoint type is privileged.

### Actor
A workspace-scoped Endpoint participant that may communicate through Events.
_Avoid_: field-owned object, draggable actor object.

### Context
A bounded stream in which stream entries occur. A Context is anchored by actor participants, a Scope, or both; it is not always a chat conversation.
_Avoid_: channel, room, field, actor container, orphan stream.

### Thread
Legacy or conversational wording for Context. New domain language should use Context.

### Event
The communication primitive. All coordination passes through canonical Events routed by the bus. A Pulse firing produces an Event like any other.

### Emit
The universal substrate publish operation. All Endpoints use emit to create canonical Events on the bus.

### Delivery
An Event made available to a specific Endpoint for processing. Context subscribers do not create deliveries.

### Event Cursor
An opaque, ordered position in a Workspace's Event stream, keyed by `(created_at, event_id)`. It is the unit the `since` parameter on Event queries speaks, and what an Endpoint Watermark stores. The `event_id` tie-break makes Events sharing a `created_at` safe to page past without skipping or repeating.
_Avoid_: offset, page number, timestamp-only cursor.

### Endpoint Watermark
A persisted, per-Endpoint Event Cursor marking how far an Endpoint has been carried forward — the point an Actor was last brought up to date. It is generic across Actors; the operator is one ordinary Endpoint. It advances only when explicitly set, never on read, so "what changed since I was last here" persists until the Actor deliberately marks themselves caught up. Distinct from `bridges.last_seen_at`, which is bridge liveness.
_Avoid_: read receipt, seen, unread badge, last_seen_at.

### Webhook
An event source that ingests external input and produces canonical substrate Events. Actorless webhook streams must create or use a scoped Context; they must not fall back to a hidden Default Scope.

### Work Log
A committed Markdown activity record for human audit. Runtime output and tool activity - NOT communication. Work logs derive Scope from their delivery/Context when scoped, and carry `scope_id: null` for direct unscoped actor Contexts.

### Turn
An Endpoint's processing cycle for delivered Events. Turn end means "this endpoint has finished processing." It is NOT a message.

### Extension
A substrate addition that provides tools, Pulse declarations, and/or programmatic Extension Hooks to agents. Lives in the workspace with an extension manifest and TypeScript entry point. Discovered and loaded by the bridge at workspace attach time.
_Avoid_: Plugin, module, add-on.

### Extension Manifest
A JSON file declaring extension metadata, capabilities, and optional Pulse schedules. Schema-versioned (`floe.extension.v1`).

### Extension Entry Point
A TypeScript file that exports a factory function receiving `ExtensionContext` and returning an array of agent tools. Loaded by the bridge.
_Avoid_: Pi extension factory (different lifecycle scope).

### Extension Tool Prefix
Extension tool names are auto-prefixed with the Extension name to prevent collisions. Extension declares `name: "add"`, agent sees `todo_add`.

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

- A **Workspace** is the top-level boundary; it has **Actors**, **Contexts**, and zero or more named **Scopes**
- **Workspace Home** is an index/dashboard over Workspace state; it is not a **Scope**
- A **Scope** organises **Scoped Primitives**; it does not execute work, contain Actors, or own a duplicated membership list
- A **Scope Projection** derives visible primitives and relationships from substrate state; it is not a storage source
- A **Field** renders one **Scope** for FloeWeb
- A **Field Layout** belongs to the Field rendering of a **Scope** and must not determine membership
- A **Context** is valid when anchored by actor participants, a **Scope**, or both
- A **Context** with actor participants may have `scope_id: null`
- A **Context** without actor participants must have a non-null `scope_id`
- A **Context** with neither actor participants nor Scope is invalid
- **Events** derive Scope from their **Context** or source ownership; Event Scope may be null for unscoped actor Contexts and must not become an independent source of truth
- A **Field** renders a **Context** as the top-level conversation/work node; Events inside that Context are its history and are not separate Field-level blocks
- A **Pulse** has **Pulse Persistence** and must have either a Scope or an explicit valid Context/subscriber anchor
- A **Pulse** creates a canonical **Event** with type `pulse.fired`
- A **Context Subscriber** appends `pulse.fired` to an explicit **Context** without creating a **Delivery**; the Context may be an unscoped actor Context
- An **Endpoint Subscriber** creates a **Delivery** for an **Endpoint** and may activate that endpoint's processor; without explicit `context_id`, it requires Pulse Scope and uses one stable generated scoped delivery Context for that Pulse + Endpoint Subscriber rather than creating a new Context per fire
- A **Webhook** is an event source; actorless webhook Events must create or use a scoped Context, not a hidden Default Scope
- A **Work Log** derives Scope from its delivery/context when available, and may carry `scope_id: null` for direct unscoped actor Contexts
- **Actors** are workspace-scoped and are not contained by Fields
- **Derived Relationships** are rendered from existing substrate state; editing one must update the primitive that owns the relationship
- An **Extension** provides **Tools**, optional **Pulse** declarations, and optional **Extension Hooks**
- An **Endpoint** declares which **Extensions** it uses via frontmatter `extensions: []`
- The bridge loads **Extensions** at workspace attach alongside **Endpoints** and **Pulses**
- Extension-declared **Pulses** are registered as normal **Pulses**; the bus is unaware of extensions
- An **Extension** registers **Extension Hooks** programmatically when its entry point is loaded
- **Hook Registration** and **Hook Firing** are separate: a registered hook only runs when the bridge/runtime fires that lifecycle point
- Most active **Extension Hooks** are **Observation Hooks**; **BeforeTurn Injection** is the current implemented behaviour-changing hook result

## Flagged ambiguities

- "Scope" previously appeared in Pulse APIs and docs to mean workspace-backed versus local/runtime-backed storage. Resolved: use **Pulse Persistence** for storage/lifecycle location, and reserve **Scope** for the workspace organising boundary.
- The earlier Field model made `.floe/fields/<id>.yaml` own Field Items and Field Connections. Resolved: future work treats **Scope** as the substrate primitive and **Field** as the FloeWeb rendering; field-owned item and connection lists are superseded.
- Earlier Scope work introduced **Default Scope** as an automatic bucket for every Context. Superseded: Scope is nullable for actor-anchored Contexts, required for actorless/scoped operational Contexts, and must not be used as a product fallback.

## Deferred Concepts

### Many-to-many Scope Membership
A primitive belonging to more than one Scope. Deferred; first Scope work uses one primary Scope per scoped primitive.

### Global Connections
Cross-scope or global relationship management. Deferred unless an existing substrate primitive already owns that relationship.

### Idle Pulse
An idle-time-based Pulse that fires after an Endpoint has been idle for a configured duration. Deferred - it is a lifecycle/keepalive concern, not scheduled event delivery.

### Pending Response Timeout
A timeout mechanism for stale `response.expected: true` states. Separate lifecycle concern from Pulse. Agents wait indefinitely; timeouts are optional lifecycle management to be designed separately.
