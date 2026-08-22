# Event

**An event is not a citizen of the substrate — it is something that lands, and it always has a source.**

Nothing in floe waits idly. An [[Actor]] or [[Command]] wakes because an event landed
in a [[Context]] it participates in or is subscribed to. Nothing else wakes anything.

## Four sources

| Source | What it is |
|---|---|
| **schedule** | A [[Event|Pulse]] — a cron expression or a one-off ISO timestamp |
| **folder** | A watched directory; a file lands or changes |
| **webhook** | An inbound HTTP call |
| **manual** | A person or an actor fires it directly |

## "Trigger" is retired

Older code and some still-unmigrated storage call this a "trigger node." That name is
retired. The firing machinery underneath — the pulse scheduler, the folder watcher, the
webhook route — is unchanged. Only the vocabulary moved: write "event," and name its
source.

## What an event carries

- `type` — a string naming what happened, e.g. `pulse.fired`
- `content` — the payload, arbitrary JSON
- `source_endpoint_id` — the [[Endpoint]] that emitted it, or `null` for a pulse
- `destination` — where it goes: a specific endpoint, a [[Context]], or a workspace broadcast
- `context_id` / `scope_id` — which context (and, derived from it, which [[Scope]]) it belongs to

An event lands in a context. That is the only thing an event does.

## Implementation

- `floe-bus/src/pulse-scheduler.ts` — the schedule source: cron and one-off pulses, single scheduled timer, no polling
- `floe-bus/src/server.ts` — `POST /v1/events/emit`, `GET /v1/events`, `POST /v1/webhooks/:workspace_id/:route_id` (webhook source), `POST /v1/pulses` (schedule source)
- `floe-bus/src/scope-graphs.ts` — event/trigger node kind, still named `"trigger"` in storage; the model above is the current name
- `docs/adr/0008-event-is-the-primitive.md` — the decision retiring trigger/pulse/watcher/webhook as separate primitives
- A folder source is self-describing on its stored Event node and is visible through scope-graph reads.

See [[Glossary]].
