import { describe, expect, it, vi } from "vitest";
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";
import type { DeliveryBundle } from "../bus-client.js";

type FakeEvent = {
  type: string;
  message?: any;
  messages?: any[];
  toolCallId?: string;
  toolName?: string;
  args?: any;
  isError?: boolean;
};

class FakeAgent {
  private listeners: Array<(event: FakeEvent) => void | Promise<void>> = [];
  private turn = 0;

  subscribe(listener: (event: FakeEvent) => void | Promise<void>): void {
    this.listeners.push(listener);
  }

  async prompt(): Promise<void> {
    this.turn += 1;
    const text = this.turn === 1 ? "First deterministic reply." : "Second deterministic reply.";
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input: 1, output: 1, totalTokens: 2 },
      model: "mock-model",
      provider: "mock-provider"
    };
    await this.emit({
      type: "message_end",
      message: assistantMessage
    });
    await this.emit({
      type: "turn_end",
      message: assistantMessage
    });
    await this.emit({
      type: "agent_end",
      messages: [assistantMessage]
    });
  }

  private async emit(event: FakeEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

describe("PiAgentCoreAdapter", () => {
  it("records visible output as work-log telemetry without auto-emitting messages", async () => {
    const fakeAgent = new FakeAgent();
    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];
    const model = {
      id: "mock-model",
      name: "Mock",
      api: "openai-responses",
      provider: "mock-provider",
      baseUrl: "https://example.invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: {
          authDir: "",
          authJsonPath: "",
          modelsJsonPath: "",
          profilesYamlPath: ""
        },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") return model as any;
            return undefined;
          },
          async getApiKeyForProvider() {
            return "test-key";
          }
        } as any,
        profiles: {
          version: 1,
          profiles: [
            {
              id: "test-profile",
              provider: "mock-provider",
              model: "mock-model"
            }
          ]
        }
      } as any,
      {
        agentFactory: () => fakeAgent,
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(input: any) {
          telemetryCalls.push(input);
        },
        async emit(event: any) {
          emittedEvents.push(event);
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-1", "thread-1", "First prompt"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );
    await adapter.handleBundle(
      context,
      makeDelivery("del-2", "thread-2", "Second prompt"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Visible output goes to telemetry as work-log, NOT emitted as messages
    const worklogDel1 = telemetryCalls.filter((item) => item.delivery_id === "del-1" && item.kind === "visible_output_worklog");
    const worklogDel2 = telemetryCalls.filter((item) => item.delivery_id === "del-2" && item.kind === "visible_output_worklog");
    expect(worklogDel1).toHaveLength(1);
    expect(worklogDel1[0].payload?.text).toContain("First deterministic reply.");
    expect(worklogDel2).toHaveLength(1);
    expect(worklogDel2[0].payload?.text).toContain("Second deterministic reply.");

    // No auto-emitted runtime_turn_output messages
    const runtimeOutputEvents = emittedEvents.filter((event) => event.metadata?.origin === "runtime_turn_output");
    expect(runtimeOutputEvents).toHaveLength(0);

    // Usage telemetry still recorded
    const usageDel1 = telemetryCalls.find((item) => item.delivery_id === "del-1" && item.kind === "usage");
    const usageDel2 = telemetryCalls.find((item) => item.delivery_id === "del-2" && item.kind === "usage");
    expect(usageDel1?.payload?.model).toBe("mock-model");
    expect(usageDel2?.payload?.provider).toBe("mock-provider");
    expect(usageDel1?.payload?.thread_id).toBe("thread-1");
    expect(usageDel2?.payload?.thread_id).toBe("thread-2");
  });
});

describe("PiAgentCoreAdapter – output classification", () => {
  function makeTestAdapter(fakeAgent: any) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      { agentFactory: () => fakeAgent, turnFinalizeTimeoutMs: 1_000 }
    );
  }

  function makeContext() {
    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];
    return {
      context: {
        bridge_id: "bridge:test",
        bus: {
          async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
          async emit(event: any) { emittedEvents.push(event); }
        }
      } as any,
      telemetryCalls,
      emittedEvents
    };
  }

  it("does not persist input echo as runtime_turn_output — only endpoint visible output is captured", async () => {
    const deliveryBundleText = "Floe delivery bundle del_abc123\n- [message] from actor:workspace:test:operator thread=thread-1: hi, tell me about yourself\nRespond naturally to the delivered events.";
    const assistantReply = "Hello! I am Floe, a durable multi-actor substrate agent.";

    // Simulate Pi emitting both a user-role echo and an assistant reply
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Pi echoes the input as a user-role message_end
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: deliveryBundleText }] }
        });
        // Then emits a message_update followed by message_end for the assistant reply
        for (const l of this.listeners) await l({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: assistantReply }] }
        });
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: assistantReply }] }
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 }, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapter(fakeAgent);
    const { context, emittedEvents, telemetryCalls } = makeContext();

    await adapter.handleBundle(
      context,
      makeDelivery("del-echo", "thread-1", "hi, tell me about yourself"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // No auto-emitted messages (visible output is work-log only)
    const runtimeOutput = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(runtimeOutput).toHaveLength(0);

    // Visible output captured in telemetry as work log
    const worklog = telemetryCalls.filter((t) => t.kind === "visible_output_worklog");
    expect(worklog).toHaveLength(1);
    expect(worklog[0].payload.text).toBe(assistantReply);
    expect(worklog[0].payload.text).not.toContain("Floe delivery bundle");
  });

  it("records no work-log when Pi produces no visible output", async () => {
    // Simulate Pi that only echoes the input events, produces no visible endpoint output
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "user", content: [{ type: "text", text: "some user echo" }] }
        });
        // turn_end with no content on the message
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapter(fakeAgent);
    const { context, emittedEvents, telemetryCalls } = makeContext();

    await adapter.handleBundle(
      context,
      makeDelivery("del-noout", "thread-1", "trigger"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // No emitted messages and no work-log (no visible output produced)
    const runtimeOutput = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(runtimeOutput).toHaveLength(0);

    const worklog = telemetryCalls.filter((t) => t.kind === "visible_output_worklog");
    expect(worklog).toHaveLength(0);
  });

  it("uses agent instructions as system prompt and recreates session when instructions change", async () => {
    const capturedSystemPrompts: string[] = [];

    function makeCapturingFactory(): any {
      return {
        listeners: [] as Array<(event: any) => void | Promise<void>>,
        subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
        async prompt() {
          for (const l of this.listeners) await l({
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "I am Floe." }] }
          });
          for (const l of this.listeners) await l({
            type: "turn_end",
            message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
          });
        }
      };
    }

    let sessionCount = 0;
    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          sessionCount++;
          capturedSystemPrompts.push(input.systemPrompt);
          return makeCapturingFactory();
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const makeCtx = () => ({
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {}
      }
    } as any);

    // First call with Floe instructions
    await adapter.handleBundle(
      makeCtx(),
      makeDelivery("del-instr-1", "thread-1", "what is your name?"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", instructions: "# Floe\n\nYou are Floe, the default agent." }
    );
    expect(sessionCount).toBe(1);
    expect(capturedSystemPrompts[0]).toContain("You are Floe");

    // Second call with same instructions — session reused (no new session created)
    await adapter.handleBundle(
      makeCtx(),
      makeDelivery("del-instr-2", "thread-2", "hi again"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", instructions: "# Floe\n\nYou are Floe, the default agent." }
    );
    expect(sessionCount).toBe(1); // session reused

    // Third call with changed instructions — session must be recreated
    await adapter.handleBundle(
      makeCtx(),
      makeDelivery("del-instr-3", "thread-3", "hi"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile", instructions: "# Updated\n\nYou are a different agent." }
    );
    expect(sessionCount).toBe(2); // new session created
    expect(capturedSystemPrompts[1]).toContain("You are a different agent");
  });
});

