/**
 * Event Cursor — an opaque, ordered position in a Workspace's Event stream.
 *
 * Events are ordered by (created_at, event_id): created_at is the primary key
 * and event_id breaks ties when two Events share a created_at to the same
 * instant. Encoding both into one opaque token lets callers page through the
 * stream ("everything after here") without two Events in the same instant ever
 * being skipped or double-counted, and without callers depending on the
 * internal keying.
 */

export type EventCursor = {
  created_at: string;
  event_id: string;
};

export class InvalidEventCursorError extends Error {
  constructor(readonly value: string) {
    super(`Invalid Event Cursor: ${value}`);
    this.name = "InvalidEventCursorError";
  }
}

export function encodeEventCursor(cursor: EventCursor): string {
  const payload = JSON.stringify([cursor.created_at, cursor.event_id]);
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeEventCursor(value: string): EventCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== "string" ||
      typeof parsed[1] !== "string"
    ) {
      throw new Error("unexpected cursor shape");
    }
    return { created_at: parsed[0], event_id: parsed[1] };
  } catch {
    throw new InvalidEventCursorError(value);
  }
}
