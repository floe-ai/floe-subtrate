/**
 * Link-inclusion tests — D5 of the peer context relay model.
 *
 * Tests:
 *  - renderOriginatingSlice renders a header with origin context_id + relay instructions
 *  - renderOriginatingSlice includes event text with actor refs
 *  - renderOriginatingSlice is empty when events have no renderable text
 *  - renderOriginatingSlice is empty for empty events array
 *  - renderOriginatingSlice is capped at MAX chars (non-fatal truncation)
 *  - Integration: session prompt includes originating slice when context has parent_context_id
 *  - Integration: session prompt has NO originating slice for root context (no parent_context_id)
 */
import { describe, expect, it } from "vitest";
import { renderOriginatingSlice, renderThreadSlice } from "./pi-agent-core-adapter.js";
import type { EventEnvelope } from "../bus-client.js";

function makeEvent(overrides: Partial<EventEnvelope> & { event_id: string }): EventEnvelope {
  return {
    event_id: overrides.event_id,
    type: overrides.type ?? "message",
    workspace_id: overrides.workspace_id ?? "workspace:test",
    source_endpoint_id: overrides.source_endpoint_id ?? "actor:test:operator",
    thread_id: overrides.thread_id ?? "ctx_test",
    context_id: overrides.context_id ?? "ctx_test",
    scope_id: null,
    correlation_id: null,
    destination_json: overrides.destination_json ?? { kind: "endpoint", endpoint_id: "actor:test:snowball" },
    content: overrides.content ?? { text: "Hello, Snowball. Please ask Floe about the weather." },
    response: { expected: false },
    metadata: {},
    created_at: overrides.created_at ?? "2026-07-16T00:00:00.000Z"
  };
}

describe("renderOriginatingSlice — D5 link-inclusion", () => {
  it("includes origin context_id in header and relay instructions", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "Hello, please ask Floe about the weather." } })
    ];
    const result = renderOriginatingSlice("ctx_origin_123", events);
    expect(result).toContain("ctx_origin_123");
    expect(result).toContain("relay");
    expect(result).toContain("context_id: ctx_origin_123");
  });

  it("includes event text with actor ref prefix", () => {
    const events = [
      makeEvent({
        event_id: "evt_1",
        source_endpoint_id: "actor:ws:operator",
        content: { text: "What is the weather?" }
      })
    ];
    const result = renderOriginatingSlice("ctx_origin_abc", events);
    expect(result).toContain("What is the weather?");
    // Actor ref should be present (neutral ref format).
    expect(result).toMatch(/\[.*\]/);
  });

  it("includes multiple events in order", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "First message" } }),
      makeEvent({ event_id: "evt_2", content: { text: "Second message" } })
    ];
    const result = renderOriginatingSlice("ctx_origin", events);
    expect(result).toContain("First message");
    expect(result).toContain("Second message");
    const firstIndex = result.indexOf("First message");
    const secondIndex = result.indexOf("Second message");
    expect(firstIndex).toBeLessThan(secondIndex);
  });

  it("returns empty string for empty events array", () => {
    expect(renderOriginatingSlice("ctx_origin", [])).toBe("");
  });

  it("returns empty string when all events have no text content", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { data: "binary" } })
    ];
    const result = renderOriginatingSlice("ctx_origin", events);
    expect(result).toBe("");
  });

  it("header mentions the origin context_id as the relay target", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "test" } })
    ];
    const result = renderOriginatingSlice("ctx_relay_target_xyz", events);
    // The header must clearly identify the relay target.
    expect(result).toContain("ctx_relay_target_xyz");
    expect(result).toContain("[End Originating Request]");
  });

  it("is different from renderThreadSlice (has unique header)", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "same event" } })
    ];
    const originSlice = renderOriginatingSlice("ctx_origin", events);
    const threadSlice = renderThreadSlice(events);
    // Both render the event text but with different headers.
    expect(originSlice).toContain("same event");
    expect(threadSlice).toContain("same event");
    // Different headers.
    expect(originSlice).not.toContain("[Thread — recent context history]");
    expect(threadSlice).not.toContain("Peer Context");
  });

  it("caps at MAX_ORIGINATING_CHARS to avoid bloating the prompt", () => {
    // Create many events with very long text.
    const events = Array.from({ length: 20 }, (_, i) => makeEvent({
      event_id: `evt_${i}`,
      content: { text: "X".repeat(500) }
    }));
    const result = renderOriginatingSlice("ctx_origin", events);
    // Should be bounded (not 20 * 500 + overhead chars).
    expect(result.length).toBeLessThan(4_000);
  });
});

