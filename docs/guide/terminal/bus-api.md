# Bus API

**The bus is a plain HTTP + WebSocket server on port 5377, and its routes are the substrate's complete, real contract.**

Everything below is read straight from `floe-bus/src/server.ts`. This page is grouped by area. See [[Working without floe-app]] for a worked end-to-end example, and [[CLI reference]] for the `floe` binary.

## Health and local config

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Liveness check. Returns `{ ok, service, time }`. |
| GET | `/v1/local-config/status` | Returns the active config path and `home`/`bus`/`app`/`bridge` config sections. |
| GET | `/v1/runtime/status` | Whether a bridge is currently connected (socket-presence liveness) and its reported `runtime_adapter`. |

## WebSocket stream

`GET /v1/events/stream` (`{ websocket: true }`). On connect the bus sends `{ type: "hello", payload: { service: "floe-bus" } }`. The bridge sends `{ type: "bridge_hello", bridge_id }` as its first message to register socket-based liveness. Every state change is broadcast to all connected sockets as `{ type, payload, at }`.

Broadcast message types observed in the bus source:

`workspace_registered`, `workspace_selected`, `workspace_deleted`, `workspace_attachment_requested`, `workspace_attachment_result`, `scope_created`, `scope_updated`, `scope_deleted`, `scope_graph_created`, `scope_projection.layout.upserted`, `context_created`, `context_deleted`, `context_scope_assigned`, `context_compacted`, `context_history_cleared`, `participant_added`, `participant_removed`, `runtime_binding_updated`, `runtime_binding_cleared`, `bridge_registered`, `endpoint_registered`, `endpoint_deleted`, `status_changed`, `event_submitted`, `destination_selector_resolved`, `delivery_created`, `delivery_bundle_available`, `delivery_reserved`, `delivery_delivered_to_bridge`, `delivery_deferred`, `turn_end_observed`, `runtime_telemetry`, `saved_config_created`, `config_snapshot_requested`, `config_snapshot_imported`, `config_apply_requested`, `pulse_created`, `pulse_fired`, `pulse_subscriber_changed`, `extensions_updated`.

There is no route to replay past broadcasts — the stream is live-only. Use `GET /v1/events` for history.

## Workspaces

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/workspaces` | — | List all registered workspaces. |
| POST | `/v1/workspaces/register` | `{ locator, name?, init_authorized?, create_directory? }` | Registers a folder as a workspace. 400 `directory_not_found` if the locator doesn't exist and `create_directory` isn't set. |
| POST | `/v1/workspaces/:workspace_id/select` | — | Marks a workspace as selected/active. |
| POST | `/v1/workspaces/:workspace_id/delete` | `{ delete_locator? }` | Deletes a workspace; optionally deletes its files too. |
| GET | `/v1/workspaces/:workspace_id/config-status` | — | Returns the workspace record. |
| POST | `/v1/workspaces/:workspace_id/config-snapshot` | — | Requests the bridge to snapshot `.floe/` config. |
| POST | `/v1/workspaces/:workspace_id/import-config` | raw JSON snapshot | Imports a config snapshot. |
| POST | `/v1/workspaces/:workspace_id/apply-config` | `{ config_id? }` | Requests the bridge apply a saved config. |
| POST | `/v1/workspaces/:workspace_id/attachment-result` | `{ bridge_id, status, config_hash?, error_code?, validation? }` | Bridge reports the result of attaching a workspace. |

```bash
curl -X POST http://localhost:5377/v1/workspaces/register \
  -H "content-type: application/json" \
  -d '{"locator": "C:/path/to/repo", "name": "My Project"}'
```

## Workspace filesystem surface

Gated on `bridge.workspace_access.local_paths` in config; returns 403 `fs_disabled` otherwise. Exists so a console not co-located with the workspace files (e.g. a browser tunneled into a remote bus) can still read/write inside the workspace root.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/fs/capability` | — | `{ local_paths: boolean }` — cheap probe. |
| GET | `/v1/fs/browse?path=` | — | Directory listing. |
| GET | `/v1/workspaces/:workspace_id/fs/agents` | — | Lists agent files under the workspace. |
| GET | `/v1/workspaces/:workspace_id/fs/file?path=` | — | Reads a file (path must resolve within the workspace root). |
| PUT | `/v1/workspaces/:workspace_id/fs/file` | `{ path, contents }` | Writes a file, creating parent dirs. |

