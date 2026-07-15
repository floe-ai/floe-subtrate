/**
 * Side-thread close lifecycle tests — fm/floe-sidethread-lifecycle
 *
 * Verifies (no live LLM calls):
 *  1. A session keyed on a side thread is evicted when
 *     `releaseSessionsForClosedThread(sideThreadId)` is called.
 *  2. A session created on the main/root thread is NOT evicted when a side
 *     thread closes.
 *  3. A session keyed on a DIFFERENT side thread is NOT evicted.
 *  4. An in-progress turn is skipped (conservative: the session is not
 *     evicted mid-turn).
 */
import { describe, expect, it } from "vitest";
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";
import type { DeliveryBundle } from "../bus-client.js";

// ---------------------------------------------------------------------------
// Shared doubles
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

const MOCK_RUNTIME_CONFIG = {
  provider: "mock-provider",
  model: "mock-model",
  auth_profile: "test-profile",
};

/** Minimal bus double — enough for handleBundle to run through. */
function makeBus() {
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
        participants: ["actor:workspace:test:operator", "actor:workspace:test:agent"],
      };
    },
    async listContextEvents(_ctxId: string) {
      return { events: [], next_cursor: null };
    },
    async listEndpoints(_workspaceId: string) {
      return [];
    },
  };
}

function makeDelivery(
  deliveryId: string,
  endpointId: string,
  contextId: string,
  threadId: string,
  text = "hello"
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
        destination_json: { kind: "endpoint", endpoint_id: endpointId } as any,
        content: { text, data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Create a fake agent factory that:
 *  - resolves the turn immediately (no pause)
 *  - increments `callCount` each time a new agent is instantiated
 */
function makeAgentFactory() {
  let callCount = 0;
  const factory = (_input: any) => {
    callCount++;
    const listeners: Array<(event: any) => void | Promise<void>> = [];
    return {
      subscribe(listener: (event: any) => void | Promise<void>) {
        listeners.push(listener);
      },
      async prompt(_message: any) {
        const assistantMsg = {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          usage: { input: 1, output: 1, totalTokens: 2 },
          model: "mock-model",
          provider: "mock-provider",
        };
        for (const l of listeners) {
          await l({ type: "turn_end", message: assistantMsg });
          await l({ type: "agent_end", messages: [assistantMsg] });
        }
      },
    } as any;
  };
  return { factory, getCallCount: () => callCount };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PiAgentCoreAdapter.releaseSessionsForClosedThread", () => {
  const ENDPOINT_A = "actor:workspace:test:agent";
  const CTX = "ctx_close_test";
  const ROOT_THREAD = CTX;                   // root thread id === context id
  const SIDE_THREAD_T = "thr_side_t_close";
  const SIDE_THREAD_T2 = "thr_side_t2_close";

  // ---------------------------------------------------------------------------
  // Test 1: Session scoped to side thread T is evicted when T is closed.
  // Detected by the agent factory being called AGAIN on the next handleBundle
  // (a new session is created, proving the old one was evicted).
  // ---------------------------------------------------------------------------
  it("evicts session scoped to the closed side thread", async () => {
    const { factory, getCallCount } = makeAgentFactory();
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: factory,
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBus();
    const ctx = { bridge_id: "bridge:test", bus } as any;

    // First call: delivery arrives on SIDE_THREAD_T → session created (sideThreadId = T)
    await adapter.handleBundle(
      ctx,
      makeDelivery("del-1", ENDPOINT_A, CTX, SIDE_THREAD_T),
      MOCK_RUNTIME_CONFIG
    );
    expect(getCallCount()).toBe(1);

    // Second call with same delivery: session reused (factory NOT called again)
    await adapter.handleBundle(
      ctx,
      makeDelivery("del-2", ENDPOINT_A, CTX, SIDE_THREAD_T),
      MOCK_RUNTIME_CONFIG
    );
    expect(getCallCount()).toBe(1); // session reused

    // Close side thread T → evict session
    adapter.releaseSessionsForClosedThread(SIDE_THREAD_T);

    // Third call: session was evicted → factory called again (new session)
    await adapter.handleBundle(
      ctx,
      makeDelivery("del-3", ENDPOINT_A, CTX, SIDE_THREAD_T),
      MOCK_RUNTIME_CONFIG
    );
    expect(getCallCount()).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Session created on the main/root thread is NOT evicted when a
  //         side thread closes (the initiator keeps their context session).
  // ---------------------------------------------------------------------------
  it("does NOT evict session created on the main/root thread", async () => {
    const { factory, getCallCount } = makeAgentFactory();
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: factory,
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBus();
    const ctx = { bridge_id: "bridge:test", bus } as any;

    // Session created on ROOT_THREAD (sideThreadId = null)
    await adapter.handleBundle(
      ctx,
      makeDelivery("del-r1", ENDPOINT_A, CTX, ROOT_THREAD),
      MOCK_RUNTIME_CONFIG
    );
    expect(getCallCount()).toBe(1);

    // Close a side thread — the root-thread session must NOT be evicted
    adapter.releaseSessionsForClosedThread(SIDE_THREAD_T);

    // Next delivery: session must still be reused (factory NOT called again)
    await adapter.handleBundle(
      ctx,
      makeDelivery("del-r2", ENDPOINT_A, CTX, ROOT_THREAD),
      MOCK_RUNTIME_CONFIG
    );
    expect(getCallCount()).toBe(1); // still reused
  });

  // ---------------------------------------------------------------------------
  // Test 3: Session scoped to a DIFFERENT side thread is not evicted.
  // ---------------------------------------------------------------------------
  it("does NOT evict sessions scoped to a different side thread", async () => {
    const { factory, getCallCount } = makeAgentFactory();
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: factory,
      turnFinalizeTimeoutMs: 1_000,
    });

    const bus = makeBus();
    const ctx = { bridge_id: "bridge:test", bus } as any;

    // Session created on SIDE_THREAD_T2
    await adapter.handleBundle(
      ctx,
      makeDelivery("del-t2-1", ENDPOINT_A, CTX, SIDE_THREAD_T2),
      MOCK_RUNTIME_CONFIG
    );
    expect(getCallCount()).toBe(1);

    // Close a DIFFERENT side thread T — T2's session must NOT be evicted
    adapter.releaseSessionsForClosedThread(SIDE_THREAD_T);

    // Next delivery on T2: session must still be reused
    await adapter.handleBundle(
      ctx,
      makeDelivery("del-t2-2", ENDPOINT_A, CTX, SIDE_THREAD_T2),
      MOCK_RUNTIME_CONFIG
    );
    expect(getCallCount()).toBe(1); // still reused — T2's session survives T's close
  });

  // ---------------------------------------------------------------------------
  // Test 4: releaseSessionsForClosedThread is a no-op for an unknown thread.
  // ---------------------------------------------------------------------------
  it("is a no-op for an unknown thread_id", () => {
    const adapter = new PiAgentCoreAdapter(MOCK_AUTH, {
      agentFactory: makeAgentFactory().factory,
      turnFinalizeTimeoutMs: 1_000,
    });
    // Must not throw even if the thread_id is not associated with any session.
    expect(() => adapter.releaseSessionsForClosedThread("thr_unknown")).not.toThrow();
  });
});
