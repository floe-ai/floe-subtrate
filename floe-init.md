# Floe Substrate - Builder Handoff v58

**Status:** V0 reset to substrate-first Floe with Pi lower layers as the runtime engine.

**Purpose:** define the next build direction after deciding not to make Pi the substrate and not to depend on Pi coding-agent as the V0 runtime path. Floe remains a durable multi-actor substrate. Pi is used where it is strongest: agent runtime/session/provider infrastructure.

This version supersedes the older held-wait/yield/Copilot-first direction.

---

## 1. Locked decisions

1. Floe remains an external durable substrate.
2. `floe-bus` remains the source of truth for events, endpoints, mailboxes, pending responses, broadcasts, pulse, webhook ingress, delivery records, workspace records, and observability.
3. V0 uses `floe-web` as the first human/operator interface.
4. V0 uses `floe-bridge` as the runtime boundary.
5. V0 bridge should use Pi lower layers: `pi-agent-core` / Pi `AgentSession` and `pi-ai` where feasible.
6. Pi coding-agent UI/TUI/web is not the V0 foundation. It becomes a later operator-shell integration through a `floe-pi-extension`.
7. `floe-pi-extension`, when enabled, is an operator client only. It must not bypass Floe by running configured Floe agents directly in the local Pi coding-agent process.
8. If the user wants ordinary non-Floe Pi behaviour, they disable the Floe extension and reload/refresh the Pi interface.
9. Direct Copilot/Codex provider adapters are not first-build targets unless Pi lower-layer embedding cannot satisfy the bridge contract.
10. `yield` is not a required Floe primitive. The first build exposes only `emit` to runtime-backed agents.
11. Native runtime turn end is observed by `floe-bridge`; it is not a Floe command.
12. Events that expect a future response declare it through structured event metadata, not through a held runtime call.
13. Pulse is optional, bus-owned, and extension-defined in meaning. It is not a runtime keepalive.
14. Broadcast is a bus destination-selector feature that resolves to concrete delivery records.
15. Memory remains external, implemented through hooks/actions such as `floe-mem`, not through Floe core.

---

## 2. Target architecture

### 2.1 V0 architecture

```text
Human
  ↓
floe-web
  ↓
floe-bus
  ↓
floe-bridge
  ↓
pi-agent-core / AgentSession
  ↓
pi-ai
  ↓
provider/model
```

V0 should prove Floe as a substrate without waiting on Pi UI extension seams.

### 2.2 Later Pi operator-shell architecture

```text
Human
  ↓
Pi coding-agent UI/TUI/web
  ↓
floe-pi-extension  # operator client only in Floe mode
  ↓
floe-bus
  ↓
floe-bridge
  ↓
pi-agent-core / AgentSession
  ↓
pi-ai
```

Rules:

- In Floe mode, Pi coding-agent is a human/operator surface, not the configured Floe agent runtime.
- The extension submits human input to `floe-bus` first.
- The runtime only receives work from `floe-bus` through `floe-bridge`.
- The extension may display events, substrate state, runtime telemetry, endpoint lists, pending responses, broadcasts, and pulse status.
- The extension must not send a configured Floe-agent prompt directly to a local Pi runtime session.
- Non-Floe Pi behaviour is allowed only when the extension is disabled or disconnected from Floe mode.

### 2.3 Why the bridge still exists

The bridge is required as a boundary even though it may be thin.

`floe-bridge` translates between:

```text
Floe events, endpoints, deliveries, pending responses, pulse, broadcast
```

and:

```text
Pi sessions, messages, tools, streaming output, runtime events, provider/model calls
```

The bridge may be a separate service, an embedded runtime host, or later partly embodied by a Pi extension. In V0 it should be a separate Floe-owned service.

---

## 3. Product responsibilities

### 3.1 `floe-bus`

Owns durable substrate state:

- workspace/project registry
- endpoint registry
- human and agent endpoint records
- canonical event intake
- destination selector resolution
- broadcast fan-out
- per-endpoint mailboxes
- durable delivery records and leases
- pending response records
- pulse scheduling
- reminder delivery
- generic webhook ingress
- endpoint status snapshots
- internal system events
- structured logs and metrics
- idempotency, retries, and dead-letter state

The bus must not know Pi session internals, provider details, tool internals, memory semantics, or agent instruction meaning.

### 3.2 `floe-web`

Owns V0 human/operator UX:

- workspace registration/selection
- `.floe/` creation consent
- endpoint/agent selection
- thread/event history
- message submission
- status display
- delivery and pending response display
- broadcast submission UI where needed
- pulse configuration UI where needed
- runtime telemetry display from bridge/bus
- webhook route display where configured
- config drift display where implemented

`floe-web` does not read project files directly. It talks to `floe-bus`.

### 3.3 `floe-bridge`

Owns runtime embodiment:

- attach to selected workspaces
- initialise/read/validate project `.floe/`
- derive/register runtime-backed agent endpoints
- compose runtime instructions/context
- start/resume Pi sessions through `pi-agent-core` / AgentSession where feasible
- use `pi-ai` for provider/model access through Pi
- inject Floe delivery bundles into Pi runtime sessions
- register/provide Floe `emit` tool capability to the runtime
- observe native turn start/end
- observe visible streaming output
- observe before/after tool use and tool failures when Pi exposes them
- report runtime telemetry and usage to bus
- execute Floe hooks/actions where configured
- report delivery state to bus

### 3.4 Pi lower layers

Pi lower layers should provide:

- runtime/session execution
- provider/model integration
- streaming visible output
- tool call lifecycle
- usage/token/cost telemetry where available
- session persistence/resume primitives where available
- model/provider configuration surfaces

Floe should not rebuild these unless Pi cannot satisfy the required bridge contract.

### 3.5 `floe-pi-extension` later

Later integration, not V0 foundation.

Responsibilities:

- connect Pi coding-agent UI/TUI/web to `floe-bus`
- register/refresh the human operator endpoint
- show substrate state in Pi commands/widgets/status
- forward user input to `floe-bus`
- display Floe-originated messages/events
- optionally expose convenience commands such as `/floe endpoints`, `/floe pending`, `/floe broadcast`, `/floe pulse`

Strict rule:

> When enabled in Floe mode, `floe-pi-extension` must block or intercept direct local Pi runtime submission for configured Floe agents. It is an operator client, not a runtime bypass.

---

## 4. Agent-facing primitive

The first build exposes one required Floe primitive to runtime-backed agents:

```text
emit
```

`emit` publishes an event to `floe-bus` and returns acknowledgement.

```ts
emit(event: EventSubmission) -> {
  ok: true,
  event_id: string,
  accepted_at: string
}
```

Rules:

- `emit` does not suspend the runtime.
- `emit` does not keep the runtime alive.
- `emit` can represent a message, progress update, request, broadcast, reminder, webhook response, or other event.
- If a response is expected, the event declares that expectation.
- After emitting, the agent may continue working or end the turn natively.
- Do not implement a required core `yield` primitive for V0.

Example request expecting a response:

```json
{
  "type": "message",
  "destination": {
    "kind": "endpoint",
    "endpoint_id": "endpoint:workspace:example:agent:reviewer"
  },
  "thread_id": "thr_123",
  "content": {
    "text": "Please review this implementation."
  },
  "response": {
    "expected": true,
    "mode": "correlated",
    "correlation_id": "corr_review_123"
  }
}
```

---

## 5. Native runtime turn end

Native turn end is observed by the bridge.

Rules:

- The agent is not instructed to call a Floe turn-end command.
- Pi runtime/session events are mapped by the bridge into Floe lifecycle records.
- When the runtime turn ends, the bridge reports endpoint state to the bus.
- If the turn emitted events with `response.expected: true`, the bus records pending response state.
- If no pending response/work remains, the endpoint becomes idle.

Endpoint states:

| State | Meaning |
|---|---|
| `idle` | Turn ended with no pending response/work. |
| `waiting` | Turn ended after creating one or more pending response records. |
| `active` | Runtime is currently working. |
| `queued` | Events are queued for endpoint but not yet consumed. |
| `error` | Runtime/bridge/action failed. |
| `offline` | No bridge/runtime available. |

---

## 6. Event envelope and response expectation

Submission shape:

```json
{
  "type": "message",
  "workspace_id": "workspace:example",
  "source_endpoint_id": "endpoint:workspace:example:user:operator",
  "destination": {
    "kind": "endpoint",
    "endpoint_id": "endpoint:workspace:example:agent:floe"
  },
  "thread_id": "thr_123",
  "correlation_id": null,
  "content": {
    "text": "Please continue the implementation review.",
    "data": {}
  },
  "response": {
    "expected": false
  },
  "metadata": {},
  "idempotency_key": "optional-client-key"
}
```

Response expectation:

```json
"response": {
  "expected": true,
  "mode": "open|thread_affine|correlated",
  "correlation_id": "corr_123",
  "timeout_at": null
}
```

Rules:

- `expected: true` creates a durable pending response record.
- `open` allows any eligible response addressed to the waiting endpoint.
- `thread_affine` requires matching thread.
- `correlated` requires matching correlation id.
- Pending response records are bus-owned state, not runtime-held waits.

---

## 7. Destination selectors and broadcast

The bus accepts direct endpoint destinations and broadcast selectors.

Direct endpoint:

```json
{
  "kind": "endpoint",
  "endpoint_id": "endpoint:workspace:example:agent:floe"
}
```

Workspace broadcast:

```json
{
  "kind": "broadcast",
  "scope": "workspace",
  "target": "agents",
  "exclude_source": true
}
```

Allowed first-build broadcast targets:

- `all`
- `agents`
- `humans`
- `active_agents`
- `active_humans`

Rules:

- A broadcast submission persists one canonical event.
- The bus resolves the selector into concrete endpoint delivery records.
- Each resolved endpoint receives its own durable delivery.
- Broadcast resolution must be logged with delivery count.
- Broadcast must respect workspace partitioning and permissions.

---

## 8. Delivery model

Delivery state machine:

```text
queued -> reserved -> delivered_to_bridge -> injected_to_runtime -> acknowledged
                                                   -> failed -> dead_lettered
```

Rules:

- Do not mark events delivered because a bundle was created.
- Bridge reports runtime injection and acknowledgement to the bus.
- Delivery leases and retries are bus-owned.
- Duplicate injection must be suppressed by delivery attempt id, endpoint id, runtime session id, and event ids.
- Queued events remain durable until acknowledged or dead-lettered.

---

## 9. Pulse model

Pulse is optional bus-owned scheduling. It is not a runtime keepalive.

Project default:

```yaml
pulse:
  default: off
  after_idle: 30m
  min_interval: 30m
```

Agent override:

```yaml
pulse:
  inherit: true
```

```yaml
pulse:
  enabled: true
  after_idle: 10m
  min_interval: 10m
```

Rules:

- Pulse is evaluated per endpoint/agent where configured.
- Project default can be inherited or overridden.
- Pulse should be based on idle time, not continuous wall-clock churn.
- Pulse does not automatically invoke a model.
- Pulse fires the public `Pulse` hook and/or creates a `pulse` event only when configured.
- Extensions decide what happens on Pulse.
- The bus schedules Pulse; it does not know what a pulse means.

---

## 10. Project `.floe/` layout

V0 default:

```text
.floe/
  floe.yaml
  agents/
    floe.md
  extensions/
    README.md
  skills/
    substrate-build/
      SKILL.md
  mcp/
    README.md
  state/
    README.md
    .gitignore
```

Default `.floe/floe.yaml`:

