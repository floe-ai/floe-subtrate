/**
 * traceBack — derive the producing-delivery ref from an event's metadata.
 *
 * Given an EventEnvelope, extracts the delivery_id and correlation_id that
 * identify the delivery that produced this event, enabling navigation back
 * through the causal chain.
 */
import type { EventEnvelope } from "../bus-client/types.ts";

export type TraceBackResult = {
  deliveryId: string | null;
  correlationId: string | null;
};

/**
 * Pure function: given an EventEnvelope, resolve the producing-delivery ref.
 *
 * - deliveryId   — from event.metadata.delivery_id (string or absent)
 * - correlationId — from event.correlation_id (top-level wire field)
 */
export function traceBack(event: EventEnvelope): TraceBackResult {
  const deliveryId =
    typeof event.metadata?.delivery_id === "string"
      ? event.metadata.delivery_id
      : null;

  const correlationId =
    typeof event.correlation_id === "string" ? event.correlation_id : null;

  return { deliveryId, correlationId };
}
