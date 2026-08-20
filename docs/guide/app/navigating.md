# Navigating floe-app

**The app is one shell with three panes: a left nav, a main column, and a right-hand inspector.**

## The shell

The left nav ([[Workspace]]-scoped) lists, top to bottom:

- **Home** — the default view.
- **Activity** — the workspace-wide event stream.
- A **Scopes** section — every [[Scope]] in the workspace, plus "New scope".
- An **Actors** section — every [[Actor]] registered in the workspace, plus "New actor".
- **Substrate Settings**, pinned to the bottom, below a divider — this switches the whole app into machine-level settings mode (see [[Settings in floe-app]]).

Selecting anything in the nav drives the main column. Opening a [[Node]], [[Actor]] or [[Context]] can also open detail in the right-hand inspector aside. The shell owns this navigation; the domain views inside it are lenses.

## Home

Home shows a grid of scope cards — one per [[Scope]], each showing its title, description, and a live count of contexts and pulses. Clicking a card opens that scope's detail view. A "New scope" tile sits at the end of the grid.

## Opening a scope

Clicking a scope card opens **scope detail** in the main column, with a **Contexts** tab and an **Ops** tab:

- **Contexts** lists the [[Context]]s that belong to this scope, by human label.
- **Ops** is a read-only view of recent [[Event]]s scoped to this scope, plus the [[Event|Pulse]]s that can fire into it (create, pause, resume, cancel, subscribe/unsubscribe).

Any extension that registers a `scope-detail-tab` view appears as an additional tab alongside Contexts and Ops. If the extension's actual component was not built into this app bundle, the tab renders a placeholder rather than nothing.

## Opening an actor

Clicking an actor in the nav opens the **actor view** with two tabs:

- **Conversations** — a list of [[Context]]s that actor is a participant in, and a right-hand pane that opens the selected one as a full conversation.
- **Configure** — the actor's [[Binding]] form (see [[Settings in floe-app]]).

## Opening a context

Clicking a context — from a scope's Contexts tab, an actor's Conversations tab, or Activity — opens it as a conversation: message list, participant pills, and a "Speaking as" composer. See [[Conversations in floe-app]].

## A gap: direct contexts are not reachable

The source has a `DirectContexts` component (`floe-app/src/scope/DirectContexts.tsx`) for listing contexts that have no [[Scope]] — the substrate allows this (a context does not require a scope). But nothing in `App.tsx` imports or renders it: there is no nav entry, no route, no button that opens it. A context with no scope exists in the bus and is reachable individually (for example from Activity or from an actor's context list), but there is no view that lists "all direct contexts" together. This is a real gap in the shipped UI, not a documentation omission.

See [[Glossary]].

## Implementation

- `floe-app/src/App.tsx` — routing/state, main column switch
- `floe-app/src/app/layout/LeftNav.tsx` — the left nav
- `floe-app/src/hooks/useNavigation.ts` — navigation state machine
- `floe-app/src/features/home/HomeView.tsx` — scope grid
- `floe-app/src/scope/ScopeDetail.tsx` — Contexts/Ops/extension tabs
- `floe-app/src/features/actor/ActorView.tsx` — Conversations/Configure tabs
- `floe-app/src/scope/DirectContexts.tsx` — exists, not wired into any route: **not reachable from the nav**