## Scopes

A [[Scope]] is the canvas nodes are placed on and connected within.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/workspaces/:workspace_id/scopes` | — | List scopes in a workspace. |
| POST | `/v1/workspaces/:workspace_id/scopes` | `{ scope_id?, title, description? }` | 409 `scope_already_exists`, 400 `scope_id_reserved`. |
| PATCH | `/v1/workspaces/:workspace_id/scopes/:scope_id` | `{ title?, description? }` | At least one field required. |
| DELETE | `/v1/workspaces/:workspace_id/scopes/:scope_id` | — | 409 `scope_not_empty` (with `context_count`/`pulse_count`) if the scope still holds contexts or pulses. |
| GET | `/v1/workspaces/:workspace_id/scopes/:scope_id/projection` | — | The rendered projection of the scope for a UI. |
| GET | `/v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer` | — | Saved layout for a renderer (only `floe-app` supported). |
| PUT | `/v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer` | raw layout JSON | Upserts the saved layout. |

```bash
curl -X POST http://localhost:5377/v1/workspaces/$WORKSPACE_ID/scopes \
  -H "content-type: application/json" \
  -d '{"title": "Billing"}'
```

## Nodes / graphs (stored vocabulary predates the current model)

The substrate still stores nodes under a `graph_id` and calls the picture a "graph". In the current locked model, a scope IS the canvas and a graph is only the picture of what's connected in it — there is no separate graph primitive to create or name. These routes are documented as they exist today:

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/workspaces/:workspace_id/scopes/:scope_id/graphs` | — | List graphs stored under a scope. |
| POST | `/v1/workspaces/:workspace_id/scopes/:scope_id/graphs` | `{ nodes: [...], created_by_endpoint_id? }` | Each node is `trigger` (event source), `actor`, or `command`, per the zod union in `server.ts`. |
| GET | `/v1/workspaces/:workspace_id/graphs` | — | List all graphs for a workspace. |
| GET | `/v1/workspaces/:workspace_id/graphs/:graph_id` | — | Get one graph. |
| POST | `/v1/workspaces/:workspace_id/graphs/:graph_id/nodes/:node_id/fire` | `{ content?, correlation_id? }` | Fires a `trigger`-kind node, creating events. 400 `scope_graph_node_not_a_trigger` if the node isn't a trigger. |

## Endpoints (actors)

An [[Endpoint]] is the substrate's addressable identity for an [[Actor]].

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/endpoints?workspace_id=` | — | List endpoints, optionally filtered by workspace. |
| GET | `/v1/workspaces/:workspace_id/endpoints` | — | List endpoints in a workspace. |
| GET | `/v1/workspaces/:workspace_id/resolve-endpoint?ref=` | — | Resolves a subscriber ref string to an endpoint id. |
| POST | `/v1/endpoints/register` | `{ endpoint_id, workspace_id, name, agent_id?, bridge_id?, status?, metadata? }` | Registers an endpoint. |
| DELETE | `/v1/endpoints/:endpoint_id` | — | 404 if not found. |
| POST | `/v1/endpoints/:endpoint_id/status` | `{ status }` | Updates endpoint status. |
| POST | `/v1/endpoints/:endpoint_id/turn-end` | — | Bridge reports a turn ended. |
| GET | `/v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark` | — | Reads the endpoint's event cursor (its watermark). |
| PUT | `/v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark` | `{ cursor }` | Advances the endpoint's watermark. 400 `invalid_event_cursor` on a bad cursor. |

## Contexts

A [[Context]] is one run of a node — where work happens and outcomes appear.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/workspaces/:workspace_id/contexts?scope=&scope_id=&limit=` | — | List contexts for a workspace, optionally scope-filtered. |
| GET | `/v1/contexts?participant=&workspace_id=&scope_id=` | — | List contexts a given endpoint participates in. |
| GET | `/v1/contexts/:id` | — | Get one context (includes participants, title, first-message preview). |
| GET | `/v1/contexts/:id/events?limit=` | — | List the context's events. |
| POST | `/v1/workspaces/:workspace_id/contexts` | `{ participants?, scope_id?, context_id?, created_by_endpoint_id?, title?, parent_context_id? }` | Requires non-empty `participants` OR a `scope_id`. Guards against self-referencing or cyclic `parent_context_id`. |
| POST | `/v1/workspaces/:workspace_id/contexts/:context_id/assign-scope` | `{ scope_id, assigned_by?, reason? }` | Assigns a context into a scope. 409 `context_scope_assignment_invalid` on conflict. |
| DELETE | `/v1/contexts/:id` | — | Deletes a context and its history. |
| POST | `/v1/contexts/:id/participants` | `{ endpoint_id }` | Idempotently adds a participant. |
| DELETE | `/v1/contexts/:id/participants/:endpoint_id` | — | Idempotently removes a participant. |
| GET | `/v1/contexts/:id/children` | — | Lists child contexts (via `parent_context_id`). |
| POST | `/v1/contexts/:id/subscriptions` | `{ endpoint_id, event_types? }` (default `["*"]`) | Subscribes an endpoint to specific event types in this context. |
| DELETE | `/v1/contexts/:id/subscriptions/:endpoint_id` | — | Unsubscribes. |
| GET | `/v1/contexts/:id/subscriptions` | — | Lists subscriptions for a context. |
| POST | `/v1/contexts/:id/subscriptions:batch` | `{ entries: [{endpoint_id, event_types}], participants_only? }` | Atomically applies participants + subscriptions. |
| POST | `/v1/contexts/:id/compact` | `{ summary, before_event_id? }` | Truncates history to a watermark and inserts a synthetic summary event. 409 if a delivery is active. |
| POST | `/v1/contexts/:id/clear-history` | — | Deletes all events, keeps the context/participants/pulse subscribers. 409 if a delivery is active. |

