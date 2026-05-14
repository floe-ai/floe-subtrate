# Design Proposal — Actor-Neutral Identity & Context Model (Revised)

**Status:** Draft v2 for review — do not implement until accepted
**Author:** orchestrator (substrate session)
**Date:** 2026-05-14
**Revision note:** v2 narrows scope per reviewer feedback. Webhooks/transports/schedulers no longer become actors. Transport metadata moves below the substrate boundary. Delivery is actor/context-level. Implementation is split into a minimal correction slice + deferred long-term work.

---

## Document Structure

1. **Problem** — current behaviour and why events bleed
2. **Long-term architecture** — the actor/context target model (directional, not for immediate implementation)
3. **Minimal correction slice** — the smallest safe change that fixes the bleed (this is what we propose to implement next)
4. **Migration & backward compatibility** — for the minimal slice
5. **Intentionally deferred** — what we are *not* doing yet, and why
6. **Tests & live QA** — focused on the minimal slice

---

## 1. Problem — Why Events Bleed

### 1.1 Identity is interface-shaped

The substrate today encodes interface type *inside* identity:

| Endpoint type | Format | Source |
|---|---|---|
| Agent | `endpoint:<workspace>:agent:<agent_id>` | `floe-bridge/src/daemon.ts:545` |
| Human (FloeWeb) | `endpoint:<workspace>:user:operator` | `floe-web/src/main.tsx:1504` |
| Webhook | `endpoint:<workspace>:webhook:<route>` | `floe-bus/src/store.ts:862` |

Every consumer that parses `endpoint_id` learns the interface. Routing, rendering, tool availability, and authorisation branch on `actor_type` (`"human" | "agent"`) either explicitly or by inferring from URL segments.

### 1.2 Threads are implicit strings

There is no `threads` table. `thread_id` is a string field on events, constructed by FloeWeb as `thread:<workspace>:<agent_id>` (`floe-web/src/main.tsx:191`). No participants list, no causality, no parent context, no sequence.

### 1.3 The bleed mechanism

FloeWeb fetches **all** workspace events (`/v1/events?workspace_id=X&limit=200`) and filters client-side (`floe-web/src/main.tsx:214-226`):

```ts
event.thread_id === threadId
&& event.type === "message"
&& (event.source_endpoint_id === humanEndpoint
    || event.source_endpoint_id === selectedAgent.endpoint_id)
```

Three failure modes result:

1. **Selecting actor ≡ selecting thread.** Choosing `floe` always shows the single `thread:<ws>:floe`. There is no concept of multiple distinct conversations with the same actor.
2. **Third-party participants are silently dropped.** If `reviewer` joins `thread:<ws>:floe` and emits, FloeWeb hides those events because the source filter only allows the human and the selected agent.
3. **Cross-thread bleed via shared `thread_id`.** When floe spawns work but reuses the active `thread_id`, agent-to-agent traffic ends up in the user's view (or gets filtered out invisibly, which is also wrong).

Root cause: identity is conflated with channel, threads are not first-class, and filtering is client-side guesswork rather than substrate-level context binding.

---

## 2. Long-Term Architecture (Directional)

This section describes the eventual model. It is **not** the implementation slice — see §3 for what we propose to build first.

### 2.1 Actors

```text
actor:<workspace_id>:<actor_id>
```

An **actor** is a durable work identity in the workspace. Examples:

```text
actor:ws_abc:justin
actor:ws_abc:floe
actor:ws_abc:reviewer
```

Constraints:

- An actor is *someone or something that does work*. It has a profile, may participate in contexts, and may be addressed.
- Webhooks, schedulers, extensions, transports, system services, runtime adapters, and CLI clients are **not** actors. They are event sources, integrations, or operational machinery.
- The substrate does not encode interface/runtime/transport into actor identity.

### 2.2 What actors are not

Per reviewer correction, the following are **explicitly not actors**:

| Concept | What it is instead |
|---|---|
| Webhook | An external event source; emits events into the system but has no profile, no work, no addressability as a peer |
| Scheduler / pulse | A system mechanism that delivers events to actors |
| Extension | A capability bundle hooked into the runtime; may emit events but not as a peer actor |
| Transport (FloeWeb, CLI, Slack) | An interface through which an actor acts |
| Runtime adapter (pi-agent-core) | Operational machinery for executing an actor's intent |

