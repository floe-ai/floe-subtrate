import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listFields,
  getField,
  putFieldSemantic,
  putFieldLayout,
  deleteField,
  subscribeToFieldEvents,
  FieldsApiError
} from "./fields-api";
import type { FieldSemantic, FieldLayoutFloeweb, FieldSummary } from "./fields";

const BUS = "http://127.0.0.1:5377";
const T0 = "2024-06-01T10:00:00.000Z";

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" }
  });
}

function textResponse(text: string, status: number): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}

function makeSemantic(overrides: Partial<FieldSemantic> = {}): FieldSemantic {
  return {
    schema: "floe.field.v1",
    id: "field-1",
    title: "Test field",
    items: [],
    connections: [],
    created_at: T0,
    updated_at: T0,
    ...overrides
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listFields", () => {
  it("GETs the workspace fields URL and unwraps .fields", async () => {
    const fields: FieldSummary[] = [
      { id: "a", title: "A", item_count: 0, connection_count: 0, updated_at: T0 }
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ fields }));

    const result = await listFields(BUS, "ws-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:5377/v1/workspaces/ws-1/fields");
    expect(result).toEqual(fields);
  });
});

describe("getField", () => {
  it("GETs the field URL and returns { semantic, layout }", async () => {
    const semantic = makeSemantic();
    const layout: FieldLayoutFloeweb = {
      schema: "floe.field.layout.floeweb.v1",
      field_id: "field-1",
      viewport: { x: 0, y: 0, zoom: 1 },
      items: {}
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ semantic, layout }));

    const result = await getField(BUS, "ws-1", "field-1");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:5377/v1/workspaces/ws-1/fields/field-1"
    );
    expect(result).toEqual({ semantic, layout });
  });

  it("coerces a null layout to null (not undefined)", async () => {
    const semantic = makeSemantic();
    fetchMock.mockResolvedValueOnce(jsonResponse({ semantic, layout: null }));

    const result = await getField(BUS, "ws-1", "field-1");

    expect(result.layout).toBeNull();
    expect(result.semantic).toEqual(semantic);
  });
});

describe("putFieldSemantic", () => {
  it("PUTs JSON body and returns .semantic", async () => {
    const semantic = makeSemantic();
    fetchMock.mockResolvedValueOnce(jsonResponse({ semantic }));

    const result = await putFieldSemantic(BUS, "ws-1", "field-1", semantic);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5377/v1/workspaces/ws-1/fields/field-1");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(semantic);
    expect(result).toEqual(semantic);
  });

  it("adds if_absent=true for create-only writes", async () => {
    const semantic = makeSemantic();
    fetchMock.mockResolvedValueOnce(jsonResponse({ semantic }));

    await putFieldSemantic(BUS, "ws-1", "field-1", semantic, { ifAbsent: true });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:5377/v1/workspaces/ws-1/fields/field-1?if_absent=true"
    );
  });
});

describe("putFieldLayout", () => {
  it("PUTs FloeWeb layout JSON and returns .layout", async () => {
    const layout: FieldLayoutFloeweb = {
      schema: "floe.field.layout.floeweb.v1",
      field_id: "field-1",
      viewport: { x: 10, y: 20, zoom: 1.5 },
      items: { item_1: { x: 100, y: 200 } }
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({ layout }));

    const result = await putFieldLayout(BUS, "ws-1", "field-1", layout);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5377/v1/workspaces/ws-1/fields/field-1/layout/floeweb");
    expect(init.method).toBe("PUT");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(layout);
    expect(result).toEqual(layout);
  });
});

describe("deleteField", () => {
  it("DELETEs and returns the result body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ semanticDeleted: true, layoutsDeleted: ["/a.layout.floeweb.yaml"] })
    );

    const result = await deleteField(BUS, "ws-1", "field-1");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:5377/v1/workspaces/ws-1/fields/field-1");
    expect(init.method).toBe("DELETE");
    expect(result).toEqual({
      semanticDeleted: true,
      layoutsDeleted: ["/a.layout.floeweb.yaml"]
    });
  });
});

describe("subscribeToFieldEvents", () => {
  it("opens the bus event stream and forwards only canonical Field events", () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
      emit(message: unknown) {
        this.onmessage?.({ data: JSON.stringify(message) });
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const events: unknown[] = [];

    const unsubscribe = subscribeToFieldEvents(BUS, (event) => events.push(event));

    expect(FakeWebSocket.instances[0].url).toBe("ws://127.0.0.1:5377/v1/events/stream");
    FakeWebSocket.instances[0].emit({ type: "hello", payload: {} });
    FakeWebSocket.instances[0].emit({
      type: "field.upserted",
      payload: {
        workspace_id: "ws-1",
        field_id: "field-1",
        source: "watcher",
        changed: "semantic"
      },
      at: T0
    });
    FakeWebSocket.instances[0].emit({
      type: "field.deleted",
      payload: { workspace_id: "ws-1", field_id: "field-1" },
      at: T0
    });
    unsubscribe();

    expect(events).toEqual([
      {
        type: "field.upserted",
        payload: {
          workspace_id: "ws-1",
          field_id: "field-1",
          source: "watcher",
          changed: "semantic"
        },
        at: T0
      },
      {
        type: "field.deleted",
        payload: { workspace_id: "ws-1", field_id: "field-1" },
        at: T0
      }
    ]);
    expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1);
  });

  it("reconnects when the Field event stream closes", () => {
    vi.useFakeTimers();
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: (() => void) | null = null;
      close = vi.fn();
      constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const unsubscribe = subscribeToFieldEvents(BUS, () => {}, { reconnectDelayMs: 50 });
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(49);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe("ws://127.0.0.1:5377/v1/events/stream");

    unsubscribe();
    FakeWebSocket.instances[1].onclose?.();
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("error handling", () => {
  it("throws FieldsApiError on non-OK with status in message", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("nope", 500));

    await expect(listFields(BUS, "ws-1")).rejects.toMatchObject({
      name: "FieldsApiError",
      status: 500,
      message: expect.stringContaining("500")
    });
  });
});

describe("URL encoding", () => {
  it("encodes workspaceId and fieldId so special characters are safe", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ semanticDeleted: true, layoutsDeleted: [] }));

    await deleteField(BUS, "ws/with space", "id with/slash");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://127.0.0.1:5377/v1/workspaces/ws%2Fwith%20space/fields/id%20with%2Fslash"
    );
  });

  it("strips trailing slash from the bus URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ fields: [] }));

    await listFields("http://127.0.0.1:5377/", "ws-1");

    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:5377/v1/workspaces/ws-1/fields");
  });
});
