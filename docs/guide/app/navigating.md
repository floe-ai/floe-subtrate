# Navigating floe-app

**The app opens on a workspace conversation with Floe. Developer inspection remains available without being the default product path.**

## The shell

The left nav ([[Workspace]]-scoped) has three normal entries:

- **Floe** — the default operator view.
- **Conversations** — conversations in which the workspace operator participates, grouped by attention and recent activity.
- **Developer tools** — a collapsed disclosure containing the existing workspace overview, Activity, Scopes, Actors, creation controls, and Substrate Settings.

Selecting a developer tool drives the main column. Opening a [[Node]], [[Actor]] or [[Context]] can also open detail in the right-hand inspector aside. The inspector is not shown on the normal Floe entry.

## First use

When no supported provider is configured, the desktop app first asks the user to choose and connect a subscription through the packaged Pi authentication flow. When no workspace exists, it then asks for a folder. Floe applies the selected model as that workspace's default and lands in the Floe conversation. An existing workspace is reused; connecting a provider does not force the user to create another one.

After onboarding, the gear beside the workspace name opens normal **Settings**. Provider connections apply to this device; the workspace model applies only to the selected workspace. Substrate Settings remains under Developer tools for diagnostics and advanced configuration.

## Floe

Opening or selecting a workspace opens its most recent conversation between the ordinary `operator` and `floe` endpoints, whether or not Floe has since attached that Context to a Scope. A compact provider → model → effort control sits at this conversation boundary. Until the workspace has a connected provider and saved model, the composer is disabled and no message can be queued for later delivery.

If no conversation exists, the app asks what outcome the operator wants. Submitting the first outcome creates a direct [[Context]], emits the message to Floe, and opens the conversation. Merely opening the workspace does not create a Context.

The operator view fixes the speaking identity to the operator and omits context labels, participant controls, substrate inventory, and the inspector. Those details remain available through Developer tools.

## Conversations

Conversations is the operator's way back into work with Floe or another actor. It lists only Contexts where the ordinary workspace operator is already a participant; actor-to-actor operational traffic is not promoted into this view.

An incoming message addressed to the operator with a response expected appears under **Needs you**. Once the operator replies, the conversation returns to **Recent**. This is an interpretation of existing Event response metadata, not separate task or notification state.

Opening an item keeps the speaking identity fixed to the operator and names the other participant in the conversation header. The general participant and identity controls remain available when the same Context is opened through Developer tools.

## Workspace overview

The Developer tools workspace overview preserves the previous scope-card grid — one per [[Scope]], each showing its title, description, and a live count of contexts and pulses. Clicking a card opens that scope's detail view. A "New scope" tile sits at the end of the grid.

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

## Other direct contexts

The default Floe entry reaches the most recent operator/Floe conversation. Conversations provides the normal route to other scoped or unscoped Contexts in which the operator participates. Contexts that do not include the operator remain available through Activity or an actor's context list under Developer tools.

See [[Glossary]].

## Implementation

- `floe-app/src/App.tsx` — routing/state, main column switch
- `floe-app/src/app/layout/LeftNav.tsx` — the left nav
- `floe-app/src/hooks/useNavigation.ts` — navigation state machine
- `floe-app/src/features/home/FloeHome.tsx` — default operator/Floe entry
- `floe-app/src/features/conversations/OperatorConversations.tsx` — operator-participating conversation list and attention projection
- `floe-app/src/workspace/FloeModelControl.tsx` — inline workspace model selection and readiness gate
- `floe-app/src/features/home/HomeView.tsx` — scope grid
- `floe-app/src/scope/ScopeDetail.tsx` — Contexts/Ops/extension tabs
- `floe-app/src/features/actor/ActorView.tsx` — Conversations/Configure tabs
- `floe-app/src/scope/DirectContexts.tsx` — general developer-oriented direct-context list, not wired into a route
