import { randomUUID } from "node:crypto";
import type { DestinationSelector } from "../store.js";
import type { ContextStoreReader } from "./store.js";

export type ResolveContextInput = {
  source_endpoint_id: string;
  destination: DestinationSelector;
  supplied_context_id: string | null | undefined;
  current_delivery_context_id: string | null | undefined;
  workspace_id: string;
};

export type ResolveContextSuccess = {
  context_id: string;
  created: boolean;
  /** When `created` is true, the participant set the caller must persist. */
  participants?: string[];
  /**
   * When set and `created` is true, the caller must create this context linked
   * (via parent_context_id) to the given origin context.
   *
   * This implements the peer context model: cross-actor communication lives in
   * its own independent context, associated to the origin by a neutral peer link,
   * NOT a side thread inside the origin context.
   */
  peer_link_to?: string | null;
};

export type NotContextParticipantError = {
  error: "E_NOT_CONTEXT_PARTICIPANT";
  payload: {
    code: "E_NOT_CONTEXT_PARTICIPANT";
    message: string;
    context_id: string;
    source_endpoint_id: string;
    available_contexts: Array<{ context_id: string; participants: string[]; topic: string | null }>;
    recovery: string[];
  };
};

export type ResolveContextResult = ResolveContextSuccess | NotContextParticipantError;

const AVAILABLE_CONTEXTS_LIMIT = 10;

function newContextId(): string {
  return `ctx_${randomUUID()}`;
}

function rejection(
  context_id: string,
  source_endpoint_id: string,
  ctxStore: ContextStoreReader
): NotContextParticipantError {
  const available = ctxStore
    .listContextsForParticipant(source_endpoint_id)
    .slice(0, AVAILABLE_CONTEXTS_LIMIT)
    .map((c) => ({ context_id: c.context_id, participants: c.participants, topic: c.topic ?? null }));
  return {
    error: "E_NOT_CONTEXT_PARTICIPANT",
    payload: {
      code: "E_NOT_CONTEXT_PARTICIPANT",
      message: `E_NOT_CONTEXT_PARTICIPANT: source endpoint ${source_endpoint_id} is not a participant of context ${context_id}.`,
      context_id,
      source_endpoint_id,
      available_contexts: available,
      recovery: [
        "Omit context_id to open a new peer context with {source, destination}.",
        "Pass a context_id from available_contexts where the source is already a participant.",
        "If the destination is in the current delivery context, omit context_id to continue it."
      ]
    }
  };
}

function destinationEndpoint(destination: DestinationSelector): string | null {
  if (destination.kind === "endpoint") return destination.endpoint_id;
  // Broadcast: not addressed by the participant-aware rule in this slice.
  return null;
}

/**
 * Pure function — encodes the participant-aware routing rules (peer context model).
 *
 * Rules:
 *
 *   Rule 1 — explicit context_id:
 *     source must be a participant of the supplied context, else E_NOT_CONTEXT_PARTICIPANT.
 *     Emits directly to that context (participant check for source only; destination
 *     participation is not required — if dest is not a participant, the event is stored
 *     in the context but no delivery is created for dest).
 *
 *   Rule 2 — runtime, destination ∈ current context:
 *     Continue the current delivery context.
 *
 *   Rule 3 — runtime, destination ∉ current context (peer context):
 *     D1 reuse: if an open peer context with participants {S, D} linked to the current
 *     context already exists, emit there.
 *     Else: create a NEW peer context {S, D} with parent_context_id = current context.
 *     Cross-actor communication lives in its own independent peer context, NEVER in
 *     a side thread inside the origin context.
 *
 *   Rule 0 — UI-originated (no current delivery context) with no supplied id:
 *     Open a new context with {source, destination}.
 *
 * Self-emit (source == destination) is allowed.
 * Side threads and force_root_thread are RETIRED — there is exactly one thread per
 * context (its root thread, thread_id = context_id).
 */
export function resolveContext(input: ResolveContextInput, ctxStore: ContextStoreReader): ResolveContextResult {
  const {
    source_endpoint_id,
    destination,
    supplied_context_id,
    current_delivery_context_id,
  } = input;

  // Rule 1: explicit context_id supplied — validate source participant.
  if (supplied_context_id) {
    const ctx = ctxStore.getContext(supplied_context_id);
    if (!ctx || !ctxStore.isParticipant(supplied_context_id, source_endpoint_id)) {
      return rejection(supplied_context_id, source_endpoint_id, ctxStore);
    }
    // Emit to the supplied context. Destination participation is not validated here —
    // the delivery layer (resolveDestinations) handles whether dest gets a notification.
    return { context_id: supplied_context_id, created: false };
  }

  const destEndpoint = destinationEndpoint(destination);

  // Runtime-originated: a current delivery context is in play.
  if (current_delivery_context_id) {
    if (destEndpoint && ctxStore.isParticipant(current_delivery_context_id, destEndpoint)) {
      // Rule 2: destination is already a participant of the current context → stay here.
      return { context_id: current_delivery_context_id, created: false };
    }
    // Rule 3: destination is NOT a participant → peer context model.
    if (destEndpoint && destEndpoint !== source_endpoint_id) {
      // D1: reuse an existing open peer context linked to this origin for the same pair.
      const existing = ctxStore.findLinkedPeerContext(
        current_delivery_context_id,
        source_endpoint_id,
        destEndpoint
      );
      if (existing) {
        return { context_id: existing.context_id, created: false };
      }
      // Create a new peer context linked to the origin.
      return {
        context_id: newContextId(),
        created: true,
        participants: [source_endpoint_id, destEndpoint],
        peer_link_to: current_delivery_context_id
      };
    }
    // destEndpoint is null (broadcast) or self-emit: stay in current context.
    return { context_id: current_delivery_context_id, created: false };
  }

  // Rule 0 — UI-originated (no current delivery context) with no supplied id:
  // open a new context with {source, destination}.
  const participants = destEndpoint && destEndpoint !== source_endpoint_id
    ? [source_endpoint_id, destEndpoint]
    : [source_endpoint_id];
  return { context_id: newContextId(), created: true, participants };
}
