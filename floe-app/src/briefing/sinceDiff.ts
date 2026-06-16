/**
 * Computes which events fall before/after a watermark boundary — the seen/unseen
 * split for the operator's briefing lens.
 */
import type { EventEnvelope } from "../bus-client/types.ts";

/**
 * Splits events into seen and unseen relative to a boundary.
 *
 * Ordering: strictly after boundary ⇒ unseen. Comparison is lexicographic on
 * (created_at, event_id) which works because created_at is an ISO-8601 string
 * and event_id is a stable tie-breaker.
 *
 * boundary null ⇒ all events are unseen.
 */
export function sinceDiff(
  events: EventEnvelope[],
  boundary: { created_at: string; event_id: string } | null
): { seen: EventEnvelope[]; unseen: EventEnvelope[] } {
  if (boundary === null) {
    return { seen: [], unseen: [...events] };
  }

  const seen: EventEnvelope[] = [];
  const unseen: EventEnvelope[] = [];

  for (const ev of events) {
    // Compare (created_at, event_id) lexicographically
    const cmp =
      ev.created_at < boundary.created_at
        ? -1
        : ev.created_at > boundary.created_at
          ? 1
          : ev.event_id < boundary.event_id
            ? -1
            : ev.event_id > boundary.event_id
              ? 1
              : 0;

    // strictly after the boundary ⇒ unseen
    if (cmp > 0) {
      unseen.push(ev);
    } else {
      seen.push(ev);
    }
  }

  return { seen, unseen };
}
