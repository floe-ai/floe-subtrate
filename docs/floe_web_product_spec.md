# Floe Web Product Spec — Workspace, Blocks, Fields, and Floe

**Status:** Rewritten draft for builder planning  
**Scope:** Floe Web product/interface layer  
**Substrate reference:** Floe Substrate Builder Handoff v58  
**Primary goal:** define the next Floe Web direction without redefining or conflicting with the v58 substrate.

---

## 0. Authority and alignment

The Floe Substrate Builder Handoff v58 remains authoritative for substrate semantics.

This spec describes the product/interface layer that sits above the substrate. It must not redefine:

- `floe-bus`
- `floe-web`
- `floe-bridge`
- event envelopes
- `emit`
- pending responses
- delivery state
- pulse
- public hooks
- agent file format
- Pi runtime composition
- the existing `.floe/` structure already defined by v58

When this spec conflicts with v58, preserve v58 unless the product design explicitly requires a revised handoff.

Floe Web must not bypass `floe-bus`, create a runtime path outside `floe-bridge`, invent a parallel event model, or directly write workspace files from browser UI code.

---

## 1. Product intent

Floe Web should not feel like:

- a chat app
- a project-management tool
- a debug console
- a file explorer
- a fixed dashboard

Floe Web should feel like:

> A visual interface for composing, configuring, and operating a portable Floe workspace.

The user should be able to open a workspace, create a Field, talk to Floe, and evolve the workspace from an initially minimal state into a richer environment of blocks, agents, extensions, surfaces, and behaviours.

---

## 2. Core model

### 2.1 Local Floe install

The local Floe install is adjacent to workspaces. It is not the parent of workspaces.

It provides local/user-specific capability and state:

- app installation
- local user session
- provider authentication
- runtime profiles
- personal/global extensions
- personal/global skills/MCPs
- personal agent templates
- preferences
- recent workspace references

A workspace can exist without a local Floe install, but it cannot operate on that machine until Floe is installed and configured.

### 2.2 Workspace

A Workspace is the portable configuration container.

A Workspace is usually a folder or repository containing `.floe/`.

The Workspace is the thing a user shares, clones, opens, or later hosts.

A Workspace may contain:

- workspace-level configuration
- fields
- block definitions and instances
- actors/agents
- extension declarations
- skills/MCP declarations
- hooks/events configuration
- connections
- portable layout/config
- references to required local profiles

A Workspace must not contain credentials or secrets. It may reference local profile names, provider names, model names, or runtime profile names, but the auth itself remains local/provider-owned.

### 2.3 Blocks

Inside a Workspace, everything user-composable is represented as a Block.

This is the core product abstraction.

A Block can be:

- placed on a surface
- nested inside another Block
- rendered with a custom Surface
- configured with Properties
- connected through Ports
- capable of exposing Slots for child Blocks
- powered by core Floe behaviour or an extension

This does not mean substrate records are literally blocks. The substrate still owns events, endpoints, deliveries, pending responses, pulse, webhooks, telemetry, and runtime state. Floe Web may surface some of those concepts as Blocks, Activity, Inspectors, or Trust views where useful.

### 2.4 Primitive

A Primitive is a Block type.

A Primitive defines:

- what kind of Block it creates
- where that Block can live
- what child Blocks it accepts
- what Ports it exposes
- what Properties configure it
- what Surface renders it
- what substrate capabilities it requires
- what extension, if any, contributed it

The user may see this as a Block type in the Block Library. Builders may see it as a `PrimitiveDefinition`.

### 2.5 Field

A Field is not a special top-level container.

A Field is a Block type.

A Field Block renders as an infinite-canvas style Surface and can contain other Blocks.

A Field may appear:

- directly inside the Workspace Home
- inside another Field
- inside another compatible Block later
- adjacent to other Field Blocks
- as a full-screen opened Surface

Opening a Field Block creates a deeper navigation context.

Example breadcrumb:

- Workspace: Floe Development
- Field: Image Pipeline
- Field: Validation Lab
- Block: Artifact Bin

The breadcrumb represents depth through Blocks, not a fixed workspace/project hierarchy.

### 2.6 Surface

A Surface is how a Block renders.

Surface is not a synonym for Field.

Examples:

