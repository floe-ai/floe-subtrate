# Floe roadmap — first-principles substrate version

Floe core should stay small.

The goal is not to pre-build every useful product pattern. The goal is to make those patterns buildable inside Floe as local capabilities, extensions, blocks, and workspace conventions.

## Core distinction

Floe core provides substrate primitives.

Blocks interpret substrate primitives.

Extensions and users provide domain capabilities.

FloeWeb renders and composes substrate state through blocks.

Floe should not answer:

```text
How should this workspace do its work?
```

Floe should answer:

```text
How can actors, events, contexts, tools, hooks, pulses, files, work logs, extensions, and blocks coordinate reliably?
```

Floe has not shipped. Do not preserve legacy behaviour unless explicitly requested. Prefer clean breaking changes over compatibility shims.

Every major slice should end with:

```text
code
tests
live proof
docs / ADR / source-of-truth update
```

Docs/source-of-truth is not a later feature. It is a standing gate.

---

# 0. Foundation and standing regression gates

These are foundation behaviours that should remain true across all future slices.

If any are not actually complete in code, treat them as immediate prerequisite work before moving forward.

## Foundation principles

* actor-neutral identity direction
* actor/context separation
* no `actor_type` in active bus surfaces
* no human/agent/user/bot categories in actor-visible surfaces
* operator identity comes from substrate/bus state, not hardcoded UI assumptions
* context isolation / no-bleed behaviour
* explicit `emit` is the only actor communication mechanism
* turn end is lifecycle, not communication
* visible runtime output and tool output are activity/work-log material, not messages
* work logs are separated from actor communication
* pulse is scheduled event creation
* canonical pulse event is `pulse.fired`
* pulse subscriber kind determines render/delivery/processing behaviour
* context pulse subscriber renders without actor activation
* endpoint pulse subscriber creates delivery and may activate if a delivery processor exists
* broadcast selectors are actor-neutral and delivery-processor based
* public extension hooks have real firing paths, typed payloads, docs, and tests
* FloeWeb is a client/renderer over substrate state, not the substrate model

## Standing regression checks

Every major slice should re-check:

* no context bleed
* no raw typed endpoint IDs in actor-visible surfaces
* no `human`, `agent`, `user`, `bot`, or `actor_type` category leakage
* communication appears only through explicit emit
* activity/work logs do not render as chat messages
* pulse events do not pollute unrelated contexts
* blocks do not become duplicate sources of truth
* docs and code agree

---

# 1. Hook completeness

This is the immediate prerequisite if it is not already finished.

The hook contract must not expose named-but-unavailable hooks.

Every public hook must have:

* real firing path
* typed payload
* tests proving it fires
* documentation describing when it fires
* no reserved/unavailable language

## Public hook surface

The intended public hook surface is:

* `SessionStart`
* `SessionResume`
* `BeforeTurn`
* `Pulse`
* `TurnEnd`
* `Error`
* `BeforeToolUse`
* `AfterToolUse`
* `ToolUseFailed`
* `SessionEnd`
* `WebhookReceived`

## Key rules

`BeforeTurn` is the only current behaviour-changing hook because it can inject prompt/context.

Observation hooks should observe only.

`SessionEnd` must mean actual session end, not turn end. It should fire only when a runtime/session is disposed, replaced, or torn down.

`WebhookReceived` should fire from the real webhook ingress path.

Programmatic TypeScript hooks are the current contract:

```ts
ExtensionContext.hooks.on(...)
```

Declarative YAML hook config remains future/not implemented.

---

# 2. Block model for substrate representation

This should move near the top of the roadmap.

> **Framing correction (2026-05).** Blocks are representational, not a storage category. Existing substrate primitives (actors, contexts, pulses, webhooks, extensions, files, work logs, events, tools) are NOT moved into a `.floe/blocks/` tree — they keep their existing homes. A **Field** is a substrate primitive that groups stable refs to those primitives. Clients render Field Items as Blocks. The first slice in this section is complete: the Field primitive, FloeWeb renderer, watcher loop, ordinary actor file-tool proof, and live close-out evidence are documented in `docs/adr/0003-field-substrate-primitive.md`, `docs/field-substrate-slice-prd.md`, and `docs/evidence/field-block-slice/README.md`. This does not introduce a parallel "block substrate".

Blocks are not domain features.

A block is a client's interpretation of a Field Item — a way to render or operate on a substrate primitive that a Field references.

Everything visible or composable in FloeWeb is a block.

A Field is a substrate primitive that FloeWeb renders as a canvas of blocks.

A surface is how a client renders blocks.

A conversation view is a block.

An actor card is a block.

A pulse card is a block.

A work-log view is a block.

