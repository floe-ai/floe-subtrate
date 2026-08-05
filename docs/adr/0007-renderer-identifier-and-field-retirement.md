# ADR-0007: Renderer identifier and Field retirement

**Status:** accepted (2026-08-05)

## Context

The layout sidecar identified the Floe app renderer as `floeweb` and used a schema and property inherited from the retired Field model. That made renderer-specific arrangement state look like a separate substrate representation.

## Decision

The Floe app renderer discriminator is `floe-app`. It remains a renderer discriminator: layout routes and filenames retain the renderer parameter so additional renderers can be introduced without changing the layout model.

Field is retired. A visual representation of a substrate primitive uses that primitive's own name; no separate user-facing rendering vocabulary is introduced. A Scope is rendered as a Scope.

Renderer-specific saved arrangement state is named Scope Projection Layout. Its schema is `floe.scope-projection.layout.floe-app.v1` and its identifying property is `scope_id`.

## Consequences

Existing saved layout sidecars are discarded. The pre-release product has no compatibility or migration path for the old schema, renderer name, property, or `.floe/fields/` fallback.

ADRs 0003 and 0004 remain unchanged as superseded decision records. ADR-0005 remains unchanged because its file-access decision is unaffected; its historical frontend spelling does not define this renderer discriminator.