These remain modelled as opaque event sources or below-substrate concerns. A future "source/integration" model may formalise them; that is out of scope for this proposal.

### 2.3 Actor schema

```text
actors
  workspace_id          TEXT      PK part
  actor_id              TEXT      PK part
  display_name          TEXT
  profile_json          JSON             -- bio, role description (display only)
  config_json           JSON             -- runtime hints (engine, extensions, skills) — advisory, not authoritative
  default_authority     TEXT             -- placeholder: "owner" | "member" | "guest" — minimal, not a permission system
  created_at            TIMESTAMP
  updated_at            TIMESTAMP
```

Authority is a **placeholder** field, not a permission system. Full permissions are deferred.

### 2.4 Context (thread)

```text
contexts
  context_id            TEXT      PK     -- "ctx_<uuid>"
  workspace_id          TEXT
  parent_context_id     TEXT      NULL
  topic                 TEXT      NULL   -- display-only; auto-derivable; identity does not depend on it
  created_by            TEXT      FK     -> actors
  created_at            TIMESTAMP
  closed_at             TIMESTAMP NULL

context_participants
  context_id            TEXT      FK
  actor_id              TEXT      FK
  joined_at             TIMESTAMP
  left_at               TIMESTAMP NULL
  role                  TEXT             -- "initiator" | "addressed" | "observer" | "added"
  PRIMARY KEY (context_id, actor_id)
```

Participants are actors. There is no human/agent distinction in participation, role, or rendering.

### 2.5 Acting instances (opaque)

When the system can reliably create one without leaking interface identity, an opaque acting instance ID may be attached to events for audit/correlation:

```text
acting_instance_id: act_<uuid>
```

Constraints:

- **Opaque.** No segment encodes transport, runtime, or interface.
- **No substrate-visible metadata** that would identify the source's nature.
- **Optional.** Required only where the bus can produce one without inferring interface type.
- Adapters may keep transport details in their own private operational logs. Those details do not flow into the canonical event or any substrate-visible surface.

### 2.6 Delivery semantics — actor/context-level

This is a **revision** from v1 of this proposal.

A canonical event targets an `actor` or `context`. Delivery is recorded at the **actor/context level**, not the binding level:

- The bus tracks: "event E was delivered for actor A in context C." Singular delivery record per actor.
- Adapters/interfaces may **observe** or **claim** processing for that delivery, but they do not split the canonical delivery into per-binding deliveries.
- When one actor has multiple active interfaces (e.g., a human in FloeWeb + CLI simultaneously), the substrate treats them as observation/notification fan-out **after** the canonical delivery is recorded. Duplicate processing is prevented at the actor/context level, not by picking a winning binding.
- For agent actors with a runtime adapter, the runtime adapter is the processor of record. For human actors, observation is passive (UIs render; nothing is "processed" beyond the human reading and replying).

The internal binding/transport concept (if needed at all in the immediate slice) is **adapter-private operational state**, not substrate identity.

### 2.7 Event schema (long-term shape)

```text
event
  event_id              TEXT      PK
  type                  TEXT
  workspace_id          TEXT
  source_actor          TEXT             -- "actor:<ws>:<id>"
  acting_instance_id    TEXT      NULL   -- opaque
  context_id            TEXT             -- "ctx_..."
  destination_json      JSON             -- selector targeting actor or context
  correlation_id        TEXT      NULL
  caused_by_event_id    TEXT      NULL
  content               JSON
  response              JSON
  metadata              JSON
  created_at            TIMESTAMP
```

Destination selectors:

```text
DestinationSelector =
  | { kind: "actor",   actor_id: "<id>" }
  | { kind: "context", context_id: "ctx_..." }
```

**Broadcast is not part of the new model.** See §5.4 for deferral rationale.

### 2.8 Rendering rules (long-term)

- Selecting a context renders all events in that context, from all participants, in chronological order. **No client-side source filtering.**
- Selecting an actor shows the actor's profile, configuration, and a list of contexts they participate in. Selecting a context from that list navigates to it.
- Sub-context events do not appear in parent contexts unless explicitly emitted there (cross-context summarisation by an actor).
- A "show related contexts" view that traverses `parent_context_id` is allowed but must be explicitly requested and visually attribute events to their context.

### 2.9 Multi-client compatibility

