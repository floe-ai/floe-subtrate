import { afterEach, describe, expect, it, vi } from "vitest";
import { createScope, getScopeProjection, listScopes, renameScope, ScopeProjectionApiError } from "./scope-projection-api";

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
            scope_id: "default",
            title: "Default Scope",
            description: null,
            created_at: "2026-05-24T00:00:00.000Z",
            updated_at: "2026-05-24T00:00:00.000Z"
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/workspaces/workspace%3Atest/scopes/default/projection")) {
        return new Response(JSON.stringify({
          projection: {
            workspace_id: "workspace:test",
            scope_id: "default",
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
    const projection = await getScopeProjection("http://bus.local/", "workspace:test", "default");

    expect(scopes).toHaveLength(1);
    expect(scopes[0].title).toBe("Default Scope");
    expect(projection.scope_id).toBe("default");
    expect(requested).toEqual([
      "http://bus.local/v1/workspaces/workspace%3Atest/scopes",
      "http://bus.local/v1/workspaces/workspace%3Atest/scopes/default/projection"
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
});
