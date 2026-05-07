# Product

## Register

product

## Users

Floe Web is for local operators and builders who are setting up, shaping, and operating portable Floe workspaces.

They are not looking for a chat app, a project tracker, or a runtime debug console. They need a clear interface for creating or opening a Workspace, adding Field Blocks, inspecting what is configured, and talking to Floe through the substrate path. They may later compose richer Blocks, extensions, agents, hooks, and surfaces, but V0 should make the first workspace loop understandable before expanding the model.

The primary user is technical enough to understand folders, providers, runtime profiles, and portable configuration. The interface should still protect them from substrate leakage unless they deliberately inspect advanced state.

## Product Purpose

Floe Web is the human/operator interface for Floe V0.

Its job is to let a user operate a portable Workspace without bypassing the substrate:

- create or open a Workspace
- consent to `.floe/` initialization
- reach Workspace Home
- create a Field Block
- open the Field into a canvas Surface
- inspect Workspace, Field, runtime, and actor access state
- open the global Floe Channel
- send messages to Floe through `floe-bus` and the default runtime-backed endpoint

Floe Web succeeds when the user understands this mental model:

> I have a portable Workspace. A Field is a Block that opens into a canvas. Actors are humans or agents with access, not objects I drag onto the canvas. Floe is the always-available system interface, not a Field actor or Block.

## Source Of Truth

`floe-init.md` is authoritative for substrate semantics.

Floe Web must preserve these v58 decisions:

- `floe-bus` owns events, endpoints, deliveries, pending responses, broadcasts, pulse, workspaces, and observability.
- `floe-web` talks to `floe-bus`; browser code does not read or write workspace files directly.
- `floe-bridge` owns runtime embodiment and `.floe/` template initialization.
- V0 uses Pi lower layers through the bridge where feasible.
- `emit` is the required runtime primitive; V0 must not reintroduce held `yield` or runtime keepalive semantics.
- Floe Web must not create a direct runtime path around `floe-bus` and `floe-bridge`.
- The Pi coding-agent extension is later operator-shell work, not the V0 foundation.

If product-layer ideas conflict with `floe-init.md`, keep `floe-init.md` unless the handoff is intentionally revised.

## Brand Personality

calm, spatial, durable, precise

Floe should feel like a quiet operating surface over a durable substrate. The floe metaphor should show up as spatial composition, light structure, and a sense that pieces can move without losing their identity. It should not become decorative ice imagery or a generic node-canvas spectacle.

## Product Model

Use these terms consistently:

- Workspace: the portable configuration container, usually a folder or repository containing `.floe/`.
- Workspace Home: the top-level product surface after a Workspace is opened. It is not a Field.
- Block: a user-composable product-layer object.
- Field: a Block type that opens into an infinite-canvas style Surface.
- Surface: how a Block renders. A Field renders as a canvas Surface.
- Inspector: configuration and state for the current selection.
- Channel: a right-side conversation pane.
- Floe: the global system interface available from any screen.
- Actor: a human or agent endpoint/participant with access. Actors are not Blocks.
- Agent: a runtime-backed actor configured through substrate-aligned agent files and runtime bindings.

Avoid using "Project" for the Workspace model. Avoid "Floe Assistant." Avoid treating Skills, MCPs, extensions, humans, agents, or provider profiles as default canvas Blocks.

## Design Principles

Composition is the primitive, but not everything belongs on the canvas. Fields are canvas-backed Blocks; actors, runtime profiles, event delivery state, hooks, and provider auth are configured or inspected through appropriate surfaces.

Start with the smallest real loop. The first useful product slice is Workspace -> Field Block -> Field Surface -> Floe Channel. Do not expose speculative Block types just because the canvas can render nodes.

Product layer respects substrate layer. UI actions should compile down to bus events, endpoint state, runtime bindings, or product-layer artifacts under `.floe/`, not create parallel runtime semantics.

Portable by default. Workspace-owned Floe product state belongs under `.floe/` in readable artifacts once the service API exists. Secrets, credentials, provider auth, and personal preferences remain local/provider-owned.

Calm surface, inspectable depth. Ordinary composition screens should stay focused and legible. Delivery records, pending responses, telemetry, hook results, and dead-letter state belong in trust/advanced views, not as the default experience.

No fake agents. Humans and agents are not rendered as default Blocks in a Field. Floe is not placed on the canvas.

## Design Direction

Floe Web is a product UI, not a landing page.

Use restrained color, stable layout, system typography, clear focus states, and standard controls. The interface should feel closer to a serious local design/build tool than a marketing SaaS dashboard.

The first viewport after a Workspace opens should communicate the actual product model:

- left: Workspace selection and local connection
- center: Workspace Home or opened Field Surface
- bottom or side: contextual Inspector, depending on available space
- right: Channel, closed by default until Floe is opened

Field canvas work should use React Flow / React Flow UI direction. In this repo, React Flow core can be adopted first; the full React Flow UI component stack requires a shadcn/Tailwind decision and should not be smuggled into the app without an explicit design-system migration.

## Anti-References

Do not make Floe Web feel like:

- ChatGPT with a sidebar
- a project-management board
- a fixed dashboard of metrics
- a debug console with a nicer skin
- an agent canvas where actors are draggable mascots
- a generic workflow automation builder
- a file explorer
- a demo UI that invents unsupported Blocks to look complete

## Accessibility & Inclusion

Target WCAG AA for the product interface.

The user must be able to navigate Workspace selection, Field creation, Inspector controls, and Channel messaging by keyboard. Focus states should be visible. Status should not rely on color alone. Motion must respect reduced-motion preferences.

The UI should use clear labels for destructive or substrate-affecting actions, especially `.floe/` initialization, runtime profile changes, and future artifact writes.
