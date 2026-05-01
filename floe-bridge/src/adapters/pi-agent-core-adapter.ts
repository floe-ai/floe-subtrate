import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type, getEnvApiKey, getModel } from "@mariozechner/pi-ai";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";

type SessionState = {
  agent: Agent;
  initialized: boolean;
};

export class PiAgentCoreAdapter implements RuntimeAdapter {
  readonly name = "pi-agent-core";
  private sessions = new Map<string, SessionState>();

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle): Promise<void> {
    const session = this.getOrCreateSession(context, bundle);
    if (!session.initialized) {
      this.subscribeAgentEvents(context, bundle, session.agent);
      session.initialized = true;
    }

    const prompt = deliveryToPrompt(bundle);
    await session.agent.prompt({
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: prompt }]
    } as any);
  }

  private getOrCreateSession(context: RuntimeContext, bundle: DeliveryBundle): SessionState {
    const key = bundle.endpoint_id;
    const existing = this.sessions.get(key);
    if (existing) return existing;

    const provider = (process.env.FLOE_PI_PROVIDER ?? "openai") as any;
    const modelId = (process.env.FLOE_PI_MODEL ?? "openai/gpt-5-mini") as any;
    const model = getModel(provider, modelId);
    if (!model) throw new Error(`Pi model not found for provider=${provider} id=${modelId}`);

    const envApiKey = getEnvApiKey(provider);
    if (!envApiKey) {
      throw new Error(`No API key found for Pi provider '${provider}'. Set provider env key (e.g. OPENAI_API_KEY).`);
    }

    const emitTool: AgentTool = {
      name: "emit",
      label: "Emit Floe Event",
      description: "Emit a Floe event back to the bus.",
      parameters: Type.Object({
        type: Type.String(),
        destination: Type.Object({
          kind: Type.String({ default: "endpoint" }),
          endpoint_id: Type.Optional(Type.String())
        }),
        text: Type.String(),
        response_expected: Type.Optional(Type.Boolean()),
        correlation_id: Type.Optional(Type.String())
      }),
      async execute(_toolCallId, params: any) {
        const targetEndpoint = params?.destination?.endpoint_id ?? bundle.events[0]?.source_endpoint_id;
        await context.bus.emit({
          type: String(params?.type ?? "message"),
          workspace_id: bundle.workspace_id,
          source_endpoint_id: bundle.endpoint_id,
          destination: {
            kind: "endpoint",
            endpoint_id: String(targetEndpoint)
          },
          thread_id: bundle.events[0]?.thread_id ?? `thread:${bundle.workspace_id}:pi`,
          correlation_id: params?.correlation_id ?? bundle.events[0]?.correlation_id ?? null,
          content: {
            text: String(params?.text ?? ""),
            data: {
              via: "pi-emit-tool",
              delivery_id: bundle.delivery_id
            }
          },
          response: {
            expected: !!params?.response_expected
          },
          metadata: {
            runtime: "pi-agent-core"
          }
        });
        return {
          content: [{ type: "text", text: "emit accepted" }],
          details: { ok: true }
        };
      }
    };

    const agent = new Agent({
      initialState: {
        model,
        systemPrompt:
          "You are a Floe runtime agent. Use tool emit to publish messages/progress/responses to Floe bus. End turns normally.",
        tools: [emitTool]
      },
      getApiKey: () => envApiKey
    });

    const state: SessionState = { agent, initialized: false };
    this.sessions.set(key, state);
    return state;
  }

  private subscribeAgentEvents(context: RuntimeContext, bundle: DeliveryBundle, agent: Agent): void {
    agent.subscribe(async (event) => {
      if (event.type === "message_update" || event.type === "message_end") {
        const text = extractText((event as any).message);
        if (text) {
          await context.bus.appendRuntimeTelemetry({
            workspace_id: bundle.workspace_id,
            endpoint_id: bundle.endpoint_id,
            delivery_id: bundle.delivery_id,
            kind: "visible_output",
            payload: { text }
          });
        }
      }
      if (event.type === "tool_execution_start") {
        await context.bus.appendRuntimeTelemetry({
          workspace_id: bundle.workspace_id,
          endpoint_id: bundle.endpoint_id,
          delivery_id: bundle.delivery_id,
          kind: "BeforeToolUse",
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
          }
        });
      }
      if (event.type === "tool_execution_end") {
        await context.bus.appendRuntimeTelemetry({
          workspace_id: bundle.workspace_id,
          endpoint_id: bundle.endpoint_id,
          delivery_id: bundle.delivery_id,
          kind: event.isError ? "ToolUseFailed" : "AfterToolUse",
          payload: {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError
          }
        });
      }
      if (event.type === "turn_end" && event.message.role === "assistant") {
        await context.bus.appendRuntimeTelemetry({
          workspace_id: bundle.workspace_id,
          endpoint_id: bundle.endpoint_id,
          delivery_id: bundle.delivery_id,
          kind: "usage",
          payload: {
            usage: event.message.usage ?? null,
            model: event.message.model ?? null,
            provider: event.message.provider ?? null
          }
        });
      }
    });
  }
}

function deliveryToPrompt(bundle: DeliveryBundle): string {
  const lines = bundle.events.map((event) => {
    const text = typeof event.content?.text === "string" ? event.content.text : JSON.stringify(event.content ?? {});
    return `- [${event.type}] from ${event.source_endpoint_id} thread=${event.thread_id}: ${text}`;
  });
  return `Floe delivery bundle ${bundle.delivery_id}\n${lines.join("\n")}\nRespond via emit tool.`;
}

function extractText(message: any): string {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("");
}