- Field Block → infinite canvas Surface
- Document Block → markdown/document Surface
- Artifact Bin Block → gallery Surface
- Task Board Block → board Surface
- Web App Output Block → live preview Surface
- Agent configuration view → inspector/channel UI, not necessarily a Block

A Surface can be simple, full-screen, embedded, zoomable, or extension-provided.

### 2.7 Actors

Actors are not Blocks.

Actors are participants/endpoints with permissions and configuration.

Actor types include:

- human
- agent

Actors may exist at:

- local Floe install level
- Workspace level
- Field/block permission level
- substrate endpoint level

A human or agent should not be represented as a default Block on a Field.

Actors can be granted access to a Workspace, Field, or Block. Access should apply to descendants, but not automatically to siblings or parents.

For V0, permissions may be minimal and local-admin-like. The concept should still be preserved in the design so the product does not collapse actors into visual Blocks.

### 2.8 Floe

Use **Floe**, not “Floe Assistant”.

Floe is the global system interface.

Floe is not a Field actor.  
Floe is not a Block.  
Floe is not assignable to a Field.

Floe is available from any screen and helps the user configure, understand, and extend the Workspace.

In local V0, Floe may effectively access the same local files and Workspace context the current user can access. Permission scoping can become stricter later for hosted/team modes.

Floe should be able to:

- explain the current screen
- configure a Workspace
- create or open Fields
- help define Blocks and extensions
- explain substrate status
- troubleshoot provider/runtime setup
- start new threads with minimal current context
- act as the user’s interface to the Floe system

### 2.9 Skills, MCPs, and agent capabilities

Skills and MCPs are not Blocks by default.

They are agent-level capabilities as defined by the substrate/runtime configuration.

Floe Web may expose them through:

- agent configuration screens
- workspace settings
- extension-managed configuration
- inspector sections
- later, extension-provided Blocks if deliberately designed that way

But the default model should not treat Skill or MCP as canvas Blocks.

### 2.10 Extensions

Extensions are not only Blocks.

An extension can be anything executable or declarative that Floe can safely support.

An extension may:

- handle hooks
- run TypeScript or other code
- run commands
- call HTTP APIs
- provide tools
- provide MCP integrations
- manage memory
- emit events
- send messages
- render UI
- define Block types
- provide custom Surfaces
- provide inspector sections
- provide activity renderers
- provide non-visual behaviour

A Block is one possible UI contribution from an extension, not the definition of an extension.

The UI should only show extension contributions where the extension declares they belong.

---

## 3. Product vocabulary

Use these terms consistently.

### User-facing

- Workspace
- Field
- Block
- Block Library
- Surface
- Inspector
- Channel
- Activity
- Floe
- Actor
- Human
- Agent

### Technical/product-layer

- Primitive
- Slot
- Port
- Connection
- Property
- Renderer/Surface
- Workspace artifact
- Permission
- Actor access

### Avoid as user-facing terms

- Attachment
- Project
- Role, unless later intentionally designed
- Workspace as local app environment
- Field as fixed top-level hierarchy
- Floe Assistant

---

## 4. Out-of-box experience

### 4.1 No workspace exists

When the user first opens Floe Web and no Workspace is registered, show a minimal screen with one primary action:

- Create Workspace

Secondary actions may include:

- Open existing Workspace
- Import existing `.floe/` Workspace

Do not show a Field or Block Library yet.

### 4.2 Create/open Workspace

The user chooses a local folder/repository location.

If the location already contains a valid Floe Workspace, Floe Web should pre-fill what it can and show any required setup.

If not, Floe Web should guide Workspace creation and `.floe/` initialisation through the existing substrate-aligned flow.

Workspace setup may include:

- Workspace name
- storage location
- provider/model/runtime default references, if available
- missing local auth/profile prompts
- default Floe endpoint recovery/setup if needed

Authentication itself remains local/provider-owned.

### 4.3 Workspace Home

After opening a Workspace, the user lands on Workspace Home.

Workspace Home is not a Field.

It is the top-level product surface for the Workspace.

In the first minimal slice, Workspace Home can be almost empty.

The first Block type available should be Field.

The user can create a Field Block.

### 4.4 Create Field Block

Creating a Field Block requires at least:

- name

The Field Block appears on Workspace Home.

Opening the Field Block shows its canvas Surface.

### 4.5 Empty Field

The empty Field Surface contains:

- top breadcrumb
- empty canvas
- contextual Block Library
- bottom Inspector
- right Channel closed by default