An extension panel is a block.

The goal is to identify the substrate primitives that need block interpretations, then define how FloeWeb composes those blocks without becoming the source of truth.

## Core principle

A block references substrate state.

A block does not duplicate substrate state.

A block can render state, expose actions, connect to other blocks, emit events, invoke tools, or interpret files/metadata.

## Core block candidates

Core should define block interpretations for current substrate primitives:

* workspace block
* actor block
* context/conversation block
* event stream block
* message block
* activity/work-log block
* pulse block
* webhook ingress block
* tool/capability block
* extension block
* file/resource block
* runtime/status block
* config/state block

These are substrate representation blocks, not domain workflow blocks.

## Block connections

Blocks must be able to connect.

This is essential for representing workflows without hard-coding workflows into core.

A connection means:

```text
this block relates to / feeds / configures / routes to / interprets / depends on another block
```

Examples:

```text
webhook block → actor block
webhook block → context block
webhook block → interpreter/config child blocks
pulse block → context block
pulse block → actor block
actor block → context block
extension block → tool/capability blocks
file/resource block → actor block
work-log block → actor block
context block → related context block
```

A webhook block, for example, may connect to an actor block and have child blocks that describe how this workflow interprets that webhook. Those child blocks are workspace-specific context/configuration for that workflow.

This should be possible at the substrate level without making “webhook workflow” a core product feature.

## Metadata and persistence

Block identity, layout, interpretation, and connections should likely be stored as workspace-local metadata.

File metadata is a strong candidate because it keeps the workspace portable and inspectable.

Possible shape:

```text
.floe/blocks/
.floe/block-metadata/
.floe/block-graph/
```

or metadata alongside the files/resources the blocks interpret.

The exact storage shape should be designed, but the principle is:

* portable with the workspace
* inspectable by actors
* editable by actors
* versionable where useful
* not hidden in FloeWeb-only state
* not the source of truth for underlying substrate objects

## What block connections unlock

Block connections allow Floe to represent:

* webhook-to-actor workflows
* pulse-to-context reminders
* actor-to-capability surfaces
* extension-provided tools
* file/resource interpretation
* context-specific instructions
* workflow-specific prompt/context blocks
* audit/activity views
* future field-like workspace arrangements

without turning those into hardcoded product systems.

## What remains out of core

Domain blocks should remain extensions or workspace conventions until proven otherwise:

* kanban/task boards
* legal review workflows
* approval flows
* CRM views
* support queues
* research boards
* reporting dashboards
* daily diaries
* communication hubs/channels

## Required first slice

Status: **complete** for the Field first slice. The implemented slice proves a minimal block model by using Field identity, Field Item refs, semantic YAML, FloeWeb layout sidecars, parent/nested Field refs, Field Connections, React Flow composition, bus watcher events, ordinary actor file tools, and committed live evidence.

The original first-slice checklist is retained here as the acceptance frame that the Field slice satisfied:

1. block identity
2. how a block references substrate state
3. how block metadata is stored, likely in workspace files
4. how block parent/child relationships work
5. how block-to-block connections work
6. how blocks can represent actors, contexts, events, pulses, tools, extensions, files, and webhooks
7. how block actions emit events or invoke tools
8. how blocks avoid becoming source of truth
9. how FloeWeb composes blocks
10. how extensions can later contribute block interpretations
11. minimal implementation path proving block representation without domain workflows
12. tests/live proof

Next slice family: substrate↔FloeWeb parity for each remaining Field Item kind (`context`, `pulse`, `webhook`, `extension`, `file`, `tool`, `work_log`, `event`). Treat each as its own focused PRD/issue slice after the Field close-out; do not expand this into domain-specific blocks or workflows.

---

# 3. Local extension lifecycle

This is a core substrate slice, but it should be designed with the block model in mind.

The purpose is not to build an extension management product. The purpose is to make local workspace capabilities first-class substrate citizens that can also be represented as blocks.

## Goal

An actor can create, install, enable, reload, use, audit, and repair a local workspace extension.

## Core should provide

* local extension install
* extension enable/disable
* extension reload/discovery
* manifest validation
* load failure surfacing
* prefixed tool registration
* hook registration through the public hook contract
* extension-declared pulse loading
* extension lifecycle work logs/audit records
* extension block representation
* proof that a newly enabled extension becomes usable without manual developer wiring

## Out of scope

* marketplace
* remote installs
* package registry
* permission system
* sandboxing
* MCP
* full extension dashboard
* domain-specific extension templates

## Principle

Audit first. Permissions later.

No permission system yet, but extension lifecycle actions must be inspectable and auditable.

---

# 4. Actor-created local capabilities through extensions

