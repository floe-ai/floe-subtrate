# Models and thinking level

**A runtime binding is the triple of auth profile, model, and thinking level an [[Actor]] uses to run.**

Every actor needs three things resolved before it can take a turn: which auth profile to authenticate with (see [[Providers and auth]]), which model to call, and how much reasoning effort to spend. Floe calls this triple a runtime binding, and it is one instance of the general [[Binding]] concept.

## Model registry

The model registry (`~/.floe/auth/models.json`) lists every model floe knows about, per provider. A model is only usable if its provider has working credentials (see [[Providers and auth]]).

## Models are constrained to the profile's provider

A profile is bound to exactly one provider. When you pick a profile for an actor, the model list narrows to that provider's models only — you cannot pick an OpenAI model while bound to an Anthropic profile. There is no profile-specific restriction beyond this; "constrained to the profile" means "constrained to the profile's provider".

## Thinking level

Thinking level (also called reasoning effort) is one of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. It only applies to models that support reasoning — the UI disables the control when the selected model doesn't.

## Resolution order

A binding resolves through three layers, most specific wins:

1. **Endpoint** — set directly on this actor
2. **Workspace** — the workspace-wide default
3. **Global** — the machine-wide default

If an actor has no endpoint-level binding, it falls back to the workspace default; if the workspace has none, it falls back to global. Clearing an actor's binding removes only that layer — it does not touch workspace or global.

A per-node [[Binding]] on a node overrides all of this, but only for that node's work — it never changes the actor's identity or its bindings elsewhere.

See [[Glossary]] for term definitions.

## Implementation

- `floe-app/src/actors/modelsForProfile.ts` — `providerForProfile`, `modelsForProfile`, `withSelectedModelOption` (profile → provider → model constraint)
- `floe-app/src/actors/ActorInspector.tsx` — profile/model/effort binding form and the three-layer resolution display
- `floe-bridge/src/bus-client.ts` — `resolveRuntimeBinding` (`RuntimeBindingResolution` type with `endpoint_*`, `workspace_*`, `global_*` fields)
- `GET /v1/runtime/bindings/resolve` — resolve endpoint/workspace/global binding (`floe-bus/src/server.ts:852`)
- `GET /v1/runtime/bindings` — list bindings (`floe-bus/src/server.ts:795`)
- `POST /v1/runtime/bindings` — set a binding (`floe-bus/src/server.ts:800`)
- `POST /v1/runtime/bindings/clear` — clear a binding at a scope (`floe-bus/src/server.ts:831`)
- `floe-bus/src/store.ts` — `runtime_bindings` table, `ThinkingLevelSchema` enum