No default human Block.  
No default agent Block.  
No default Floe Block.  
No fake global capability store.

Floe is available through the global Channel.

---

## 5. Navigation and depth

### 5.1 Breadcrumb

The breadcrumb represents the current depth through Blocks.

Example:

- Workspace
- Field
- Field
- Document
- Artifact Bin

Clicking a breadcrumb returns to that depth.

### 5.2 Opening Blocks

Every Block can define what happens when opened.

Possible behaviours:

- select only
- open in full-screen Surface
- zoom into nested content
- open a document-like view
- open a gallery or app preview
- open an extension-provided Surface

For V0, Field Blocks should open into an infinite canvas Surface.

Other Block open behaviours can come later.

### 5.3 Selecting Blocks

Selecting a Block updates the Inspector.

If the selected Block has a Channel or actor-related conversation context, it may also update or open the right Channel, but this is not required for every Block.

---

## 6. Actors and permissions

### 6.1 Actors are configured separately from Blocks

Actors are not created by dragging Actor Blocks into a Field.

Actors should be configured at the Workspace/system level and granted access to Workspace, Field, or Block scopes.

For V0, this may be minimal and may rely on existing endpoint/agent configuration.

### 6.2 Access scope

Access should follow containment.

If an actor has access to a Block, it can see/operate on that Block’s descendants.

It should not automatically see siblings or parents unless granted access at that level.

Examples:

- Workspace access → actor can access every Field/Block in the Workspace.
- Field access → actor can access that Field and descendants only.
- Block access → actor can access that Block and descendants only.

### 6.3 Assignment

Assignment is not part of V0.

Do not introduce assignees or task ownership as a core product model.

Assignments may be added later through an extension.

### 6.4 Agent configuration

Agents continue to use the substrate-defined agent configuration.

Floe Web may provide configuration UI for agents, but should not redefine the agent file format.

Agent configuration may include:

- name/label
- instructions
- provider/model/runtime override
- skills
- MCP references
- extensions
- hooks/pulse configuration where supported

Agent access to Fields/Blocks should be represented as permissions/access, not visual placement on the canvas.

---

## 7. Channels

### 7.1 Channel pane

The right pane is the Channel pane.

It can be closed or minimised at any time.

It opens when the user opens Floe or enters a compatible conversational context.

### 7.2 Floe channel

Floe is the default system-level Channel.

Floe can be opened from any screen.

Floe should show a clear header:

- Floe
- System

Floe can start a new thread with minimal context from the current screen. The user can ask it to include more context if needed.

### 7.3 Agent channels

Agent channels are not opened by clicking Actor Blocks because actors are not Blocks.

The UI needs an actor/channel selector or access panel where the user can open a channel to an agent that has access to the current scope.

Possible V0 approach:

- top/right Channel button
- list available actors for current Workspace/Field/Block
- select an agent
- Channel opens with that agent context

Messages to an agent must map to the existing event/message substrate.

### 7.4 Channel replacement

Opening a new Channel replaces the right pane context.

Closing the pane hides the current conversation.

Closing the pane should not change the current selected Block.

---

## 8. Inspector

The Inspector configures the current selection.

It is not chat.  
It is not Floe.  
It is not the full event log.

### 8.1 Workspace Home selected

Show:

- Workspace name
- location
- `.floe/` status
- provider/model/runtime defaults
- available actor access summary
- available Field Blocks
- setup health

### 8.2 Field Block selected

Show:

- Field name
- Field path/location within product-layer storage
- child Blocks count
- actor access summary
- open Field action
- portable/local status
- surface settings

### 8.3 Block selected

Show:

- Block type
- name
- properties
- child Blocks
- ports/connections
- actor access summary
- surface options
- activity summary
- trust/advanced summary, where relevant

### 8.4 Actor access configuration

Actor access may be shown from the Inspector for Workspace, Field, or Block scopes.

V0 may show this as read-only or minimal.

Do not model actors as Blocks.

---

## 9. Block Library

The Block Library is contextual.

It shows Block types compatible with the current surface/selection.

### 9.1 Workspace Home

For the first minimal slice, the only prescribed Block type is:

- Field

Do not prescribe more until the builder investigates current code and confirms what should be exposed.

### 9.2 Inside a Field

The builder should investigate current code and substrate capabilities before exposing additional Block types.

