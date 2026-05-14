# Issue: Operator identity — durable display name from bus

## Summary

Make the operator's display name come from the bus endpoint record (durable, workspace-level), not hardcoded "Operator". Provide UI to edit it.

## Current behaviour

- `ensureOperator()` registers with `name: "Operator"` unconditionally.
- No way to change the name.

## Target behaviour

1. On workspace open, FloeWeb reads the operator endpoint record from the bus (via existing list endpoints response).
2. If the operator endpoint exists, use its `name` field for display.
3. FloeWeb provides a small settings affordance (in the inspector or a name-edit inline control) to update the name.
4. Update calls `POST /v1/endpoints/register` with the new name (upsert behaviour already exists).
5. Default name for fresh workspace: "You" (neutral).
6. localStorage may cache for instant display, but bus record is source of truth.

## Scope

- `floe-web/src/main.tsx`: `ensureOperator` must NOT send `actor_type`. Registers with: endpoint_id, workspace_id, name, status, metadata only.
- Add a name-edit UI element (inline editable label or small settings input).
- Chat messages from self show "You" (or configured name).

## Tests

- Playwright: set operator name → messages authored by the current acting actor show the configured display name.
- Unit: registration body does NOT contain `actor_type` field.
- Registration body uses the configured name.

## Out of scope

- Avatar, profile page, extended operator settings.
- Auth/identity federation.
