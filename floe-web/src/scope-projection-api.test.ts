import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createScope,
  getScopeProjection,
  getScopeProjectionLayout,
  listScopes,
  parseScopeProjectionStreamMessage,
  putScopeProjectionLayout,
  renameScope,
  ScopeProjectionApiError
} from "./scope-projection-api";

describe("Scope Projection API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists Scopes and fetches one Scope Projection without calling legacy Field endpoints", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/v1/workspaces/workspace%3Atest/scopes")) {
        return new Response(JSON.stringify({
          scopes: [{
            workspace_id: "workspace:test",
            scope_id: "research",
            title: "Research",
            description: null,
            created_at: "2026-05-24T00:00:00.000Z",
            updated_at: "2026-05-24T00:00:00.000Z"
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/workspaces/workspace%3Atest/scopes/research/projection")) {
        return new Response(JSON.stringify({
          projection: {
            workspace_id: "workspace:test",
            scope_id: "research",
            generated_at: "2026-05-24T00:00:00.000Z",
            refs: { contexts: [], pulses: [], events: [], activity: [] },
            relationships: {
              context_participants: [],
              pulse_subscribers: [],
              event_context_ownership: []
            },
            unsupported: []
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }));

    const scopes = await listScopes("http://bus.local/", "workspace:test");
    const projection = await getScopeProjection("http://bus.local/", "workspace:test", "research");

    expect(scopes).toHaveLength(1);
    expect(scopes[0].title).toBe("Research");
    expect(projection.scope_id).toBe("research");
    expect(requested).toEqual([
      "http://bus.local/v1/workspaces/workspace%3Atest/scopes",
      "http://bus.local/v1/workspaces/workspace%3Atest/scopes/research/projection"
    ]);
    expect(requested.some((url) => url.includes("/fields"))).toBe(false);
  });

  it("creates and renames Scopes with encoded workspace and scope ids", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") || null });
      return new Response(JSON.stringify({
        scope: {
          workspace_id: "ws/one",
          scope_id: "scope/one",
          title: "Renamed",
          description: null,
          is_default: false,
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:01:00.000Z"
        }
      }), { status: init?.method === "POST" ? 201 : 200, headers: { "content-type": "application/json" } });
    }));

    await createScope("http://bus.local", "ws/one", { scope_id: "scope/one", title: "Created" });
    await renameScope("http://bus.local", "ws/one", "scope/one", { title: "Renamed" });

    expect(calls).toEqual([
      {
        url: "http://bus.local/v1/workspaces/ws%2Fone/scopes",
        method: "POST",
        body: JSON.stringify({ scope_id: "scope/one", title: "Created" })
      },
      {
        url: "http://bus.local/v1/workspaces/ws%2Fone/scopes/scope%2Fone",
        method: "PATCH",
        body: JSON.stringify({ title: "Renamed" })
      }
    ]);
  });

  it("surfaces Scope API error status and body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "scope_not_found" }), { status: 404, headers: { "content-type": "application/json" } })
    ));

    await expect(getScopeProjection("http://bus.local", "ws-1", "missing"))
      .rejects.toMatchObject({
        name: "ScopeProjectionApiError",
        status: 404,
        body: { error: "scope_not_found" }
      } satisfies Partial<ScopeProjectionApiError>);
  });

  it("loads and saves Scope Projection renderer layout sidecars without legacy Field endpoints", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/v1/workspaces/workspace%3Atest/scopes/research/projection/layout/floeweb")) {
        if (init?.method === "PUT") {
          return new Response(JSON.stringify({
            layout: JSON.parse(String(init.body))
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          layout: {
            schema: "floe.field.layout.floeweb.v1",
            field_id: "research",
            viewport: { x: 10, y: 20, zoom: 1.1 },
            items: {
              "context:ctx_research": { x: 100, y: 200 },
              "pulse:pulse_daily": { x: 400, y: 200 }
            }
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/workspaces/workspace%3Atest/scopes/missing/projection/layout/floeweb")) {
        return new Response(JSON.stringify({ error: "scope_projection_layout_not_found" }), { status: 404, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    }));

    const layout = await getScopeProjectionLayout("http://bus.local", "workspace:test", "research");
    const saved = await putScopeProjectionLayout("http://bus.local", "workspace:test", "research", layout!);
    const missing = await getScopeProjectionLayout("http://bus.local", "workspace:test", "missing");

    expect(layout?.items["context:ctx_research"]).toEqual({ x: 100, y: 200 });
    expect(saved).toEqual(layout);
    expect(missing).toBeNull();
    expect(calls).toEqual([
      "http://bus.local/v1/workspaces/workspace%3Atest/scopes/research/projection/layout/floeweb",
      "http://bus.local/v1/workspaces/workspace%3Atest/scopes/research/projection/layout/floeweb",
      "http://bus.local/v1/workspaces/workspace%3Atest/scopes/missing/projection/layout/floeweb"
    ]);
    expect(calls.some((url) => url.includes("/fields"))).toBe(false);
  });

  it("parses only Scope Projection layout stream messages", () => {
    expect(parseScopeProjectionStreamMessage(JSON.stringify({
      type: "scope_projection.layout.upserted",
      payload: {
        workspace_id: "workspace:test",
        scope_id: "research",
        source: "api",
        renderer: "floeweb"
      },
      at: "2026-05-24T00:00:00.000Z"
    }))).toEqual({
      type: "scope_projection.layout.upserted",
      payload: {
        workspace_id: "workspace:test",
        scope_id: "research",
        source: "api",
        renderer: "floeweb"
      },
      at: "2026-05-24T00:00:00.000Z"
    });
    expect(parseScopeProjectionStreamMessage(JSON.stringify({
      type: "field.upserted",
      payload: { workspace_id: "workspace:test", field_id: "legacy-field", changed: "semantic" }
    }))).toBeNull();
  });
});
