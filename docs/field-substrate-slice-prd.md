# PRD: Field — First Substrate-Native Field Primitive

## Status
Accepted — ready for implementation.

Supersedes the in-FloeWeb-only `FieldBlock` (clean break; no migration).

Captured decisions:
- `CONTEXT.md` — Field, Field Item, Field Item Ref, Field Connection, Field Layout, Block (representational).
- `PRODUCT.md` — Field/Block/Surface redefined.
- `docs/ROADMAP.md` §2 — framing correction.
- `docs/adr/0003-field-substrate-primitive.md` — architectural decision and rejected options.

## Problem Statement

Floe's roadmap calls for "blocks" as the way clients interpret substrate state. The current implementation has a `FieldBlock` concept that exists only inside FloeWeb's `localStorage`, with its semantic shape (which items are in the field) conflated with its renderer layout (ReactFlow `Node`/`Edge` positions and dimensions). That violates the brief in three ways: the field is not portable with the workspace, FloeWeb is the source of truth, and semantic data is inseparable from renderer state.

An operator who wants a portable, inspectable working map of how substrate primitives connect — actors, contexts, files, pulses, webhooks, extensions, work logs — has no substrate-native way to express it. A runtime-backed actor cannot read or modify that working map at all, because it lives in browser storage. If FloeWeb is uninstalled, the working map is gone.

There is also a framing risk: an earlier reading of the roadmap implied a parallel `.floe/blocks/<kind>/` storage tree that would duplicate every existing substrate primitive. That would weaken the substrate by introducing a second source of truth for actors, pulses, webhooks, and contexts.

## Solution

Introduce **Field** as a new substrate primitive. A Field is workspace-local YAML that groups stable references (Field Items) to existing substrate primitives and records minimal `from → to` Field Connections between them. Renderer layout is stored in a separate sidecar file per renderer. The bus owns the HTTP API and file I/O, watches `.floe/fields/` for external changes, and broadcasts `field.upserted` / `field.deleted` on its existing event stream. FloeWeb is one renderer over substrate state — not the source of truth.

Concretely:

- Semantic file: `.floe/fields/<field-id>.yaml` (schema `floe.field.v1`).
- Layout sidecar: `.floe/fields/<field-id>.layout.floeweb.yaml` (schema `floe.field.layout.floeweb.v1`).
- Items: `{ item_id, ref: "<kind>:<id>" }`. Kinds in scope: `actor`, `context`, `pulse`, `webhook`, `extension`, `file`, `tool`, `work_log`, `event`, `field`.
- Connections: `{ id, from, to, label?, metadata? }`. `label` is free-form workspace text; core does not interpret it. There is no relationship ontology.
- The bus indexes fields on workspace attach, exposes 5 HTTP endpoints, and pushes WS events when files change (from any source — FloeWeb edit, hand edit, or runtime-backed actor edit).
- Existing substrate primitives (actor, context, pulse, webhook, extension, file, work log, event, tool) keep their existing storage and stable refs. Fields only reference them.

The first live proof loop:
1. An operator creates a Field in FloeWeb. A YAML file appears under `.floe/fields/`.
2. A runtime-backed Floe actor is asked, in a chat, to inspect that field's YAML using its ordinary file-read tool and report what items and connections it sees.
3. The same actor is asked to add a new item to the field using its ordinary file-edit tool.
4. The bus watcher picks up the actor's write and broadcasts the change. FloeWeb re-renders the field live, showing the new item.
5. The operator can delete FloeWeb's storage entirely — the field still exists in the workspace files and re-renders fresh on next load.

## User Stories

