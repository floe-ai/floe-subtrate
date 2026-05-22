# PRD: Scope as the Substrate Organising Boundary

## Status
Accepted - ready for issue breakdown. No implementation may start until the Architecture Integration Gate completes.

## Current Propagation Map

This map reflects the current code shape before the Scope slice:

1. **Context/thread**: contexts currently have workspace, parent, creator, participants, and event ordering, but no organising `scope_id`. Context creation happens through bus context resolution when events are emitted or triggers create target contexts.
2. **Event**: events currently store workspace, destination, context, metadata, and content, but no independent Scope. The correct model is that events inherit Scope from their Context or source primitive.
3. **Pulse**: pulses currently use a field named `scope` for workspace/local storage. That meaning is Pulse Persistence, not organising Scope. Pulses need a separate organising `scope_id`.
4. **Webhook**: webhook ingress currently uses route id and creates a trigger event for the first available processor endpoint; there is no persisted webhook route/config Scope. Until route config exists, webhook events should land in the Default Scope.
5. **Work log**: work logs are committed actor activity records written from runtime delivery processing. They currently include trigger, thread/context-adjacent identifiers, delivery, tool activity, and emitted events, but no Scope. They should derive Scope from delivery/context where available.
6. **File/resource metadata**: workspace file tools can read/write files and record touched paths in tool activity, but there is no file/resource Scope metadata. Files should only become scoped when explicit metadata/frontmatter/sidecar support exists; Field membership must not be faked.
7. **Extension/capability**: extensions are discovered at workspace attach, provide tools/hooks/pulse declarations, and bind to actors through agent configuration. They currently have no Scope. Capabilities remain workspace-level/default-scope visible unless extension/capability configuration owns a Scope association.
8. **Actor**: actors are workspace-scoped endpoints/participants. They are not inside Fields. Fields may render context/thread nodes involving actors, and actor presence may be shown through participants/relationships.

## Problem Statement

FloeWeb currently has a Field/Block direction that makes field files own item membership and simple connections. That direction risks duplicating the substrate: contexts, pulses, webhooks, events, extensions, files, actors, tools, and work logs already exist as substrate primitives, but a field-owned graph can become a second source of truth for what exists and how things relate.

The user needs Floe to preserve a substrate-first model: Scope is the organising boundary, Field is a rendering of that boundary, and FloeWeb derives what to show from scoped substrate primitives and their existing relationships.

## Solution

Introduce Scope as a substrate-level organising boundary inside a Workspace. Every Workspace has a Default Scope. Scoped primitives declare or derive one primary `scope_id`. FloeWeb lists Scopes as Fields and renders the selected Scope by querying scoped primitives and derived relationships from the substrate.

Rename the old Pulse "scope" concept to Pulse Persistence so `scope` only means the organising boundary. Pulse Persistence describes where/how a Pulse definition is stored or carried, such as workspace-backed versus local/runtime-backed.

Do not build a new field-owned graph runtime. Do not make field files or layout sidecars the membership source of truth. Layout remains renderer-specific metadata for how FloeWeb arranges the current Scope projection.

For the first implementation, the Scope projection should prove a narrow derived relationship set only: context/thread -> participants, pulse -> subscribers, events -> context/Scope, and work logs -> scoped delivery/context where available. Webhook ingress may safely land in Default Scope until route configuration exists. Extension/capability Scope can remain default/workspace-level unless already supported by an owning primitive.

## User Stories

