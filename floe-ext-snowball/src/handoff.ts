/**
 * Card ownership handoff helper — Slice 4 (fm/snowball-card-context).
 *
 * A "handoff" is the operation that runs on card CREATE and card MOVE:
 *   1. Add the acting actor as a participant of the card context (creator or mover).
 *   2. For each actor in the destination column's assigned_actors:
 *      - addParticipant(cardContextId, actorEp)
 *      - subscribeToContext(cardContextId, actorEp, actor.event_types)
 *   3. On MOVE: for each actor in the prior column's assigned_actors:
 *      - subscribeToContext(cardContextId, priorEp, [])   <- silent watcher
 *      (still a participant, can still emit, never woken again)
 *   4. If the destination column has assigned actors, emit snowball.card.entered_column
 *      into the card context (destination: {kind:"context"}) so subscribed actors are woken.
 *
 * Actors are uniform — no human/agent distinction. The operator and any LLM
 * agent are handled by identical code.
 */

import type { BusClient } from "./stub/bus-client.js";
import type { AssignedActor, SidecarExitCriterion } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve an actor_ref slug to a full endpoint id. */
export function actorEndpointId(workspaceId: string, actorRef: string): string {
  return `actor:${workspaceId}:${actorRef}`;
}

/** The built-in floe operator endpoint for a workspace. */
export function operatorEndpointId(workspaceId: string): string {
  return actorEndpointId(workspaceId, "operator");
}

// ---------------------------------------------------------------------------
// Column assignment application
// ---------------------------------------------------------------------------

export interface ApplyColumnAssignmentParams {
  /** The card's bus context id. If null, the call is a no-op (lazy context creation failed). */
  cardContextId: string | null;
  /** Destination column's assigned actors. */
  destAssignedActors: AssignedActor[];
  /** Prior column's assigned actors (for demotion to silent watchers on move). */
  priorAssignedActors: AssignedActor[];
  /**
   * The actor performing the action (operator for UI, destination actor for tools).
   * Added as participant if not already present, then used as source_endpoint_id.
   */
  actingActorEp: string;
  workspaceId: string;
  scope_id: string;
  cardId: string;
  cardTitle: string;
  toColumnId: string;
  toColumnName: string;
  fromColumnId: string;
  bus: BusClient;
}

/**
 * Apply a column's actor assignments to a card context.
 *
 * Used by both card creation (priorAssignedActors=[]) and card move.
 *
 * After this call:
 * - actingActorEp is a participant of the card context
 * - all destAssignedActors are participants subscribed to their event_types
 * - all priorAssignedActors have their subscription set to [] (silent watchers)
 * - if destAssignedActors is non-empty, snowball.card.entered_column is emitted
 *   into the card context, waking subscribed actors
 */
export async function applyColumnAssignment(
  params: ApplyColumnAssignmentParams
): Promise<void> {
  const {
    cardContextId,
    destAssignedActors,
    priorAssignedActors,
    actingActorEp,
    workspaceId,
    scope_id,
    cardId,
    cardTitle,
    toColumnId,
    toColumnName,
    fromColumnId,
    bus,
  } = params;

  if (!cardContextId) return;

  // Build one batch: acting actor as participant-only (must be able to emit,
  // not subscribed); destination actors as participant + subscription;
  // prior actors demoted to silent watchers (participant, event_types: []).
  const entries: Array<{ endpoint_id: string; event_types: string[] }> = [];

  for (const actor of destAssignedActors) {
    entries.push({
      endpoint_id: actorEndpointId(workspaceId, actor.actor_ref),
      event_types: actor.event_types,
    });
  }

  for (const actor of priorAssignedActors) {
    entries.push({
      endpoint_id: actorEndpointId(workspaceId, actor.actor_ref),
      event_types: [], // silent watcher — remains participant, never woken
    });
  }

  try {
    await bus.applyContextSubscriptions(cardContextId, entries, [actingActorEp]);
  } catch (err) {
    console.warn(`[snowball] applyContextSubscriptions failed: ${err}`);
  }

  // Emit entered_column only when the destination column has assigned actors.
  // Uses destination:{kind:"context"} so the bus routes to subscribed actors.
  if (destAssignedActors.length === 0) return;

  try {
    await bus.emit({
      type: "snowball.card.entered_column",
      workspace_id: workspaceId,
      source_endpoint_id: actingActorEp,
      scope_id,
      context_id: cardContextId,
      destination: {
        kind: "context",
        context_id: cardContextId,
      },
      content: {
        text: `Card "${cardTitle}" has entered column "${toColumnName}"`,
        data: {
          card_id: cardId,
          card_title: cardTitle,
          column_id: toColumnId,
          column_name: toColumnName,
          from_column_id: fromColumnId,
          board_scope_id: scope_id,
        },
      },
      response: { expected: true },
      metadata: { source: "snowball-extension" },
    });
  } catch (err) {
    console.warn(`[snowball] entered_column emit failed: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Card context creation
// ---------------------------------------------------------------------------

export interface CreateCardContextParams {
  workspaceId: string;
  scope_id: string;
  cardTitle: string;
  /** The actor who created the card (becomes first participant). */
  creatorEp: string;
  bus: BusClient;
}

/**
 * Create a bus context for a card.
 * Returns the new context_id, or null on failure.
 * The creator actor is added as a participant immediately.
 */
export async function createCardContext(
  params: CreateCardContextParams
): Promise<string | null> {
  const { workspaceId, scope_id, cardTitle, creatorEp, bus } = params;
  try {
    const contextId = await bus.createContext({
      workspace_id: workspaceId,
      scope_id,
      participants: [creatorEp],
      title: cardTitle,
    });
    return contextId;
  } catch (err) {
    console.warn(`[snowball] createCardContext failed: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Exit criteria helpers (used by handoff consumers)
// ---------------------------------------------------------------------------

/** Return the unchecked exit criteria for a card in its current column. */
export function getUncheckedCriteriaForColumn(
  cardChecks: Record<string, Record<string, { checked: boolean }>>,
  columnId: string,
  exitCriteria: SidecarExitCriterion[]
): SidecarExitCriterion[] {
  const colChecks = cardChecks[columnId] ?? {};
  return exitCriteria.filter((ec) => !colChecks[ec.id]?.checked);
}