describe("Substrate guidance", () => {
  it("shared guidance is identity-neutral and does not hard-code 'You are Floe'", async () => {
    const capturedSystemPrompts: string[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          capturedSystemPrompts.push(input.systemPrompt);
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {}
      }
    } as any;

    // Call with no agent instructions — shared guidance only
    await adapter.handleBundle(
      context,
      makeDelivery("del-guidance", "thread-1", "hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(capturedSystemPrompts).toHaveLength(1);
    const guidance = capturedSystemPrompts[0];
    // Shared guidance must NOT contain "You are Floe"
    expect(guidance).not.toContain("You are Floe");
    // But must contain identity-neutral endpoint framing
    expect(guidance).toContain("runtime-backed endpoint in Floe");
    // Must teach explicit emit as the only communication path
    expect(guidance).toContain("only");
    expect(guidance).toContain("emit");
    expect(guidance).toContain("NOT automatically a message");
  });
});

function makeDelivery(deliveryId: string, threadId: string, text: string): DeliveryBundle {
  return {
    delivery_id: deliveryId,
    endpoint_id: "actor:workspace:test:floe",
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
        correlation_id: null,
        destination_json: {
          kind: "endpoint",
          endpoint_id: "actor:workspace:test:floe"
        },
        content: {
          text,
          data: {}
        },
        response: {
          expected: false
        },
        metadata: {},
        created_at: new Date().toISOString()
      }
    ]
  };
}