Same actor on FloeWeb + CLI + Slack + API + a runtime adapter produces identical canonical events. The substrate sees only `source_actor` and (optionally) `acting_instance_id`. It does not know which interface acted and never branches on it.

Adapter/transport-private metadata stays in adapter logs.

### 2.10 Compatibility with fields, blocks, extensions

Fields/blocks render context views, actor views, or invent new views without substrate changes. Extensions register hooks (already shipped) and contribute tools that operate on contexts. Channels/hubs/queues become field/block patterns built on top of contexts. No mandatory channel structure.

---

## 3. Minimal Correction Slice (Proposed for Implementation)

**Goal:** stop event bleed, stop conflating actor with chat — with the smallest safe substrate change.

This slice does **not** implement the full long-term architecture. It implements the minimum needed to fix the current product issue.

### 3.1 What this slice changes

#### 3.1.1 First-class context records

Add a `contexts` table and a `context_participants` table (schemas as in §2.4). For now, only the columns strictly needed:

```text
contexts
  context_id            TEXT      PK
  workspace_id          TEXT
  parent_context_id     TEXT      NULL    -- nullable; for future related-context views (low risk to include now)
  created_by_endpoint_id TEXT     -- existing endpoint id; no actor migration yet
  created_at            TIMESTAMP

context_participants
  context_id            TEXT      FK
  endpoint_id           TEXT             -- existing endpoint id; not actor_id yet
  joined_at             TIMESTAMP
  PRIMARY KEY (context_id, endpoint_id)
```

Note: this slice keeps `endpoint_id` as the participant reference. The actor migration is deferred. We are buying first-class contexts without yet renaming identity.

#### 3.1.2 Add `context_id` to events

Add a `context_id` column to the `events` table. **It is the canonical context handle.** The legacy `thread_id` field is removed from new flows where practical; if any current internal component still depends on it, either update that component to use `context_id` or keep a clearly-marked temporary internal alias with a TODO. No migration shim, no dual-write, no preservation of old workspace data.

For new events: `context_id` is required (or computed by the bus per the §3.1.4 rule on emit-time when not supplied).

#### 3.1.3 Server-side context-scoped query

Add a new endpoint:

```text
GET /v1/contexts/<context_id>/events?limit=N
```

Returns all events with `context_id == ctx_...`, regardless of source. **No source filtering.**

The legacy `/v1/events?workspace_id=X` remains for inspection/admin views.

#### 3.1.4 Context-aware emit (corrected rule)

The emit API accepts a `context_id` (preferred) or a `thread_id` (legacy, mapped). A guiding principle:

```text
destination controls delivery.
context_id controls event grouping/rendering.
```

A context is **not** a delivery target. An emit must always specify an explicit destination endpoint (or a specific selector). Targeting a context for delivery — i.e., implicit broadcast to all participants — is **not** part of this slice.

The substrate applies this **participant-aware continue rule** to decide which context an emit belongs to:

1. **Explicit context_id provided** → use it, after validating the source endpoint is a participant. Reject otherwise.
2. **No context_id provided, current delivery context known, destination endpoint is already a participant in the current context** → continue the current context.
3. **No context_id provided, destination endpoint is not a participant in the current context** → open a new context with {source endpoint, destination endpoint} as participants. Return its `context_id`.
4. **No recency heuristics.** A "previous context with this destination" is never auto-selected; UIs that want continue-previous must explicitly pass `context_id`.

**There is no server-side notion of "current UI context".** The bus does not remember which context a UI most recently selected. The "current delivery context" used in rules 2 and 3 only exists when a runtime is processing a delivered event (e.g., the bridge calling `emit` from inside an agent turn). For UI-originated emits with no delivery context, rules 2 and 3 do not apply — only rule 1 (explicit `context_id`) or "open a new context with {source, destination}" (rule 3 reduced to its no-current-context form).

Concretely:

| Caller | `context_id` | Current delivery context | Outcome |
|---|---|---|---|
| Runtime (during delivery) | provided | n/a | rule 1 |
| Runtime (during delivery) | omitted | exists | rule 2 or 3 (participant-aware) |
| FloeWeb / external client | provided | n/a | rule 1 |
| FloeWeb / external client | omitted | none | open new context with {source, destination} |

Rejection rules:

- An emit with `context_id: A, destination: null` is **rejected** unless the event type is an explicit internal/system type (e.g., a context lifecycle event) that does not require delivery to a peer.
- An emit with `context_id: A` where the source endpoint is not a participant in A is rejected with structured error code `E_NOT_CONTEXT_PARTICIPANT`. The error payload includes `context_id`, `source_endpoint_id`, a bounded `available_contexts` list (contexts the source *is* a participant in, with participants and topic), and `recovery` hints. **No event is persisted, no delivery is created, and the bus does not silently fall back to the participant-aware continue rule.**
- An emit whose destination endpoint exists but does not belong to the workspace is rejected.
- **Self-emit is allowed.** `source == destination` is a valid emit; the source endpoint is, by definition, a participant of any context it created (or that was created targeting it, e.g., pulse). No special-case rejection.

Worked example:

```text
Context A: justin ↔ floe
  - floe replies, destination=justin                 → continues Context A
                                                       (justin is a participant in A)
  - floe emits, destination=reviewer (not in A)      → opens Context B: {floe, reviewer}
  - reviewer replies, destination=floe (in B)        → continues Context B
  - floe emits a summary, destination=justin,        → continues Context A
                              context_id=A             (justin is participant in A)
```

Context B never renders inside Context A unless explicitly summarised, mirrored, or surfaced by a related-context view. Natural replies stay in their context. Cross-endpoint reach-out always opens a separate context.

This is the change that prevents both auto-merging of unrelated conversations *and* unnatural fragmentation of normal replies — without introducing implicit group-chat semantics.

> **Group-chat behaviour is deferred.** If we later want explicit broadcast within a context, it would take the form of a new selector such as `{ kind: "context_participants", context_id: "ctx_…", exclude_source: true }`, or a channel/hub block/extension with a clear delivery and activation policy. The minimal slice does not introduce any such behaviour.

#### 3.1.5 Agent-to-agent isolation (driven by §3.1.4 rule)

Because the participant-aware continue rule (§3.1.4) opens a new context whenever the destination is not already a participant, agent-to-agent reach-outs are isolated automatically:

- Agent floe receives a delivery in `ctx_user_floe` (participants: justin, floe).
- Floe emits to reviewer without a `context_id`.
- Reviewer is not in `ctx_user_floe` → bus opens `ctx_floe_reviewer` (participants: floe, reviewer). Reviewer's reply continues there.
- Floe later emits a summary back into `ctx_user_floe` by passing that `context_id` explicitly. Justin is a participant; the message lands.

**Delivery context rendered to the agent (this slice):**

```yaml
current_context_id: ctx_...
current_context_participants:
  - endpoint:...
  - endpoint:...
source_endpoint: endpoint:...
reply_destination: endpoint:...
```

(Optional `current_context_topic` may appear once topic semantics are implemented; do not invent it now.)

The agent does **not** receive a global list of contexts in delivery context. Sibling/older contexts are discoverable later via an explicit `list_contexts` (or `list_actor_contexts`) tool — out of scope for this slice.

**SUBSTRATE_GUIDANCE additions (concise):**
- `context_id` groups related events; `destination` controls delivery.
- Emitting to a participant in the current context continues that context.
- Emitting to a non-participant without a `context_id` opens a new context.
- To intentionally respond in the current context, pass the current `context_id`.
- To consult another endpoint privately, omit `context_id` unless that endpoint is already a participant.
- Contexts are not channels or broadcasts.

**Emit tool behaviour:** accepts optional `context_id`. If omitted, bus applies the participant-aware continue rule. If provided, bus validates source participation and returns `E_NOT_CONTEXT_PARTICIPANT` if invalid (per §3.1.4).

#### 3.1.6 Non-actor triggers (pulse, webhook) — target-only participants

Pulse and webhook events are not actor-to-actor messages. They are non-actor substrate/integration triggers. They must not synthesise actor-shaped sources (no `endpoint:<ws>:system:scheduler`, no webhook "endpoints" treated as participants).

Rule for pulse/webhook-triggered events:

- The trigger must specify an **explicit target** selector (for the slice: `{ kind: "endpoint", endpoint_id: ... }`; long-term: `{ kind: "actor", actor_id: ... }`).
- Trigger source details (pulse_id, pulse_name, webhook route, etc.) are recorded in event **metadata** only.
- The trigger source is **not** added as a context participant.
- Context participants initially contain **only the target endpoint**.
- The bus creates a delivery for the target endpoint.
- The participant-aware continue rule (§3.1.4) applies only when an actor/endpoint is emitting; it does **not** apply to bus-generated trigger events.

