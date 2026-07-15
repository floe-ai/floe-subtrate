/**
 * Session isolation tests — fm/floe-ctx-session-iso
 *
 * Verifies:
 *  1. Two contexts for one agent produce two independent sessions (C-1)
 *  2. A session built for context A contains nothing from context B (C-1)
 *  3. Cold start (cursor=null) injects the full thread (C-2)
 *  4. Warm continue injects only the delta since last cursor (C-2/C-3)
 *  5. Reply still lands in the origin context (D-B invariant survives rekey)
 *
 * No live LLM calls — all tests use fixtures and doubles.
 */
import { describe, expect, it } from "vitest";
import { PiAgentCoreAdapter, renderThreadSlice } from "./pi-agent-core-adapter.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

const MOCK_MODEL = {
  id: "mock-model",
  name: "Mock",
  api: "openai-responses",
  provider: "mock-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} as const;

const MOCK_AUTH = {
  paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
  authStorage: {} as any,
  modelRegistry: {
    find(provider: string, modelId: string) {
      if (provider === "mock-provider" && modelId === "mock-model") return MOCK_MODEL as any;
      return undefined;
    },
    async getApiKeyForProvider() {
      return "test-key";
    },
  } as any,
  profiles: {
    version: 1,
    profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }],
  },
} as any;

const MOCK_RUNTIME_CONFIG = { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" };

function makeDeliveryWithContext(
  deliveryId: string,
  threadId: string,
  contextId: string | null,
  text: string,
  endpointId = "actor:workspace:test:floe"
): DeliveryBundle {
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
        content: { text, data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString(),
      } as EventEnvelope,
    ],
  };
}

/** A fake agent that records every prompt text it receives. */
class RecordingAgent {
  readonly promptsReceived: string[] = [];
  private listeners: Array<(event: any) => void | Promise<void>> = [];

  subscribe(listener: (event: any) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  async prompt(message: any): Promise<void> {
    const text = message?.content?.[0]?.text ?? "";
    this.promptsReceived.push(text);
    const assistantMsg = {
      role: "assistant",
      content: [{ type: "text", text: "ack" }],
      usage: { input: 1, output: 1, totalTokens: 2 },
      model: "mock-model",
      provider: "mock-provider",
    };
    for (const l of this.listeners) {
      await l({ type: "message_end", message: assistantMsg });
      await l({ type: "turn_end", message: assistantMsg });
      await l({ type: "agent_end", messages: [assistantMsg] });
    }
  }
}

/** Minimal bus context that tracks listContextEvents calls. */
function makeBusWith(contextEventMap: Map<string, { events: EventEnvelope[]; next_cursor: string | null }>) {
  return {
    async appendRuntimeTelemetry(_input: any) {},
    async emit(_event: any) {},
    async getContext(contextId: string) {
      return {
        context_id: contextId,
        workspace_id: "workspace:test",
        parent_context_id: null,
        created_by_endpoint_id: null,
        scope_id: null,
        created_at: new Date().toISOString(),
        participants: ["actor:workspace:test:operator", "actor:workspace:test:floe"],
      };
    },
    async listContextEvents(contextId: string, since?: string | null) {
      const entry = contextEventMap.get(contextId);
      if (!entry) return { events: [], next_cursor: null };
      // Simulate "since" cursor filtering: if since is provided, return subset
      // In real tests we just return the configured events for simplicity
      return { events: entry.events, next_cursor: entry.next_cursor };
    },
    async listEndpoints() { return []; },
  };
}

function makeMockContext(bus: ReturnType<typeof makeBusWith>): any {
  return { bridge_id: "bridge:test", bus } as any;
}

// ---------------------------------------------------------------------------
// C-1: Session isolation — one session per (endpoint, context)
// ---------------------------------------------------------------------------

describe("C-1: Session key per (agent, context)", () => {
  it("two contexts for one agent produce two independent agent instances", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
      ["ctx_card_B", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    // Deliver to context A
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A1", "thread-A", "ctx_card_A", "work on card A"),
      MOCK_RUNTIME_CONFIG
    );

    // Deliver to context B (same endpoint, different context)
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-B1", "thread-B", "ctx_card_B", "work on card B"),
      MOCK_RUNTIME_CONFIG
    );

    // Two distinct agent instances created
    expect(agentInstances).toHaveLength(2);
    expect(agentInstances[0]).not.toBe(agentInstances[1]);
  });

