import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listFields,
  getField,
  putFieldSemantic,
  deleteField,
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
