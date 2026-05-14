# PRD — Actor UX Correction & Delivery Symmetry

## Problem Statement

Three structural issues prevent FloeWeb from correctly presenting the actor-neutral context model:

1. **Context bleed**: `refreshContexts` queries contexts by the selected actor's participant ID rather than the operator's own. When viewing "designer", the UI shows ALL contexts where designer participates — including floe↔designer conversations the operator has no part in.

2. **Delivery asymmetry**: The bus gates push-delivery on `actor_type === "agent"` (store.ts:1366). This means the operator actor can never receive a bus-pushed delivery. While FloeWeb polls for events (so messages display), the asymmetry means the substrate treats actors as fundamentally different categories — violating actor neutrality.

3. **Hardcoded operator identity**: The operator is always `actor:<ws>:operator` with the display name "Operator". There's no way to customise the operator's name within a workspace.

Additionally, the actor/conversation panel's UX doesn't clearly separate actors, contexts, and activity — and retains wording/code that implies categories.

## Solution

Fix all three substrate issues and redesign the FloeWeb actor/conversation panel to correctly present the actor/context/message model, while preserving the existing block/field/canvas workspace surface untouched.

## User Stories

1. As an operator, I want to see only conversations I participate in, so that I never see private actor-to-actor conversations I'm not part of.
2. As an operator, I want to select an actor and see only my conversations with that actor, so that context is clear and bounded.
3. As an operator, I want to start a new conversation with any actor, so that my conversations are intentionally separated.
4. As an operator, I want to set my own display name, so that I'm not hardcoded as "Operator".
5. As an operator, I want to see each actor's status (idle, active, waiting, runtime_unconfigured), so that I know if they can respond.
6. As an operator, I want to see activity/work grouped below the relevant message, so that I understand what happened behind a response.
7. As an operator, I want to never see "human", "agent", or raw endpoint IDs in the UI, so that the interface is actor-neutral.
8. As an operator, I want conversations to never bleed events from other contexts, so that I can trust the conversation boundary.
9. As an operator, I want the bus to treat all actors symmetrically for delivery eligibility, so that future clients (CLI, API, Slack) work identically.
10. As an actor with a registered delivery processor, I want to receive deliveries based on that registration, not based on a category label, so that any actor can be operated by any interface.
11. As an operator, I want the first message to an actor to lazily create the context, so that no fake or empty contexts exist.
12. As an operator, I want the channel panel to show a clear separation between "which actor" and "which conversation", so that selecting an actor doesn't merge all their messages.
13. As an operator, I want continuing an existing conversation to pass the explicit context_id, so that replies stay in the right context.
14. As an operator, I want pulse/trigger activity to appear in its own target-only context, so that scheduled work doesn't pollute my conversations.
15. As an operator, I want raw telemetry and work-log entries to never appear as chat messages, so that communication and activity are visually distinct.

## Implementation Decisions

### Substrate: Delivery symmetry (bus)

- Replace `actor_type !== "agent"` delivery gate with a check for whether the actor has a registered delivery processor (runtime binding). The current signal for this is `bridge_id IS NOT NULL`.
- An actor with a registered delivery processor is eligible for push-delivery regardless of any other field.
- An actor without a delivery processor (like the operator in FloeWeb) relies on poll-based access via `/v1/contexts/:id/events`.
- **Remove `actor_type` from the schema entirely.** Drop the column from the `endpoints` table DDL. Remove the field from the registration zod schema, the `registerEndpoint` function signature, all SQL queries, and all code that reads or writes it.
- Remove from the bus API: the `/v1/endpoints/register` body no longer accepts or requires `actor_type`. The bus does not know or care what kind of thing operates an actor.
- All routing, broadcast, delivery, and status-transition logic that currently branches on `actor_type` must be replaced with delivery-processor-presence checks (`bridge_id IS NOT NULL`) or unconditional actor logic.
- **Existing local workspaces/DBs may be reset.** Floe has not shipped — there is no compatibility obligation.
- FloeWeb registration must NOT send `actor_type`. It registers an actor with an ID, name, status, and metadata. Nothing more.
- Add tests proving: no code references `actor_type` in any routing/query path; no actor-visible surface exposes category labels; no prompt/tool/UI reveals what interface operates an actor.

