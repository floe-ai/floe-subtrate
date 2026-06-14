import { describe, expect, it } from "vitest";
import {
  decodeEventCursor,
  encodeEventCursor,
  InvalidEventCursorError
} from "./event-cursor.js";

describe("Event Cursor codec", () => {
  it("round-trips a cursor through encode/decode", () => {
    const cursor = { created_at: "2026-06-14T00:00:00.000Z", event_id: "evt_abc" };
    expect(decodeEventCursor(encodeEventCursor(cursor))).toEqual(cursor);
  });

  it("produces an opaque token that does not leak its fields verbatim", () => {
    const token = encodeEventCursor({ created_at: "2026-06-14T00:00:00.000Z", event_id: "evt_abc" });
    expect(token).not.toContain("evt_abc");
    expect(token).not.toContain("2026-06-14");
  });

  it("throws InvalidEventCursorError on a malformed cursor", () => {
    expect(() => decodeEventCursor("not-a-cursor")).toThrow(InvalidEventCursorError);
  });
});