Possible future Block types may include:

- Context Source
- Group
- Event
- Webhook
- Document
- Task Board
- Artifact Bin
- extension-provided Blocks

But the spec should not require these in the first slice unless current implementation supports them.

### 9.3 Extension-provided Blocks

Extensions may contribute Block types.

Those Block types should appear only where compatible.

A contributed Block type may also have:

- custom Surface
- properties
- hooks
- ports
- required actor capabilities
- event behaviour
- non-visual extension behaviour

---

## 10. Block model

### 10.1 Block instance

A Block instance should minimally represent:

- id
- primitive/type id
- label/name
- parent location
- properties
- child Blocks
- ports/connections
- surface/rendering information
- persistence/ownership
- access/permissions reference

### 10.2 Nesting

Blocks can live inside Blocks.

A Document Block might contain inline child Blocks.

A Field Block contains Blocks on a canvas Surface.

A Task Board Block might contain Task Blocks.

The storage model should preserve readability as much as practical.

### 10.3 Slots

Slots define where child Blocks can fit.

A Block may expose zero or more Slots.

A child Block may fit some Slots and not others.

The UI should use compatibility rules to prevent invalid nesting.

### 10.4 Ports and connections

Ports define explicit typed inputs/outputs.

Connections should be used when relationship matters, not for implicit membership.

Examples:

- Event output connects to handler input.
- Generated artifact connects to validation input.
- Field-to-field coordination connects through explicit future behaviour.

### 10.5 Properties

Properties are configuration values.

Examples:

- name
- description
- prompt text
- path
- model override reference
- event response expectation
- surface setting

Properties are not child Blocks.

---

## 11. Storage and persistence principles

The builder should not overfit storage before inspecting the current codebase.

However, the following principles should guide the design.

### 11.1 Store under `.floe/`

All portable Workspace-owned Floe configuration should live under `.floe/`.

Do not create `.floe-web/`.

### 11.2 Do not redefine existing v58 files

Do not replace or conflict with existing v58-defined files/folders.

If product-layer files are required, add them under a clearly separated `.floe/` subpath.

A likely location is `.floe/web/`, but the builder should confirm after inspecting current code.

### 11.3 Prefer readable text artifacts

Prefer text-based, Git-readable artifacts over opaque databases.

Acceptable directions include:

- YAML
- Markdown with YAML front matter
- small linked files
- readable graph/index files
- block files that can be inspected and diffed

Avoid one massive unreadable graph file if it harms Git review and portability.

### 11.4 Let block type influence storage

A Block’s storage may depend on its Surface/type.

Examples:

- Field Block may store layout/canvas data.
- Document Block may store Markdown with YAML front matter.
- Task Board Block may store a readable board/task structure.
- Web App Output Block may store metadata and references to generated artefacts.
- Extension Blocks may define their own storage needs.

The first implementation does not need to solve all of this. It only needs a minimal, readable storage path for Workspace Home and Field Block creation.

### 11.5 Browser UI must not write files directly

Floe Web browser code should request substrate/product-layer services to load, validate, patch, and write Workspace artifacts.

---

## 12. Extension model

### 12.1 Extension breadth

An extension can be anything Floe can safely support.

It can:

- define Block types
- define Surfaces
- run hooks
- run scripts
- call APIs
- provide tools
- provide MCP integrations
- emit events
- provide activity renderers
- modify/produce artifacts
- expose inspector UI
- operate with no visual Block at all

### 12.2 Block is only one UI contribution

Do not assume every extension becomes a Block.

An extension may contribute:

- a Block type
- a Surface for a Block
- an action
- a hook handler
- an activity renderer
- an inspector section
- an agent capability
- a non-visual service

### 12.3 Minimal V0

For V0, extension UI should be minimal.

Do not build broad extension authoring or arbitrary action running before the basic Workspace → Field → Floe loop works.

Floe can eventually help author extensions, but the first slice should focus on the user being able to create a Workspace, create a Field Block, and talk to Floe.

---

## 13. Activity and trust

### 13.1 Activity

Activity is the user-facing rendering of events and changes.

It can include:

- messages
- emits
- progress updates
- requests
- broadcasts
- webhook events
- state changes
- runtime summaries
- errors
- extension activity

Activity should not dominate the first screen.

### 13.2 Trust/advanced visibility

