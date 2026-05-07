import { describe, expect, it } from "vitest";
import { PiAgentCoreAdapter } from "./pi-agent-core-adapter.js";
import type { DeliveryBundle } from "../bus-client.js";

type FakeEvent = {
  type: string;
  message?: any;
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
    await this.emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }]
      }
    });
    await this.emit({
      type: "turn_end",
      message: {
        role: "assistant",
        usage: { input: 1, output: 1, totalTokens: 2 },
        model: "mock-model",
        provider: "mock-provider"
      }
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
    const deliveryBundleText = "Floe delivery bundle del_abc123\n- [message] from endpoint:workspace:test:user:operator thread=thread-1: hi, tell me about yourself\nRespond naturally to the delivered events.";
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
    endpoint_id: "endpoint:workspace:test:agent:floe",
    workspace_id: "workspace:test",
    trigger_event_id: `evt:${deliveryId}`,
    delivered_at: new Date().toISOString(),
    events: [
      {
        event_id: `evt:${deliveryId}`,
        type: "message",
        workspace_id: "workspace:test",
        source_endpoint_id: "endpoint:workspace:test:user:operator",
        thread_id: threadId,
        correlation_id: null,
        destination_json: {
          kind: "endpoint",
          endpoint_id: "endpoint:workspace:test:agent:floe"
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
            destination: "endpoint:workspace:test:user:operator",
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

    // Delivery context should be rendered in the prompt
    expect(capturedPrompt).toContain("[Delivery Context]");
    expect(capturedPrompt).toContain("endpoint:workspace:test:user:operator"); // source + reply
    expect(capturedPrompt).toContain("thread-ctx-1"); // thread
    expect(capturedPrompt).toContain("reply_destination");
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
            { endpoint_id: "endpoint:workspace:test:agent:floe", name: "Floe", actor_type: "agent", status: "idle" },
            { endpoint_id: "endpoint:workspace:test:user:operator", name: "Operator", actor_type: "human", status: "active" }
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
      { endpoint_id: "endpoint:ws-a:agent:floe", name: "Floe", actor_type: "agent", status: "idle" },
      { endpoint_id: "endpoint:ws-a:user:operator", name: "Operator", actor_type: "human", status: "active" }
    ];
    const workspaceBEndpoints = [
      { endpoint_id: "endpoint:ws-b:agent:reviewer", name: "Reviewer", actor_type: "agent", status: "idle" }
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
      endpoint_id: "endpoint:ws-a:agent:floe",
      workspace_id: "workspace:a",
      trigger_event_id: "evt:scope-a",
      delivered_at: new Date().toISOString(),
      events: [{
        event_id: "evt:scope-a",
        type: "message",
        workspace_id: "workspace:a",
        source_endpoint_id: "endpoint:ws-a:user:operator",
        thread_id: "thread-scope",
        correlation_id: null,
        destination_json: { kind: "endpoint", endpoint_id: "endpoint:ws-a:agent:floe" },
        content: { text: "list endpoints", data: {} },
        response: { expected: false },
        metadata: {},
        created_at: new Date().toISOString()
      }]
    };

    await adapter.handleBundle(context, deliveryInA, { provider: "mock-provider", model: "mock-model", auth_profile: "test-profile" });

    expect(listEndpointsResult).not.toBeNull();
    const parsed = JSON.parse(listEndpointsResult.content[0].text);

    // Should only see workspace A endpoints (excluding self)
    expect(parsed).toHaveLength(1); // only operator (self excluded)
    expect(parsed[0].endpoint_id).toBe("endpoint:ws-a:user:operator");

    // Should NOT see workspace B endpoints
    const wsB = parsed.filter((ep: any) => ep.endpoint_id.includes("ws-b"));
    expect(wsB).toHaveLength(0);
  });
});