1. As an operator, I want every Workspace to have a Default Scope, so that newly created work never becomes invisible or orphaned.
2. As an operator, I want to create a Scope with a title and purpose, so that I can organise substrate work around a real area of work.
3. As an operator, I want FloeWeb to list Scopes as Fields, so that the UI matches the corrected substrate model.
4. As an operator, I want opening a Field to render a Scope, so that the canvas is a projection rather than a separate data store.
5. As an operator, I want contexts created from a selected Field to inherit that Field's Scope, so that conversation/work state lands in the expected organising boundary.
6. As an operator, I want contexts created without a selected Scope to land in the Default Scope, so that the system never silently creates unscoped context state.
7. As an operator, I want events inside a context to appear in the same Scope as that context, so that Field rendering reflects actual work history.
8. As an operator, I want pulses to have organising Scope separate from Pulse Persistence, so that storage location and workspace organisation are not confused.
9. As an operator, I want pulse-fired events to appear in the relevant Scope, so that scheduled work and reminders are visible in the right Field.
10. As an operator, I want pulse subscribers rendered as existing relationships, so that I can see what a pulse already targets without creating a duplicate Field edge.
11. As an operator, I want webhook events to land in a safe Scope, so that inbound work is visible even before richer webhook route configuration exists.
12. As an operator, I want work logs to be discoverable from the Scope of the work that produced them, so that activity and audit trails appear near the work they describe.
13. As an operator, I want actors to remain workspace-scoped, so that adding or removing a Field does not imply moving actor identity.
14. As an operator, I want context/thread nodes involving actors to open the existing conversation/sidebar path, so that Fields do not invent a second conversation UI.
15. As an operator, I want moving a node on the Field canvas to update only layout metadata, so that layout never changes membership.
16. As an operator, I want layout metadata to survive reloads, so that my Field remains spatially useful without becoming the semantic source of truth.
17. As an operator, I want Field rendering to show derived relationships such as context participants and pulse subscribers, so that the canvas explains existing substrate state.
18. As an operator, I want editing a pulse subscriber from FloeWeb to update the Pulse, so that relationship edits go to the owning primitive.
19. As an operator, I want unsupported primitives to be omitted or shown as unsupported rather than faked into Field membership, so that the model stays honest.
20. As an actor, I want the current Scope to be available when I create scoped primitives, so that my work lands in the operator's current organising boundary.
21. As an actor, I want the Default Scope to be used when no explicit Scope is supplied, so that I can create useful substrate state without extra ceremony.
22. As an actor, I want Pulse Persistence terminology in tools and prompts, so that I do not confuse storage location with organising Scope.
23. As a maintainer, I want a substrate API for listing Scopes and scoped primitives, so that clients do not read workspace files directly.
24. As a maintainer, I want Scope propagation rules written down and tested, so that future primitives do not invent their own membership semantics.
25. As a maintainer, I want no `.floe/blocks` substrate and no field-owned item/connection source of truth, so that Floe does not grow a duplicate substrate.
26. As a product reviewer, I want the old Field Item/Field Connection model clearly superseded, so that new implementation does not extend the wrong direction.
27. As a product reviewer, I want live proof that FloeWeb derives a Field from scoped substrate state, so that the corrected model is visible in the product.

## Implementation Decisions

- Define Scope as a bus/substrate primitive with stable `scope_id`, `workspace_id`, optional title/name, optional description/purpose, and created/updated metadata.
- Every Workspace gets a Default Scope. The recommended stable id is `default`, workspace-local and never hidden.
- The Default Scope is never deletable.
- Do not implement broad Scope deletion in this slice. Either disallow deletion entirely, or allow only empty non-default Scope deletion. If deletion of non-empty Scopes is introduced later, it must require an explicit reassignment target for every scoped primitive.
- Use one primary Scope per scoped primitive in this slice. Many-to-many Scope membership is explicitly deferred.
- Add `scope_id` to Context as the first authoritative scoped work/communication primitive.
- Events inherit Scope from Context for normal emits. Trigger events inherit Scope from their source primitive where available, or from Default Scope.
- The source of truth for an Event's Scope is the owning Context or source primitive. Event rows may denormalise `scope_id` only for query/index convenience; denormalised event Scope must not become authoritative or drift from the owner.
- Rename the Pulse storage concept to Pulse Persistence in public language and new API/tooling. Workspace-backed and local/runtime-backed are persistence choices, not Scopes.
- Add Pulse organising `scope_id` separately from Pulse Persistence.
- Pulse creation from an active Context inherits that Context's Scope unless explicitly overridden. Pulse creation without an active Context or explicit Scope uses Default Scope.
- Pulse-fired context subscriber events inherit the subscriber Context's Scope. Pulse-fired endpoint deliveries carry the Pulse's organising Scope unless they are associated with an explicit Context, in which case the Context Scope wins for conversation rendering.
- Webhook ingress uses Default Scope until webhook route/config Scope exists. This PRD must not fake webhook membership through Field files.
- Work logs derive Scope from the delivery's trigger/current Context where available. If no Context can be resolved, they belong to Default Scope for indexing/rendering.
- Files/resources are not faked into Scope membership. File/resource scoping requires explicit metadata/frontmatter/sidecar support and is otherwise deferred in this slice. Scope must not be inferred from "a scoped actor touched this file"; tool activity can be scoped in the Work Log, but the file itself does not automatically become scoped.
- Extensions/capabilities remain workspace-level/default-scope visible unless an extension/capability owner supplies a Scope association. Do not invent a capability registry in this slice.
- Actors remain workspace-scoped. FloeWeb may render actor presence through Context participants, delivery targets, Pulse subscribers, Work Logs, and extension/capability relationships where they already exist, but must not imply that an Actor belongs to a Field. Context/thread nodes are the primary scoped unit.
- Add substrate APIs to list Scopes, create/update/delete Scopes where safe, list scoped primitives for a Scope, and update the Scope of primitives that safely own `scope_id`.
- FloeWeb lists Scopes as Fields and renders the selected Scope by querying scoped primitives and derived relationships through the bus.
- Field layout is renderer metadata keyed to the Scope rendering and stable rendered refs. It stores positions, dimensions, viewport, collapsed state, and similar UI state only.
- Existing field-owned semantic item/connection files are superseded and should not be extended. Since Floe has not shipped, prefer a clean break over compatibility shims.
- Scope projections render derived relationships from existing substrate state. Editing a relationship writes to the owning primitive: pulse subscriber edits update the Pulse; context edits use Context support; extension enablement updates extension/actor/workspace config if supported.
- The first vertical slice should support at minimum Scope, Context, Pulse, Event inheritance, Work Log derivation, Default Scope fallback, and FloeWeb rendering of scoped contexts/pulses with derived relationships.

