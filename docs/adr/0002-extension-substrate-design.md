# ADR-0002: Extension substrate design — manifest, loading, and scope

## Status
Accepted

## Context
The Floe substrate needs an extension model so that agents can gain new capabilities beyond built-in tools. The PRD lists event types, tools, state, hooks, pulse behaviours, and work-log contributions as possible extension provisions. Pi (the runtime) has its own extension format (TypeScript factory functions with `ExtensionAPI`). We needed to decide: what IS a Floe extension, how is it shaped, loaded, and bound to agents?

## Decision

### Current scope: tools, pulse declarations, and programmatic extension hooks
Extensions provide agent tools, optional pulse schedule declarations, and programmatic Extension Hooks registered from TypeScript through `ExtensionContext.hooks.on(...)`. Event type declarations, dedicated state management, work-log contributions, and declarative YAML hook configuration remain deferred.

### Manifest format: extension.json
Extensions live in `.floe/extensions/NAME/` with a JSON manifest (`extension.json`) declaring metadata and capabilities. JSON was chosen over YAML because extensions contain TypeScript code — JSON is the natural companion (like `package.json`).

### Entry point: factory function returning AgentTool[]
The TypeScript entry exports `export default function(ctx: ExtensionContext): AgentTool[]`. This matches the existing internal pattern (pulse-tools, actor-tools are factories receiving context). The `ExtensionContext` provides `workspacePath`, `busClient`, `workspaceId`, `extensionName`, and `hooks.on(...)` for programmatic hook registration.

Rejected alternative: Pi-compatible `export default function(pi: ExtensionAPI)` — Pi extensions operate at runtime level (session lifecycle), while Floe extensions operate at substrate level (bus/bridge, cross-agent). The lifecycles don't align. Pi compatibility is a nice-to-have for later, not a current driver.

### Extension hooks: programmatic registration, bridge/runtime firing
Hook registration and hook firing are separate. An extension may register handlers while it is loaded, but a hook runs only when the current bridge/runtime path fires it. The public fired hooks are `SessionStart`, `SessionResume`, `BeforeTurn`, `Pulse`, `TurnEnd`, `Error`, `BeforeToolUse`, `AfterToolUse`, `ToolUseFailed`, `SessionEnd`, and `WebhookReceived`. `BeforeTurn` supports prompt/context injection via returned `inject` data; the other active hooks are observation hooks. `SessionEnd` fires when runtime sessions are replaced or disposed, and `WebhookReceived` fires from the real bus webhook ingest event path.

### Loading: on workspace attach (bridge-only)
The bridge discovers and loads extensions at workspace attach time, alongside agents and pulses. The bus is extension-unaware — extension-declared pulses are registered as normal pulses.

### Tool namespacing: auto-prefix
Extension tool names are automatically prefixed with the extension name (`todo_add`, `notes_search`) to prevent collisions. The extension author writes `name: "add"`, the agent sees `todo_add`.

### State: workspace-free
Extensions have no designated state directory. Extension tools read/write the workspace filesystem like any other agent tool. Structured extension state (SQLite, caches) can be added later if needed.

### TypeScript loading: dynamic import
The bridge runs under `tsx`, so `await import('./path/to/index.ts')` works natively. No new dependencies needed.

## Consequences
- `.floe/extensions/NAME/extension.json` becomes the extension manifest format
- Bridge gains extension discovery, loading, and tool injection logic
- Agent frontmatter `extensions: ["name"]` binds extensions to agents
- Extension-declared pulses flow through existing pulse infrastructure
- Programmatic Extension Hooks are part of the current extension substrate
- Declarative YAML hook configuration is future/not implemented
- Public hook names must have firing paths, typed payloads, and tests before being documented
- No bus schema changes needed
- Pi extension compatibility is deferred but not precluded