If the current schema cannot support `source_endpoint_id: null`, use an internal/legacy source marker for storage compatibility only — never rendered, never added as a participant.

Example pulse event:

```yaml
type: pulse.fired
source_endpoint_id: null              # or legacy marker; not rendered, not a participant
context_id: ctx_pulse_<uuid>
destination:
  kind: endpoint
  endpoint_id: endpoint:<ws>:agent:floe
metadata:
  trigger_kind: pulse
  pulse_id: pulse_123
  pulse_name: daily_check
```

Resulting context:

```yaml
context_id: ctx_pulse_<uuid>
participants:
  - endpoint:<ws>:agent:floe        # target endpoint only
```

If the target actor processes the pulse and has nothing to communicate, it ends with no emit (per the existing conditional emit rule). If it wants to notify another endpoint, the §3.1.4 rule applies — since the target is the only participant in the pulse context, emitting to anyone else without an explicit `context_id` opens a new context. Webhooks follow the same pattern; one context per ingest is acceptable for the slice.

#### 3.1.6 FloeWeb chat panel

FloeWeb stops fetching all workspace events. It calls the new `/v1/contexts/<id>/events` endpoint for the currently selected context. No client-side source filter.

The "selected agent" UI gains a minimal change: a list of contexts for that agent (with the default context preselected). "New conversation with this actor" becomes an explicit affordance.

**Context list ordering and labelling (slice scope):**
- Sort: by `last_event_at` descending (most recent activity on top). The bus exposes `last_event_at` on the `/v1/contexts?participant=<endpoint_id>` response as a cheap aggregate (`MAX(events.created_at)` per context).
- Label: text preview of the first message event in the context (truncated to ~80 chars). If no message event exists yet (e.g., pulse-only context with no emit), fall back to a generic label like `"Pulse: <pulse_name>"` derived from the first event's metadata, else `"Conversation"`.
- Default context (if one exists for this agent) is pinned first regardless of activity.

**"New conversation" affordance:**
- Clicking "New conversation with <agent>" enters a local UI draft state: `selected_context_id = null`, `draft_destination = endpoint:<agent>`. **No API call is made.**
- On first send, FloeWeb emits with `context_id: null`. Because there is no current delivery context for UI-originated emits, the bus opens a new context with `{operator, agent}` as participants and returns the new `context_id`. FloeWeb adopts it.
- This avoids empty abandoned contexts and removes the need for any `new_context: true` flag.
- Continuing an existing FloeWeb conversation requires FloeWeb to pass the explicit `context_id`.

**Fresh-workspace bootstrap:**
- No default context is pre-created on workspace attach, bridge boot, FloeWeb load, actor selection, or composer open.
- A fresh workspace has zero contexts. Selecting an actor with no contexts shows an empty state (e.g., "No conversations with <agent> yet. Send a message to start one.") with a primed composer.
- The first message creates the first context via the lazy rule above. Reloading FloeWeb after that shows the real created context — never a fake default.

**This is the only UI change in the slice.** Profile views, multi-context navigation, and related-context views are deferred.

#### 3.1.7 Participant set is fixed at context creation (no add/remove in slice)

Once a context is created, its participant set is **frozen for the duration of this slice**. There is no `add_participant` or `remove_participant` API.

If a participant of context A emits to a destination not in A's participants, the bus does **not** add the destination to A. Instead, it opens a new context with `{source, destination}` as participants (per §3.1.4 rule 3). The original context is untouched.

Worked example:
- Context A: `{operator, floe}`.
- Operator asks floe to consult reviewer.
- Floe emits to reviewer (no `context_id`). Reviewer is not in A.
- Bus creates Context B: `{floe, reviewer}`. A is unchanged.
- Reviewer replies in B.
- Floe later emits a summary back into A by passing `context_id=A` explicitly.

Why deferred: participant management raises policy/product questions outside the slice (who may add, history visibility, activation, leave, agent loops, group vs channel semantics). These get an intentional later slice or a field/block/extension pattern. Future shape (not in slice): `add_participant(context_id, endpoint_id, authority)` / `remove_participant(...)`.

### 3.2 What this slice does not change

To stay narrow, the slice **does not**:

- Rename `endpoint` → `actor` or `binding`. Endpoint IDs remain the routing identifier for now.
- Backfill an `actors` table. Actors as a first-class concept come later.
- Introduce `acting_instance_id`, `caused_by_event_id`, or `parent_context_id` as required fields. They may be added as nullable columns for forward compatibility but are not used by this slice.
- Change broadcast semantics (see §5.4).
- Touch tool availability or authority.
- Touch transport/binding state. Adapters keep doing what they do.

### 3.3 What the slice gives us

After this slice:

- ✅ Selecting a context renders only events in that context — bleed eliminated server-side.
- ✅ Agent-to-agent conversations live in their own contexts and never appear in unrelated views.
- ✅ Selecting an actor surfaces multiple distinct conversations (no auto-merge).
- ✅ Default Floe conversation continues to work unchanged.
- ✅ Existing `thread_id`-based events remain readable.

We do **not** yet have actor-neutral identity, opaque acting instances, causality fields, or unified multi-binding delivery. Those come in subsequent slices.

---

## 4. Fresh-State Implementation (no migration)

This product has not shipped. All existing workspaces and bus SQLite state are test/dev data and may be discarded. The slice does **not** implement legacy migration.

### 4.1 What this means concretely

- No `thread_to_context_map` table.
- No backfill of historical threads to contexts.
- No dual-write of `thread_id` and `context_id`.
- No release-window preservation of old `thread_id` chat history.
- No participant inference from historical events.
- Existing `.floe` workspaces and bus DBs may be deleted as part of bringing up the new schema.

### 4.2 Fresh-state behaviour

- A fresh workspace boots with the new schema. No contexts exist initially.
- The first emit between operator and floe creates the first context (per §3.1.4 lazy creation).
- FloeWeb's chat panel renders from `/v1/contexts/<context_id>/events` only. The legacy workspace-wide event fetch is removed from chat code paths (it may remain for inspector/admin views).
- If any internal component still depends on `thread_id`, fix it — do not preserve the old field for compatibility.

### 4.3 What still gets carried forward

Only structural/canonical things that aren't workspace data:

- Bus database schema migrations are written normally so that anyone who runs the slice gets the new schema cleanly.
- Existing endpoints (operator, floe agent) re-register on bus boot as today; this is not "migration," just normal boot.
- Pulse definitions in workspace config files (`floe.yaml`) are read fresh at attach time and produce events under the new context model.

This drastically reduces slice scope and complexity.

---

## 5. Intentionally Deferred

### 5.1 Actor identity migration

The renaming of `endpoint:<ws>:agent:<id>` → `actor:<ws>:<id>` and the `actors` / `actor_bindings` tables are deferred to a subsequent slice. The minimal slice keeps endpoint IDs as participants. This avoids touching every adapter, every test, and every UI surface in one pass.

### 5.2 Acting instance IDs

`acting_instance_id` is not introduced in the minimal slice. It will be added when the bus can reliably emit one **without** leaking interface identity, and when there is a concrete audit/replay use case that needs it.

### 5.3 Causality fields

`caused_by_event_id` and `parent_context_id` are not used in the minimal slice. They may be added as nullable columns for forward compatibility but the slice does not populate or query them. Sub-context navigation is a future concern.

### 5.4 Broadcast

The current broadcast targets `target: "all" | "agents" | "humans" | "active_agents" | "active_humans"` (see `floe-bus/src/store.ts:11-18`).

Per reviewer correction:

- **`humans` and `agents` targeting is removed** from the new model. Compatibility shim retained: existing code using these targets continues to work but is logged as deprecated.
- **Broadcast does not auto-activate every actor.** Visibility, delivery, and activation remain separate concerns. A broadcast becomes a notification visible in actor inboxes; whether each actor processes it is a separate decision (currently: only actors with a runtime adapter ever activate; humans may see and ignore).
- **No new broadcast features in this slice.** If a future slice needs a clean broadcast, it gets designed then.

### 5.5 Authority / permissions

`default_authority` is a placeholder field on the future `actors` table. It is not in the minimal slice. No permission checks are added.

### 5.6 Multi-binding delivery semantics

Same-actor multi-interface (FloeWeb + CLI simultaneously) is not addressed in the slice. Today this works incidentally because there's only ever one operator endpoint per workspace. When this becomes a real product concern, a separate slice addresses delivery-fan-out semantics.