## Testing Decisions

- Good tests prove externally visible behaviour: persisted Scope records, API responses, event/context/pulse/work-log Scope propagation, FloeWeb rendering, and layout writes that do not affect membership.
- Test the Scope store/index as a deep module through its public interface: create/list/update/default Scope, default creation idempotency, and validation failures.
- Test Context propagation through bus event submission: selected/explicit Scope, Default Scope fallback, and event inheritance through Context.
- Test Pulse propagation through bus and bridge-facing tools: Pulse Persistence is separate from organising `scope_id`, pulse-fired events inherit the correct Scope, and old Pulse "scope" wording is not reintroduced in new surfaces.
- Test webhook fallback at the API boundary: current ingress events land in Default Scope until scoped route configuration exists.
- Test work-log derivation through runtime processing: work logs produced from scoped deliveries are indexed/renderable through that Scope.
- Test Scope deletion safety: Default Scope cannot be deleted, and non-default deletion is either unavailable or restricted to empty Scopes.
- Test FloeWeb with Playwright against a real bus-backed workspace: list Scopes as Fields, open a Scope Field, create a context/pulse in that Field, observe scoped rendering, move nodes, and verify layout changes do not change Scope membership.
- Add a regression guard that Field layout/renderer metadata cannot create membership. The authoritative membership source must remain primitive `scope_id` or derived ownership.
- Prior art exists in bus store/server tests, context resolver tests, pulse scheduler/subscriber tests, bridge work-log tests, and FloeWeb Field Playwright tests.

## Out of Scope

- No many-to-many Scope membership.
- No global connection model.
- No relationship ontology.
- No dangerous Scope deletion; the Default Scope is never deletable, and non-empty Scope deletion with reassignment is deferred unless explicitly approved after architecture review.
- No `.floe/blocks` substrate.
- No field-owned canonical item list.
- No field-owned canonical connection list.
- No moving actors, contexts, pulses, webhooks, files, extensions, tools, or work logs into block storage.
- No broad extension lifecycle or marketplace work.
- No new permission model.
- No cross-scope relationship management unless an existing primitive already requires it.
- No file/resource scoping unless minimal explicit metadata support is included by architecture review. File Scope must not be inferred from actor/tool activity.
- No domain-specific workflow blocks such as kanban, approvals, queues, dashboards, or CRM views.

## Further Notes

This PRD intentionally supersedes the earlier Field-as-substrate-primitive direction. The core invariant is: Scope exists in the substrate, primitives declare or derive Scope, Field renders Scope, relationships are derived from existing primitive state, and layout is renderer-specific metadata only.

Implementation must run the Architecture Integration Gate before code changes because this slice touches bus schema, context/event/pulse propagation, FloeWeb Field/canvas behaviour, docs, and live QA.
