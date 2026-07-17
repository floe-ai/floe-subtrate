# substrate-build

Deep reference for inspecting, composing, and extending the Floe substrate. Use this when someone asks
you to add a capability, build an extension, wire an MCP, or understand how Floe is built. Compose
before you code; keep the substrate general.

## The layering (preserve the daemon boundary)

- **floe-bus** owns durable routing state: contexts, events, threads, participants, subscriptions,
  deliveries, pulses, scopes. It PUSHES to subscribers; nothing polls it.
- **floe-bridge** owns runtime adaptation: it embodies actors (runtimes), fires hooks, assembles
  prompts, and initializes the `.floe/` workspace template.
- **floe-app** owns the human operator experience. It is one client over the substrate; it holds no
  substrate state of its own.

Never route around this boundary or push substrate state into the client.

## Compose primitives first (usually no code)

Most needs are met with existing primitives:

- **Contexts** — bounded streams for a piece of work; open one and add the participants who should be
  woken.
- **Scopes** — the intentional organising boundary for connected/operational work (`scope_id` on
  scoped primitives; actorless contexts must be scoped; there is no Default Scope).
- **Events + emit** — all coordination is canonical events; `emit` is the only way to communicate.
- **Pulses** — bus-owned scheduled events (cron or one-off) delivered to subscribers; the way to
  schedule recurring or future work without polling (see `docs/adr/0001-pulse-scheduled-event-delivery.md`).
- **Workspace files** — durable truth; read and write them with file tools.

Explain the composition to the user so they learn the substrate instead of depending on bespoke code.

## Write a code extension only as the escape hatch

Reserve extensions for genuinely new capability (external I/O, computation, a new tool surface). An
extension is a `.floe/extensions/NAME/` folder with:

- `extension.json` — the manifest (`floe.extension.v1`): metadata, capabilities, optional pulse
  declarations.
- a TypeScript entry `export default function(ctx: ExtensionContext): AgentTool[]` — returns agent
  tools (auto-prefixed with the extension name, so `add` becomes `name_add`) and may register
  programmatic hooks via `ctx.hooks.on(...)`. `ctx` provides `workspacePath`, `busClient`,
  `workspaceId`, and `extensionName`.
- binding — add the extension to an actor's frontmatter `extensions: ["name"]`.

Hooks that can fire: `SessionStart`, `SessionResume`, `BeforeTurn` (can inject prompt context via a
returned `inject`), `Pulse`, `TurnEnd`, `Error`, `BeforeToolUse`, `AfterToolUse`, `ToolUseFailed`,
`SessionEnd`, `WebhookReceived`. Registration and firing are separate: a registered hook only runs when
the bridge/runtime fires that lifecycle point. See `docs/adr/0002-extension-substrate-design.md`.

## MCP

Runtime-native MCP profiles are referenced or copied under `.floe/mcp/`. Use one to give an actor an
external tool server when a capability is better served by an existing MCP than by a bespoke extension.

## Keep it substrate-first and thin

Before adding any machinery, apply the two `MISSION.md` tests:

- **Redundancy test** — would a 10x better model make this unnecessary? If yes, do not build it.
- **Actor-generality test** — is it useful to an actor that never opens the UI (an agent, a webhook
  processor, a headless script)? If only the UI needs it, it is client code, not substrate.

Check whether the workspace filesystem and typed events already cover the need. Extensions stay thin:
file formats + config + minimal glue, never a parallel state machine beside the substrate.

## Where the canonical knowledge lives

`CONTEXT.md` (terminology and invariants), `docs/adr/` (accepted decisions), `docs/architecture/`,
`MISSION.md` (intent and the tests), and `docs/floe_thought_log.md` (current direction). Canonical
documents govern: where a plan, PRD, or roadmap conflicts with `CONTEXT.md` or an accepted ADR, the
canonical document wins — surface the conflict, do not follow the stale side. Read what you need; be
precise and token-frugal.

## Tests

If you write tests, they must NEVER make live LLM calls — use fixtures or injected doubles only.
