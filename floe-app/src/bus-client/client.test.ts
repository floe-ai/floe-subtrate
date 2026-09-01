import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  listWorkspaces,
  listScopes,
  listScopeCompositions,
  listContextEventHistoryPage,
  listContextEvents,
  listContextTree,
  listContextsByParticipantPage,
  createScope,
  updateScope,
  retireScope,
  deleteScope,
  getRuntimeBindings,
  resolveRuntimeBinding,
  listDeliveries,
  getRuntimeStatus,
  getContextDiagnosticEvidence,
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

  it("loads bounded Context diagnostics from the Bus-owned projection", async () => {
    const evidence = { schema: "floe.context-diagnostic.v1", events: [] };
    const fetchMock = mockFetch(evidence);
    vi.stubGlobal("fetch", fetchMock);

    await expect(getContextDiagnosticEvidence("workspace:one", "ctx:one", {
      event_limit: 20,
      telemetry_limit: 40,
    })).resolves.toEqual(evidence);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/v1/workspaces/workspace%3Aone/diagnostics/contexts/ctx%3Aone");
    expect(url).toContain("event_limit=20");
    expect(url).toContain("telemetry_limit=40");
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

  it("requests bounded Context history backward from the newest page", async () => {
    const fetchMock = mockFetch({
      events: [{ event_id: "event-older" }],
      next_cursor: null,
      previous_cursor: "cursor-earlier",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listContextEventHistoryPage("ctx:long", {
      before: "cursor-newer",
      limit: 50,
      type: "message",
    })).resolves.toEqual({
      events: [{ event_id: "event-older" }],
      previous_cursor: "cursor-earlier",
    });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("context_id=ctx%3Along");
    expect(url).toContain("direction=backward");
    expect(url).toContain("before=cursor-newer");
    expect(url).toContain("type=message");
    expect(url).toContain("limit=50");
  });

  it("pages recent participant Contexts without one request per conversation", async () => {
    const page = {
      contexts: [{ context_id: "ctx:recent", latest_message_preview: "Done" }],
      next_cursor: "older-contexts",
    };
    const fetchMock = mockFetch(page);
    vi.stubGlobal("fetch", fetchMock);

    await expect(listContextsByParticipantPage({
      participant: "actor:workspace:operator",
      workspace_id: "workspace:test",
      limit: 20,
      before: "newer-contexts",
    })).resolves.toEqual(page);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("participant=actor%3Aworkspace%3Aoperator");
    expect(url).toContain("workspace_id=workspace%3Atest");
    expect(url).toContain("limit=20");
    expect(url).toContain("before=newer-contexts");
  });

  it("loads one bounded Context lineage for the Work projection", async () => {
    const result = { contexts: [{ context_id: "ctx:root" }], truncated: false };
    const fetchMock = mockFetch(result);
    vi.stubGlobal("fetch", fetchMock);

    await expect(listContextTree("ctx:root", 200)).resolves.toEqual(result);
    expect(fetchMock.mock.calls[0][0] as string).toContain("/v1/contexts/ctx%3Aroot/tree?limit=200");
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

  it("retireScope stops active work while preserving the Scope", async () => {
    const result = {
      status: "retired" as const,
      cancelled_delivery_count: 2,
      cancelled_queue_count: 3,
      cancelled_pulse_count: 1,
    };
    const fetchMock = mockFetch(result);
    vi.stubGlobal("fetch", fetchMock);

    await expect(retireScope("ws:one", "pipeline one")).resolves.toEqual(result);
    expect(fetchMock.mock.calls[0][0] as string).toContain("/workspaces/ws%3Aone/scopes/pipeline%20one/retire");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("POST");
  });

  it("deleteScope sends DELETE and handles 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    vi.stubGlobal("fetch", fetchMock);
    await deleteScope("ws1", "s1");
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});
