import { afterEach, describe, expect, it, vi } from "vitest";
import { assignContextToScope, ContextAssignmentApiError } from "./context-assignment-api";

describe("Context assignment API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assigns a Workspace-level Context to an explicit Scope through the Bus endpoint", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") || null });
      return new Response(JSON.stringify({
        ok: true,
        context: {
          context_id: "ctx/one",
          scope_id: "scope/one",
          participants: ["actor:operator"]
        },
        audit_event: { event_id: "evt_assignment", type: "context.scope_assigned" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    const result = await assignContextToScope("http://bus.local/", "workspace:test", "ctx/one", {
      scopeId: "scope/one",
      actorId: "actor:operator"
    });

    expect(result).toEqual({
      ok: true,
      context: {
        context_id: "ctx/one",
        scope_id: "scope/one",
        participants: ["actor:operator"]
      },
      audit_event: { event_id: "evt_assignment", type: "context.scope_assigned" }
    });
    expect(calls).toEqual([{
      url: "http://bus.local/v1/workspaces/workspace%3Atest/contexts/ctx%2Fone/assign-scope",
      method: "POST",
      body: JSON.stringify({ scope_id: "scope/one", assigned_by: "actor:operator" })
    }]);
  });

  it("maps Bus assignment errors to user-facing model language", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "context_scope_assignment_invalid", reason: "orphan_context" }), {
        status: 409,
        headers: { "content-type": "application/json" }
      })
    ));

    await expect(assignContextToScope("http://bus.local", "ws", "orphan", { scopeId: "research" }))
      .rejects.toMatchObject({
        name: "ContextAssignmentApiError",
        status: 409,
        code: "context_scope_assignment_invalid",
        message: "Only actor-anchored Workspace Contexts can be assigned to a Scope."
      } satisfies Partial<ContextAssignmentApiError>);
  });
});