1. As an operator setting up a workspace, I want to create a Field that holds a working map of how substrate primitives connect, so that I can reason about a working area instead of memorising it.
2. As an operator, I want each Field stored as a YAML file in `.floe/fields/`, so that the working map is committed with my repository and travels with the workspace.
3. As an operator, I want a Field's semantic content (items, connections) separated from its renderer layout (positions, dimensions, viewport), so that I can review a meaningful diff in git without layout noise.
4. As an operator, I want each renderer (FloeWeb today, others later) to keep its layout in its own sidecar file, so that the same Field can be rendered differently by different clients without conflicting layout edits.
5. As an operator, I want Field Items to reference existing substrate primitives by stable URI-style refs (`actor:floe`, `context:ctx_123`, `pulse:morning-standup`, `webhook:github-pr`, `extension:github`, `file:.floe/instructions/pr-review.md`, `tool:todo_add`, `work_log:.floe/agents/reviewer/worklogs/2026-05-19.md`, `field:inbound-pr-review`, `event:evt_abc`), so that Fields point at the substrate rather than duplicating it.
6. As an operator, I want the same substrate primitive to be referenceable more than once in a Field, so that distinct working roles for the same primitive can be expressed.
7. As an operator, I want Field Connections to be a minimal `from → to` with an optional free-form label, so that I can capture relationships without core inventing a relationship ontology.
8. As an operator, I want to inspect a Field's YAML by hand and understand it without running FloeWeb, so that the working map remains meaningful even if FloeWeb is removed.
9. As an operator, I want to hand-edit a Field's YAML file in any text editor, so that I can correct refs or add items without needing UI.
10. As an operator, I want hand-edits to `.floe/fields/<id>.yaml` to be reflected in FloeWeb within seconds, so that the file and the canvas stay in sync regardless of who wrote the file.
11. As a runtime-backed actor (a Floe agent given a chat instruction), I want to read a Field's YAML using my ordinary file-read tool, so that I can report the items and connections in plain language without depending on a custom field tool.
12. As a runtime-backed actor, I want to add or remove an item in a Field using my ordinary file-edit tool, so that I can improve the working environment for my operator without waiting for a custom field tool API to exist.
13. As an operator, I want my actor's hand-written field edits to appear in FloeWeb live, so that the substrate-first claim is observably true.
14. As an operator, I want a Field to support nested Fields via `ref: field:<other-id>`, so that I can decompose a large working map into smaller named maps.
15. As an operator, I want to create a new Field from FloeWeb, so that the common case is fast.
16. As an operator, I want to rename a Field's title from FloeWeb without changing its id, so that the on-disk filename stays stable and connections to it survive.
17. As an operator, I want to delete a Field from FloeWeb, so that both the semantic file and all its renderer sidecars are removed in one action.
18. As an operator, I want to add an Actor Item or a nested Field Item to a Field through FloeWeb (the two primitives FloeWeb already knows how to list), so that the most common item additions don't require editing YAML.
19. As an operator, I want to add Item kinds FloeWeb does not yet have pickers for (context, file, extension, pulse, webhook, tool, work log) by editing the YAML, so that the model is not constrained by what FloeWeb has shipped pickers for.
20. As an operator, I want unknown or future Field Item kinds to render as a generic block rather than crash the canvas, so that the model remains forward-compatible as new substrate primitives appear.
21. As an operator, I want broken or unresolvable refs to render visibly (without crashing or hiding the item), so that I can repair them.
22. As an operator, I want to draw a connection between two items in FloeWeb by dragging from one to another, so that the common case is fast.
23. As an operator, I want to add an optional label to a connection in FloeWeb, so that I can annotate the relationship without core treating the label as semantics.
24. As an operator, I want to move items around the canvas, so that the layout reflects how I think about the working area.
25. As an operator, I want item moves and viewport changes to write only to the FloeWeb layout sidecar — never to the semantic file — so that the semantic file's git history is uncluttered by layout churn.
26. As an operator, I want to delete an item or a connection from FloeWeb, so that I can prune a Field as it evolves.
27. As an operator, I want deleting an Item to also delete every Connection touching that Item, so that the Field never holds dangling Connections.
28. As an operator, I want a Field to have a stable, human-readable id (workspace-local slug) that matches its filename, so that filename, id, and `field:` refs are obvious.
29. As an operator, I want id collisions on create to be rejected with a clear error, so that I never silently overwrite a Field.
30. As a multi-client substrate user, I want a future renderer (CLI, list, outline) to add its own `<id>.layout.<renderer>.yaml` sidecar without touching the semantic file or FloeWeb's sidecar, so that multiple renderers can coexist.
31. As an operator, I want the same Item to occupy different positions in different Fields, so that layout follows the Field-and-renderer pair, not the underlying primitive.
32. As a system maintainer, I want the bus to validate field and layout schemas at read and write time and reject malformed payloads with descriptive errors, so that bad files cannot silently corrupt the index.
33. As a system maintainer, I want core never to interpret connection labels or metadata, so that no relationship ontology leaks into substrate semantics.
34. As a system maintainer, I want field state in the bus's index to be derived from disk on demand (and on watcher events), so that disk remains the source of truth and the bus restart does not lose anything.