Trust/advanced views may later show:

- endpoint state
- event envelope
- delivery state
- pending response
- runtime injection/acknowledgement
- telemetry
- hook/action result
- errors/dead letters

These must align with v58 and must not expose hidden chain-of-thought.

---

## 14. Builder investigation requirements

Before implementation, the builder must inspect the current codebase and report findings.

The report should answer:

1. How current `floe-web` registers/selects workspaces.
2. How `.floe/` creation consent and initialisation currently work.
3. Which process currently owns workspace file writes.
4. How the default `floe` agent endpoint is registered and addressed.
5. How a browser-originated message currently reaches the `floe` endpoint.
6. What existing runtime/profile/model configuration UI and APIs exist.
7. What current agent configuration files support.
8. What extension/skills/MCP parsing exists today.
9. What hooks/pulse/webhook support is actually implemented versus planned.
10. What local product-state persistence exists.
11. What file/artifact APIs exist or need to be added for Floe Web product-layer state.
12. What current React route/component structure can be reused.
13. Whether `.floe/web/` is the right location for product-layer files or whether another under-`.floe/` path is more consistent.
14. What minimal storage format should be used for the first Field Block and Workspace Home state.
15. Which Block types should be exposed in the Block Library for the first slice.

The builder should propose the smallest implementation that satisfies the V0 acceptance criteria without inventing broad extension infrastructure.

---

## 15. V0 implementation slice

The first useful slice is intentionally small.

### Must have

- Create/open Workspace from Floe Web.
- Workspace uses existing v58-compatible `.floe/` structure.
- Workspace creation/opening uses existing substrate-aligned services, not browser-direct file writes.
- Workspace Home opens after setup.
- User can create a Field Block.
- User can open the Field Block into an empty canvas Surface.
- Breadcrumb shows Workspace → Field.
- Right Channel can open Floe.
- User can chat to Floe.
- Floe message path uses existing event/message substrate and default `floe` endpoint where available.
- Workspace/provider/model/runtime missing-state prompts are visible where needed.
- Basic Inspector shows Workspace Home or Field Block state.
- Product UI avoids project-management framing.
- Product UI does not show actors as Blocks.
- Product UI does not prescribe unsupported Block types.

### Should have

- Minimal Block Library.
- Field Block naming/editing.
- Field Block persistence in a readable product-layer artifact.
- Close/minimise Channel.
- Basic activity summary for Floe chat, if available from current substrate.
- Builder report documenting kept/reused/added code.

### Later

- Additional Block types.
- Nested Field Blocks.
- Document Blocks.
- Custom extension-provided Blocks.
- Field/Block permission UI.
- Agent channel selector.
- Rich actor access configuration.
- Multi-field navigation.
- Cross-field connections.
- Extension authoring through Floe.
- Custom Surfaces.
- Trust/advanced substrate explorer.

---

## 16. Acceptance criteria

The V0 Floe Web product slice is acceptable when:

1. A user can create or open a Workspace.
2. The Workspace uses the v58-compatible `.floe/` structure.
3. The user can reach Workspace Home.
4. Workspace Home does not assume a project hierarchy.
5. Workspace Home can create a Field Block.
6. A Field Block can be named.
7. A Field Block can be opened into an empty canvas Surface.
8. Breadcrumb shows the user’s current depth.
9. The right Channel can open Floe.
10. The user can send a message to Floe through the existing substrate path.
11. Floe is not rendered as a Block.
12. The current human user is not rendered as a default Block.
13. Actors are treated as permissions/endpoints/configuration, not canvas Blocks.
14. The first Block Library does not expose unsupported or speculative Block types.
15. Workspace/provider/model/runtime setup gaps are surfaced clearly.
16. Portable product-layer state is stored under `.floe/` in a readable format chosen after codebase investigation.
17. No `.floe-web/` sibling folder is introduced.
18. Browser UI code does not write workspace files directly.
19. The builder report explains storage decisions and how they align with v58.
20. The builder report identifies the next smallest Block type or extension point to implement after Field.

---

## 17. Product principle

Floe Web should make composition the primitive, without forcing everything into the canvas.

The user should feel:

“I have a portable Workspace. Inside it, I can create Blocks. A Field is a Block that opens into a canvas. Actors are people or agents with access to parts of the Workspace. Floe is always available to help me configure, understand, and extend the system.”
