import { randomUUID } from "node:crypto";
import type { DestinationSelector } from "../store.js";
import type { ContextStoreReader } from "./store.js";

export type ResolveContextInput = { source_endpoint_id: string; destination: DestinationSelector; supplied_context_id: string | null | undefined; current_delivery_context_id: string | null | undefined; workspace_id: string };
export type ResolveContextSuccess = { context_id: string; created: boolean; participants?: string[]; parent_context_id?: string | null };
export type NotContextParticipantError = { error: "E_NOT_CONTEXT_PARTICIPANT"; payload: { code: "E_NOT_CONTEXT_PARTICIPANT"; message: string; context_id: string; source_endpoint_id: string; available_contexts: Array<{ context_id: string; participants: string[]; topic: string | null }>; recovery: string[] } };
export type ResolveContextResult = ResolveContextSuccess | NotContextParticipantError;
const newContextId = () => `ctx_${randomUUID()}`;
const destinationEndpoint = (destination: DestinationSelector) => destination.kind === "endpoint" ? destination.endpoint_id : null;
function rejection(context_id: string, source_endpoint_id: string, ctxStore: ContextStoreReader): NotContextParticipantError {
  return { error: "E_NOT_CONTEXT_PARTICIPANT", payload: { code: "E_NOT_CONTEXT_PARTICIPANT", message: `E_NOT_CONTEXT_PARTICIPANT: source endpoint ${source_endpoint_id} is not a participant of context ${context_id}.`, context_id, source_endpoint_id, available_contexts: ctxStore.listContextsForParticipant(source_endpoint_id).slice(0, 10).map(c => ({ context_id: c.context_id, participants: c.participants, topic: c.topic ?? null })), recovery: ["Omit context_id to open a new context with {source, destination}.", "Pass a context_id from available_contexts where the source is already a participant.", "If the destination is in the current delivery context, omit context_id to continue it."] } };
}
/** Resolves explicit context selection, runtime continuation, and linked peer contexts. */
export function resolveContext(input: ResolveContextInput, ctxStore: ContextStoreReader): ResolveContextResult {
  const { source_endpoint_id, destination, supplied_context_id, current_delivery_context_id } = input;
  if (supplied_context_id) {
    if (!ctxStore.getContext(supplied_context_id) || !ctxStore.isParticipant(supplied_context_id, source_endpoint_id)) return rejection(supplied_context_id, source_endpoint_id, ctxStore);
    return { context_id: supplied_context_id, created: false };
  }
  const destination_endpoint_id = destinationEndpoint(destination);
  if (current_delivery_context_id && destination_endpoint_id && ctxStore.isParticipant(current_delivery_context_id, destination_endpoint_id)) return { context_id: current_delivery_context_id, created: false };
  const participants = destination_endpoint_id && destination_endpoint_id !== source_endpoint_id ? [source_endpoint_id, destination_endpoint_id] : [source_endpoint_id];
  // ponytail: Reuse parent_context_id as the peer link until the ROADMAP's neutral link and peer-context UI land; revisit then.
  return { context_id: newContextId(), created: true, participants, parent_context_id: current_delivery_context_id ?? null };
}
