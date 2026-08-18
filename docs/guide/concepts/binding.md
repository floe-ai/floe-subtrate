# Binding

**A binding is one piece of typed configuration on an [[Actor]] or a node, held in an ordered list.**

## Kinds

| Kind | What it configures |
|---|---|
| `model` | Which model the actor runs as |
| `auth profile` | Which credentials it runs under |
| `thinking level` | Reasoning effort: off, minimal, low, medium, high, xhigh |
| `instructions` | Free-form text, resolved inline — the text itself is the material |
| `role` | A centrally-stored, versioned bundle (planned; points at something rather than carrying text inline) |

The substrate carries and orders bindings generically. It does not know what any
`kind` means — meaning lives with the kind, not with the list.

## The key idea

A node's binding is what the actor is doing **as that node** — never baked into the
actor's own identity file, and never hardcoded per workflow. The same actor can be
bound to one model with terse instructions in one working space, and a different
model with a different role in another. Its identity doesn't change; what it's doing
right now does.

## Resolution order

A binding resolves endpoint first, then falls back outward:

1. **endpoint** (agent-level, this actor specifically)
2. **workspace** (workspace default, applies to every actor here without its own binding)
3. **global** (machine-wide default)

The first layer that has a value wins. `GET /v1/runtime/bindings/resolve` returns all
three layers plus which one is effective, so a UI can show inheritance rather than
just the resolved value.

## Implementation

- `floe-bus/src/bindings.ts` — the generic `Binding` type; `instructions` is the only kind implemented on this path today
- `floe-bus/src/server.ts` — `GET`/`POST /v1/runtime/bindings`, `POST /v1/runtime/bindings/clear`, `GET /v1/runtime/bindings/resolve` (endpoint → workspace → global resolution)
- `floe-app/src/actors/ActorInspector.tsx` — model/auth-profile/thinking-level binding editor and the resolved effective-binding display
- `role` binding (pointing at a versioned bundle) — Not built yet.

See [[Glossary]].
