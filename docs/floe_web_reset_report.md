# Floe Web Reset Report

## Summary

This pass realigns `floe-web` with `floe-init.md` v58 and `docs/floe_web_product_spec.md`.

The change is a product/UI reset inside the existing service skeleton, not an empty-repo rebuild. That follows the v58 handoff: keep the viable bus, bridge, web, workspace, endpoint, and event scaffolding unless the pivot fails quickly.

## Kept

- Existing `floe-web` to `floe-bus` API path.
- Existing workspace register/select calls.
- Existing `.floe/` initialization consent flag passed through workspace registration.
- Existing human endpoint registration from the web UI.
- Existing message submission through `/v1/events/emit`.
- Existing runtime profile/model binding API.
- Existing event, telemetry, and runtime status reads.

## Rebuilt

- Replaced the chat-first shell with Workspace Home, Field Block creation, opened Field Surface, Inspector, and right Channel.
- Renamed product framing from project-oriented UI to Workspace-oriented UI.
- Made Floe the global Channel, not a Block or Field actor.
- Removed default visual actor placement from the Field model.
- Added React Flow as the canvas runtime for opened Field Surfaces.
- Rewrote `PRODUCT.md` so the impeccable context matches v58 and the new product spec.

## Collisions And Decisions

### Greenfield wording

The web spec/request suggested restarting from scratch, but `floe-init.md` says not to restart from an empty repository unless the pivot fails quickly.

Decision: hard-reset the `floe-web` experience while preserving the existing service split and API paths.

### React Flow UI stack

`https://reactflow.dev/ui` currently assumes shadcn/ui and Tailwind CSS. The current `floe-web` package is React 18 with hand-written CSS and no Tailwind/shadcn system.

Decision: install and use `@xyflow/react` for the Field canvas now. Do not migrate to the full React Flow UI/shadcn/Tailwind stack until we explicitly decide on that design-system migration.

### Product-layer persistence

The product spec wants portable Field state stored under `.floe/`, likely under `.floe/web/`. Current APIs do not expose a product-layer artifact service that can read/write `.floe/web/` through bus/bridge without browser-direct file writes.

Decision: Field Blocks are currently local browser draft state so the UI loop can be exercised without violating browser-direct workspace writes. This is not the final persistence model.

Required follow-up: add a substrate-aligned product artifact API, probably mediated through bus events and bridge-owned workspace file access, then persist Field Blocks under a readable `.floe/` subpath.

### Existing contract drift

`docs/contracts.md` still mentions Copilot-first and `yield` semantics. That conflicts with `floe-init.md` v58.

Decision: leave it untouched in this UI pass, but treat it as stale documentation that needs a substrate-doc cleanup.

## First Slice Status

Implemented:

- Create/open Workspace through existing bus registration.
- Workspace Home as the first post-open surface.
- Field Block creation and naming.
- Field Block opening into a React Flow canvas Surface.
- Breadcrumb from Workspace to opened Field.
- Inspector for Workspace, Field, runtime, and actor access summaries.
- Right Channel for Floe, closed by default.
- Floe messages through existing event substrate.
- Runtime missing-state prompts.
- No default human, agent, or Floe Blocks on the canvas.
- No speculative Block types in the first Block Library.

Not complete yet:

- Portable `.floe/` product-layer persistence for Fields.
- Service-owned product artifact read/write API.
- Nested Fields and additional Block types.
- Agent channel selector beyond the default Floe Channel.
- Advanced trust view for deliveries, pending responses, and telemetry.

## Next Smallest Backend Step

Add product artifact endpoints without letting browser code write workspace files directly:

1. Define `.floe/web/fields.yaml` or `.floe/web/workspace.yaml` as the first readable artifact.
2. Add bus API requests for product artifact load/save.
3. Have bridge service the file operations for authorized attached workspaces.
4. Keep browser UI limited to API calls.
5. Update Field creation to persist through that path instead of local browser draft state.