```yaml
schema: floe.workspace.v1
version: 1

applied_config:
  config_id: cfg_composition_floe_default
  version: 1
  source: initial_template

agents:
  - id: floe
    path: ./agents/floe.md

pulse:
  default: off
  after_idle: 30m
  min_interval: 30m

state:
  path: ./state
```

Rules:

- Do not generate `roles/` or `policies/` by default.
- Skills and MCP remain runtime-native.
- Extensions are Floe lifecycle-triggered behaviour.
- Project source, generated artefacts, journals, and plans belong outside `.floe/` unless explicitly Floe config.
- Secrets belong in local product storage or provider-native secure storage, not project `.floe/`.

---

## 11. Agent file format

`.floe/agents/floe.md`:

```markdown
---
schema: floe.agent.v1
agent_id: floe
label: Floe

runtime:
  engine: pi
  provider: configured_by_pi_ai
  options: {}

applied_from:
  config_id: cfg_composition_floe_default
  version: 1

extensions: []
skills:
  - ../skills/substrate-build
mcp: []

pulse:
  inherit: true

scope:
  paths:
    - ./
  services: []
---

# Floe

You are Floe, the default agent for this project.

Use `emit` to publish messages, progress, requests, and other events into Floe.

If you need a future response before more work can continue, emit an event with a response expectation and then end your turn normally.

If your work is complete and you are not waiting for anything, send your final response and end the turn normally.

Do not try to keep yourself alive. Floe will resume or start your runtime session when new work arrives.
```

Rules:

- Omit `endpoint_id` from committed agent files.
- The bridge derives endpoint ids from bus workspace id plus `agent_id`.
- The bridge must not write derived endpoint ids back into committed agent files.

---

## 12. Runtime composition through Pi

`floe-bridge` resolves runtime context in this order:

1. Load bridge/workspace attachment context.
2. Load `.floe/floe.yaml`.
3. Load agent Markdown frontmatter/body.
4. Resolve declared extensions.
5. Resolve extension-provided instruction profiles.
6. Resolve runtime-native skill references.
7. Resolve runtime-native MCP references.
8. Build pulse policy from project default plus agent override.
9. Build Floe event delivery bundle.
10. Run `BeforeTurn` hooks.
11. Construct Pi runtime/session input.
12. Register/inject Floe `emit` tool.
13. Start or resume Pi AgentSession.

Rules:

- Runtime-native skill/MCP semantics are passed to Pi/provider layers where supported.
- Floe must not invent a second Pi skill/MCP protocol.
- Unsupported Pi capabilities must be reported clearly.
- If Pi lower-layer APIs cannot provide a needed lifecycle event, the bridge may simulate it conservatively or mark it unsupported.

---

## 13. Runtime-observed events and telemetry

Bridge maps Pi events into Floe telemetry/public hooks where available:

- session start
- session resume
- visible stream output
- turn end
- before tool use
- after tool use
- tool failure
- session end
- runtime errors
- usage/token/cost data where available

Rules:

- Do not expose hidden chain-of-thought.
- Visible output, tool activity, status, and trace summaries may be displayed/logged.
- Usage telemetry should include model, input tokens, output tokens, cached tokens, estimated cost/credits where available, and context bundle size.

---

## 14. Public extension hooks

Public hooks:

- `SessionStart`
- `BeforeTurn`
- `TurnEnd`
- `BeforeToolUse`
- `AfterToolUse`
- `ToolUseFailed`
- `SessionResume`
- `SessionEnd`
- `Pulse`
- `WebhookReceived`
- `Error`

Rules:

- Public hook names are PascalCase.
- Runtime adapters map Pi/native events into this vocabulary where available.
- `BeforeToolUse`, `AfterToolUse`, and `ToolUseFailed` are capability hooks.
- Unsupported hooks must be advertised as unavailable.
- Internal bus/bridge event names must not leak into ordinary user-authored extension config.

Hook config shape:

```yaml
hooks:
  BeforeTurn:
    - matcher: "*"
      handlers:
        - type: http
          url: http://127.0.0.1:8787/retrieve
          timeout: 5s
          inject_result_as: memory_context

  Pulse:
    - matcher: "agent:floe"
      handlers:
        - type: command
          command: ./memory-maintain.sh
          timeout: 30s
```