### 5.7 Transport metadata as substrate state

Per reviewer correction, transports (`floe-web`, `floe-bridge`, `slack`, etc.) are **not** modelled in substrate state. The minimal slice does not add a `transport` column anywhere. Adapters keep their own operational state private.

### 5.8 Context lifecycle (open/close/archive)

Contexts have **no lifecycle status** in this slice. Once created, a context is always open and remains emittable into (subject to participant gating). There is no `close`, `reopen`, `archive`, or `status` column. Lifecycle, retention, and UI archiving are deferred to a later slice and may be UI-only when introduced.

---

## 6. Tests & Live QA (for the slice)

### 6.1 Substrate unit tests

| # | Test | What it proves |
|---|---|---|
| T1 | `createContext({participants: [E1, E2]})` creates a row with both as participants | Context creation |
| T2 | `emit(source=E1, destination=E2)` without `context_id` and no current context opens a new context | Lazy creation |
| T3 | `emit(source=E1, destination=E2)` where E2 ∈ current context's participants → continues current context | Participant-aware continue |
| T4 | `emit(source=E1, destination=E3)` where E3 ∉ current context → opens new context with {E1,E3} | Isolation |
| T5 | `emit(context_id=A, source=X)` where X ∉ A's participants → rejected | Participant gating |
| T6 | `emit(context_id=A, destination=null)` for non-system event → rejected | Destination required |
| T7 | `getContextEvents(ctx_X)` never returns events with `context_id == ctx_Y` | Context isolation |
| T8 | Pulse trigger event has `context_id` set, target endpoint as sole participant, no synthetic source participant | Pulse target-only |
| T9 | Webhook ingest creates one context per ingest with target endpoint as sole participant | Webhook target-only |
| T10 | No `add_participant` / `remove_participant` API exists; participant set returned by `getContext` is identical before and after any emit cycle | Participant immutability |
| T11 | When destination is not a participant, original context's participant set is unchanged after the new context is created | No silent join |
| T12 | Emit with `context_id=A` where source ∈ A → succeeds | Strict participant gating (positive) |
| T13 | Emit with `context_id=A` where source ∉ A → rejected with `E_NOT_CONTEXT_PARTICIPANT`; no event persisted, no delivery created; error includes bounded `available_contexts` | Strict participant gating (negative) |
| T14 | Self-emit (source == destination) into a context the source participates in → succeeds; event lands in same context | Self-emit allowed |
| T15 | Rendered delivery context contains `current_context_id`, `current_context_participants`, `source_endpoint`, `reply_destination`; does NOT contain a global contexts list | Delivery context shape |
| T16 | Agent emits to a current participant → event continues current context (verified via T15 + T3) | Continue path |
| T17 | Agent emits to a non-participant → new context opened (verified via T15 + T4) | New-context path |
| T18 | UI-originated emit with `context_id: null` and no delivery context → bus opens new context with {operator, destination}; previous UI selection is not consulted | UI lazy new-conversation |
| T19 | UI-originated emit with explicit `context_id` → continues that context (rule 1 path) | UI continue-existing |
| T20 | Fresh workspace returns zero contexts; selecting an actor and opening a composer do NOT create a context; first sent message creates the first context | Fresh-workspace bootstrap |

### 6.2 Live E2E proofs (must pass before declaring slice complete) — fresh-state

**E2E-1 — Fresh workspace creates first context lazily on first emit:**
1. Boot a fresh workspace (no prior bus state). Verify `/v1/contexts?participant=<operator>` returns an empty list.
2. Operator opens FloeWeb, selects floe — UI shows empty-state ("No conversations with floe yet"). No context is created by selection or composer open.
3. Operator sends a first message to floe.
4. Verify: a context is created lazily on emit; the resulting `context_id` is returned and FloeWeb adopts it. `context_participants` contains operator and floe.
5. Reload FloeWeb. Verify the real context appears in the list (no fake default).

**E2E-2 — Two separate contexts with the same two participants do not bleed:**
1. Operator messages floe — context A created.
2. Operator opens an explicit "new conversation" with floe and sends another message — context B created.
3. Verify: A renders only the round-1 messages; B renders only the round-2 messages. Selecting either renders only its own events.

