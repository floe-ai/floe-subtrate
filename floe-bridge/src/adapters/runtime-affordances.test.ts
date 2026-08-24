import { describe, expect, it } from "vitest";
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";

const MODEL = {
  id: "mock-model",
  name: "Mock",
  api: "openai-responses",
  provider: "mock-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096
};

const AUTH = {
  paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
  authStorage: {},
  modelRegistry: {
    find: () => MODEL,
    getApiKeyForProvider: async () => "key"
  },
  profiles: { version: 1, profiles: [{ id: "profile", provider: "mock-provider", model: "mock-model" }] }
} as any;

function delivery(): DeliveryBundle {
  return {
    delivery_id: "del-affordances",
    endpoint_id: "actor:workspace:test:a",
    workspace_id: "workspace:test",
    trigger_event_id: "evt-current",
    delivered_at: new Date().toISOString(),
    events: [{
      event_id: "evt-current",
      type: "message",
      workspace_id: "workspace:test",
      source_endpoint_id: "actor:workspace:test:operator",
      thread_id: "ctx-current",
      context_id: "ctx-current",
      correlation_id: null,
      destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:a" },
      content: { text: "Ask B only if needed." },
      response: { expected: false },
      metadata: {},
      created_at: new Date().toISOString()
    }]
  };
}

describe("model-facing runtime affordances", () => {
  it("retrieves history deliberately and hides request correlation bookkeeping", async () => {
    let tools: any[] = [];
    let capturedPrompt = "";
    let historyResult: any;
    let requestResult: any;
    let secondRequestResult: any;
    const emitted: any[] = [];
    const telemetry: any[] = [];
    const historyCalls: any[] = [];
    const oldEvent: EventEnvelope = {
      event_id: "evt-old",
      type: "message",
      workspace_id: "workspace:test",
      source_endpoint_id: "actor:workspace:test:operator",
      thread_id: "ctx-current",
      context_id: "ctx-current",
      correlation_id: null,
      destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:a" },
      content: { text: "The older fact is cobalt." },
      response: { expected: false },
      metadata: {},
      created_at: "2026-08-20T00:00:00.000Z"
    };
    const agent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      reset() {},
      async prompt(message: any) {
        capturedPrompt = message.content[0].text;
        historyResult = await tools.find((tool) => tool.name === "context_history")
          .execute("tc-history", { limit: 2 });
        requestResult = await tools.find((tool) => tool.name === "request")
          .execute("tc-request", { actor: "b", work: "Return the colour fact." });
        secondRequestResult = await tools.find((tool) => tool.name === "request")
          .execute("tc-request-2", { actor: "b", work: "Do unrelated work too." });
        const assistant = { role: "assistant", content: [], stopReason: "stop", usage: null, model: "mock-model", provider: "mock-provider" };
        for (const listener of this.listeners) {
          await listener({ type: "agent_end", messages: [assistant] });
        }
      }
    };
    const adapter = new PiAgentCoreAdapter(AUTH, {
      agentFactory: (input) => {
        tools = input.tools;
        return agent;
      },
      turnFinalizeTimeoutMs: 1_000
    });
    const bus = {
      async appendRuntimeTelemetry(input: any) { telemetry.push(input); },
      async recordRuntimeTurnResult() { throw new Error("empty output must not record a result"); },
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test", parent_context_id: null, created_by_endpoint_id: null, scope_id: null, created_at: new Date().toISOString(), participants: [] };
      },
      async listContextEvents(contextId: string, cursor: string | null, limit: number) {
        historyCalls.push({ contextId, cursor, limit });
        return { events: [oldEvent], next_cursor: "cursor-next" };
      },
      async listEndpoints() {
        return [
          { endpoint_id: "actor:workspace:test:a", name: "A", status: "active" },
          { endpoint_id: "actor:workspace:test:b", name: "B", status: "idle" }
        ];
      },
      async emit(event: any) { emitted.push(event); }
    };

    await adapter.handleBundle(
      { bridge_id: "bridge:test", bus } as any,
      delivery(),
      { provider: "mock-provider", model: "mock-model", auth_profile: "profile" }
    );

    expect(capturedPrompt).toContain("Ask B only if needed.");
    expect(capturedPrompt).not.toContain("The older fact is cobalt.");
    expect(capturedPrompt).not.toContain("actor:workspace:test:b");
    expect(capturedPrompt).not.toContain("correlation_id");
    expect(historyCalls).toEqual([{ contextId: "ctx-current", cursor: null, limit: 2 }]);
    expect(historyResult.content[0].text).toContain("The older fact is cobalt.");
    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: "context_history_retrieval",
      payload: expect.objectContaining({ returned_events: 1 })
    }));

    expect(requestResult.content[0].text).not.toMatch(/req_[a-f0-9-]+/);
    expect(secondRequestResult).toMatchObject({
      content: [{ text: expect.stringContaining("already has a pending actor dependency") }],
      details: { ok: false, error: "dependency_already_requested" }
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "request",
      source_endpoint_id: "actor:workspace:test:a",
      destination: { kind: "endpoint", endpoint_id: "actor:workspace:test:b" },
      context_id: null,
      current_delivery_context_id: "ctx-current",
      content: { text: "Return the colour fact." },
      response: { expected: true, mode: "correlated" },
      metadata: {
        origin: "pi_request_tool",
        request_return_context_id: "ctx-current",
        request_parent_delivery_id: "del-affordances",
        request_continuation_event_id: null
      }
    });
    expect(emitted[0].correlation_id).toMatch(/^req_/);
    expect(emitted[0].response.correlation_id).toBe(emitted[0].correlation_id);
  });
});