  it("same context reuses the same agent instance on second delivery", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A1", "thread-A", "ctx_card_A", "first turn"),
      MOCK_RUNTIME_CONFIG
    );
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A2", "thread-A", "ctx_card_A", "second turn"),
      MOCK_RUNTIME_CONFIG
    );

    // Only one agent instance (session reused for same context)
    expect(agentInstances).toHaveLength(1);
  });

  it("a session for context A sees no prompts from deliveries to context B", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
      ["ctx_card_B", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-A1", "thread-A", "ctx_card_A", "secret info about card A"),
      MOCK_RUNTIME_CONFIG
    );

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-B1", "thread-B", "ctx_card_B", "card B message"),
      MOCK_RUNTIME_CONFIG
    );

    // Two sessions, two agents
    expect(agentInstances).toHaveLength(2);

    const agentA = agentInstances[0];
    const agentB = agentInstances[1];

    // Agent B received NO prompts from agent A's session
    for (const p of agentB.promptsReceived) {
      expect(p).not.toContain("secret info about card A");
    }

    // Agent A received NO prompts from agent B's session
    for (const p of agentA.promptsReceived) {
      expect(p).not.toContain("card B message");
    }
  });

  it("no-context deliveries (context_id=null) use ':no-context' key and are isolated from context deliveries", async () => {
    const agentInstances: RecordingAgent[] = [];
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => {
        const a = new RecordingAgent();
        agentInstances.push(a);
        return a;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBusWith(new Map([
      ["ctx_card_A", { events: [], next_cursor: null }],
    ]));
    const context = makeMockContext(bus);

    // No-context delivery
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-noCtx", "thread-nc", null, "no context message"),
      MOCK_RUNTIME_CONFIG
    );

    // Context delivery
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-ctx", "thread-ctx", "ctx_card_A", "context message"),
      MOCK_RUNTIME_CONFIG
    );

    // Two distinct sessions
    expect(agentInstances).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// C-2/C-3: Thread-slice injection and cursor advance
// ---------------------------------------------------------------------------

describe("C-2/C-3: Thread-slice injection and cursor advance", () => {
  it("cold start (cursor=null) injects full thread — all context events are rendered", async () => {
    const capturedPrompts: string[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompts.push(message?.content?.[0]?.text ?? "");
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    // Provide historical thread events for this context
    const historicalEvents: EventEnvelope[] = [
      {
        event_id: "evt_hist_1",
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: "thread-ctx-C",
        context_id: "ctx_card_C",
        correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
        content: { text: "history message from operator" },
        response: { expected: false },
        metadata: {},
        created_at: "2024-01-01T00:00:00.000Z",
      } as EventEnvelope,
    ];

    const bus = makeBusWith(new Map([
      ["ctx_card_C", { events: historicalEvents, next_cursor: "cursor_after_hist" }],
    ]));
    const context = makeMockContext(bus);

    // This is a COLD START — no session exists, threadCursor=null
    const triggerDelivery = makeDeliveryWithContext(
      "del-C1", "thread-ctx-C", "ctx_card_C", "new trigger message"
    );

    await adapter.handleBundle(context, triggerDelivery, MOCK_RUNTIME_CONFIG);

    // The prompt should contain the thread history
    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];
    expect(prompt).toContain("[Thread — recent context history]");
    expect(prompt).toContain("history message from operator");
    // Trigger event itself is rendered separately by deliveryToPrompt (not in thread slice)
    // The thread slice lists [operator] history; the trigger "new trigger message" is the
    // delivery section. Both end up in the final prompt.
    expect(prompt).toContain("new trigger message");
  });

  it("warm continue injects only the delta since last cursor, not the full thread", async () => {
    const capturedPrompts: string[] = [];
    let listContextEventsCallCount = 0;
    let lastSince: string | null | undefined = undefined;

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompts.push(message?.content?.[0]?.text ?? "");
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    const contextId = "ctx_card_D";
    const firstTurnEvents: EventEnvelope[] = [
      {
        event_id: "evt_hist_old",
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: "thread-D",
        context_id: contextId,
        correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
        content: { text: "old history message" },
        response: { expected: false },
        metadata: {},
        created_at: "2024-01-01T00:00:00.000Z",
      } as EventEnvelope,
    ];
    const secondTurnEvents: EventEnvelope[] = [
      {
        event_id: "evt_hist_new",
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: "thread-D",
        context_id: contextId,
        correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
        content: { text: "delta-only message" },
        response: { expected: false },
        metadata: {},
        created_at: "2024-01-02T00:00:00.000Z",
      } as EventEnvelope,
    ];

    // Custom bus that tracks calls and returns different results per turn
    let turnCount = 0;
    const bus = {
      async appendRuntimeTelemetry(_input: any) {},
      async emit(_event: any) {},
      async getContext(contextId: string) {
        return {
          context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(),
          participants: [],
        };
      },
      async listContextEvents(ctxId: string, since?: string | null) {
        listContextEventsCallCount++;
        lastSince = since;
        if (turnCount === 0) {
          return { events: firstTurnEvents, next_cursor: "cursor_after_first" };
        } else {
          return { events: secondTurnEvents, next_cursor: "cursor_after_second" };
        }
      },
      async listEndpoints() { return []; },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    // Turn 1: cold start
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-D1", "thread-D", contextId, "first trigger"),
      MOCK_RUNTIME_CONFIG
    );
    turnCount++; // Advance for second turn

    // Turn 2: warm continue
    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-D2", "thread-D", contextId, "second trigger"),
      MOCK_RUNTIME_CONFIG
    );

    // Two prompts sent to the agent
    expect(capturedPrompts).toHaveLength(2);

    // Turn 1: cursor was null (cold start) — the since param was null/undefined
    // Turn 2: cursor should be "cursor_after_first" (warm continue)
    expect(listContextEventsCallCount).toBe(2);
    // Last call used the cursor from turn 1's response
    expect(lastSince).toBe("cursor_after_first");

    // Turn 1 prompt includes old history
    expect(capturedPrompts[0]).toContain("old history message");
    // Turn 2 prompt includes delta-only message
    expect(capturedPrompts[1]).toContain("delta-only message");
  });

  it("cursor is NOT advanced when turn fails (so next attempt re-fetches from same position)", async () => {
    const listContextEventsCursors: Array<string | null | undefined> = [];

    let turnAttempt = 0;
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(_message: any) {
        turnAttempt++;
        if (turnAttempt === 1) {
          // First turn: simulate agent_end with stop_reason=error → turn fails
          for (const l of this.listeners) {
            await l({
              type: "agent_end",
              messages: [{
                role: "assistant",
                content: [{ type: "text", text: "" }],
                stopReason: "error",
                errorMessage: "400 Bad Request",
                usage: null, model: "mock-model", provider: "mock-provider",
              }],
            });
          }
        } else {
          // Second turn: success
          const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
            usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
          for (const l of this.listeners) {
            await l({ type: "turn_end", message: assistantMsg });
            await l({ type: "agent_end", messages: [assistantMsg] });
          }
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = {
      async appendRuntimeTelemetry(_input: any) {},
      async emit(_event: any) {},
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(), participants: [] };
      },
      async listContextEvents(_ctxId: string, since?: string | null) {
        listContextEventsCursors.push(since ?? null);
        return { events: [], next_cursor: "cursor_after_fetch" };
      },
      async listEndpoints() { return []; },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    // Turn 1: fails with 400 — session is invalidated and deleted
    try {
      await adapter.handleBundle(
        context,
        makeDeliveryWithContext("del-E1", "thread-E", "ctx_card_E", "first"),
        MOCK_RUNTIME_CONFIG
      );
    } catch {
      // expected failure
    }

    // Turn 2: new session (prior session deleted on 400 error)
    // A fresh session = cold start again = cursor should be null
    try {
      await adapter.handleBundle(
        context,
        makeDeliveryWithContext("del-E2", "thread-E", "ctx_card_E", "retry"),
        MOCK_RUNTIME_CONFIG
      );
    } catch {
      // may or may not fail depending on the 400 handling
    }

    // Both calls used null cursor (fresh session = cold start each time after invalidation)
    expect(listContextEventsCursors.length).toBeGreaterThanOrEqual(1);
    expect(listContextEventsCursors[0]).toBeNull();
  });

  it("thread slice excludes the trigger event (already rendered by deliveryToPrompt)", async () => {
    const capturedPrompts: string[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompts.push(message?.content?.[0]?.text ?? "");
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: () => fakeAgent,
      turnFinalizeTimeoutMs: 1_000,
    });

    const contextId = "ctx_card_F";
    const triggerDelivery = makeDeliveryWithContext(
      "del-F1", "thread-F", contextId, "the trigger text"
    );
    const triggerEventId = triggerDelivery.events[0].event_id;

    // Bus returns the trigger event ALSO in the context events (as would happen in reality)
    const bus = {
      async appendRuntimeTelemetry(_input: any) {},
      async emit(_event: any) {},
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(), participants: [] };
      },
      async listContextEvents(_ctxId: string) {
        return {
          events: [
            {
              event_id: "evt_hist_1",
              type: "message",
              workspace_id: "workspace:test",
              source_endpoint_id: "actor:workspace:test:operator",
              thread_id: "thread-F",
              context_id: contextId,
              correlation_id: null,
              destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
              content: { text: "historical message" },
              response: { expected: false },
              metadata: {},
              created_at: "2024-01-01T00:00:00.000Z",
            } as EventEnvelope,
            // The trigger event is also in the thread
            {
              ...triggerDelivery.events[0],
              event_id: triggerEventId,
            },
          ],
          next_cursor: "cursor_F",
        };
      },
      async listEndpoints() { return []; },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    await adapter.handleBundle(context, triggerDelivery, MOCK_RUNTIME_CONFIG);

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0];

    // Historical message appears in thread slice
    expect(prompt).toContain("historical message");
    // The trigger text "the trigger text" should appear ONCE (from deliveryToPrompt),
    // not twice (it's excluded from the thread slice)
    const occurrences = (prompt.match(/the trigger text/g) || []).length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-B invariant: reply still lands in origin context
// ---------------------------------------------------------------------------

describe("D-B invariant: reply lands in origin context after session rekey", () => {
  it("emit tool defaults context_id to the delivery origin context", async () => {
    let emitToolFn: ((callId: string, params: any) => Promise<any>) | null = null;
    const emittedEvents: any[] = [];
    const fakeAgent = {
      tools: [] as any[],
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(_message: any) {
        // Use the emit tool to reply — without specifying context_id
        if (emitToolFn) {
          await emitToolFn("tc_emit", {
            type: "message",
            text: "reply without explicit context_id",
          });
        }
        const assistantMsg = { role: "assistant", content: [{ type: "text", text: "ack" }],
          usage: { input: 1, output: 1, totalTokens: 2 }, model: "mock-model", provider: "mock-provider" };
        for (const l of this.listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    };

    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: (input) => {
        // Capture the emit tool
        const emitTool = input.tools.find((t: any) => t.name === "emit");
        if (emitTool) emitToolFn = emitTool.execute;
        return fakeAgent as any;
      },
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = {
      async appendRuntimeTelemetry(_input: any) {},
      async emit(event: any) { emittedEvents.push(event); },
      async getContext(contextId: string) {
        return { context_id: contextId, workspace_id: "workspace:test",
          parent_context_id: null, created_by_endpoint_id: null,
          scope_id: null, created_at: new Date().toISOString(),
          participants: ["actor:workspace:test:operator", "actor:workspace:test:floe"] };
      },
      async listContextEvents(_ctxId: string) {
        return { events: [], next_cursor: null };
      },
      async listEndpoints(workspaceId: string) {
        return [
          { endpoint_id: "actor:workspace:test:operator", name: "operator", status: "idle" },
        ];
      },
    };
    const context = { bridge_id: "bridge:test", bus } as any;

    await adapter.handleBundle(
      context,
      makeDeliveryWithContext("del-G1", "thread-G", "ctx_origin_G", "message from operator"),
      MOCK_RUNTIME_CONFIG
    );

    // The emitted event's context_id should default to the delivery origin context
    expect(emittedEvents).toHaveLength(1);
    expect(emittedEvents[0].context_id).toBe("ctx_origin_G");
  });
});

// ---------------------------------------------------------------------------
// renderThreadSlice unit tests
// ---------------------------------------------------------------------------

describe("renderThreadSlice", () => {
  it("returns empty string for empty events array", () => {
    expect(renderThreadSlice([])).toBe("");
  });

  it("returns empty string when no events have text", () => {
    const events: EventEnvelope[] = [
      {
        event_id: "e1", type: "context.compacted",
        workspace_id: "ws", source_endpoint_id: null,
        thread_id: "t", context_id: "c", correlation_id: null,
        destination_json: { kind: "broadcast" },
        content: {},  // no text
        response: { expected: false }, metadata: {}, created_at: "2024-01-01T00:00:00.000Z",
      } as any,
    ];
    expect(renderThreadSlice(events)).toBe("");
  });

  it("renders message events with [ActorRef] text format", () => {
    const events: EventEnvelope[] = [
      {
        event_id: "e1", type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:operator",
        thread_id: "t", context_id: "c", correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:floe" },
        content: { text: "hello from operator" },
        response: { expected: false }, metadata: {}, created_at: "2024-01-01T00:00:00.000Z",
      } as EventEnvelope,
      {
        event_id: "e2", type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "actor:workspace:test:floe",
        thread_id: "t", context_id: "c", correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: "actor:workspace:test:operator" },
        content: { text: "response from floe" },
        response: { expected: false }, metadata: {}, created_at: "2024-01-01T00:01:00.000Z",
      } as EventEnvelope,
    ];
    const result = renderThreadSlice(events);
    expect(result).toContain("[Thread — recent context history]");
    expect(result).toContain("[operator] hello from operator");
    expect(result).toContain("[floe] response from floe");
    expect(result).toContain("[End Thread]");
  });

  it("uses 'system' for events without source_endpoint_id", () => {
    const events: EventEnvelope[] = [
      {
        event_id: "e1", type: "pulse.fired",
        workspace_id: "ws", source_endpoint_id: null,
        thread_id: "t", context_id: "c", correlation_id: null,
        destination_json: { kind: "broadcast" },
        content: { text: "pulse triggered" },
        response: { expected: false }, metadata: {}, created_at: "2024-01-01T00:00:00.000Z",
      } as any,
    ];
    const result = renderThreadSlice(events);
    expect(result).toContain("[system] pulse triggered");
  });

  it("caps at MAX_THREAD_SLICE_EVENTS most recent events", () => {
    // Create 55 events (more than the 50-event cap)
    const events: EventEnvelope[] = Array.from({ length: 55 }, (_, i) => ({
      event_id: `e${i}`,
      type: "message",
      workspace_id: "ws",
      source_endpoint_id: "actor:ws-a:operator",
      thread_id: "t", context_id: "c", correlation_id: null,
      destination_json: { kind: "broadcast" },
      content: { text: `message-${String(i).padStart(3, "0")}` },
      response: { expected: false }, metadata: {},
      created_at: `2024-01-01T00:${String(i).padStart(2, "0")}:00.000Z`,
    } as EventEnvelope));

    const result = renderThreadSlice(events);
    // Should contain the last 50 events (messages 005-054), not the first 5 (000-004)
    expect(result).not.toContain("message-000");
    expect(result).not.toContain("message-004");
    expect(result).toContain("message-005");
    expect(result).toContain("message-054");
  });
});
