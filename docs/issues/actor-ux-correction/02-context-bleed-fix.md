# Issue: Context bleed fix — query by self participant

## Summary

Fix the FloeWeb context fetch to query by the operator's own actor ID, then client-side filter to contexts where the selected actor also participates.

## Current behaviour (broken)

`refreshContexts` calls `GET /v1/contexts?participant=${agentEndpointId}` — fetching ALL contexts where the selected agent participates, including private actor-to-actor conversations the operator has no part in.

## Target behaviour

1. `refreshContexts` calls `GET /v1/contexts?participant=${selfActorId}` — only the operator's own contexts.
2. The conversation list for a selected actor filters client-side: `contexts.filter(c => c.participants.includes(selectedActorId))`.
3. Result: selecting "Floe" shows only contexts where {operator, floe} both participate.

## Scope

- `floe-web/src/main.tsx` line 459: change `participant=` from selected actor's ID to self participant ID.
- Rename internal variables: `agentEndpointId` → `selectedActorId` (or equivalent neutral name). Use whatever identifier the context API actually stores for participants — do not mix actor-form IDs with endpoint-backed participants.
- `sortContextsForAgent` in `floe-web/src/contexts.ts`: update filter logic if needed (currently expects the full list to already be scoped). Client-side filter to only contexts containing both self AND selected actor.
- Update Playwright tests in `no-actor-bleed.spec.ts` to assert bleed is impossible.

## Tests

- Playwright: mock workspace with 3 actors; Context A (self+floe), Context B (floe+reviewer). Select floe → see only A. Select reviewer → see nothing (or only self+reviewer contexts if any exist).
- Unit: context filter returns only contexts containing both self AND selected actor.

## Acceptance

Selecting an actor in the conversation panel never shows contexts where the operator is not a participant.
