import { describe, expect, it, vi, type MockedFunction } from "vitest";
import {
  seedDefaultActor,
  actorEndpointId,
  DEFAULT_ACTOR_SLUG,
  DEFAULT_ACTOR_NAME,
} from "./actor-seed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUS_BASE = "http://127.0.0.1:5174";
const WORKSPACE_ID = "ws_test_abc";
const EXPECTED_ENDPOINT_ID = `actor:${WORKSPACE_ID}:${DEFAULT_ACTOR_SLUG}`;

/** Build a minimal fetch mock that returns the given endpoints on GET and 201 on POST. */
function mockFetch(existingEndpoints: Array<{ endpoint_id: string }>): MockedFunction<typeof fetch> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input.toString();

    if (!init?.method || init.method === "GET") {
      // GET /v1/workspaces/:ws/endpoints
      return new Response(JSON.stringify({ endpoints: existingEndpoints }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (init?.method === "POST" && url.includes("/v1/endpoints/register")) {
      const body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          endpoint: {
            endpoint_id: body.endpoint_id,
            workspace_id: body.workspace_id,
            name: body.name,
            agent_id: body.agent_id,
            bridge_id: body.bridge_id,
            status: body.status,
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("not found", { status: 404 });
  });
}

// ---------------------------------------------------------------------------
// actorEndpointId
// ---------------------------------------------------------------------------

describe("actorEndpointId", () => {
  it("builds the actor:<workspace_id>:<slug> format", () => {
    expect(actorEndpointId("ws_123", "operator")).toBe("actor:ws_123:operator");
  });

  it("preserves the slug verbatim", () => {
    expect(actorEndpointId("ws_abc", "release-notes-drafter")).toBe(
      "actor:ws_abc:release-notes-drafter"
    );
  });
});

// ---------------------------------------------------------------------------
// seedDefaultActor — creates when absent
// ---------------------------------------------------------------------------

describe("seedDefaultActor — creates when absent", () => {
  it("returns seeded: true and the correct endpoint_id", async () => {
    const fetch = mockFetch([]); // no existing endpoints
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: true, endpoint_id: EXPECTED_ENDPOINT_ID });
  });

  it("calls GET to list endpoints before registering", async () => {
    const fetch = mockFetch([]);
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    const getCall = fetch.mock.calls.find(
      ([url, opts]) => !opts?.method || opts.method === "GET"
    );
    expect(getCall).toBeDefined();
    expect(getCall![0].toString()).toContain(`/v1/workspaces/${encodeURIComponent(WORKSPACE_ID)}/endpoints`);
  });

  it("calls POST /v1/endpoints/register with the correct actor payload", async () => {
    const fetch = mockFetch([]);
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    expect(postCall).toBeDefined();
    expect(postCall![0].toString()).toContain("/v1/endpoints/register");

    const payload = JSON.parse(postCall![1]!.body as string);
    expect(payload).toMatchObject({
      endpoint_id: EXPECTED_ENDPOINT_ID,
      workspace_id: WORKSPACE_ID,
      name: DEFAULT_ACTOR_NAME,
      agent_id: DEFAULT_ACTOR_SLUG,
      bridge_id: null,
      status: "idle",
    });
  });
});

// ---------------------------------------------------------------------------
// seedDefaultActor — idempotent when actor already exists
// ---------------------------------------------------------------------------

describe("seedDefaultActor — idempotent when actor already exists", () => {
  it("returns seeded: false with reason already_exists", async () => {
    const fetch = mockFetch([{ endpoint_id: EXPECTED_ENDPOINT_ID }]);
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: false, reason: "already_exists" });
  });

  it("does NOT call POST /v1/endpoints/register", async () => {
    const fetch = mockFetch([{ endpoint_id: EXPECTED_ENDPOINT_ID }]);
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    expect(postCall).toBeUndefined();
  });

  it("only calls GET once (no duplicate registrations)", async () => {
    const fetch = mockFetch([{ endpoint_id: EXPECTED_ENDPOINT_ID }]);
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(fetch.mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// seedDefaultActor — does not affect other actors already present
// ---------------------------------------------------------------------------

describe("seedDefaultActor — other actors present", () => {
  it("still seeds the operator when other actors exist but operator does not", async () => {
    const fetch = mockFetch([
      { endpoint_id: `actor:${WORKSPACE_ID}:floe` },
      { endpoint_id: `actor:${WORKSPACE_ID}:tester` },
    ]);
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: true, endpoint_id: EXPECTED_ENDPOINT_ID });
  });

  it("skips seeding only when operator specifically exists (not other actors)", async () => {
    const fetch = mockFetch([
      { endpoint_id: `actor:${WORKSPACE_ID}:floe` },
      { endpoint_id: EXPECTED_ENDPOINT_ID }, // operator is present
    ]);
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: false, reason: "already_exists" });
  });
});

// ---------------------------------------------------------------------------
// seedDefaultActor — error paths
// ---------------------------------------------------------------------------

describe("seedDefaultActor — error handling", () => {
  it("returns list_failed when list endpoint is unreachable", async () => {
    const fetch = vi.fn(async (): Promise<Response> => {
      throw new Error("ECONNREFUSED");
    });
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: false, reason: "list_failed" });
  });

  it("returns list_failed when list endpoint returns non-OK status", async () => {
    const fetch = vi.fn(async (): Promise<Response> => {
      return new Response("internal error", { status: 500 });
    });
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: false, reason: "list_failed" });
  });

  it("returns register_failed when POST /v1/endpoints/register returns non-OK", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ endpoints: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("conflict", { status: 409 });
    });
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    expect(result).toEqual({ seeded: false, reason: "register_failed" });
  });
});

// ---------------------------------------------------------------------------
// actor shape invariants
// ---------------------------------------------------------------------------

describe("actor shape invariants", () => {
  it("endpoint_id follows actor:<workspace_id>:<slug> convention", async () => {
    const fetch = mockFetch([]);
    const result = await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    if (!result.seeded) throw new Error("expected seeded");
    expect(result.endpoint_id).toMatch(/^actor:[^:]+:[^:]+$/);
    expect(result.endpoint_id).toBe(`actor:${WORKSPACE_ID}:${DEFAULT_ACTOR_SLUG}`);
  });

  it("registers with bridge_id null (human actor — no bridge required)", async () => {
    const fetch = mockFetch([]);
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    const payload = JSON.parse(postCall![1]!.body as string);
    expect(payload.bridge_id).toBeNull();
  });

  it("registers with status idle", async () => {
    const fetch = mockFetch([]);
    await seedDefaultActor(BUS_BASE, WORKSPACE_ID, fetch as typeof globalThis.fetch);

    const postCall = fetch.mock.calls.find(([, opts]) => opts?.method === "POST");
    const payload = JSON.parse(postCall![1]!.body as string);
    expect(payload.status).toBe("idle");
  });
});
