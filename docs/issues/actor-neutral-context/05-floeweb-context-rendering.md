# Slice 5 — FloeWeb Context-Scoped Rendering (first user-visible vertical acceptance point)

> **Type:** AFK
> **Significance:** This is the first slice where the user-visible bleed bug is actually fixed. Slices 1–4 are substrate plumbing.

## Parent

`docs/actor-neutral-context-slice-prd.md`

## What to build

Replace FloeWeb's workspace-wide event fetch + client-side source filter with context-scoped rendering, and add a per-agent context list with a lazy "new conversation" affordance.

**Chat fetch:**
- Replace `GET /v1/events?workspace_id=X` (used for chat rendering) with `GET /v1/contexts/<id>/events` for the currently selected context.
- Remove the client-side filter on `event.source_endpoint_id` from the chat rendering path.
- The legacy workspace-wide endpoint may remain in use for inspector/admin views, but **not** for chat.

**Agent panel context list:**
- When the operator selects an agent, fetch `GET /v1/contexts?participant=<agent_endpoint_id>`.
- Render the list sorted by `last_event_at` desc.
- Label each entry with `first_message_preview` (truncated to ~80 chars). If null (e.g., pulse-only context), fall back to `"Pulse: <pulse_name>"` derived from the first event's metadata, else `"Conversation"`.
- The default context (if one exists) is pinned first regardless of activity.

**"New conversation" affordance:**
- Clicking "New conversation with <agent>" enters local UI draft state: `selected_context_id = null`, `draft_destination = endpoint:<agent>`. **No API call is made.**
- On first send, FloeWeb emits with `context_id: null`. The bus opens a new context with `{operator, agent}` as participants and returns the new `context_id`. FloeWeb adopts it.
- No `new_context: true` flag.

**Continuing an existing conversation:**
- FloeWeb always passes the explicit `context_id` on send when continuing.

**Empty state:**
- If an agent has zero contexts, show `"No conversations with <agent> yet. Send a message to start one."` with a primed composer.
- Do **not** auto-create a default context on workspace attach, FloeWeb load, actor selection, or composer open.

## Acceptance criteria

- [ ] Chat rendering fetches `/v1/contexts/<id>/events`; the workspace-wide event fetch is no longer called from the chat path.
- [ ] No client-side `event.source_endpoint_id` filter exists in the chat rendering path.
- [ ] Selecting an agent shows a context list sorted by `last_event_at` desc with the documented labelling.
- [ ] Default context (if any) is pinned first.
- [ ] Clicking "New conversation" makes no API call; first send creates the context and FloeWeb adopts it.
- [ ] Continuing an existing FloeWeb conversation sends the explicit `context_id`.
- [ ] Fresh workspace shows empty state for agents; selecting an agent or opening the composer does not create a context.
- [ ] Reloading FloeWeb after sending the first message shows the real created context (no fake default).
- [ ] Manual demo: two contexts with the same participants do not bleed in the UI.

## Caution (from PRD)

There is no server-side "current UI context". For UI-originated emits, continue requires explicit `context_id`; new conversation means omit `context_id`. Do not introduce a flag or server-side selection memory.

## Blocked by

- Slice 2 — Context API
