# The scope canvas

**A [[Scope]] IS the canvas — but the canvas mostly does not exist yet.**

This page describes the intended surface, not something you can open today. Read [[Navigating floe-app]] for what actually ships: a scope detail view with Contexts and Ops tabs, not a canvas.

## What it is meant to show

There is no separate "graph" object. Nodes are placed in a scope and connected to each other, and that picture of connected nodes is the canvas — it does not need a name of its own.

- **[[Node]]s** are drawn as cards carrying their kind ([[Event]], working space, or [[Command]]) and their current run count.
- **Connections** are drawn as edges carrying multiplicity labels — `1 → 50`, `140 → 46` — so a split or a convergence reads at a glance, without opening anything.
- A running node shows per-node state counts, an attention marker for runs that want a human, and a stack behind the card for the runs it currently holds.

The canvas shows **current state and the shape of what will happen next — never history**. History belongs to the activity log ([[Navigating floe-app]] → Activity), not the canvas. If you want to know what happened, you look at the log. If you want to know what is running and what is about to run, you look at the canvas.

## Opening detail

Clicking a node is meant to open it in the right-hand inspector aside, two levels deep: the node itself, then its runs, then one run — a [[Context]]. A [[Command]] run is drawn returning to the working-space [[Context]] that called it: dashed and faint always, as the permanent shape of the relationship, lit up only while that call is actually live.

## Layout is per-machine, stored in the bus

A node's position on the canvas is stored in the bus, keyed per machine, so a team looking at the same scope from different machines sees the same auto-arranged picture — layout is not something each person redraws for themselves.

## Enumeration dies at scale

At any real size, you do not read a canvas by looking at every node. You search for the thing you are looking for. The only thing the canvas volunteers unprompted, without being asked, is what is wrong — an attention marker, a stalled run. Everything else you find by searching, not by scanning.

See [[Glossary]].

## Implementation

Not built yet.

There is a scope detail view with Contexts and Ops tabs (`floe-app/src/scope/ScopeDetail.tsx`, `floe-app/src/scope/Ops.tsx`) but no canvas, no node cards, no edges, and no per-machine layout storage in the shipped app. The substrate's own node storage (`floe-bus/src/scope-graphs.ts`) still uses a `scope_graphs` table with a `graph_id` column, which contradicts the locked model above — that is a storage detail, not the model to build the canvas against.