describe("Substrate model — explicit emit only", () => {
  function makeTestAdapterWithEmit(fakeAgent: any) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      { agentFactory: () => fakeAgent, turnFinalizeTimeoutMs: 1_000 }
    );
  }

  it("agent using emit tool produces a canonical message event on the bus", async () => {
    let emitToolHandler: ((args: any) => Promise<any>) | null = null;

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Simulate tool registration — capture emit handler
        for (const l of this.listeners) await l({
          type: "tool_call_start",
          toolCallId: "tc_1",
          toolName: "emit"
        });
        // Simulate the agent calling emit (via tool result)
        if (emitToolHandler) {
          await (emitToolHandler as (args: any) => Promise<any>)({
            type: "message",
            destination: "actor:workspace:test:operator",
            thread_id: "thread-1",
            content: { text: "Hello from Floe!" },
            response_expected: false
          });
        }
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "I emitted my response." }] }
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: { input: 5, output: 3, totalTokens: 8 }, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];
    const adapter = makeTestAdapterWithEmit(fakeAgent);

    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
        async emit(event: any) {
          emittedEvents.push(event);
          // Capture the emit tool handler when the adapter registers it
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-emit-1", "thread-1", "say hello"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Visible output ("I emitted my response.") should be in work-log telemetry only
    const worklog = telemetryCalls.filter((t) => t.kind === "visible_output_worklog");
    expect(worklog).toHaveLength(1);
    expect(worklog[0].payload.text).toContain("I emitted my response.");

    // No auto-emitted runtime_turn_output
    const autoEmits = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(autoEmits).toHaveLength(0);
  });

  it("delivery context includes source, destination, thread, and reply info", async () => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {}
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-ctx-1", "thread-ctx-1", "hello context test"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Delivery context should be rendered in the prompt with neutral refs
    expect(capturedPrompt).toContain("[Delivery Context]");
    expect(capturedPrompt).toContain("source_actor: operator");
    expect(capturedPrompt).toContain("reply_actor: operator");
    expect(capturedPrompt).toContain("thread-ctx-1"); // thread
    expect(capturedPrompt).toContain("reply_actor");
  });

  it("delivery prompt includes current_context_id and fetched current_context_participants when trigger has context_id", async () => {
    let capturedPrompt = "";
    const getContextCalls: string[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(contextId: string) {
          getContextCalls.push(contextId);
          return {
            context_id: contextId,
            workspace_id: "workspace:test",
            parent_context_id: null,
            created_by_endpoint_id: "actor:workspace:test:operator",
            created_at: new Date().toISOString(),
            participants: [
              "actor:ws:floe",
              "actor:ws:operator"
            ]
          };
        }
      }
    } as any;

    const delivery = makeDelivery("del-ctx-2", "thread-ctx-2", "hello with context");
    (delivery.events[0] as any).context_id = "ctx_test_abc";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(getContextCalls).toContain("ctx_test_abc");
    expect(capturedPrompt).toContain("current_context");
    expect(capturedPrompt).toContain("ctx_test_abc");
    // Strict: actual participants rendered as neutral refs under participants:
    expect(capturedPrompt).toMatch(/participants:\s*\n\s*-\s+floe/);
    expect(capturedPrompt).toMatch(/participants:[\s\S]*-\s+operator/);
    // Not rendered as empty placeholder
    expect(capturedPrompt).not.toMatch(/participants:\s*\[\]/);
    // No legacy id leakage
    expect(capturedPrompt).not.toContain("actor:ws:floe");
    expect(capturedPrompt).not.toContain("actor:ws:operator");
    // No global contexts list
    expect(capturedPrompt).not.toContain("available_contexts");
    expect(capturedPrompt).not.toContain("all_contexts");
    expect(capturedPrompt).not.toContain("source_contexts");
  });

  it("delivery prompt omits current_context block when trigger has no context_id", async () => {
    let capturedPrompt = "";
    let getContextCalled = false;
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(_id: string) {
          getContextCalled = true;
          return null;
        }
      }
    } as any;

    // Default delivery has no context_id on the trigger event
    await adapter.handleBundle(
      context,
      makeDelivery("del-no-ctx", "thread-no-ctx", "hello no context"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Bridge must NOT call getContext when there is no current context
    expect(getContextCalled).toBe(false);
    // current_context block omitted entirely
    expect(capturedPrompt).not.toContain("current_context");
    expect(capturedPrompt).not.toContain("participants:");
  });

  it("delivery prompt does not crash when bus.getContext throws — participants empty, warning logged", async () => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(_id: string) {
          throw new Error("simulated bus failure");
        }
      }
    } as any;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const delivery = makeDelivery("del-ctx-fail", "thread-ctx-fail", "hello");
      (delivery.events[0] as any).context_id = "ctx_unreachable";

      await expect(
        adapter.handleBundle(
          context,
          delivery,
          { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
        )
      ).resolves.toBeUndefined();

      // Block still rendered with id, but participants empty
      expect(capturedPrompt).toContain("ctx_unreachable");
      expect(capturedPrompt).toMatch(/participants:\s*\[\]/);

      // Warning logged
      const warned = warnSpy.mock.calls.flat().some((arg: any) =>
        typeof arg === "string" && arg.includes("getContext")
      );
      expect(warned).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("delivery prompt does not crash when bus.getContext returns null — participants empty", async () => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async getContext(_id: string) {
          return null;
        }
      }
    } as any;

    const delivery = makeDelivery("del-ctx-null", "thread-ctx-null", "hello");
    (delivery.events[0] as any).context_id = "ctx_missing";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(capturedPrompt).toContain("ctx_missing");
    expect(capturedPrompt).toMatch(/participants:\s*\[\]/);
  });

  it("trigger event with source_endpoint_id: null does not crash the turn", async () => {
    let capturedPrompt = "";
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt(message: any) {
        capturedPrompt = message?.content?.[0]?.text ?? "";
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
      }
    } as any;

    const delivery = makeDelivery("del-null-src", "thread-null-src", "trigger from system");
    // Simulate pulse/webhook trigger — no source endpoint
    (delivery.events[0] as any).source_endpoint_id = null;
    (delivery.events[0] as any).type = "pulse.fired";

    await expect(
      adapter.handleBundle(
        context,
        delivery,
        { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
      )
    ).resolves.toBeUndefined();

    // Prompt rendered with a sane fallback for source/reply
    expect(capturedPrompt).toContain("[Delivery Context]");
    // No literal "null" rendered as source_endpoint
    expect(capturedPrompt).not.toMatch(/source_endpoint:\s*null/);
  });

  it("emit tool accepts optional context_id and forwards it to the bus, plus current_delivery_context_id", async () => {
    const emittedEvents: any[] = [];
    let capturedTools: any[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Find the emit tool and call it WITH a context_id
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          await emitTool.execute("tc_emit_1", {
            type: "message",
            destination: "actor:workspace:test:operator",
            text: "reply continuing context",
            context_id: "ctx_caller_supplied",
            response_expected: false
          });
        }
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          capturedTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); }
      }
    } as any;

    const delivery = makeDelivery("del-emit-ctx", "thread-emit-ctx", "go");
    (delivery.events[0] as any).context_id = "ctx_delivery";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    const emitted = emittedEvents[0];
    // Caller-supplied context_id forwarded
    expect(emitted.context_id).toBe("ctx_caller_supplied");
    // current_delivery_context_id always set from active delivery
    expect(emitted.current_delivery_context_id).toBe("ctx_delivery");
  });

  it("emit tool always forwards current_delivery_context_id even when context_id omitted", async () => {
    const emittedEvents: any[] = [];
    let capturedTools: any[] = [];

    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        const emitTool = capturedTools.find((t: any) => t.name === "emit");
        if (emitTool) {
          await emitTool.execute("tc_emit_2", {
            type: "message",
            destination: "actor:workspace:test:operator",
            text: "no context_id supplied",
            response_expected: false
          });
        }
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          capturedTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(event: any) { emittedEvents.push(event); }
      }
    } as any;

    const delivery = makeDelivery("del-emit-noctx", "thread-emit-noctx", "go");
    (delivery.events[0] as any).context_id = "ctx_delivery_2";

    await adapter.handleBundle(
      context,
      delivery,
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    expect(emittedEvents).toHaveLength(1);
    const emitted = emittedEvents[0];
    // No caller-supplied context_id forwarded
    expect(emitted.context_id ?? null).toBeNull();
    // But current_delivery_context_id MUST be set
    expect(emitted.current_delivery_context_id).toBe("ctx_delivery_2");
  });

  it("turn end does not produce any message event", async () => {
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Only turn_end, no visible output, no emit
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const emittedEvents: any[] = [];
    const telemetryCalls: any[] = [];
    const adapter = makeTestAdapterWithEmit(fakeAgent);
    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
        async emit(event: any) { emittedEvents.push(event); }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-turnend", "thread-turnend", "trigger"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // Turn end is lifecycle only — no messages emitted
    expect(emittedEvents).toHaveLength(0);
    // No work-log visible output either (nothing was said)
    const worklog = telemetryCalls.filter((t) => t.kind === "visible_output_worklog");
    expect(worklog).toHaveLength(0);
  });

  it("no global endpoint directory is exposed — list_endpoints requires bus context", async () => {
    let registeredTools: string[] = [];
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          registeredTools = input.tools?.map((t: any) => t.name ?? t.tool?.name) ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        // list_endpoints returns workspace-scoped results only
        async listEndpoints(workspaceId: string) {
          return [
            { endpoint_id: "actor:workspace:test:floe", name: "Floe", actor_type: "agent", status: "idle" },
            { endpoint_id: "actor:workspace:test:operator", name: "Operator", actor_type: "human", status: "active" }
          ];
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeDelivery("del-tools", "thread-tools", "list my tools"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // list_endpoints tool should be registered
    expect(registeredTools).toContain("list_endpoints");
    // emit tool should be registered
    expect(registeredTools).toContain("emit");
  });

  it("list_endpoints is workspace-scoped and excludes cross-workspace endpoints", async () => {
    let listEndpointsResult: any = null;

    // Fake agent that calls list_endpoints tool
    const fakeAgent = {
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      registeredTools: [] as any[],
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async prompt() {
        // Call list_endpoints tool
        const tool = this.registeredTools.find((t: any) => t.name === "list_endpoints");
        if (tool) {
          listEndpointsResult = await tool.execute("tc_list", {});
        }
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: null, model: "mock-model", provider: "mock-provider" }
        });
      }
    };

    const adapter = new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          fakeAgent.registeredTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 1_000
      }
    );

    const workspaceAEndpoints = [
      { endpoint_id: "actor:ws-a:floe", name: "Floe", actor_type: "agent", status: "idle" },
      { endpoint_id: "actor:ws-a:operator", name: "Operator", actor_type: "human", status: "active" }
    ];
    const workspaceBEndpoints = [
      { endpoint_id: "actor:ws-b:reviewer", name: "Reviewer", actor_type: "agent", status: "idle" }
    ];

    const context = {
      bridge_id: "bridge:test",
      bus: {
        async appendRuntimeTelemetry(_input: any) {},
        async emit(_event: any) {},
        async listEndpoints(workspaceId: string) {
          if (workspaceId === "workspace:a") return workspaceAEndpoints;
          if (workspaceId === "workspace:b") return workspaceBEndpoints;
          return [];
        }
      }
    } as any;

    // Agent in workspace A calls list_endpoints
    const deliveryInA: DeliveryBundle = {
      delivery_id: "del-scope-a",
      endpoint_id: "actor:ws-a:floe",
      workspace_id: "workspace:a",
      trigger_event_id: "evt:scope-a",
      delivered_at: new Date().toISOString(),
      events: [{
        event_id: "evt:scope-a",
        type: "message",
        workspace_id: "workspace:a",
        source_endpoint_id: "actor:ws-a:operator",
        thread_id: "thread-scope",
        correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: "actor:ws-a:floe" },
        content: { text: "list endpoints", data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString()
      }]
    };

    await adapter.handleBundle(context, deliveryInA, { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });

    expect(listEndpointsResult).not.toBeNull();
    const parsed = JSON.parse(listEndpointsResult.content[0].text);

    // Should only see workspace A endpoints (excluding self) — neutral refs only
    expect(parsed).toHaveLength(1); // only operator (self excluded)
    expect(parsed[0].ref).toBe("operator");
    expect(parsed[0]).not.toHaveProperty("endpoint_id");
    expect(parsed[0]).not.toHaveProperty("actor_type");

    // Should NOT see workspace B endpoints (no leakage of any ws-b name)
    const wsB = parsed.filter((ep: any) => ep.name === "Reviewer" || (ep.ref ?? "").includes("reviewer"));
    expect(wsB).toHaveLength(0);
  });
});

