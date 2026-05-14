# Issue: Actor/conversation panel UX correction

## Summary

Redesign the FloeWeb conversation panel to cleanly separate actor selection from context selection, remove category-implying UI elements, and ensure the panel works correctly with the fixed context query.

## Current behaviour (broken)

- `<Bot>` icon used in actor selector header (implies category).
- "Default channel" label in inspector.
- Actor selector uses a dropdown that shows agent status with a category-implying layout.
- Context list works but was keyed on the wrong participant query (fixed in issue 02).

## Target behaviour

1. **Actor selector** at top of panel: list of actors (all non-self actors in the workspace) with neutral icon (circle/initial), name, and status. No "Bot" icon, no category badge.
2. **Context list** below: "Conversations with [Actor Name]" heading. Shows contexts filtered by both self + selected actor participation (from issue 02).
3. **Empty state** when actor has no conversations: "No conversations with [Name] yet. Send a message to start one."
4. **Inspector** ActorAccessSection: remove "Default channel" label. Show neutral "Actors" count only.
5. **Message rendering**: already uses `.self`/`.other` (done in Slice 9). Verify no `<Bot>` or category icon in message headers.
6. **Activity rendering**: keep current grouped model. Labels should be understandable.

## Scope

- `floe-web/src/main.tsx`: actor selector, ActorAccessSection, message rendering icons.
- `floe-web/src/styles.css`: any remaining category-referencing styles.
- Playwright tests: `actor-neutral-ui.spec.ts` updated to assert no system category labels.

## Tests

- DOM contains no `Bot` icon in actor selector area.
- Inspector shows "Actors" (neutral) not "Default channel" or category counts.
- Actor list items show name + status only — no category badge, no raw IDs.
- System-generated labels/badges/icons/metadata must not contain: `human`, `agent`, `user`, `bot`, raw endpoint IDs, or `actor_type`.
- User-chosen actor display names that contain those words (e.g., "Creative Agent") are allowed and must not trigger test failures.

## Out of scope

- Full 3-panel layout redesign (the panel stays as a side panel).
- Actor profile page.
- Conversation details drawer.