describe("renderOriginatingSlice — peer context integration (D5)", () => {
  it("documents that originContextId is surfaced in the slice for relay ergonomics", () => {
    // D3: the actor needs the origin context_id to relay back.
    // The slice explicitly includes: "To relay results back, emit with context_id: <id>"
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "Snowball, please get weather from Floe." } })
    ];
    const result = renderOriginatingSlice("ctx_operator_snowball_c", events);

    // The actor can parse or read the context_id from this slice.
    expect(result).toContain("ctx_operator_snowball_c");
    // Instruction to relay back.
    expect(result).toMatch(/emit with context_id.*ctx_operator_snowball_c/);
  });
});

// Integration: ensure link-inclusion is ONLY injected for actors that are
// participants of the origin context. A leaf actor (not in origin participants)
// must NOT receive the originating slice; a bridging actor who IS a participant
// must still receive it.
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";

describe("D5 link-inclusion — origin membership gating", () => {
  const MOCK_AUTH = {
    paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
    authStorage: {} as any,
    modelRegistry: {
      find(provider: string, modelId: string) {
        if (provider === "mock-provider" && modelId === "mock-model") {
          return {
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
          } as any;
        }
        return undefined;
      },
      async getApiKeyForProvider() { return "test-key"; }
    },
    profiles: { version: 1, profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }] }
  } as any;

  function makeDelivery(deliveryId: string, endpointId: string, contextId: string, threadId: string): any {
    return {
      delivery_id: deliveryId,
      endpoint_id: endpointId,
      workspace_id: "workspace:test",
      trigger_event_id: `evt:${deliveryId}`,
      delivered_at: new Date().toISOString(),
      events: [
        {
          event_id: `evt:${deliveryId}`,
          type: "message",
          workspace_id: "workspace:test",
          source_endpoint_id: "actor:workspace:test:operator",
          thread_id: threadId,
          context_id: contextId,
          correlation_id: null,
          destination_json: { kind: "endpoint", endpoint_id: endpointId },
          content: { text: "hello", data: {} },
          response: { expected: false },
          metadata: {},
          created_at: new Date().toISOString()
        }
      ]
    };
  }

  it("does NOT inject originating slice for an actor that is NOT a participant of the origin", async () => {
    let capturedPrompt = "";
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        // signal completion
        for (const l of this.listeners) await l({ type: "turn_end", message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" } });
        for (const l of this.listeners) await l({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], model: "mock-model", provider: "mock-provider" });
      }
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, { agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }, turnFinalizeTimeoutMs: 1000 });

    const ENDPOINT = "actor:workspace:test:leaf";
    const PEER_CTX = "ctx_peer_1";
    const ORIGIN_CTX = "ctx_origin_1";

    const bus = {
      async appendRuntimeTelemetry() {},
      async emit() {},
      async getContext(ctxId: string) {
        if (ctxId === PEER_CTX) {
          return {
            context_id: PEER_CTX,
            workspace_id: "workspace:test",
            parent_context_id: ORIGIN_CTX,
            created_by_endpoint_id: null,
            scope_id: null,
            created_at: new Date().toISOString(),
            // peer context participants can be empty or different
            participants: ["actor:workspace:test:other"]
          };
        }
        if (ctxId === ORIGIN_CTX) {
          return {
            context_id: ORIGIN_CTX,
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: null,
            scope_id: null,
            created_at: new Date().toISOString(),
            // origin participants do NOT include our ENDPOINT
            participants: ["actor:workspace:test:other"]
          };
        }
        return null;
      },
      async listContextEvents(ctxId: string, _since?: string | null, _limit?: number) {
        if (ctxId === ORIGIN_CTX) {
          return { events: [
            { event_id: "evt_o1", type: "message", workspace_id: "workspace:test", source_endpoint_id: "actor:workspace:test:operator", thread_id: ORIGIN_CTX, context_id: ORIGIN_CTX, content: { text: "origin text" }, response: { expected: false }, metadata: {}, created_at: new Date().toISOString() }
          ], next_cursor: null };
        }
        return { events: [], next_cursor: null };
      },
      async listEndpoints(_ws: string) { return []; }
    } as any;

    const ctx = { bridge_id: "bridge:test", bus } as any;

    await adapter.handleBundle(ctx, makeDelivery("del-x", ENDPOINT, PEER_CTX, "thread-x"), { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });

    // Should NOT contain the peer context header / relay instruction
    expect(capturedPrompt).not.toContain("Peer Context");
    expect(capturedPrompt).not.toMatch(/emit with context_id.*ctx_origin_1/);
  });

  it("does inject originating slice for an actor that IS a participant of the origin", async () => {
    let capturedPrompt = "";
    const fakeAgent: any = {
      registeredTools: [] as any[],
      listeners: [] as Array<(e: any) => void | Promise<void>>,
      subscribe(l: any) { this.listeners.push(l); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({ type: "turn_end", message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" } });
        for (const l of this.listeners) await l({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], model: "mock-model", provider: "mock-provider" });
      }
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, { agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }, turnFinalizeTimeoutMs: 1000 });

    const ENDPOINT = "actor:workspace:test:bridge_agent";
    const PEER_CTX = "ctx_peer_2";
    const ORIGIN_CTX = "ctx_origin_2";

    const bus = {
      async appendRuntimeTelemetry() {},
      async emit() {},
      async getContext(ctxId: string) {
        if (ctxId === PEER_CTX) {
          return {
            context_id: PEER_CTX,
            workspace_id: "workspace:test",
            parent_context_id: ORIGIN_CTX,
            created_by_endpoint_id: null,
            scope_id: null,
            created_at: new Date().toISOString(),
            participants: [ENDPOINT]
          };
        }
        if (ctxId === ORIGIN_CTX) {
          return {
            context_id: ORIGIN_CTX,
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: null,
            scope_id: null,
            created_at: new Date().toISOString(),
            // origin participants include our ENDPOINT (bridging actor)
            participants: [ENDPOINT, "actor:workspace:test:other"]
          };
        }
        return null;
      },
      async listContextEvents(ctxId: string, _since?: string | null, _limit?: number) {
        if (ctxId === ORIGIN_CTX) {
          return { events: [
            { event_id: "evt_o1", type: "message", workspace_id: "workspace:test", source_endpoint_id: "actor:workspace:test:operator", thread_id: ORIGIN_CTX, context_id: ORIGIN_CTX, content: { text: "origin text" }, response: { expected: false }, metadata: {}, created_at: new Date().toISOString() }
          ], next_cursor: null };
        }
        return { events: [], next_cursor: null };
      },
      async listEndpoints(_ws: string) { return []; }
    } as any;

    const ctx = { bridge_id: "bridge:test", bus } as any;

    await adapter.handleBundle(ctx, makeDelivery("del-y", ENDPOINT, PEER_CTX, "thread-y"), { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });

    // Should contain peer context header and relay instruction
    expect(capturedPrompt).toContain("Peer Context");
    expect(capturedPrompt).toMatch(/emit with context_id.*ctx_origin_2/);
    expect(capturedPrompt).toContain("origin text");
  });
});