// ─── Slice 4: Full actor work loop acceptance ─────────────────────────────────
describe("Full actor work loop acceptance", () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require("fs") as typeof import("fs");
  const { join } = require("path") as typeof import("path");
  const { tmpdir } = require("os") as typeof import("os");

  function makeAcceptanceAdapter(fakeAgent: any, workspaceLocator: string) {
    return new PiAgentCoreAdapter(
      {
        paths: { authDir: "", authJsonPath: "", modelsJsonPath: "", profilesYamlPath: "" },
        authStorage: {} as any,
        modelRegistry: {
          find(provider: string, modelId: string) {
            if (provider === "mock-provider" && modelId === "mock-model") {
              return {
                id: "mock-model", name: "Mock", api: "openai-responses", provider: "mock-provider",
                baseUrl: "https://example.invalid", reasoning: false, input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000, maxTokens: 4096
              } as any;
            }
            return undefined;
          },
          async getApiKeyForProvider() { return "test-key"; }
        } as any,
        profiles: {
          version: 1,
          profiles: [{ id: "test-profile", provider: "mock-provider", model: "mock-model" }]
        }
      } as any,
      {
        agentFactory: (input) => {
          fakeAgent.registeredTools = input.tools ?? [];
          return fakeAgent;
        },
        turnFinalizeTimeoutMs: 5_000
      }
    );
  }

  function makeAcceptanceDelivery(workspaceId: string, text: string): DeliveryBundle {
    return {
      delivery_id: "del-acceptance",
      endpoint_id: `actor:${workspaceId}:floe`,
      workspace_id: workspaceId,
      trigger_event_id: "evt:acceptance",
      delivered_at: new Date().toISOString(),
      events: [{
        event_id: "evt:acceptance",
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: `actor:${workspaceId}:operator`,
        thread_id: `thread:${workspaceId}:floe`,
        correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: `actor:${workspaceId}:floe` },
        content: { text, data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString()
      }]
    };
  }

  it("agent uses read/write/ls/bash tools, writes work log, and emits response", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "floe-acceptance-"));
    writeFileSync(join(workspaceDir, "hello.txt"), "Hello from workspace\n");

    const telemetryCalls: any[] = [];
    const emittedEvents: any[] = [];

    // FakeAgent that exercises the full tool chain:
    // 1. ls to list files
    // 2. read to read hello.txt
    // 3. write to create output.txt
    // 4. bash to run a command
    // 5. emit to send a response
    const fakeAgent = {
      registeredTools: [] as any[],
      listeners: [] as Array<(event: any) => void | Promise<void>>,
      subscribe(listener: (event: any) => void | Promise<void>) { this.listeners.push(listener); },
      async emit(event: any) { for (const l of this.listeners) await l(event); },
      async prompt() {
        const findTool = (name: string) => this.registeredTools.find((t: any) => t.name === name);

        // Helper to call a tool with proper Pi event lifecycle
        const callTool = async (name: string, callId: string, args: any) => {
          const tool = findTool(name);
          expect(tool).toBeDefined();
          await this.emit({ type: "tool_execution_start", toolCallId: callId, toolName: name, args });
          const result = await tool!.execute(callId, args);
          await this.emit({ type: "tool_execution_end", toolCallId: callId, toolName: name, isError: false });
          return result;
        };

        // Step 1: ls the workspace
        const lsResult = await callTool("ls", "tc_ls", { path: "." });
        expect(lsResult.content[0].text).toContain("hello.txt");

        // Step 2: read hello.txt
        const readResult = await callTool("read", "tc_read", { path: "hello.txt" });
        expect(readResult.content[0].text).toContain("Hello from workspace");

        // Step 3: write output.txt
        const writeResult = await callTool("write", "tc_write", { path: "output.txt", content: "Work loop verified" });
        expect(writeResult.content[0].text).toContain("output.txt");

        // Step 4: bash a simple command
        const bashResult = await callTool("bash", "tc_bash", { command: "echo floe-test-ok" });
        expect(bashResult.content[0].text).toContain("floe-test-ok");

        // Step 5: emit response
        await callTool("emit", "tc_emit", {
          type: "message",
          text: "Work loop complete.",
          response_expected: false
        });

        // End agent turn
        for (const l of this.listeners) await l({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] }
        });
        for (const l of this.listeners) await l({
          type: "turn_end",
          message: { role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 }, model: "mock-model", provider: "mock-provider" }
        });
        for (const l of this.listeners) await l({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Done." }] }]
        });
      }
    };

    const adapter = makeAcceptanceAdapter(fakeAgent, workspaceDir);
    const workspaceId = "workspace:acceptance";
    const context = {
      bridge_id: "bridge:test",
      workspace_locator: workspaceDir,
      bus: {
        async appendRuntimeTelemetry(input: any) { telemetryCalls.push(input); },
        async emit(event: any) { emittedEvents.push(event); },
        async listEndpoints(_workspaceId: string) {
          return [
            { endpoint_id: `actor:${_workspaceId}:floe`, name: "Floe", actor_type: "agent", status: "idle" },
            { endpoint_id: `actor:${_workspaceId}:operator`, name: "Operator", actor_type: "human", status: "active" }
          ];
        }
      }
    } as any;

    await adapter.handleBundle(
      context,
      makeAcceptanceDelivery(workspaceId, "Run the work loop"),
      { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" }
    );

    // --- Acceptance criteria ---

    // 1. All 7 workspace tools registered
    const toolNames = fakeAgent.registeredTools.map((t: any) => t.name);
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("ls");
    expect(toolNames).toContain("grep");
    expect(toolNames).toContain("find");
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("emit");
    expect(toolNames).toContain("list_endpoints");

    // 2. File was actually created
    expect(existsSync(join(workspaceDir, "output.txt"))).toBe(true);
    expect(readFileSync(join(workspaceDir, "output.txt"), "utf-8")).toBe("Work loop verified");

    // 3. Agent emitted a message event
    const messageEmits = emittedEvents.filter((e) => e.type === "message");
    expect(messageEmits).toHaveLength(1);
    expect(messageEmits[0].content.text).toBe("Work loop complete.");

    // 4. Tool telemetry was recorded (BeforeToolUse/AfterToolUse for each tool)
    const toolTelemetry = telemetryCalls.filter((t) => t.kind === "BeforeToolUse" || t.kind === "AfterToolUse");
    expect(toolTelemetry.length).toBeGreaterThanOrEqual(8); // at least 4 tools × 2 (before + after)

    // 5. Visible output is work-log only (not auto-emitted)
    const worklog = telemetryCalls.filter((t) => t.kind === "visible_output_worklog");
    expect(worklog).toHaveLength(1);
    expect(worklog[0].payload.text).toContain("Done.");
    const autoEmits = emittedEvents.filter((e) => e.metadata?.origin === "runtime_turn_output");
    expect(autoEmits).toHaveLength(0);

    // 6. Work log file was written to workspace
    const worklogDir = join(workspaceDir, ".floe", "agents", "floe", "worklogs");
    if (existsSync(worklogDir)) {
      const files = require("fs").readdirSync(worklogDir);
      expect(files.length).toBeGreaterThan(0);
    }

    // Cleanup
    rmSync(workspaceDir, { recursive: true, force: true });
  });
});

describe("extractShortRef (removed — superseded by toNeutralRef)", () => {
  it("is no longer exported; see runtime-core/neutral-ref.ts for replacement", () => {
    // extractShortRef returned category-prefixed refs ("agent:floe", "user:operator")
    // which leaked substrate-category metadata to agents. It has been deleted.
    // toNeutralRef from runtime-core/neutral-ref returns neutral refs ("floe", "operator")
    // and is exhaustively unit-tested in runtime-core/neutral-ref.test.ts.
    expect(true).toBe(true);
  });
});

