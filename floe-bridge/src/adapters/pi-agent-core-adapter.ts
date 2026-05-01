import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type { AgentRuntimeConfig, BridgeAuthRuntime, RuntimeAuthResolved } from "../auth.js";
import { resolveRuntimeAuth } from "../auth.js";
import type { DeliveryBundle } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";

type SessionState = {
  agent: Agent;
  initialized: boolean;
  provider: string;
  modelId: string;
};

export class PiAgentCoreAdapter implements RuntimeAdapter {
  readonly name = "pi-agent-core";
  private sessions = new Map<string, SessionState>();

  constructor(private readonly authRuntime: BridgeAuthRuntime) {}

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const resolved = await resolveRuntimeAuth(this.authRuntime, runtimeConfig);
    const session = this.getOrCreateSession(context, bundle, resolved);
    if (!session.initialized) {
      this.subscribeAgentEvents(context, bundle, session.agent);
      session.initialized = true;
    }

    if (resolved.usedEnvFallback) {
      await context.bus.appendRuntimeTelemetry({
        workspace_id: bundle.workspace_id,
        endpoint_id: bundle.endpoint_id,
        delivery_id: bundle.delivery_id,
        kind: "runtime_config",
        payload: {
          source: "env_fallback",
          provider: resolved.provider,
          model: resolved.modelId
        }
      });
    }

    const prompt = deliveryToPrompt(bundle);
    await session.agent.prompt({
      role: "user",
      timestamp: Date.now(),
      content: [{ type: "text", text: prompt }]
    } as any);
  }

  private getOrCreateSession(context: RuntimeContext, bundle: DeliveryBundle, resolved: RuntimeAuthResolved): SessionState {
    const key = bundle.endpoint_id;
    const existing = this.sessions.get(key);
    if (existing && existing.provider === resolved.provider && existing.modelId === resolved.model.id) return existing;

    const emitTool = this.createEmitTool(context, bundle);
    const agent = new Agent({
      initialState: {
        model: resolved.model,
        systemPrompt:
          "You are a Floe runtime agent. Use tool emit to publish messages/progress/responses to Floe bus. End turns normally.",
        tools: [emitTool]
      },
      getApiKey: async () => {
        const latest = await this.authRuntime.modelRegistry.getApiKeyForProvider(resolved.provider);
        if (!latest) throw new Error(`Provider '${resolved.provider}' is missing authentication. Run 'floe login'.`);
        return latest;
      }
    });

    const state: SessionState = {
      agent,
      initialized: false,
      provider: resolved.provider,
      modelId: resolved.model.id
    };
    this.sessions.set(key, state);
    return state;
  }

  private createEmitTool(context: RuntimeContext, bundle: DeliveryBundle): AgentTool {
    return {
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