This is the second half of the extension lifecycle arc, not a separate capability system.

The intended loop is:

```text
actor creates extension
→ actor enables extension
→ actor uses extension
→ actor observes result
→ actor repairs extension
```

Extensions are the first capability container.

Blocks are how those capabilities become visible and composable in FloeWeb.

## Core should prove actors can

* write extension files in the workspace
* install or register the extension
* enable it
* reload discovery
* see newly available tools/hooks
* see newly available extension/capability blocks where applicable
* use the new capability
* inspect failures
* modify and repair the extension
* leave an audit trail of what changed

Avoid creating a vague parallel “capability registry” before extensions prove the path.

Near-term language should be:

```text
capability discovery and surfacing
```

not a full abstract registry.

---

# 5. Generic capability and tool surfacing

Core needs enough capability surfacing for actors and clients to understand what is available.

Core owns the generic substrate layer for tools/capabilities.

## Core should own

* tool discovery
* tool descriptions
* tool invocation
* tool result recording
* tool failure recording
* extension capability visibility
* capability/tool blocks
* actor-visible capability lists that do not leak runtime/interface categories
* clear distinction between tools/capabilities and communication

## Core should not own domain capabilities

Examples that should not be core:

* GitHub issue triage
* legal contract review
* project management
* calendar planning
* memory/RAG
* daily diary generation
* approval workflows
* reporting dashboards

Those should be extensions or workspace-level capabilities.

---

# 6. Actor/context/event/activity UX hardening

FloeWeb is a client over substrate state. It should make the core primitives understandable without inventing competing product concepts.

With the block model, this means FloeWeb should render and compose blocks over substrate primitives instead of accumulating ad hoc panels.

## FloeWeb should harden

* actor block/list rendering
* selected actor clarity
* context/conversation block stability
* active context clarity
* message/event block rendering
* activity/work-log block rendering
* pulse event block rendering
* tool-use visibility
* extension lifecycle visibility
* actor state visibility
* block connection visibility
* empty states
* accessibility
* mobile/tablet layout
* live no-bleed regression proof

## Actor state surface

Actor state should clarify delivery/runtime/work status without becoming chat presence or category labelling.

Useful states may include:

* idle
* processing
* waiting
* queued work
* scheduled work
* blocked/error
* runtime unconfigured
* delivery processor unavailable
* auth/profile missing

## Still forbidden in normal actor-visible surfaces

* human
* agent
* bot
* user
* `actor_type`
* raw typed endpoint IDs
* system-imposed category labels

---

# 7. Work log and audit primitives

Work logs are core because they preserve what actors did without turning activity into communication.

Work logs should also be representable as blocks.

## Core should provide primitive auditability for

* tool use
* tool failure
* extension install/enable/disable/reload
* block creation/update/connect/disconnect
* hook firing where useful
* pulse creation/firing
* webhook ingress
* context creation
* actor changes
* runtime/session lifecycle where relevant

## Core should not prescribe product interpretations such as

* daily reports
* performance dashboards
* actor diaries
* compliance packs
* legal audit formats

Those should be built as extensions or surfaces/blocks over work logs.

---

# 8. Pulse and webhook hardening

Pulse and webhook ingress are core because they are generic event-creation mechanisms.

Both should have block interpretations and support block connections.

## Pulse

Core owns:

* scheduled event creation
* canonical `pulse.fired`
* context subscriber behaviour
* endpoint/delivery subscriber behaviour
* multiple subscribers
* pulse block representation
* pulse audit/history
* cancellation/rescheduling primitives where needed
* clear FloeWeb rendering for context-delivered pulse events

Core should not become:

* a reminder app
* a task system
* a habit tracker
* a monitoring product

Those are user-space patterns over pulse.

## Webhooks

Core owns:

* webhook ingress
* canonical webhook event creation
* `WebhookReceived` hook firing
* webhook block representation
* webhook route/config primitive if needed
* replay/debug/audit primitives where useful

Core should not hard-code domain integrations.

GitHub, Jira, Slack, email, calendar, and similar integrations should be extensions.

## Webhook block example

A webhook block can connect to:

* an actor block
* a context block
* an extension block
* child interpretation/config blocks
* work-log/audit blocks

The child blocks may describe how this workflow interprets that webhook.

This lets a workspace define:

```text
when this webhook arrives
→ interpret it using this context/config
→ send/deliver it to this actor or context
→ record the work/audit
```

without core knowing the domain.

---

# 9. Packaging and local product readiness

As the substrate becomes self-extending and block-composable, the local product loop needs to become reliable.

## Core/product work may include

