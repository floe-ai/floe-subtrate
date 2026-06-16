import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventEnvelope } from "../bus-client/types.ts";
import { traceBack } from "./traceBack.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: "evt-1",
    type: "test.event",
    workspace_id: "ws-1",
    source_endpoint_id: "ep-1",
    thread_id: "thread-1",
    context_id: "ctx-1",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "broadcast", scope: "workspace", target: "all" },
    content: {},
    response: { expected: false },
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// traceBack unit
// ---------------------------------------------------------------------------

describe("traceBack", () => {
  it("extracts deliveryId from metadata.delivery_id", () => {
    const ev = makeEvent({ metadata: { delivery_id: "del-abc" } });
    const result = traceBack(ev);
    expect(result.deliveryId).toBe("del-abc");
    expect(result.correlationId).toBeNull();
  });

  it("extracts correlationId from top-level correlation_id", () => {
    const ev = makeEvent({ correlation_id: "corr-xyz" });
    const result = traceBack(ev);
    expect(result.correlationId).toBe("corr-xyz");
    expect(result.deliveryId).toBeNull();
  });

  it("returns null for both when neither is present", () => {
    const ev = makeEvent();
    const result = traceBack(ev);
    expect(result.deliveryId).toBeNull();
    expect(result.correlationId).toBeNull();
  });

  it("handles both fields present simultaneously", () => {
    const ev = makeEvent({
      correlation_id: "corr-1",
      metadata: { delivery_id: "del-1" },
    });
    const result = traceBack(ev);
    expect(result.deliveryId).toBe("del-1");
    expect(result.correlationId).toBe("corr-1");
  });
});

// ---------------------------------------------------------------------------
// Timeline — scrubs events by cursor (paging via listEvents mock)
// ---------------------------------------------------------------------------

vi.mock("../bus-client/client.ts", () => ({
  listEvents: vi.fn(),
  getEventTrace: vi.fn(),
}));

import * as client from "../bus-client/client.ts";

describe("Timeline", () => {
  const page1: EventEnvelope[] = [
    makeEvent({ event_id: "evt-1", type: "a.first" }),
    makeEvent({ event_id: "evt-2", type: "a.second" }),
  ];
  const page2: EventEnvelope[] = [
    makeEvent({ event_id: "evt-3", type: "b.third" }),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("scrubs events by cursor — loads page 1 then page 2 via next_cursor", async () => {
    const listEventsMock = vi.mocked(client.listEvents);

    // First call returns page 1 + cursor pointing to page 2
    listEventsMock
      .mockResolvedValueOnce({ events: page1, next_cursor: "cursor-for-page-2" })
      // Second call with since=cursor-for-page-2 returns page 2
      .mockResolvedValueOnce({ events: page2, next_cursor: null });

    // First page load (no since)
    const first = await client.listEvents({ workspace_id: "ws-1", limit: 20 });
    expect(first.events).toHaveLength(2);
    expect(first.events[0].event_id).toBe("evt-1");
    expect(first.next_cursor).toBe("cursor-for-page-2");

    // Second page load using the cursor
    const second = await client.listEvents({
      workspace_id: "ws-1",
      limit: 20,
      since: first.next_cursor!,
    });
    expect(second.events).toHaveLength(1);
    expect(second.events[0].event_id).toBe("evt-3");
    expect(second.next_cursor).toBeNull();

    // Verify the second call received the cursor as `since`
    expect(listEventsMock).toHaveBeenCalledTimes(2);
    expect(listEventsMock).toHaveBeenNthCalledWith(2, {
      workspace_id: "ws-1",
      limit: 20,
      since: "cursor-for-page-2",
    });
  });

  it("accumulates events across pages", async () => {
    const listEventsMock = vi.mocked(client.listEvents);
    listEventsMock
      .mockResolvedValueOnce({ events: page1, next_cursor: "c1" })
      .mockResolvedValueOnce({ events: page2, next_cursor: null });

    const r1 = await client.listEvents({ workspace_id: "ws-1" });
    const r2 = await client.listEvents({ workspace_id: "ws-1", since: r1.next_cursor! });

    const allEvents = [...r1.events, ...r2.events];
    expect(allEvents).toHaveLength(3);
    expect(allEvents.map((e) => e.event_id)).toEqual(["evt-1", "evt-2", "evt-3"]);
  });
});