```bash
curl -X POST http://localhost:5377/v1/workspaces/$WORKSPACE_ID/contexts \
  -H "content-type: application/json" \
  -d '{"participants": ["'"$ENDPOINT_ID"'"], "title": "Investigate invoice #4471"}'

curl "http://localhost:5377/v1/contexts/$CONTEXT_ID/events"
```

## Events

An [[Event]] is not a citizen — something that lands, with a source.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/events/emit` | See `EventCommandSchema` below | Submits an event. Returns 202 with `event_id`, `deliveries_created`, full `event`. |
| GET | `/v1/events?workspace_id=&thread_id=&context_id=&scope_id=&since=&limit=` | — | Lists events; returns `next_cursor` for paging. |
| GET | `/v1/events/:event_id/trace` | — | Full delivery trace for one event. 404 `event_not_found`. |

`EventCommandSchema` fields: `type`, `workspace_id`, `source_endpoint_id`, `destination` (one of `{kind:"endpoint", endpoint_id}`, `{kind:"broadcast", scope:"workspace", target, exclude_source?}`, `{kind:"context", context_id}`), `thread_id?`, `context_id?`, `current_delivery_context_id?`, `scope_id?`, `correlation_id?`, `content` (object), `response?` (`{expected, mode?, correlation_id?, timeout_at?}`), `metadata?`, `idempotency_key?`.

`destination:{kind:"context"}` is the single context-delivery path: it records the event in the context log AND delivers to actors whose subscription in that context matches the event type. Zero subscriptions = zero deliveries (a natural record-only outcome).

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

## Deliveries

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/v1/delivery/claim` | `bridge_id`, `limit?` | A bridge claims up to `limit` (default 10, max 100) pending deliveries. |
| GET | `/v1/delivery` | `workspace_id?`, `limit?` | Lists delivery records. |
| POST | `/v1/delivery/:delivery_id/status` | `{ bridge_id, state, error? }` | `state` is one of `injected_to_runtime`, `acknowledged`, `failed`, `dead_lettered`, `deferred`. |
| GET | `/v1/pending-responses` | `workspace_id?`, `limit?` | Lists events awaiting a correlated response. |

Delivery in normal operation rides the WebSocket (`delivery_bundle_available` broadcast), not `GET /v1/delivery/claim` — the claim route exists for bridges reconnecting or the multi-bridge fallback case.

## Pulses

