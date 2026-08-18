# Scope

**A scope is a way of organising the pieces of a product that make sense together — and it is the canvas they are organised on.**

A scope holds [[Node]]s. You place nodes in a scope and connect them to each other.
That picture of connected nodes — what's in the scope and how it's wired — is the
graph.

## There is no graph primitive

You never create a graph. You never name a graph. A graph is not a thing that
exists in the substrate — it is the picture you get when you look at a scope. The
substrate stores the nodes and infers the wiring from shared [[Context]]
membership; nothing else is stored for "the graph."

## Scopes nest

A scope can contain other scopes, so a product's pieces can be organised at
whatever grain makes sense — one scope for the whole thing, or many nested scopes
for its parts.

## What belongs in a scope

- Nodes: [[Event]] nodes, working space nodes, [[Command]] nodes
- The connections between them (implied by shared context membership)
- Nested scopes for related sub-work

## What doesn't belong in a scope

- [[Actor]]s — they live at workspace level and are only ever assigned into a
  working space node, never owned by a scope
- History of what already happened — that's in a [[Context]], read separately
  from the authored nodes
- A name or identity for "the graph" itself — it doesn't have one

## Implementation

- `floe-bus/src/scope-graphs.ts` — node kinds and how connections are inferred from context membership (no stored edge record)
- `floe-bus/src/server.ts` — `POST /v1/workspaces/:workspace_id/scopes`, `DELETE /v1/workspaces/:workspace_id/scopes/:scope_id`, `GET /v1/workspaces/:workspace_id/scopes`
- `floe-bus/src/server.ts` — `GET /v1/workspaces/:workspace_id/scopes/:scope_id/projection` — the derived, read-only view of what happened
- `floe-bus/src/server.ts` — `GET`/`POST /v1/workspaces/:workspace_id/scopes/:scope_id/graphs` — the substrate still stores authored nodes under a `graphs`/`graph_id` table; this contradicts the model above. Write the model, not the table.
- The scope canvas does not exist in `floe-app` yet. There is a scope detail view with Contexts and Ops tabs only.

See [[Glossary]].
