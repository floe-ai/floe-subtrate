import { randomUUID } from "node:crypto";
import type { DestinationSelector } from "../store.js";
import type { ContextStoreReader } from "./store.js";

export type ResolveContextInput = {
  source_endpoint_id: string;
  destination: DestinationSelector;
  supplied_context_id: string | null | undefined;
  current_delivery_context_id: string | null | undefined;
  /**
   * The thread_id of the delivery being processed.  Used as parent when
   * a side thread is needed (Rule 3 runtime).  Falls back to
   * current_delivery_context_id (root thread) when absent.
   */
  current_delivery_thread_id?: string | null;
  workspace_id: string;
};

export type ResolveContextSuccess = {
  context_id: string;
  created: boolean;
  /** When `created` is true, the participant set the caller must persist. */
  participants?: string[];
  /**
   * When set, the caller must create a side thread with this parent_thread_id
   * inside `context_id` and use the resulting thread_id on the emitted event.
   *
   * NULL / absent → stay on the current (main or side) thread.
   */
  side_thread?: {
    parent_thread_id: string;
  } | null;
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
        "Omit context_id to open a new context with {source, destination}.",
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
 * Pure function — encodes the participant-aware continue rule (design §3.1.4).
 *
 *   UI-originated (no current delivery context):
 *     supplied_context_id present  → rule 1 (validate participant or reject)
 *     supplied_context_id omitted  → open new context with {source, destination}
 *
 *   Runtime-originated (current_delivery_context_id present):
 *     supplied_context_id present       → rule 1
 *     destination ∈ current context    → continue current context on current thread (rule 2)
 *     destination ∉ current context    → stay in same context, create a SIDE THREAD (rule 3)
 *                                         side_thread.parent_thread_id = current_delivery_thread_id
 *                                         (falls back to current_delivery_context_id = root thread)
 *
 *   Self-emit (source == destination) is allowed.
 */
export function resolveContext(input: ResolveContextInput, ctxStore: ContextStoreReader): ResolveContextResult {
  const {
    source_endpoint_id,
    destination,
    supplied_context_id,
    current_delivery_context_id,
    current_delivery_thread_id,
  } = input;

  // Rule 1: explicit context_id supplied — validate strict participant gating.
  if (supplied_context_id) {
    const ctx = ctxStore.getContext(supplied_context_id);
    if (!ctx || !ctxStore.isParticipant(supplied_context_id, source_endpoint_id)) {
      return rejection(supplied_context_id, source_endpoint_id, ctxStore);
    }
    return { context_id: supplied_context_id, created: false };
  }

  const destEndpoint = destinationEndpoint(destination);

  // Runtime-originated: a current delivery context is in play.
  if (current_delivery_context_id) {
    if (destEndpoint && ctxStore.isParticipant(current_delivery_context_id, destEndpoint)) {
      // Rule 2: destination is a participant — continue current context on current thread.
      return { context_id: current_delivery_context_id, created: false };
    }
    // Rule 3: destination is NOT a participant of the current context.
    // Stay in the SAME context but open a new side thread for this sub-exchange.
    // The side thread's parent is the delivery thread (or root = context_id when absent).
    const parentThreadId =
      current_delivery_thread_id && current_delivery_thread_id.length > 0
        ? current_delivery_thread_id
        : current_delivery_context_id;
    return {
      context_id: current_delivery_context_id,
      created: false,
      side_thread: { parent_thread_id: parentThreadId },
    };
  }

  // UI-originated (no current delivery context) with no supplied id:
  // open a new context with {source, destination}.
  const participants = destEndpoint && destEndpoint !== source_endpoint_id
    ? [source_endpoint_id, destEndpoint]
    : [source_endpoint_id];
  return { context_id: newContextId(), created: true, participants };
}