A [[Event|Pulse]] is a schedule (once or cron) that fires an event.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/pulses` | `{ pulse_id, workspace_id, persistence?, scope_id?, current_context_id?, trigger: {type: "once"\|"cron", at?, schedule?, timezone?}, event?: {type: "pulse.fired", content?}, content?, subscribers: [...], created_by? }` | `subscribers` entries are `{kind:"context", context_id}` or `{kind?:"endpoint", endpoint_ref, context_id?}`. |
| GET | `/v1/pulses?workspace_id=&status=&scope_id=` | — | Lists pulses. |
| POST | `/v1/pulses/:pulse_id/pause` | — | Pauses; removes from the fire queue. |
| POST | `/v1/pulses/:pulse_id/resume` | — | Resumes; recalculates next fire time for cron pulses. |
| POST | `/v1/pulses/:pulse_id/cancel` | — | Cancels; removes from the fire queue. |
| POST | `/v1/pulses/:pulse_id/subscribe` | subscriber object | Adds a subscriber to an existing pulse. |
| POST | `/v1/pulses/:pulse_id/unsubscribe` | — | Removes a subscriber. |

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

## Extensions

An [[Extension]] contributes tools, pulses, views, HTTP handlers and bundled agents. It is registered in memory by the bridge, never persisted.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/extensions/report` | `{ workspace_id, extensions: [{name, views?, errors?, relay_url?}] }` | Bridge reports loaded extensions after each workspace attach. Writable, not independently readable beyond the summary below. |
| GET | `/v1/extensions?workspace_id=` | — | Lists registered extensions (name, views, errors, relay_url). |
| GET | `/v1/extensions/:name/*` | — | Proxies to the extension's HTTP relay. 503 `extension_relay_not_available` if none registered. |
| POST | `/v1/extensions/:name/*` | any JSON | Same proxy, POST. |

Extension hooks themselves (`SessionStart`, `BeforeTurn`, `Pulse`, `WebhookReceived`, etc.) fire inside the bridge process and have **no HTTP surface at all** — writable only in the sense that the bridge invokes them; there is nothing to call or list here.

## Webhooks

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/webhooks/:workspace_id/:route_id` | any JSON | Ingests an inbound webhook as an event source. 400 `scope_required` if the route needs a scope and none is configured. |

Webhook routes are **write-only** — there is no `GET` to list configured webhook routes or replay past webhook calls; use `GET /v1/events` filtered by workspace to see what they produced.

## Folder watchers

No HTTP surface exists for folder watchers at all: no create, list, or read route. They are configured outside the bus and have no read endpoint.

## Runtime bindings

A [[Binding]] attaches an auth profile/model/thinking level to an actor or workspace default.

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/runtime/bindings?workspace_id=` | — | Lists bindings. |
| POST | `/v1/runtime/bindings` | `{ scope: "agent"\|"workspace_default"\|"global_default", workspace_id?, endpoint_id?, auth_profile, model?, thinking_level? }` | Upserts a binding. |
| POST | `/v1/runtime/bindings/clear` | `{ scope, workspace_id?, endpoint_id? }` | Clears a binding. |
| GET | `/v1/runtime/bindings/resolve?workspace_id=&endpoint_id=` | — | Resolves the effective binding for an endpoint (agent → workspace default → global default). |

## Runtime telemetry and status

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/runtime/status` | — | See Health section above. |
| POST | `/v1/runtime/telemetry` | `{ workspace_id, endpoint_id, delivery_id?, kind, payload }` | Bridge appends a telemetry record. |
| GET | `/v1/runtime/telemetry?workspace_id=&delivery_id=&limit=` | — | Lists telemetry records. |
| POST | `/v1/bridges/register` | `{ bridge_id, capabilities? }` | Registers a bridge process. |
| POST | `/v1/bridges/:bridge_id/liveness` | — | Reports bridge liveness (also handled implicitly via the WS `bridge_hello`). |

## Auth

Auth **write** happens only via the `floe` CLI or desktop shell (`floe login`), never over HTTP.

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/auth/profiles` | Lists configured auth profiles and the default profile id. Read-only. |
| GET | `/v1/auth/models?provider=` | Lists available models, optionally filtered by provider. Read-only. |

## Saved configs

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/v1/configs` | — | Lists saved configs. |
| POST | `/v1/configs` | `{ name, config }` | Creates a saved config. |

See [[Glossary]] for term definitions.

## Implementation

- `floe-bus/src/server.ts` — every route documented on this page
- `floe-bus/src/store.ts` — `BusStore`, broadcast call sites, business logic behind the routes
- `floe-bus/src/scope-graphs.ts` — node/graph storage (still keyed by `graph_id`; the model above is the current one)
- `floe-bus/src/pulse-scheduler.ts` — pulse fire scheduling
