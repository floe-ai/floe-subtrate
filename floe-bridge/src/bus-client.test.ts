/**
 * Unit tests for BusClient — the new participant/subscription/children HTTP
 * methods added for the card=context rework.
 *
 * fetch is mocked via vi.stubGlobal so no real network or bus is needed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { BusClient } from "./bus-client.js";

const BASE = "http://127.0.0.1:5377";
const client = new BusClient(BASE);

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// addParticipant
// ---------------------------------------------------------------------------

describe("BusClient.addParticipant", () => {
  it("POSTs to /v1/contexts/:id/participants with endpoint_id body", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", added: true });

    const result = await client.addParticipant("ctx:1", "actor:ws:agent-a");

    expect(result).toEqual({ added: true });
    const fetchMock = vi.mocked(globalThis.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/participants`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ endpoint_id: "actor:ws:agent-a" });
  });

  it("returns added=false when bus says not newly added", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", added: false });
    const result = await client.addParticipant("ctx:1", "actor:ws:agent-a");
    expect(result).toEqual({ added: false });
  });
});

// ---------------------------------------------------------------------------
// removeParticipant
// ---------------------------------------------------------------------------

describe("BusClient.removeParticipant", () => {
  it("DELETEs /v1/contexts/:id/participants/:endpoint_id", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", removed: true });

    const result = await client.removeParticipant("ctx:1", "actor:ws:agent-a");

    expect(result).toEqual({ removed: true });
    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/participants/actor%3Aws%3Aagent-a`);
    expect(init?.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// subscribeToContext
// ---------------------------------------------------------------------------

describe("BusClient.subscribeToContext", () => {
  it("POSTs to /v1/contexts/:id/subscriptions with endpoint_id and event_types", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: ["*"] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a", ["*"]);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/subscriptions`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      endpoint_id: "actor:ws:agent-a",
      event_types: ["*"],
    });
  });

  it("sends non-empty event type list as-is", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: ["message", "snowball.card.entered_column"] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a", ["message", "snowball.card.entered_column"]);

    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.event_types).toEqual(["message", "snowball.card.entered_column"]);
  });

  it("sends [] for a silent watcher subscription", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: [] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a", []);

    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.event_types).toEqual([]);
  });

  it("defaults event_types to ['*'] when omitted", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a", event_types: ["*"] });

    await client.subscribeToContext("ctx:1", "actor:ws:agent-a");

    const fetchMock = vi.mocked(globalThis.fetch);
    const body = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(body.event_types).toEqual(["*"]);
  });
});

// ---------------------------------------------------------------------------
// unsubscribeFromContext
// ---------------------------------------------------------------------------

describe("BusClient.unsubscribeFromContext", () => {
  it("DELETEs /v1/contexts/:id/subscriptions/:endpoint_id", async () => {
    mockFetch({ ok: true, context_id: "ctx:1", endpoint_id: "actor:ws:agent-a" });

    await client.unsubscribeFromContext("ctx:1", "actor:ws:agent-a");

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/subscriptions/actor%3Aws%3Aagent-a`);
    expect(init?.method).toBe("DELETE");
  });
});

// ---------------------------------------------------------------------------
// listContextSubscriptions
// ---------------------------------------------------------------------------

describe("BusClient.listContextSubscriptions", () => {
  it("GETs /v1/contexts/:id/subscriptions and returns the subscriptions array", async () => {
    const payload = {
      subscriptions: [
        { endpoint_id: "actor:ws:agent-a", event_types: ["*"], subscribed_at: "2026-01-01T00:00:00.000Z" },
        { endpoint_id: "actor:ws:agent-b", event_types: [], subscribed_at: "2026-01-02T00:00:00.000Z" },
      ],
    };
    mockFetch(payload);

    const result = await client.listContextSubscriptions("ctx:1");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(payload.subscriptions[0]);
    expect(result[1]).toEqual(payload.subscriptions[1]);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3A1/subscriptions`);
  });
});

// ---------------------------------------------------------------------------
// listChildContexts
// ---------------------------------------------------------------------------

describe("BusClient.listChildContexts", () => {
  it("GETs /v1/contexts/:id/children and returns the contexts array", async () => {
    const payload = {
      contexts: [
        { context_id: "ctx:child:1", workspace_id: "ws:1", scope_id: "scope:1", created_at: "2026-01-01T00:00:00.000Z", title: "Child card", participants: [] },
      ],
    };
    mockFetch(payload);

    const result = await client.listChildContexts("ctx:parent");

    expect(result).toHaveLength(1);
    expect(result[0].context_id).toBe("ctx:child:1");

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/v1/contexts/ctx%3Aparent/children`);
  });

  it("returns empty array when there are no children", async () => {
    mockFetch({ contexts: [] });
    const result = await client.listChildContexts("ctx:parent");
    expect(result).toEqual([]);
  });
});
