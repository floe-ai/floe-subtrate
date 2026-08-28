# Navigating floe-app

**The app opens the Conversations workspace index. Developer inspection remains available without being the default product path.**

## The shell

The left nav ([[Workspace]]-scoped) has one normal operator entry and one secondary disclosure:

- **Conversations** — the default operator view, containing conversations in which the workspace operator participates.
- **Developer tools** — a collapsed disclosure containing the existing workspace overview, Activity, Scopes, Actors, creation controls, and Substrate Settings.

Selecting a developer tool drives the main column. Opening a [[Node]], [[Actor]] or [[Context]] can also open detail in the right-hand inspector aside. The inspector is not shown in normal Conversations.

## First use

When no supported provider is configured, the desktop app first asks the user to choose and connect a subscription through the packaged Pi authentication flow. When no workspace exists, it then asks for a folder. Floe applies the selected model as that workspace's default and lands in Conversations with Floe. An existing workspace is reused; connecting a provider does not force the user to create another one.

After onboarding, the gear beside the workspace name opens normal **Settings**. Provider connections apply to this device; the workspace model applies only to the selected workspace. Substrate Settings remains under Developer tools for diagnostics and advanced configuration.

## Conversations

Conversations is the operator's normal way into work with Floe or another actor. When conversations already exist, opening or selecting a workspace leaves the operator at the shared index instead of silently choosing one. When there are none, the app opens a new outcome with Floe. Deliberately clicking Conversations returns to the index.

If no Floe conversation exists, the app asks what outcome the operator wants. Submitting the first outcome creates a direct [[Context]], emits the message to Floe, and opens the conversation. Merely opening the workspace does not create a Context.

The list contains only Contexts where the ordinary workspace operator is already a participant; actor-to-actor operational traffic is not promoted into this view. Floe is the default collaborator and new-outcome target, not a separate navigation hierarchy.

Active Scopes appear under **Organised work** on the same index. Opening one shows the current Actor and Command responsibilities plus planned “Event → participant” routes derived from subscriptions. Selecting any planned node reveals the executions that reached it; **Context history** exposes the complete shared scoped Context separately. This is read-only operator legibility over Bus-owned state, not an editor or a second routing model. Retired Scopes remain available under Developer tools for history/debugging and do not appear here.

An incoming message addressed to the operator with a response expected appears under **Needs you**. Once the operator replies, the conversation returns to **Recent**. This is an interpretation of existing Event response metadata, not separate task or notification state.

Opening an item keeps the speaking identity fixed to the operator and names the other participant in the conversation header. Every selected operator conversation has the same back, new-conversation, and delete controls. New conversation starts a fresh Context with the current collaborator; from the list, **New with Floe** starts a fresh outcome with Floe. A compact provider → model → effort control sits at the conversation boundary, and the composer remains disabled until the workspace has a connected provider and saved model.

Conversation history is read through the Bus cursor contract until the current end of the Context, rather than silently stopping at the first default page. Supplementary runtime/delivery status may fail independently without hiding durable messages.

The operator view omits participant controls, substrate inventory, and the inspector. The general participant and identity controls remain available when the same Context is opened through Developer tools.

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

Conversations provides the normal route to scoped or unscoped Contexts in which the operator participates. Contexts that do not include the operator remain available through Activity or an actor's context list under Developer tools.

See [[Glossary]].

## Implementation

- `floe-app/src/App.tsx` — routing/state, main column switch
- `floe-app/src/app/layout/LeftNav.tsx` — the left nav
- `floe-app/src/hooks/useNavigation.ts` — navigation state machine
- `floe-app/src/features/conversations/OperatorConversations.tsx` — unified operator entry, conversation lifecycle, list, and attention projection
- `floe-app/src/features/work/ScopeWorkView.tsx` — read-only Scope plan, per-node executions, and scoped Context history
- `floe-app/src/workspace/FloeModelControl.tsx` — inline workspace model selection and readiness gate
- `floe-app/src/features/home/HomeView.tsx` — scope grid
- `floe-app/src/scope/ScopeDetail.tsx` — Contexts/Ops/extension tabs
- `floe-app/src/features/actor/ActorView.tsx` — Conversations/Configure tabs
- `floe-app/src/scope/DirectContexts.tsx` — general developer-oriented direct-context list, not wired into a route
