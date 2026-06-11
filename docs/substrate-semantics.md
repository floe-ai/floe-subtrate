# Floe Substrate Semantics

**Status:** Addendum to Floe Substrate Builder Handoff v58 (v58 itself is superseded — see `docs/floe_thought_log.md` — but the semantics here remain current substrate doctrine)  
**Purpose:** Clarify the substrate model so implementation language, APIs, and runtime
guidance do not drift toward chat-shaped assumptions.

---

## 1. Endpoint equality

Humans, agents, webhooks, extensions, schedulers, and future actors are all
**endpoints**. No endpoint type is privileged in the substrate.

The substrate model is:

```
endpoint emits event
→ bus routes event
→ bus creates deliveries for authorised/subscribed endpoints
→ endpoint processes delivered events
→ endpoint may emit more events
→ endpoint processing cycle ends
```

Every endpoint follows the same lifecycle regardless of whether it is backed by
a human, an AI runtime, a cron scheduler, or a webhook ingress.

---

## 2. Event is the primitive

The bus does not route prompts or replies. It routes **canonical events**.

- A human message is an event.
- An agent message is an event.
- A webhook payload is an event.
- A scheduler/pulse output is an event.
- A todo extension update is an event (or extension state mutation surfaced through events).
- A runtime visible output converted by the bridge is also a canonical event.

All communication and coordination passes through events. There is no separate
"message" channel.

---

## 3. `emit` is universal

`emit` is the substrate publish operation.

| Actor | Access path |
|-------|-------------|
| Agent | Runtime tool |
| Human | UI action (routed through bus) |
| Webhook | HTTP ingress |
| Extension/scheduler | Integration path |

All paths produce the same canonical event shape. `emit` is not "just an agent
tool" — it is the universal publish primitive.

---

## 4. Turn is endpoint lifecycle, not communication

A runtime turn ending means:

> "This endpoint has finished processing the current delivered events."

It does **not** mean:

> "The agent replied to the human."

Turn end is observed by the bridge for lifecycle/status/telemetry. It is not a
substrate message. The bus transitions endpoint state (active → idle/waiting)
based on turn end, not based on whether a "reply" was emitted.

---

## 5. Chat is a view, not the model

The chat UI is one rendering of events in a thread/context.

Implementation language and APIs must not drift into:

```
user prompt → assistant response
```

The substrate model is:

```
events → deliveries → endpoint processing cycles → emitted events
```

Thread views in floe-web render events grouped by thread_id. They do not imply
a request/response pair at the substrate level.

---

## 6. Runtime visible output is work log — not communication

Runtime visible output (model-generated text, tool results, telemetry) is **not**
automatically converted into a message event.

Only explicit `emit` calls create communication events on the bus.

Visible output produced during a processing cycle is recorded as **work log /
runtime trace** for observability. It is not rendered in the main message view.

The long-term model:

- Communication = explicit `emit(event)`
- Visible output = work log
- Turn end = lifecycle

The previous V0 adapter compatibility behaviour (`runtime_turn_output` auto-emit)
has been removed. Agents must explicitly emit message events to communicate.

---

## 7. Visibility through subscriptions/permissions

Not all endpoints see all endpoints, threads, channels, or events.

The bus enforces visibility:

- Events directly delivered to an endpoint
- Events in channels/threads the endpoint is subscribed to
- Endpoints/channels it is allowed to discover
- Workspace/project scopes it has access to

Agents must not receive a global directory of every endpoint by default.
Destination discovery is permission-scoped.

---

## 8. Threads/channels are not endpoint properties

| Concept | Definition |
|---------|-----------|
| Endpoint | Addressable participant/interface |
| Thread | Event grouping/context |
| Channel | Subscription/routing surface |
| Delivery | An event made available to an endpoint |
| Subscription | What an endpoint is allowed to see/receive |

An endpoint may have:

- **inbox** = deliveries visible to that endpoint
- **outbox** = events emitted by that endpoint
- **subscriptions** = channels/threads/scopes it can access

But a thread is not owned by an endpoint.

---

## 9. Agents work by observing state, not primarily messaging

Do not design the system as if agents primarily coordinate through chat.

A typical agent cycle:

1. Woken by pulse/scheduler/todo/webhook/event
2. Inspect authorised system state
3. Read files, use tools
4. Update extension state, commit code
5. Emit a review/update/progress event
6. End processing cycle

Messaging is for communication, notification, review, approval, or
coordination. It is not the whole work model.

---

## 10. Pi containment

Pi remains the V0 runtime engine. Its chat/message/turn assumptions belong
**inside** `PiRuntimeAdapter`.

The stack boundary:

```
floe-bus
→ floe-bridge
  → floe-runtime-core contract
    → PiRuntimeAdapter
      → pi-agent-core
        → pi-ai
```

No code above the runtime adapter should need to know Pi's internal
user/assistant/message assumptions. If Pi becomes too much friction later, a
Floe-native direct-provider adapter can implement the same
`floe-runtime-core` contract.

---

## 11. Destination discovery

Agents receive minimal destination context:

1. **Delivery context** (always available):
   - source endpoint
   - reply destination
   - thread id
   - correlation id

2. **Runtime tool** (optional, scoped):
   - `list_endpoints` — returns only endpoints visible/addressable by the current endpoint
   - `resolve_destination` — maps a human-readable target to allowed destination selectors

Endpoint IDs are never hard-coded into prompts. Agents use delivery context
or discovery tools.

---

## 12. Agent work log / actor diary

Each processing cycle produces a committed Markdown work log — the agent's
activity record for human audit and future memory.

**Location:** `.floe/agents/<agent_id>/worklogs/YYYY-MM-DD.md`

**Includes:**
- Task/turn id, trigger, timing
- Delivered events summary
- Important runtime notes (visible output captured as work trace)
- Meaningful tool activity summary
- Emitted events
- Outcome
- Links/references to artefacts

**Must NOT include:**
- Tokens, secrets, raw credentials
- Full raw telemetry dumps
- Excessive unbounded stream snapshots
- Huge command outputs (summarise instead)

The work log is for **observability and audit**. It is not a communication
mechanism. It is committed to the project by default so humans can review
agent activity.

**Raw runtime telemetry** (full tool call payloads, usage records, delivery
lifecycle details) remains in local bus state / event telemetry storage and is
separate from the committed diary.

---

## 13. Default Floe agent is not technically special

The default `.floe/agents/floe.md` agent is special only by composition content:

- name/label: Floe
- default instruction body
- substrate-build skill
- knowledge of Floe infrastructure

It uses the same technical path as any other runtime-backed agent:

```
agent file → frontmatter parsed → instruction body loaded
→ runtime profile resolved → substrate guidance injected
→ destination context rendered → runtime adapter invoked
→ emitted events / work log / telemetry / lifecycle returned to bus
```

It does not bypass emit/event semantics, endpoint visibility, delivery records,
runtime profile binding, subscriptions/permissions, destination discovery, or
runtime adapter selection.

---

## 14. What this means for implementation

When writing code in floe-bus, floe-bridge, or floe-web:

- ✅ Use "event", "delivery", "endpoint", "emit", "turn", "processing cycle"
- ❌ Do not use "prompt", "reply", "assistant response", "user message" as substrate concepts
- ✅ Communication = explicit emit only
- ❌ Do not auto-convert visible output into messages
- ✅ Enforce visibility through subscriptions/permissions
- ❌ Do not expose global endpoint directories
