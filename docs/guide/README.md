# Floe user guide

**Floe is a substrate: a small set of primitives that agents and people use to build the environment around their work.**

It is not an agent framework and not a workflow tool. A [[Workspace]] holds [[Scope]]s, [[Actor]]s and [[Extension]]s. A scope is a canvas: you place [[Node]]s on it and connect them. A node is the work; a [[Context]] on that scope is one run of it — and a context can equally stand alone, off any canvas, as a conversation between actors. [[Event]]s land in contexts and wake things. That's the whole shape — everything else in this guide is detail on top of it.

Read [[What floe is]] for why this exists, or jump straight to [[Install and first run]] to get something running.

## Read this first

New to floe? Read these five in order:

1. [[What floe is]]
2. [[Install and first run]]
3. [[Concepts]]
4. [[Scope]]
5. [[The documentation pipeline]]

## Entry

- [[Floe user guide]] — this page
- [[What floe is]]
- [[Install and first run]]

## Concepts

- [[Concepts]]
- [[Workspace]]
- [[Scope]]
- [[Node]]
- [[Actor]]
- [[Context]]
- [[Event]]
- [[Command]]
- [[Artifact]]
- [[Binding]]
- [[Endpoint]]
- [[Hook]]
- [[Extension]]
- [[Delivery and Turn]]

## Setup

- [[Services]]
- [[Providers and auth]]
- [[Models and thinking level]]
- [[Substrate settings]]
- [[Workspace config]]

## Terminal

- [[Working without floe-app]]
- [[CLI reference]]
- [[Bus API]]

## floe-app

- [[floe-app]]
- [[Navigating floe-app]]
- [[The scope canvas]]
- [[Conversations in floe-app]]
- [[Settings in floe-app]]

## Tutorial

- [[The documentation pipeline]]

## Reference

- [[Glossary]]

## Implementation

- `docs/guide/` — this guide, a free-form standing document directory (`floe-bus/src/docs-structure.test.ts`)
- `floe-bus/src/scope-graphs.ts` — node kinds and wiring
- `floe-bus/src/server.ts` — all bus HTTP/WebSocket routes
- `floe-cli/src/cli.ts` — the `floe` command