## Implementation Decisions

### Domain model and storage

- A Field is a new substrate primitive. It is not "the first block type". Existing substrate primitives keep their existing storage and stable refs.
- Semantic source of truth: `.floe/fields/<field-id>.yaml`, schema `floe.field.v1`.
- Renderer layout: separate sidecar per renderer, named `.floe/fields/<field-id>.layout.<renderer>.yaml` (FloeWeb's is `.layout.floeweb.yaml`, schema `floe.field.layout.floeweb.v1`).
- Field id format: workspace-local slug; filename equals id; id is also the value used in `field:<id>` refs. Collisions on create are rejected.
- Field Item: `{ item_id, ref: "<kind>:<id>" }`. `item_id` is field-local; the same `ref` may appear more than once in a field under different `item_id`s.
- Field Connection: `{ id, from, to, label?, metadata? }`. `from` and `to` are `item_id` values within the same field. `label` and `metadata` are free-form workspace text; core does not interpret them.
- No relationship ontology. No domain-specific block types. No permission model. No field-as-runtime-boundary. No field-as-permission-boundary.
- Resolvability of refs is NOT pre-validated at write time. Clients are expected to render broken refs as visibly broken.

### Read/write path

- The bus owns the HTTP API and the file I/O for fields. The bridge is unchanged.
- A new deep module `fields-store` encapsulates file I/O, parsing, zod validation, change detection, and emits "field changed on disk" events. It has no Fastify or WebSocket coupling.
- A thin module `fields-watcher` wraps `chokidar` per registered workspace, debounces, and forwards changes to `fields-store`. Watcher lifecycle is tied to workspace register / select / unregister.
- Five HTTP endpoints on the existing bus server:
  - `GET    /v1/workspaces/:workspace_id/fields` — returns a list of field summaries (id, title, item count, connection count, updated_at).
  - `GET    /v1/workspaces/:workspace_id/fields/:field_id` — returns the full semantic field plus the FloeWeb layout sidecar if present.
  - `PUT    /v1/workspaces/:workspace_id/fields/:field_id` — upserts the semantic field. Rejects malformed payloads with 400. Rejects id-mismatch (path vs body) with 400. On create, rejects duplicate id with 409.
  - `PUT    /v1/workspaces/:workspace_id/fields/:field_id/layout/:renderer` — upserts the layout sidecar for one renderer. `:renderer` is restricted to `[a-z][a-z0-9_-]*`. Layout writes never modify the semantic file.
  - `DELETE /v1/workspaces/:workspace_id/fields/:field_id` — removes the semantic file AND every layout sidecar matching `<field-id>.layout.*.yaml`.
- WebSocket broadcast over the existing `/v1/events/stream` channel:
  - `field.upserted` with `{ workspace_id, field_id, source: "api" | "watcher" }`.
  - `field.deleted` with `{ workspace_id, field_id }`.
- The watcher and the API both emit these events. FloeWeb subscribers must be safe to receive their own `source: "api"` echo (idempotent re-render).

### FloeWeb rendering and editing

- A new pure module `fields` (mirroring the existing `contexts` pattern) holds substrate↔ReactFlow transforms. Public surface:
  - `fieldToReactFlow(semantic, layout) → { nodes, edges }`
  - `reactFlowToLayout(nodes, viewport) → sidecar shape`
  - `applyNodeChangesToLayout(prev, changes) → next layout` (debounced caller writes back)
  - `buildSemanticUpdate(prev, op) → next semantic` for the limited edit operations supported in slice 1
- A thin module `fields-api` wraps the five HTTP endpoints and the WS subscription.
- `main.tsx` is modified to:
  - Remove the `localFieldStoragePrefix` and all `localStorage` reads/writes for fields.
  - Remove the legacy `FieldBlock` type and all code that constructs ReactFlow nodes/edges directly.
  - Hydrate fields from the bus, subscribe to WS events, and re-render on `field.upserted` / `field.deleted`.
  - Render every Item kind with a simple icon-mapped block; unknown kinds use a generic fallback (no crash). Each block shows the ref string so broken refs are visibly broken.
  - Support exactly these edits (intentionally minimal):
    - Create / rename / delete a Field.
    - Add an Item where the ref kind is `actor` (picker uses the existing endpoint list FloeWeb already has) or `field` (picker uses the existing fields list).
    - Draw a Connection by dragging from one item to another; optional label entered inline.
    - Move an Item on the canvas; viewport changes. These write only to the layout sidecar.
    - Delete an Item (cascades to remove all Connections touching it) or delete a Connection.
  - Item kinds the model supports but FloeWeb does not yet add via UI (context, file, extension, pulse, webhook, tool, work_log, event) are added by editing the YAML directly. They render normally once present.

### Boundary rules carried forward

- FloeWeb never reads or writes `.floe/` directly. It talks only to the bus over HTTP/WS. This preserves the existing v58 substrate boundary.
- The bridge is not modified in this slice. Field file I/O lives in the bus.
- No new actor tools (`field_list`, `field_add_item`, etc.) and no `floe-cli` field subcommands are introduced. The runtime-actor proof relies on ordinary file-read / file-edit tools the actor already has.
- Core does not interpret connection labels or metadata.

### Schema sketches

`.floe/fields/<field-id>.yaml`:

```yaml
schema: floe.field.v1
id: inbound-pr-review
title: Inbound PR Review
description: Working map for incoming GitHub PRs.
items:
  - { item_id: github_webhook, ref: "webhook:github-pr" }
  - { item_id: floe_actor,     ref: "actor:floe" }
connections:
  - { id: c_1, from: github_webhook, to: floe_actor, label: routes-to }
metadata: { owner: jfenech }
created_at: 2026-05-19T16:00:00Z
updated_at: 2026-05-19T16:00:00Z
```

`.floe/fields/<field-id>.layout.floeweb.yaml`:

```yaml
schema: floe.field.layout.floeweb.v1
field_id: inbound-pr-review
viewport: { x: 0, y: 0, zoom: 1 }
items:
  github_webhook: { x: 100, y: 80, width: 240, height: 80, collapsed: false }
  floe_actor:     { x: 400, y: 80, width: 240, height: 80 }
```

## Testing Decisions

Good tests in this codebase exercise externally observable behaviour only — file contents on disk, HTTP responses, WS events received, pure-transform outputs. Tests must not assert on internal React state, internal store maps, or internal chokidar handles. Deep modules are tested through their public surfaces; thin modules are exercised by the E2E.

### Modules under test

- `fields-store` (`floe-bus`, vitest unit). Round-trip read/write/delete; schema validation rejects malformed YAML; deletion removes every `.layout.*.yaml` sidecar; watcher events fire when a file is written by an external process; id-mismatch and duplicate-id rejections. Prior art: `floe-bus/src/pulse-scheduler.test.ts`, `floe-bus/src/store.ts` round-trip tests.
- `fields-server` (`floe-bus`, vitest integration against an in-process Fastify server). Each of the five endpoints; happy path and error cases; WS broadcast received by a subscribed client after both an API write and an external file write. Prior art: `floe-bus/src/server.test.ts`.
- `fields` transforms (`floe-web`, vitest unit, no React). `fieldToReactFlow`, `reactFlowToLayout`, `applyNodeChangesToLayout`, `buildSemanticUpdate`. Includes unknown-kind fallback and broken-ref handling. Prior art: `floe-web/src/contexts.test.ts`.
- Playwright E2E `floe-web/tests/field-block.spec.ts` covering verification scenarios 1–6: file present after create, FloeWeb renders, external YAML edit propagates to canvas, FloeWeb edit writes back to file, layout/semantic separation (a move never touches the semantic file), delete removes semantic and sidecar. Prior art: existing tests in `floe-web/tests/`.
- Bridge actor field-edit test (`floe-bridge`, vitest, fake/recorded adapter). Covers scenarios 7–8: a Floe actor instance uses its ordinary file-read tool to read `.floe/fields/<id>.yaml` and reports items + connections; the same actor uses its ordinary file-edit tool to add an item; the bus watcher picks up the edit; the bus's field index reflects the change. Prior art: `floe-bridge/src/adapters/pi-agent-core-adapter.test.ts`.

### Live one-off pass

After all automated suites are green, run a single end-to-end live pass against the user's local environment with a real model provider: bus + bridge + FloeWeb up, sample-project workspace open, Floe agent receives a chat instruction to inspect and then edit a Field. Capture screenshots and the runtime transcript into `docs/evidence/field-block-slice/`. This satisfies the AGENTS.md "live proof" gate without forcing real-provider runs into CI.

## Out of Scope

- No `floe-cli` field subcommands.
- No new actor tools (`field_list`, `field_add_item`, `field_connect`, `field_remove_item`, etc.). The runtime-actor proof uses ordinary file-read / file-edit tools.
- No relationship ontology. Connection `label` and `metadata` remain free-form workspace text.
- No permission model; no field-as-permission-boundary; no field-as-runtime/session-boundary.
- No domain-specific block types (kanban, approvals, review queues, dashboards, channels, group chat, etc.).
- No FloeWeb pickers for non-actor / non-field Item kinds in this slice. Adding pickers per ref kind is a follow-on slice family (substrate↔FloeWeb parity).
- No move of existing primitives into a `.floe/blocks/` tree. Actors, contexts, pulses, webhooks, extensions stay where they are.
- No migration of any existing FloeWeb `localStorage` `FieldBlock` data; clean break.
- No bridge changes in this slice; the bridge does not own field file I/O.
- No multi-workspace concurrency hardening beyond what chokidar gives by default; pathological concurrent-writer scenarios are out of scope.
- No conflict resolution UI for concurrent edits. Last write wins; the WS broadcast tells every client to re-render.
- No history/audit-log surface for field changes (work-log integration for field edits is a candidate for the audit-primitives slice later).
- No public extension hook for field events. (`field.upserted` / `field.deleted` go to existing WS subscribers only.)
- No GraphQL, no JSON-RPC, no alternative API shapes — REST + WS over the existing bus surface only.

## Further Notes

- The brief makes a point of this slice being the *substrate proof* for Fields, not the *finished product surface*. The temptation to ship pickers for every Item kind in FloeWeb should be resisted. Substrate↔FloeWeb parity for each remaining Item kind (context, file, extension, pulse, webhook, tool, work_log) is a follow-on slice family and will likely be sequenced after the lifecycle slices that make those primitives easier to list and select.
- `ref:` strings deliberately reuse existing stable substrate ids (no new id schemes). If a primitive's stable id format ever changes, fields will hold stale refs; clients render them as broken; the cure is to edit the YAML or use whatever future tool exists.
- The decision to keep file I/O in the bus (rather than introducing a new bus↔bridge command channel) is a pragmatic choice for this slice and can be revisited later without changing the HTTP contract. Documented in `docs/adr/0003-field-substrate-primitive.md`.
- Existing v58 boundary rules carried forward verbatim: FloeWeb never touches `.floe/` directly; agents do not have a parallel runtime path around the bus; the bus is the only API surface FloeWeb consumes.
- After this slice merges, ROADMAP §2 should advance from "framing locked" to "first slice complete" and the follow-on slice family (substrate↔FloeWeb parity for each Item kind) should be enumerated.
