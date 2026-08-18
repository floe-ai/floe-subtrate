# Glossary

Alphabetical definitions of every term used across this guide, each linking to its full page where one exists.

## Actor

Non-deterministic participant, backed by a model or a person. Lives at workspace level; assigned into [[Node|working space nodes]]. Peers cannot tell what backs one. See [[Actor]].

## Artifact

What travels between [[Node]]s. Small or ephemeral goes by wire, in an [[Event]]'s content; large, durable, human-reviewable, or cross-scope goes by file. See [[Artifact]].

## Binding

An ordered list of typed configuration on an actor or a node — model, auth profile, thinking level, instructions, role. What an actor is doing *as* a node, never baked into the actor's identity. See [[Binding]].

## Bridge

The service that runs actors. Attaches [[Workspace]]s, claims deliveries, executes [[Delivery and Turn|turns]], loads [[Extension]]s.

## Bus

The substrate daemon. SQLite plus HTTP and WebSocket. Owns [[Context]]s, [[Event]]s, deliveries, [[Scope]]s, pulses. See [[Bus API]].

## Command

A deterministic [[Node]], backed by a file meeting the command contract. Given the same inputs, it produces the same raw facts every time. See [[Command]].

## Command contract

What a command file must provide: named inputs, named outputs, and raw execution facts (`exit_code`, `passed`, `stdout`, `stderr`). See [[Command]].

## Context

One run of a [[Node]] — a bounded stream where work happens and outcomes appear. Anchored by actor participants, a [[Scope]], or both. See [[Context]].

## Delivery

An [[Event]] made available to a specific [[Endpoint]] for processing. A context subscriber does not create a delivery. See [[Delivery and Turn]].

## Emit

The universal publish operation. Every [[Endpoint]] uses emit to create canonical [[Event]]s on the [[Services|Bus]].

## Endpoint

The substrate's addressable identity for an [[Actor]]. Delivery is gated on runtime attachment (`bridge_id` and status), never on any stored backing label. See [[Endpoint]].

## Endpoint watermark

A persisted, per-endpoint [[Endpoint|Event cursor]] marking how far that endpoint has been carried forward. Advances only when explicitly set, never on read.

## Event

Not a citizen — something that lands, carrying a source: schedule, folder, webhook, or manual. See [[Event]].

## Event cursor

An opaque, ordered position in a workspace's event stream, keyed by `(created_at, event_id)`. What `since` parameters and [[Endpoint|Endpoint watermark]]s speak in.

## Extension

An independent repository built against the substrate contract. Contributes tools, pulses, views, HTTP handlers, [[Hook]]s, and bundled agents. Never lives in this repo. See [[Extension]].

## Hook

An extension-supplied handler fired at a point in the runtime lifecycle. Fifteen exist, including `BeforeTurn`, `Pulse`, and `WebhookReceived`. See [[Hook]].

## Injection

Content a `BeforeTurn` [[Hook]] adds into a turn's prompt. Inject-once / resolve-live: the same resolved content is not re-injected every turn; clearing or compacting a context resets the baseline.

## Node

A citizen placed on a [[Scope]]'s canvas. A node is the work to be done; a [[Context]] is one run of it. Three kinds: event node, working space node, [[Command]] node. See [[Node]].

## Pulse

A schedule — once or cron — that fires an [[Event]] for its subscribers. Not a heartbeat or keepalive.

## Scope

A way of organising the pieces of a product that make sense together, and the canvas those pieces are placed on. Scopes nest. See [[Scope]].

## Session

A private, ephemeral per-`(actor, context)` construct holding tool and reasoning memory. Not persisted — a restart is a cold start that re-derives from the world and the context history.

## Subscription

Which [[Event]] types wake an actor in a [[Context]]. `["*"]` wakes on everything, `[]` is a silent watcher, no row means never woken. Distinct from [[Context|Participation]].

## Participation

Context membership. Any participant may always emit, regardless of subscription.

## Thread

Retired as a primitive — see the table below. Where it appears in code (`events.thread_id`) it is deferred schema-collapse storage, not a concept to design around.

## Turn

One agent run, built from exactly one [[Context]] — no bleed between contexts. See [[Delivery and Turn]].

## Webhook

An [[Event]] source: an inbound HTTP call that lands and wakes the system, the same as a schedule, folder, or manual source.

## Work log

A committed Markdown activity record for human audit. Runtime output and tool activity — not communication.

## Workspace

The outer boundary of all work for a product. Holds actors, scopes, extensions, and settings. What it *is* lives in git (`.floe/`); what is happening now lives in the [[Services|Bus]]. See [[Workspace]].

## Working space

A [[Node]] kind: where work happens. Not an actor itself — actors are assigned into it. See [[Node]].

---

## Retired terms

| Term | Replaced by |
|---|---|
| Field | A [[Scope]] is rendered as itself — no separate rendering concept |
| Default Scope | Does not exist. Scope is nullable for actor-anchored contexts, required otherwise |
| `trigger` as a node kind | An [[Event]] with a source (schedule, folder, webhook, manual) |
| named graph / `graph_id` | A [[Scope]] is the canvas; a graph is only the picture of what's placed on it |
| read receipt | [[Endpoint|Endpoint watermark]] or [[Endpoint|Event cursor]] |
| Thread as a primitive | There is no Thread primitive — a [[Context]] is the shared event stream |
