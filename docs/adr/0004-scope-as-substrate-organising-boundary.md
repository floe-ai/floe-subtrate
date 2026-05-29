# ADR-0004: Scope as an intentional substrate organising boundary

**Status:** superseded and corrected (2026-05-29)

Floe's earlier Field slice made `.floe/fields/<id>.yaml` own item
membership and connections. That proved a useful canvas loop, but it also
risked making Field files a second substrate beside actors, contexts, events,
pulses, webhooks, extensions, files, tools, and work logs.

The original version of this ADR correctly moved membership ownership from
Field files into substrate primitives, but it over-corrected by saying every
Workspace has a Default Scope and every scoped primitive should fall into that
Default Scope. That rule is no longer accepted.

## Corrected decision

**Workspace** is the top-level boundary. Actors belong to the Workspace.

**Contexts** are bounded streams. A Context may be anchored by actor
participants, by Scope, or by both. A Context with neither actor participants
nor Scope is invalid.

**Scope** is an intentional organising boundary for connected,
event-driven, or operational work. Scope is not a universal fallback bucket.

**Field** is the FloeWeb representation of a Scope. Field layout may be
renderer-specific metadata, but Field files, renderer state, and canvas layout
must not determine substrate membership.

## Required Context anchors

- Actor-participant Contexts may have `scope_id: null`.
- Actorless Contexts must have a real non-null Scope.
- Pulse, Webhook, and event-source flows that create or reuse generated
  operational Contexts must have a real Scope.
- Events derive Scope from the owning Context or source primitive. Event Scope
  must not become an independent source of truth that can disagree with Context
  Scope.

## Default Scope correction

Default Scope is not a product concept and should not be preserved as product
behaviour.

New code must not create, require, or route through a hidden Default Scope.
Workspace Home is an index/dashboard over the Workspace, not a Scope and not a
Field. Unscoped actor Contexts remain discoverable through Workspace, Actor, and
Context views rather than through a fake Default Field.

The id `default` is reserved for stale compatibility cleanup only. It must not
be available as a user-created Scope id. Existing records that relied on the old
Default Scope assumption should be migrated, rejected, or explicitly assigned to
a real Scope according to the corrected anchor rules; the system does not need
to preserve legacy Default Scope behaviour.

## Webhook and event-source ownership

Webhook and event-source Scope comes from source or route configuration. A
request payload must not arbitrarily override Scope ownership. If a future
feature allows request-selected Scope, it must select from validated configured
ownership and still preserve the rule that generated actorless operational
streams are scoped.

## Consequences

ADR-0003 remains superseded for Field ownership direction, and this corrected
ADR supersedes the Default Scope requirement from the original ADR-0004.

The next substrate work must implement nullable Context Scope for actor-anchored
Workspace-level Contexts, reject actorless scopeless Contexts, enforce scoped
Pulse/Webhook/event-source operational flows, and keep Scope Projection limited
to real scoped substrate records.
