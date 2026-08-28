import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listWorkspaces,
  listScopes,
  listScopeCompositions,
  listContextEvents,
  createScope,
  updateScope,
  deleteScope,
  getRuntimeBindings,
  resolveRuntimeBinding,
  listDeliveries,
  getRuntimeStatus,
  listConfigs,
  emit,
} from "./client.ts";

// ---------------------------------------------------------------------------
// Minimal fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Existing capabilities
// ---------------------------------------------------------------------------

describe("bus-client — existing", () => {
  it.todo("advances watermark via PUT");
  it.todo("pages events with next_cursor");
});

// ---------------------------------------------------------------------------
// New — reads
// ---------------------------------------------------------------------------

describe("bus-client — reads", () => {
  it("listWorkspaces unwraps { workspaces }", async () => {
    const workspaces = [{ workspace_id: "ws1", name: "Test", locator: "/tmp/ws1", status: "active", selected_at: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    vi.stubGlobal("fetch", mockFetch({ workspaces }));
    const result = await listWorkspaces();
    expect(result).toEqual(workspaces);
  });

  it("listWorkspaces forwards a bootstrap cancellation signal", async () => {
    const fetchMock = mockFetch({ workspaces: [] });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await listWorkspaces(controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/v1/workspaces"),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("listScopes unwraps { scopes } and encodes workspace_id", async () => {
    const scopes = [{ scope_id: "s1", workspace_id: "ws:abc", title: "Scope 1", description: null, status: "active", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    const fetchMock = mockFetch({ scopes });
    vi.stubGlobal("fetch", fetchMock);
    const result = await listScopes("ws:abc");
    expect(result).toEqual(scopes);
    expect((fetchMock.mock.calls[0][0] as string)).toContain(encodeURIComponent("ws:abc"));
  });

  it("getRuntimeBindings unwraps { bindings }", async () => {
    const bindings = [{ binding_key: "runtime:global:default", scope: "global_default", workspace_id: null, endpoint_id: null, auth_profile: "default", model: null, thinking_level: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    vi.stubGlobal("fetch", mockFetch({ bindings }));
    const result = await getRuntimeBindings();
    expect(result).toEqual(bindings);
  });

  it("resolveRuntimeBinding returns resolution shape directly", async () => {
    const resolution = {
      endpoint_auth_profile: null,
      workspace_auth_profile: "default",
      global_auth_profile: null,
      endpoint_model: null,
      workspace_model: "claude-3-opus",
      global_model: null,
      endpoint_thinking_level: null,
      workspace_thinking_level: null,
      global_thinking_level: null,
    };
    vi.stubGlobal("fetch", mockFetch(resolution));
    const result = await resolveRuntimeBinding("ws1", "ep1");
    expect(result).toEqual(resolution);
  });

  it("listDeliveries unwraps { deliveries }", async () => {
    const deliveries = [{ delivery_id: "d1", endpoint_id: "ep1", workspace_id: "ws1", trigger_event_id: "ev1", events_json: "[]", state: "reserved", lease_expires_at: null, attempt_count: 1, last_error: null, created_at: "2024-01-01T00:00:00Z", claimed_at: null }];
    vi.stubGlobal("fetch", mockFetch({ deliveries }));
    const result = await listDeliveries({ workspace_id: "ws1" });
    expect(result).toEqual(deliveries);
  });

  it("getRuntimeStatus returns bridge shape", async () => {
    const status = { bridge: { online: true, runtime_adapter: "claude" } };
    vi.stubGlobal("fetch", mockFetch(status));
    const result = await getRuntimeStatus();
    expect(result.bridge.online).toBe(true);
  });

  it("listConfigs unwraps { configs }", async () => {
    const configs = [{ config_id: "cfg_1", name: "prod", config_json: "{}", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" }];
    vi.stubGlobal("fetch", mockFetch({ configs }));
    const result = await listConfigs();
    expect(result).toEqual(configs);
  });
});

// ---------------------------------------------------------------------------
// New — writes
// ---------------------------------------------------------------------------

describe("bus-client — writes", () => {
  it("bounds a message submission when the local substrate stops responding", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })));

    const pending = expect(emit({
      type: "message",
      workspace_id: "ws1",
      source_endpoint_id: "actor:ws1:operator",
      destination: { kind: "endpoint", endpoint_id: "actor:ws1:floe" },
      content: { text: "hello" },
      response: { expected: true },
      metadata: {},
    })).rejects.toThrow("Floe's local service stopped responding");

    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
  });

  it("pages through an entire Context history without dropping newer messages", async () => {
    const first = Array.from({ length: 500 }, (_, index) => ({ event_id: `event-${index}` }));
    const last = { event_id: "event-500" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: first, next_cursor: "cursor-500" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ events: [last], next_cursor: "cursor-501" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await listContextEvents("ctx:long", { all: true });

    expect(result).toHaveLength(501);
    expect(result.at(-1)).toEqual(last);
    expect(fetchMock.mock.calls[0][0] as string).toContain("context_id=ctx%3Along");
    expect(fetchMock.mock.calls[1][0] as string).toContain("since=cursor-500");
  });

  it("listScopeCompositions unwraps the Scope's stored composition", async () => {
    const graphs = [{ graph_id: "graph-1", workspace_id: "ws:abc", scope_id: "delivery", context_id: "ctx-1", nodes: [], created_at: "2026-08-27T00:00:00Z", updated_at: "2026-08-27T00:00:00Z" }];
    const fetchMock = mockFetch({ graphs });
    vi.stubGlobal("fetch", fetchMock);
    await expect(listScopeCompositions("ws:abc", "delivery pipeline")).resolves.toEqual(graphs);
    expect(fetchMock.mock.calls[0][0] as string).toContain("/scopes/delivery%20pipeline/graphs");
  });

  it("createScope unwraps { scope } and POSTs", async () => {
    const scope = { scope_id: "s-new", workspace_id: "ws1", title: "New Scope", description: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" };
    const fetchMock = mockFetch({ scope }, 201);
    vi.stubGlobal("fetch", fetchMock);
    const result = await createScope("ws1", { title: "New Scope" });
    expect(result).toEqual(scope);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("updateScope unwraps { scope } and PATCHes", async () => {
    const scope = { scope_id: "s1", workspace_id: "ws1", title: "Updated", description: null, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-02T00:00:00Z" };
    const fetchMock = mockFetch({ scope });
    vi.stubGlobal("fetch", fetchMock);
    const result = await updateScope("ws1", "s1", { title: "Updated" });
    expect(result).toEqual(scope);
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
  });

  it("deleteScope sends DELETE and handles 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    await deleteScope("ws1", "s1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
