# Field as substrate primitive

**Status:** superseded by ADR-0004 (2026-05-22)

This ADR records an implemented intermediate slice, but it no longer guides future Field/Block work. The corrected model is that Scope is the substrate organising boundary and Field is the FloeWeb rendering/projection of a Scope; field-owned item and connection lists are superseded.

## Context

The roadmap calls for a "block model" for substrate representation. An earlier framing treated *blocks* as a parallel storage category — implying actors, pulses, webhooks, etc. would move into a `.floe/blocks/<kind>/` tree. That framing duplicates the substrate and forces every primitive to fit a single storage shape.

## Decision

Introduce **Field** as a new substrate primitive. A Field groups stable references (Field Items) to existing substrate primitives and records minimal `from → to` connections between them. "Block" remains a representational concept — how a client renders a Field Item — not a storage category.

Concretely:

- Semantic source of truth: `.floe/fields/<field-id>.yaml` (schema `floe.field.v1`).
- Renderer layout: separate sidecar `.floe/fields/<field-id>.layout.<renderer>.yaml` (e.g. `.layout.floeweb.yaml`).
- Field Items hold a field-local `item_id` plus a stable URI-style ref `<kind>:<id>` pointing to an existing substrate primitive.
- Field Connections are `{ id, from, to, label?, metadata? }`; `label` is free-form and is not interpreted by core.
- Bus owns the HTTP API and file I/O for fields, watches `.floe/fields/` for external changes, and broadcasts `field.upserted` / `field.deleted` on the existing event stream. The bus index is derived from the files — the files are authoritative.
- FloeWeb is one renderer/editor over substrate state. Removing FloeWeb does not destroy a field's meaning.
- Existing substrate primitives (actor, context, pulse, webhook, extension, file, tool, work log, event) keep their existing storage and stable refs. Fields only reference them.

## Considered options

- **Universal `.floe/blocks/<kind>/<id>.yaml` storage.** Rejected — it would duplicate the substrate and force unrelated primitives into a single storage shape, breaking the model already in place.
- **Bus SQLite as source of truth with optional file export.** Rejected — the brief requires workspace files to be authoritative so a field remains meaningful outside FloeWeb and outside any running bus instance.
- **Single per-field YAML with renderer layout inline under a namespaced subtree.** Rejected — couples layout churn to the semantic file and tempts conflation; the brief explicitly requires layout to be separable from semantic data.
- **Bridge-owned file I/O with new bus↔bridge command channel.** Deferred — the bus already exposes the only API surface FloeWeb talks to and already knows each workspace's path. Bus-owned file I/O for fields ships the slice cleanly; ownership can move to the bridge later without changing the HTTP contract.

## Consequences

- Fields can be created or edited entirely outside FloeWeb (any text editor, any actor with file-write tools); a chokidar watcher on `.floe/fields/` closes the loop and FloeWeb re-renders live.
- There is no relationship ontology, no permission model, and no domain-specific block types in this slice. Connection labels are free-form workspace metadata only.
- Future renderers (CLI, other clients) can add their own `.layout.<renderer>.yaml` sidecars without touching the semantic file.
- Future substrate primitives that need their own grouping/connection semantics can repeat the pattern (semantic file + renderer sidecar + bus index + watcher) but are not required to live under `.floe/blocks/`.
