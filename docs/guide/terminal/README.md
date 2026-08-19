# Working without floe-app

**You can run and drive floe entirely from a terminal, but the `floe` CLI does not cover the substrate — you talk to it over HTTP.**

The bus is a plain HTTP + WebSocket server on port 5377. Every [[Scope]], [[Context]], [[Event]] and [[Event|Pulse]] the substrate can hold is reachable with `curl`. The `floe` CLI is a separate, much smaller thing: it starts services, checks health, manages auth, and resets local state. It has **no commands for scopes, contexts, nodes or extensions.** For those, you use the bus's HTTP API directly.

## What the CLI covers

- `floe setup`, `floe start`, `floe stop`, `floe restart`, `floe status`, `floe logs`
- `floe login`, `floe auth list`, `floe auth doctor`, `floe logout`
- `floe config path`, `floe config edit`
- `floe autostart on|off`
- `floe doctor`, `floe reset`, `floe uninstall`, `floe open`, `floe desktop`

Full detail: [[CLI reference]].

## What the CLI does not cover

Nothing in `floe-cli/src/` creates a [[Scope]], creates a [[Context]], emits an [[Event]], registers an [[Actor]]/[[Endpoint]], or schedules a [[Event|Pulse]]. There is no `floe scope`, `floe context`, `floe node`, or `floe extension` command family. If you want to do any of that from a terminal, you call the bus directly.

## The real workflow

1. Start services: `floe start` (or `floe setup` the first time). This brings up the bus on `http://localhost:5377`, the bridge, and the frontend on `http://localhost:5379`.
2. Confirm the bus is up: `curl http://localhost:5377/health`.
3. Find your workspace id: `curl http://localhost:5377/v1/workspaces`.
4. Drive the substrate with the routes in [[Bus API]].

## Worked example: scope → context → event → read → pulse

Create a [[Scope]] (the canvas nodes are placed on) in a workspace:

```bash
curl -X POST http://localhost:5377/v1/workspaces/$WORKSPACE_ID/scopes \
  -H "content-type: application/json" \
  -d '{"title": "Billing"}'
```

Create a [[Context]] (here, a scope-less one — a bare conversation, which is why it needs a participant [[Endpoint]]):

```bash
curl -X POST http://localhost:5377/v1/workspaces/$WORKSPACE_ID/contexts \
  -H "content-type: application/json" \
  -d '{"participants": ["'"$ENDPOINT_ID"'"], "title": "Investigate invoice #4471"}'
```

Emit an [[Event]] into that context:

```bash
curl -X POST http://localhost:5377/v1/events/emit \
  -H "content-type: application/json" \
  -d '{
    "type": "message",
    "workspace_id": "'"$WORKSPACE_ID"'",
    "source_endpoint_id": "'"$ENDPOINT_ID"'",
    "destination": {"kind": "context", "context_id": "'"$CONTEXT_ID"'"},
    "context_id": "'"$CONTEXT_ID"'",
    "content": {"text": "Check invoice #4471"}
  }'
```

Read the context's events back:

```bash
curl "http://localhost:5377/v1/contexts/$CONTEXT_ID/events"
```

Create a [[Event|Pulse]] (a schedule that fires an event) that wakes a context once, five minutes out:

```bash
curl -X POST http://localhost:5377/v1/pulses \
  -H "content-type: application/json" \
  -d '{
    "pulse_id": "billing-followup-1",
    "workspace_id": "'"$WORKSPACE_ID"'",
    "trigger": {"type": "once", "at": "2026-08-19T00:00:00.000Z"},
    "subscribers": [{"kind": "context", "context_id": "'"$CONTEXT_ID"'"}]
  }'
```

Every route used above, and everything else the bus exposes, is documented in [[Bus API]].

See [[Glossary]] for term definitions.

## Implementation

- `floe-cli/src/cli.ts` — the full command registry (setup, services, auth only)
- `floe-bus/src/server.ts` — every HTTP route and the WebSocket stream
- `POST /v1/workspaces/:workspace_id/scopes` — create a scope
- `POST /v1/workspaces/:workspace_id/contexts` — create a context
- `POST /v1/events/emit` — emit an event
- `GET /v1/contexts/:id/events` — read a context's events
- `POST /v1/pulses` — create a pulse