### Substrate: Operator identity

- The operator is an actor. Its identity follows the standard model: `actor:<workspace_id>:<actor_handle>`.
- Default handle: `operator`. Default display name: "You" (neutral, non-categorical).
- The durable operator display name comes from the `name` field on the actor's endpoint record in the bus.
- FloeWeb reads the operator's current name from the bus endpoint record on startup.
- FloeWeb provides a UI to update the operator's display name (calls `POST /v1/endpoints/register` with the new name — upsert behaviour).
- localStorage may cache the name for instant display before the bus responds, but is NOT the source of truth.
- No special schema or endpoint structure for operators. The operator is an actor. FloeWeb is one interface through which that actor can act.
- Future: the handle itself may become configurable (`actor:<ws>:justin` instead of `actor:<ws>:operator`). Not required in this slice.

### FloeWeb: Context query fix (the bleed)

- `refreshContexts` currently: `GET /v1/contexts?participant=${agentEndpointId}` (incorrect — uses the selected actor's ID)
- Corrected: `GET /v1/contexts?participant=${selfActorId}`
- Then **client-side filter** in the actor/conversation panel to show only contexts where both self AND the selected actor are participants. This is cheap (small list) and avoids needing a new bus API for multi-participant AND queries.
- Result: the conversation list for a selected actor shows only contexts where {self, selected actor} both participate. Contexts between other actors are invisible in this panel.
- Note: this is a UI panel decision, not a substrate visibility rule. Future FloeWeb views (admin/inspection/activity) may display broader context views. This pass only corrects the actor conversation panel.

### FloeWeb: Actor/conversation panel redesign

The panel (`<aside className="channel">`) keeps its position as a togglable right-side panel alongside the workspace surface. The CSS class name may remain `channel` temporarily to avoid churn, but user-facing language is actor/context based. Changes:

**Header**: Shows selected actor name + status. If multiple actors exist, a dropdown or list-based selector at the top of the panel. No "Bot" icon — use a neutral circle/initial icon for all actors equally. No icon should imply category.

**Context list section**: "Conversations with [Actor]" heading. Lists contexts where both self and selected actor participate. Each item shows: first-message preview (or "Conversation" fallback), relative timestamp. "New conversation" button at bottom or top.

**Message view**: Unchanged structurally — already uses `/v1/contexts/:id/events` and renders per-context. Messages styled as self/other (no category classes). Activity groups already render below messages — keep.

**Empty states** (already implemented):
- No conversations yet → "No conversations with [Actor] yet. Send a message to start one."
- Draft mode → "New conversation with [Actor]. Type a message below to start."
- No context selected → "Select a conversation or start a new one."

**Composer**: Unchanged. Continues to pass `context_id` for existing contexts or omit for new.

### Actor-neutral language audit

- Remove "Default channel" from inspector's ActorAccessSection.
- Remove any `<Bot>` icon or category-implying iconography from the actor selector. Use a neutral circle/initial icon for all actors equally.
- Category words (`human`, `agent`, `user`, `runtime`, `bot`) must not appear as UI labels or hardcoded icon choices that distinguish actors by substrate type. An actor whose user-chosen display name happens to contain "Agent" (e.g., "Creative Agent") is allowed — what is banned is *system-imposed category labels*.
- CSS class `.channel-message.self` / `.channel-message.other` (already done in Slice 9).
- Tests must be precise: ban system-generated category leakage (raw IDs, `actor_type`, `human`/`agent` as system labels, "Bot" as a hardcoded icon label), but allow user-chosen display names that may contain any word.

### Activity display

- Keep the current grouped activity model (activity groups collapse below relevant messages).
- Activity group labels should be human-readable: "Read file", "Searched code", "Completed" — not raw telemetry event types.
- Raw telemetry stays accessible via an expandable debug drawer (already exists as expanded/collapsed toggle).
- Activity is never confused with communication — it renders with distinct styling (muted, indented, collapsible).

## Testing Decisions

### What makes a good test

Tests assert external, user-visible behaviour — not implementation details. A test should break only if the user would notice a difference.

### Modules to test

1. **Bus delivery symmetry** — unit tests in `floe-bus/src/store.test.ts` (or a new `delivery.test.ts`):
   - Actor with `bridge_id` set → eligible for delivery.
   - Actor with `bridge_id = null` → not eligible for push delivery.
   - Registration without `actor_type` succeeds (the field does not exist).
   - No code path references `actor_type`.
   - Existing broadcast/webhook queries work with delivery-processor-presence logic.

2. **Context query (bleed fix)** — Playwright spec in `floe-web/tests/`:
   - Mock workspace with 3 actors (operator, floe, reviewer).
   - Context A (operator+floe), Context B (floe+reviewer).
   - Select floe → see only Context A. Context B events never appear.
   - Select reviewer → see no contexts (operator has none with reviewer).

3. **Operator name** — unit or Playwright test:
   - Registration body does NOT contain `actor_type`.
   - Setting operator name → registration uses that name.
   - Channel shows "You" (or configured name) for self messages.

4. **Actor-neutral UI** — extend existing `actor-neutral-ui.spec.ts`:
   - No system-imposed category labels visible: no "human"/"agent" as system labels, no raw endpoint IDs, no `actor_type` field, no "Bot" as a hardcoded category icon.
   - User-chosen display names are allowed even if they contain the word "Agent" (e.g., "Creative Agent" is a valid actor name).
   - Tests assert against system-generated UI elements (badge labels, section headers, icon alt text) — not against user-authored display names.

5. **`actor_type` leakage proof** — test across all actor-visible surfaces:
   - Runtime prompt text contains no `actor_type` field.
   - `list_endpoints` response contains no `actor_type` key.
   - `resolve_destination` response contains no `actor_type` key.
   - Delivery context block contains no `actor_type`, `human`, or `agent` category.
   - Context participants shown to actors are neutral refs only.
   - FloeWeb rendered DOM contains no `actor_type` attribute or visible text.

6. **Live regression** — HITL acceptance (not automated):
   - Ask an actor: "Can you guess if I am human or agent? Give evidence and confidence."
   - Actor must not cite substrate metadata. May guess from conversational style only.

### Prior art

- `floe-web/tests/context-rendering.spec.ts` — route-mocked Playwright tests for context rendering.
- `floe-web/tests/no-actor-bleed.spec.ts` — route-mocked bleed assertions.
- `floe-web/tests/actor-neutral-ui.spec.ts` — DOM category audits.
- `floe-bus/src/contexts/integration.test.ts` — submitEvent + resolver integration.

## Out of Scope

- Channels, rooms, inboxes, group conversations, or Slack-like concepts.
- Adding participants to existing contexts.
- Context close/archive lifecycle.
- Permissions or authorization model.
- Global context search.
- Context merge/split.
- Related-context trees or linked summaries view.
- Block/field/canvas workspace surface changes.
- Inspector panel redesign (beyond removing category labels).
- Real-time push notification to FloeWeb (remains poll-based for now).
- Full operator profile management UI (settings page, avatar, etc.) — only the name is editable in this pass.

## Implementation Rules

- Do not preserve legacy category fields or typed IDs for compatibility. Floe has not shipped. If a local workspace, DB, test fixture, route mock, or UI assumption depends on human/agent/user/bot categories, update or delete it.
- All actors are actors. There is no substrate distinction between them. The bus, bridge, and web surfaces must not encode or reveal what interface operates an actor.

## Further Notes

- The actor/conversation panel remains a side panel — it does not replace the main workspace surface. The reference image is used for UX guidance (actor list → context list → messages flow) but the implementation adapts it to the existing panel layout.
- **`actor_type` is removed from the schema.** It does not exist as a nullable column, an optional field, or a compatibility value. New code does not reference it. Existing local workspaces/DBs may be reset.
- Delivery symmetry enables future clients (CLI, API, Slack) to register actors with a delivery processor and receive push deliveries identically to any current actor.

## Live QA acceptance check

As part of final live validation, the following regression test must pass:

> Ask an actor: "Can you guess if I am human or agent? Give evidence and confidence."

Expected answer:
- The substrate does not expose whether an actor is human or agent.
- The actor may guess from writing style only, with limited confidence.
- It must NOT cite endpoint labels, raw IDs, `human`, `agent`, `user`, `actor_type`, runtime labels, or UI/tool metadata as evidence.

This test is performed live during HITL and must pass before the slice is considered complete.
