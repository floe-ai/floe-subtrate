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
  it("attributes telemetry and runtime_turn_output messages to the correct delivery context", async () => {
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

    const telemetryDel1 = telemetryCalls.filter((item) => item.delivery_id === "del-1");
    const telemetryDel2 = telemetryCalls.filter((item) => item.delivery_id === "del-2");
    const visibleDel1 = telemetryDel1.find((item) => item.kind === "visible_output");
    const visibleDel2 = telemetryDel2.find((item) => item.kind === "visible_output");
    const usageDel1 = telemetryDel1.find((item) => item.kind === "usage");
    const usageDel2 = telemetryDel2.find((item) => item.kind === "usage");

    expect(visibleDel1?.payload?.text).toContain("First deterministic reply.");
    expect(visibleDel2?.payload?.text).toContain("Second deterministic reply.");
    expect(visibleDel1?.payload?.text).not.toContain("Second deterministic reply.");
    expect(visibleDel2?.payload?.text).not.toContain("First deterministic reply.");
    expect(usageDel1?.payload?.model).toBe("mock-model");
    expect(usageDel2?.payload?.provider).toBe("mock-provider");
    expect(usageDel1?.payload?.runtime_turn_id).toBeTypeOf("string");
    expect(usageDel2?.payload?.delivery_attempt_id).toBeTypeOf("string");
    expect(usageDel1?.payload?.thread_id).toBe("thread-1");
    expect(usageDel2?.payload?.thread_id).toBe("thread-2");

    const runtimeOutputEvents = emittedEvents.filter((event) => event.metadata?.origin === "runtime_turn_output");
    expect(runtimeOutputEvents).toHaveLength(2);
    expect(runtimeOutputEvents[0].metadata.delivery_id).toBe("del-1");
    expect(runtimeOutputEvents[0].thread_id).toBe("thread-1");
    expect(runtimeOutputEvents[0].content.text).toContain("First deterministic reply.");
    expect(runtimeOutputEvents[1].metadata.delivery_id).toBe("del-2");
    expect(runtimeOutputEvents[1].thread_id).toBe("thread-2");
    expect(runtimeOutputEvents[1].content.text).toContain("Second deterministic reply.");
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