First-build handler types:

- `http`
- `command`
- `prompt` / `inject` if needed

Do not build broad action runner support before the substrate spine works.

---

## 15. Pi coding-agent extension rules for later V1

When `floe-pi-extension` exists:

- it acts as an operator client for Floe
- it can show Floe substrate state in Pi UI/TUI/web
- it can submit human input to `floe-bus`
- it can display Floe-originated messages and runtime telemetry
- it can register commands and UI surfaces
- it may not directly run a configured Floe agent through the local Pi coding-agent runtime

Strict mode:

- If the extension is enabled and connected to a Floe workspace, direct Pi runtime submission for configured Floe agents is blocked.
- To use Pi normally outside Floe, the user disables the extension and refreshes/reloads the Pi interface.
- No mixed mode in V1.

---

## 16. Transport model

Primary live paths use sockets/event streams.

| Edge | Primary transport |
|---|---|
| `floe-web` ↔ `floe-bus` | WebSocket or equivalent event stream |
| `floe-bridge` ↔ `floe-bus` | WebSocket or equivalent event stream |
| External webhook → `floe-bus` | HTTP ingress |
| Health/setup/admin | HTTP accepted |

Polling may exist only for degraded recovery, startup reconciliation, or diagnostics.

---

## 17. API surface

Suggested bus endpoints:

```text
GET  /health
POST /v1/workspaces/register
GET  /v1/workspaces
POST /v1/workspaces/{workspace_id}/select
POST /v1/events/emit
POST /v1/webhooks/{workspace_id}/{route_id}
```

No separate wait/yield endpoint is required.

Socket messages should cover:

- bridge registration
- workspace attachment request/result
- endpoint registration
- event accepted
- destination selector resolved
- delivery available/reserved/injected/acknowledged
- pending response created/resolved
- pulse due/fired
- endpoint status changed
- runtime telemetry
- hook/action result summary

---

## 18. Observability

Structured logs must show:

- workspace register/select
- endpoint register
- event accepted
- destination resolved
- delivery queued/reserved/delivered/injected/acknowledged
- pending response created/resolved
- bridge runtime start/resume/end
- runtime stream summaries
- tool start/result/failure
- emitted events
- pulse schedule/fire
- hook/action start/result/failure
- errors and retries

Metrics should include:

- queue depth per endpoint
- delivery latency
- pending response duration
- pulse count
- hook/action duration
- runtime failure count
- runtime start/resume count
- token/cost telemetry where available

---

## 19. Implementation drift guardrails

1. Do not implement held-yield or runtime keepalive semantics.
2. Do not build direct Copilot/Codex adapters before proving Pi lower-layer bridge viability.
3. Do not move substrate state into Pi.
4. Do not allow Pi coding-agent direct runtime bypass when Floe mode is enabled.
5. Do not treat broadcast as a magic endpoint; resolve to concrete deliveries.
6. Do not mark delivery complete until runtime injection/acknowledgement is reported.
7. Do not leak internal system events into public hook config.
8. Do not expose hidden chain-of-thought.
9. Do not build broad extension/action runner support before the spine works.
10. Do not discard current service skeleton unless the code is too entangled to remove the old runtime model.

---

## 20. V0 implementation sequence

1. Make the repo build/run cleanly from a fresh checkout.
2. Keep the service split: `floe-web`, `floe-bus`, `floe-bridge`.
3. Remove old `yield` and runtime keepalive code paths.
4. Implement/clean `emit` as the single runtime primitive.
5. Implement `response.expected` and pending response records.
6. Implement destination selectors and broadcast delivery fan-out.
7. Implement durable delivery acknowledgement states.
8. Implement project `.floe/` template and default `.floe/agents/floe.md` with Pi runtime engine metadata.
9. Implement bridge Pi lower-layer spike using AgentSession / `pi-agent-core` / `pi-ai` where feasible.
10. Register/inject Floe `emit` tool into the Pi-backed runtime.
11. Map Pi runtime events into Floe telemetry and public hooks.
12. Prove the vertical slice:

```text
Human -> floe-web -> floe-bus -> floe-bridge -> pi-agent-core -> pi-ai -> emit -> bus -> web
```

13. Add pulse only after the basic event loop works.
14. Add Pi coding-agent extension only after V0 substrate spine is stable.

---

## 21. Acceptance criteria

V0 is acceptable when:

1. `floe-web`, `floe-bus`, and `floe-bridge` run independently.
2. User can register/select a workspace through `floe-web`.
3. Bridge creates/loads `.floe/` only after product-flow consent.
4. Default agent lives at `.floe/agents/floe.md`.
5. The default agent mentions `emit` and native turn end, not `yield`.
6. User message is persisted by `floe-bus`.
7. Bus resolves destination selector to concrete delivery records.
8. Bridge injects a delivery bundle into a Pi-backed runtime session.
9. Runtime can call `emit` into Floe.
10. Bus persists the emitted event.
11. Runtime turn end is observed and endpoint state updated.
12. Pending response records are created when `response.expected: true`.
13. Broadcast fan-out works for at least `agents` and `humans` targets.
14. Delivery state reaches `acknowledged` only after runtime injection/acknowledgement.
15. Runtime visible output/tool telemetry is forwarded to bus/web where available.
16. No direct Copilot/Codex adapter exists unless Pi lower-layer integration fails and the handoff is revised.
17. No Pi coding-agent extension path bypasses Floe.
18. Structured logs demonstrate the full vertical slice.

---

## 22. Existing builder code decision

Do **not** restart from an empty repository yet.

The existing work already has the service shape Floe still needs: bus, bridge, web, CLI/setup scaffolding, workspace concepts, events, and a fake runtime path. That is enough to justify a hard pivot rather than a full rebuild.

Recommended action:

1. Create a new branch: `v58-pi-runtime-reset`.
2. Keep reusable scaffolding:
   - service/package layout
   - CLI/service startup work
   - workspace registry concepts
   - event store concepts
   - web workspace/operator scaffolding
   - bridge process shell
   - socket/event-stream work if clean
3. Delete or replace old assumptions:
   - `yield` endpoint/API
   - runtime keepalive code
   - held runtime logic
   - direct Copilot-first adapter logic
   - fake runtime behaviour that encodes old send-and-wait semantics
4. Rebuild the spine around:
   - `emit`
   - native turn-end observation
   - pending responses
   - Pi lower-layer runtime host

Start from scratch only if the current code cannot be made to build cleanly or if old held-yield assumptions are so entangled that removal takes longer than recreating the service skeleton.

Decision: **pivot the existing builder agent on a new branch, with v58 as authoritative. Do not greenfield unless the pivot fails quickly.**

---

## 23. Builder prompt

Pause feature expansion and realign against v58.

Floe remains a durable substrate. V0 uses:

```text
Human -> floe-web -> floe-bus -> floe-bridge -> pi-agent-core / AgentSession -> pi-ai
```

Do not build direct Copilot/Codex adapters. Do not build a Pi coding-agent extension for V0. Do not implement `yield` or runtime keepalive semantics.

Keep the service skeleton if viable, but remove old runtime assumptions. The first vertical slice is:

```text
user message -> bus event -> delivery -> bridge -> Pi-backed runtime -> emit -> bus -> web display -> native turn end observed
```

Deliver:

1. A report listing what was kept, removed, and rebuilt.
2. A working local demo of the vertical slice.
3. Logs showing event persistence, destination resolution, delivery state, runtime injection, emitted event persistence, turn-end observation, and endpoint status update.
4. A short Pi integration report explaining which Pi APIs were used and which runtime events/hooks are available.

Do not add broad extension/action runner support, Pi UI extension support, or headless RPC workers until the V0 spine is proven.
