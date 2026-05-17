# Issue: Bus delivery symmetry — remove actor_type entirely

## Summary

Remove `actor_type` from the bus schema, registration API, and all code paths. Replace all category-based routing with delivery-processor-presence checks (`bridge_id IS NOT NULL` is the current implementation detail). Existing local DBs may be reset.

## Scope

1. **Schema DDL** (`store.ts:176`): Remove `actor_type TEXT NOT NULL` from the `endpoints` table. Drop the column entirely.
2. **Registration** (`store.ts:532-535`, `server.ts:358`): Remove `actor_type` from the `registerEndpoint` function signature, SQL INSERT, and zod schema. The API no longer accepts it.
3. **Delivery gate** (`store.ts:1366`): `actor_type !== "agent"` → `!endpoint.bridge_id` (or `bridge_id IS NULL`).
4. **Status transition** (`store.ts:808`): `CASE WHEN actor_type = 'agent'` → `CASE WHEN bridge_id IS NOT NULL`.
5. **Webhook target** (`store.ts:998`): `WHERE actor_type = 'agent'` → `WHERE bridge_id IS NOT NULL`.
6. **Broadcast filter** (`store.ts:1281-1284`): Replace actor-category selectors with `with_delivery_processor`/`without_delivery_processor`/`active_with_delivery_processor`/`active_without_delivery_processor` (plus `all`/`active`).
7. **Delivery processor binding status** (`server.ts:237,260`): `actor_type === "agent"` → `endpoint.bridge_id IS NOT NULL` (check bridge_id on the endpoint record).
8. **All remaining references**: `git grep actor_type -- floe-bus/src/` must return zero matches after this change (except possibly in migration/wipe comments).

## Tests

- Registration without `actor_type` succeeds.
- `actor_type` field is rejected or ignored if sent.
- Actor with `bridge_id` set receives push delivery.
- Actor with `bridge_id = null` does NOT receive push delivery.
- Broadcast with `with_delivery_processor` targets only endpoints with a delivery processor. `all` targets everyone.
- Delivery processor binding status change only affects endpoints with `bridge_id`.
- `git grep actor_type -- floe-bus/src/` returns zero routing/filtering uses.

## Acceptance

All active source, test, route mock, prompt, tool payload, UI code, and schema surfaces across the repo must not depend on `actor_type`:

```text
git grep -n "actor_type" -- .
```

Must return zero matches in active code (comments documenting removal are acceptable).

Additionally, check that no actor-visible surface exposes old typed IDs:

```text
git grep -n "endpoint:.*:user:" -- .
git grep -n "endpoint:.*:agent:" -- .
git grep -n "user:operator" -- .
git grep -n "agent:floe" -- .
```

These patterns must not appear in actor-visible tools, prompts, delivery context, context participants, or UI code. Internal migration comments or changelog entries are acceptable.