**E2E-3 — A normal reply to a participant stays in the current context:**
1. Operator messages floe (context A, participants {operator, floe}).
2. Floe emits a reply with destination=operator, no `context_id`.
3. Verify: the reply lands in context A (participant-aware continue). No new context is created.

**E2E-4 — Emit to non-participant opens a separate context:**
1. From context A, floe emits with destination=reviewer, no `context_id`. Reviewer is not a participant of A.
2. Verify: a new context B is created with participants {floe, reviewer}. Reviewer's reply continues in B.

**E2E-5 — Agent-to-agent messages do not appear in the initiating context:**
1. Reproduce E2E-4.
2. Verify: context A renders only operator's request and floe's direct messages. The floe↔reviewer exchange does not appear there.

**E2E-6 — A summary emitted back into the initiating context appears there:**
1. Continue E2E-5. Floe summarises the reviewer exchange and emits the summary with destination=operator and `context_id=A` explicitly.
2. Verify: the summary appears in context A. The original reviewer messages still do not appear there.

**E2E-7 — `/v1/contexts/<context_id>/events` returns only events for that context:**
1. With several distinct contexts populated, call the endpoint for one specific `context_id`.
2. Verify: only events with that `context_id` are returned, regardless of source. No events from other contexts appear.

**E2E-8 — FloeWeb no longer uses workspace-wide event fetch + client-side source filtering for chat rendering:**
1. Network-inspect FloeWeb during chat use.
2. Verify: chat fetches go to `/v1/contexts/<id>/events`. The legacy `/v1/events?workspace_id=X` is no longer called from chat code paths (it may remain for inspector/admin views).
3. Verify: no client-side filter on `event.source_endpoint_id` exists in the chat rendering path.

**E2E-9 — Pulse target-only context works without synthetic participants:**
1. Configure a pulse for floe; let it fire.
2. Verify: the resulting context has `floe` as its sole participant. No synthetic system endpoint, no scheduler "actor". The trigger metadata (pulse_id, pulse_name) is in event metadata only.
3. Verify: floe's runtime is activated by normal delivery; if floe ends without emit, the context contains exactly one event.

---

## 7. Resolved Decisions (from review)

1. **Implicit-continue rule:** participant-aware. Continue only when destination is already a participant in the current delivery context; otherwise open a new context. No recency heuristics.
2. **Webhook contexts:** one context per ingest is acceptable for now. Route-level grouping deferred to a future block/extension pattern.
3. **Dual-write window:** one release.
4. **Nullable causality fields:** `parent_context_id` on `contexts` is included in this slice (low risk, useful for related-context views). `caused_by_event_id` is **deferred** (not low-risk; semantics need design).
5. **Endpoint IDs as participants:** acceptable temporarily for the slice. Long-term model uses actor IDs. The slice does not introduce any new parsing of `user`/`agent`/`webhook` segments in endpoint IDs.

---

## 8. Summary

| Concern | Today | Long-term target | Minimal slice |
|---|---|---|---|
| Identity | `endpoint:<ws>:<type>:<id>` | `actor:<ws>:<id>` | Unchanged (endpoints stay) |
| Thread | Implicit string | First-class `contexts` + participants | First-class `contexts` + participants (using endpoint IDs) |
| Transport in substrate | Implicit via `actor_type` | Removed; adapter-private | Unchanged (deferred cleanup) |
| Actor-vs-context conflation | Selecting actor = chat | Selecting actor = profile + list of contexts | Selecting actor = list of contexts (basic) |
| Filtering | Client-side, source-matching | Server-side, context-bound | Server-side, context-bound |
| Delivery | Per-endpoint queue | Actor/context-level with adapter observation | Unchanged (deferred) |
| Causality | None | `caused_by_event_id` + `parent_context_id` | `parent_context_id` only (causal events deferred) |
| Audit handle | None | Opaque `acting_instance_id` (optional) | Not introduced |
| Broadcast | `humans`/`agents` targeting | Removed; visibility ≠ activation | Compatibility shim only; deprecation logged |
| Webhooks/schedulers/transports as actors | N/A | **Not actors.** Remain non-actor sources/integrations | **Not actors.** Unchanged |
| Migration | N/A | Multi-slice, gradual | **None — fresh-state only; old workspaces wiped** |

The minimal slice fixes the bleed without committing the whole substrate to a one-shot rewrite. The long-term direction is documented for future slices to follow incrementally.