* clean local setup
* workspace initialisation
* reset/dev commands
* config validation
* startup/shutdown reliability
* runtime/provider repair flows
* logs and diagnostics
* reproducible QA runs
* packaged local app or desktop shell later

Because Floe has not shipped, clean breaking changes are still preferable to compatibility shims.

---

# 10. Multi-client readiness

FloeWeb is one client. The substrate should be usable by many clients without changing its mental model.

Future clients may include:

* CLI
* API clients
* Slack
* webhooks
* desktop surfaces
* other runtimes
* external automation clients

## Core work here is mostly about keeping APIs and events clean

* actor-neutral refs
* context isolation
* explicit emits
* block metadata portable outside FloeWeb
* no FloeWeb-only assumptions
* no client-specific substrate semantics
* consistent audit/event models
* delivery-processor based routing, not interface category routing

---

# 11. Memory and retrieval as extensions first

Memory is important, but the memory strategy should not be core yet.

Core already produces the raw material:

* events
* contexts
* work logs
* files
* actor activity
* extension activity
* pulse history
* webhook events
* block metadata and block connections

Memory systems should first be built as extensions that use:

* tools
* files
* summaries
* `BeforeTurn` injection
* context/query APIs
* work logs
* block graph/metadata where useful

Examples:

* actor diary
* project memory
* legal matter memory
* research memory
* preference memory
* RAG over workspace files
* retrieval over long context history
* retrieval over block-connected workspace state

Core should avoid prescribing one memory model too early.

---

# 12. Multi-actor collaboration patterns as block/context patterns, not channels

Core already supports actor-to-actor work through explicit contexts and emits.

The canonical pattern remains:

```text
A ↔ B
B ↔ C
B summarises back to A ↔ B
```

Do not introduce channels, rooms, teams, or implicit group chat as core concepts.

Future participant management or group contexts may be valid, but only if deliberately designed as substrate primitives.

Until then, collaboration should be built from:

* contexts
* explicit emits
* summaries
* work logs
* extensions
* blocks
* block connections

This section is a constraint, not a feature mandate.

---

# 13. External integrations through extensions and blocks

External integrations should not become substrate concepts.

Core should enable integrations through:

* extension lifecycle
* tools
* hooks
* webhook ingress
* pulse
* work logs
* files
* audit
* block interpretations
* block connections
* eventual permissions

Integrations should be built as extensions and represented through blocks:

* GitHub
* Jira
* Slack
* email
* calendar
* Confluence
* SharePoint
* browser/API connectors
* local app automation

The substrate should remain client-neutral and integration-neutral.

---

# 14. Safety, permissions, and sandboxing

Deferred, but not forgotten.

The moment actors can create and enable capabilities, connect blocks, and route events through workspace-defined structures, safety pressure increases.

## Near-term rule

```text
local/dev/open-first
auditable by default
permissions later
```

## Future work

* extension permissions
* tool access controls
* filesystem boundaries
* block/action permissions
* external integration scopes
* runtime/tool audit
* user approval gates
* sandboxing
* policy hooks
* safe capability sharing

Do not build this into the immediate extension lifecycle or block-model slice, but design those slices so lifecycle and block-graph actions are inspectable and auditable.

---

# What Floe core should not prescribe

These should be buildable inside Floe, not built into Floe core:

* legal review workflows
* project management systems
* kanban/task systems
* support triage
* research workflows
* approval/review processes
* memory systems
* daily diaries
* reporting dashboards
* GitHub/Jira/Slack/email/calendar integrations
* communication channels
* group chat products
* domain-specific blocks
* domain-specific fields
* workflow engines

Floe should make these possible through primitives.

It should not decide they are the product.

---

# Revised working order

1. Hook completeness, if not already truly complete
2. Block model for substrate representation
3. Minimal FloeWeb rendering/composition of core substrate blocks
4. Local extension lifecycle
5. Actor-created local capabilities through extensions
6. Generic capability/tool surfacing
7. Actor/context/event/activity UX hardening
8. Work log and audit hardening
9. Pulse and webhook hardening
10. Packaging/local product readiness
11. Multi-client API cleanliness
12. Memory/retrieval extensions
13. External integration extensions
14. Collaboration patterns as context/block/extension patterns, not channels
15. Safety, permissions, and sandboxing

---

# Short version

Floe core should build the substrate that lets work happen.

Blocks are how FloeWeb represents and composes that substrate.

Users and extensions should build the ways of working.

The next major move after hook completeness is:

```text
Block model for substrate representation
```

because this clarifies how actors, contexts, pulses, webhooks, tools, extensions, files, work logs, and future workflows fit together.

Then local extension lifecycle can build on that model so extensions can eventually contribute not only tools and hooks, but also block interpretations and block-connected capabilities.
