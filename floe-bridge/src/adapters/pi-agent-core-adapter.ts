import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { getGitHubCopilotBaseUrl } from "@mariozechner/pi-ai/oauth";
import type { AgentRuntimeConfig, BridgeAuthRuntime, RuntimeAuthResolved } from "../auth.js";
import { resolveRuntimeAuth } from "../auth.js";
import type { DeliveryBundle } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";

type AgentLike = {
  prompt(input: unknown): Promise<void>;
  subscribe(listener: (event: any) => void | Promise<void>): void;
};

type AgentFactoryInput = {
  model: RuntimeAuthResolved["model"];
  tools: AgentTool[];
  getApiKey: () => Promise<string>;
  systemPrompt: string;
};

type AgentFactory = (input: AgentFactoryInput) => AgentLike;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type RuntimeTurnContext = {
  runtime_turn_id: string;
  delivery_id: string;
  delivery_attempt_id: string;
  endpoint_id: string;
  workspace_id: string;
  thread_id: string;
  source_endpoint_id: string;
  correlation_id: string | null;
  started_at: string;
  trigger_event_id: string;
  reply_destination_endpoint_id: string;
  visible_output: string;
  last_visible_telemetry_text: string;
  finalized: boolean;
  completion: Deferred<void>;
};

type SessionState = {
  agent: AgentLike;
  initialized: boolean;
  provider: string;
  modelId: string;
  instructionsHash: string;
  context?: RuntimeContext;
  activeTurn?: RuntimeTurnContext;
};

export class PiAgentCoreAdapter implements RuntimeAdapter {
  readonly name = "pi-agent-core";
  private sessions = new Map<string, SessionState>();
  private readonly agentFactory: AgentFactory;
  private readonly turnFinalizeTimeoutMs: number;

  constructor(
    private readonly authRuntime: BridgeAuthRuntime,
    options?: {
      agentFactory?: AgentFactory;
      turnFinalizeTimeoutMs?: number;
    }
  ) {
    this.agentFactory = options?.agentFactory ?? createDefaultAgent;
    this.turnFinalizeTimeoutMs = options?.turnFinalizeTimeoutMs ?? 5_000;
  }

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const resolved = await resolveRuntimeAuth(this.authRuntime, runtimeConfig);
    const session = await this.getOrCreateSession(context, bundle, resolved, runtimeConfig);
    if (!session.initialized) {
      this.subscribeAgentEvents(session);
      session.initialized = true;
      console.log("[bridge] pi session created", {
        endpoint_id: bundle.endpoint_id,
        provider: resolved.provider,
        model: resolved.model.id
      });
    } else {
      console.log("[bridge] pi session reused", {
        endpoint_id: bundle.endpoint_id,
        provider: resolved.provider,
        model: resolved.model.id
      });
    }

    if (session.activeTurn && !session.activeTurn.finalized) {
      throw new Error(`Runtime turn already active for endpoint '${bundle.endpoint_id}'.`);
    }

    const turn = this.startTurn(bundle);
    session.activeTurn = turn;

    if (resolved.usedEnvFallback) {
      await this.appendTelemetry(context, turn, "runtime_config", {
        source: "env_fallback",
        provider: resolved.provider,
        model: resolved.modelId
      });
    }

    const prompt = deliveryToPrompt(bundle);
    console.log("[bridge] pi prompt injected", {
      delivery_id: bundle.delivery_id,
      runtime_turn_id: turn.runtime_turn_id,
      endpoint_id: bundle.endpoint_id
    });
    try {
      await session.agent.prompt({
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text: prompt }]
      } as any);
      await this.awaitTurnCompletion(context, session, turn);
    } catch (error) {
      if (session.activeTurn === turn) session.activeTurn = undefined;
      if (!turn.finalized) turn.completion.reject(error);
      throw error;
    }
  }

  private async getOrCreateSession(context: RuntimeContext, bundle: DeliveryBundle, resolved: RuntimeAuthResolved, runtimeConfig?: AgentRuntimeConfig): Promise<SessionState> {
    const key = bundle.endpoint_id;
    const rawInstructions = runtimeConfig?.instructions?.trim() ?? "";
    // Build the full system prompt: agent instructions + substrate guidance
    const systemPrompt = rawInstructions
      ? `${rawInstructions}\n\nUse emit only for explicit substrate operations (routing/progress/structured events). Normal replies are captured from your visible output.`
      : "You are a Floe runtime agent. Respond naturally. Use emit only for explicit substrate operations (routing/progress/structured events).";

    const instructionsHash = instructionHash(systemPrompt);

    const existing = this.sessions.get(key);
    if (existing && existing.provider === resolved.provider && existing.modelId === resolved.model.id && existing.instructionsHash === instructionsHash) {
      existing.context = context;
      return existing;
    }

    const state: SessionState = {
      agent: null as unknown as AgentLike,
      initialized: false,
      provider: resolved.provider,
      modelId: resolved.model.id,
      instructionsHash,
      context
    };

    // Patch github-copilot model baseUrl using the live token's proxy-ep field.
    // The static Pi registry hardcodes api.individual.githubcopilot.com, but enterprise
    // accounts have a different endpoint embedded in the token via proxy-ep.
    let model = resolved.model;
    if (model.provider === "github-copilot") {
      const apiKey = await this.authRuntime.modelRegistry.getApiKeyForProvider(resolved.provider);
      if (apiKey) {
        const patchedBaseUrl = getGitHubCopilotBaseUrl(apiKey);
        if (patchedBaseUrl !== model.baseUrl) {
          console.log("[bridge] pi patched github-copilot baseUrl", {
            from: model.baseUrl,
            to: patchedBaseUrl,
            endpoint_id: bundle.endpoint_id
          });
          model = { ...model, baseUrl: patchedBaseUrl };
        }
      }
    }

    console.log("[bridge] pi agent instructions loaded", {
      endpoint_id: bundle.endpoint_id,
      instructions_bytes: rawInstructions.length,
      instructions_hash: instructionsHash
    });

    const emitTool = this.createEmitTool(state);
    state.agent = this.agentFactory({
      model,
      tools: [emitTool],
      systemPrompt,
      getApiKey: async () => {
        const latest = await this.authRuntime.modelRegistry.getApiKeyForProvider(resolved.provider);
        if (!latest) throw new Error(`Provider '${resolved.provider}' is missing authentication. Run 'floe login'.`);
        return latest;
      }
    });

    this.sessions.set(key, state);
    return state;
  }

  private createEmitTool(session: SessionState): AgentTool {
    return {
      name: "emit",
      label: "Emit Floe Event",
      description: "Emit a Floe substrate event for routing/progress/structured operations.",
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
      execute: async (_toolCallId, params: any) => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context is available for emit.");

        const targetEndpoint = params?.destination?.endpoint_id ?? turn.reply_destination_endpoint_id;
        await context.bus.emit({
          type: String(params?.type ?? "message"),
          workspace_id: turn.workspace_id,
          source_endpoint_id: turn.endpoint_id,
          destination: {
            kind: "endpoint",
            endpoint_id: String(targetEndpoint)
          },
          thread_id: turn.thread_id,
          correlation_id: params?.correlation_id ?? turn.correlation_id,
          content: {
            text: String(params?.text ?? ""),
            data: {
              origin: "pi_emit_tool",
              runtime_turn_id: turn.runtime_turn_id,
              delivery_id: turn.delivery_id,
              delivery_attempt_id: turn.delivery_attempt_id
            }
          },
          response: {
            expected: !!params?.response_expected
          },
          metadata: {
            runtime: "pi-agent-core",
            origin: "pi_emit_tool",
            runtime_turn_id: turn.runtime_turn_id,
            delivery_id: turn.delivery_id,
            delivery_attempt_id: turn.delivery_attempt_id
          }
        });
        return {
          content: [{ type: "text", text: "emit accepted" }],
          details: { ok: true }
        };
      }
    };
  }

  private subscribeAgentEvents(session: SessionState): void {
    session.agent.subscribe(async (event) => {
      const turn = session.activeTurn;
      const context = session.context;
      if (!turn || !context) return;

      try {
        if ((event.type === "message_update" || event.type === "message_end") && event.message?.role === "assistant") {
          const text = extractText((event as any).message);
          if (text) {
            turn.visible_output = text;
            if (text !== turn.last_visible_telemetry_text) {
              turn.last_visible_telemetry_text = text;
              console.log("[bridge] pi visible_output observed", {
                runtime_turn_id: turn.runtime_turn_id,
                delivery_id: turn.delivery_id,
                text_length: text.length,
                event_type: event.type
              });
              await this.appendTelemetry(context, turn, "visible_output", { text });
            }
          } else if (event.type === "message_end") {
            const msg = (event as any).message;
            console.log("[bridge] pi message_end no text extracted", {
              runtime_turn_id: turn.runtime_turn_id,
              role: msg?.role,
              content_types: Array.isArray(msg?.content) ? msg.content.map((c: any) => c?.type) : "(no content array)",
              stop_reason: msg?.stopReason ?? msg?.stop_reason
            });
          }
        }

        if (event.type === "tool_execution_start") {
          await this.appendTelemetry(context, turn, "BeforeToolUse", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            args: event.args
          });
        }

        if (event.type === "tool_execution_end") {
          await this.appendTelemetry(context, turn, event.isError ? "ToolUseFailed" : "AfterToolUse", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError
          });
        }

        if (event.type === "turn_end" && event.message?.role === "assistant") {
          await this.finalizeTurn(context, session, turn, event.message);
        }
      } catch (error) {
        if (session.activeTurn === turn) session.activeTurn = undefined;
        if (!turn.finalized) turn.completion.reject(error);
        console.error("[bridge] pi adapter event handling failed", error);
      }
    });
  }

  private startTurn(bundle: DeliveryBundle): RuntimeTurnContext {
    const trigger = bundle.events[0];
    const sourceEndpoint = trigger?.source_endpoint_id || `endpoint:${bundle.workspace_id}:user:operator`;
    const threadId = trigger?.thread_id || `thread:${bundle.workspace_id}:pi`;
    return {
      runtime_turn_id: `rt_${randomUUID()}`,
      delivery_id: bundle.delivery_id,
      delivery_attempt_id: `da_${randomUUID()}`,
      endpoint_id: bundle.endpoint_id,
      workspace_id: bundle.workspace_id,
      thread_id: threadId,
      source_endpoint_id: sourceEndpoint,
      correlation_id: trigger?.correlation_id ?? null,
      started_at: new Date().toISOString(),
      trigger_event_id: trigger?.event_id ?? `evt:${bundle.delivery_id}`,
      reply_destination_endpoint_id: sourceEndpoint,
      visible_output: "",
      last_visible_telemetry_text: "",
      finalized: false,
      completion: createDeferred<void>()
    };
  }

  private async awaitTurnCompletion(context: RuntimeContext, session: SessionState, turn: RuntimeTurnContext): Promise<void> {
    const completed = await Promise.race([
      turn.completion.promise.then(() => true),
      sleep(this.turnFinalizeTimeoutMs).then(() => false)
    ]);
    if (completed) return;
    console.log("[bridge] pi turn timeout, finalizing", {
      runtime_turn_id: turn.runtime_turn_id,
      delivery_id: turn.delivery_id,
      visible_output_length: turn.visible_output.length
    });
    if (session.activeTurn === turn && !turn.finalized) {
      await this.finalizeTurn(context, session, turn, null);
    }
    await turn.completion.promise;
  }

  private async finalizeTurn(
    context: RuntimeContext,
    session: SessionState,
    turn: RuntimeTurnContext,
    assistantMessage: any | null
  ): Promise<void> {
    if (turn.finalized) return;
    turn.finalized = true;

    try {
      const output = turn.visible_output.trim() || extractText(assistantMessage)?.trim() || "";
      if (output.length > 0) {
        console.log("[bridge] pi runtime_turn_output emitting", {
          runtime_turn_id: turn.runtime_turn_id,
          delivery_id: turn.delivery_id,
          output_length: output.length
        });
        await context.bus.emit({
          type: "message",
          workspace_id: turn.workspace_id,
          source_endpoint_id: turn.endpoint_id,
          destination: {
            kind: "endpoint",
            endpoint_id: turn.reply_destination_endpoint_id
          },
          thread_id: turn.thread_id,
          correlation_id: turn.correlation_id,
          content: {
            text: output,
            data: {
              origin: "runtime_turn_output",
              runtime_turn_id: turn.runtime_turn_id,
              delivery_id: turn.delivery_id,
              delivery_attempt_id: turn.delivery_attempt_id,
              trigger_event_id: turn.trigger_event_id
            }
          },
          response: {
            expected: false
          },
          metadata: {
            runtime: "pi-agent-core",
            origin: "runtime_turn_output",
            runtime_turn_id: turn.runtime_turn_id,
            delivery_id: turn.delivery_id,
            delivery_attempt_id: turn.delivery_attempt_id,
            thread_id: turn.thread_id,
            started_at: turn.started_at
          }
        });
      } else {
        const stopReason = assistantMessage?.stopReason ?? assistantMessage?.stop_reason ?? null;
        const errorMessage = assistantMessage?.errorMessage ?? null;
        console.log("[bridge] pi runtime_no_visible_output", {
          runtime_turn_id: turn.runtime_turn_id,
          delivery_id: turn.delivery_id,
          had_assistant_message: !!assistantMessage,
          assistant_content_types: assistantMessage && Array.isArray(assistantMessage.content)
            ? assistantMessage.content.map((c: any) => c?.type)
            : null,
          stop_reason: stopReason,
          error_message: errorMessage
        });
        if (stopReason === "error") {
          await this.appendTelemetry(context, turn, "runtime_error", {
            note: "Pi runtime returned an error assistant message.",
            stop_reason: stopReason,
            error_message: errorMessage,
            had_assistant_message: !!assistantMessage,
            assistant_content_types: assistantMessage && Array.isArray(assistantMessage.content)
              ? assistantMessage.content.map((c: any) => c?.type ?? typeof c)
              : null,
            assistant_content_items: assistantMessage && Array.isArray(assistantMessage.content)
              ? assistantMessage.content.length
              : null
          });
        } else {
          await this.appendTelemetry(context, turn, "runtime_no_visible_output", {
            note: "No assistant visible output was produced during this turn.",
            had_assistant_message: !!assistantMessage,
            assistant_content_types: assistantMessage && Array.isArray(assistantMessage.content)
              ? assistantMessage.content.map((c: any) => c?.type ?? typeof c)
              : null,
            assistant_content_items: assistantMessage && Array.isArray(assistantMessage.content)
              ? assistantMessage.content.length
              : null,
            stop_reason: stopReason
          });
        }
      }

      if (assistantMessage) {
        await this.appendTelemetry(context, turn, "usage", {
          usage: assistantMessage.usage ?? null,
          model: assistantMessage.model ?? null,
          provider: assistantMessage.provider ?? null,
          stop_reason: assistantMessage.stopReason ?? assistantMessage.stop_reason ?? null,
          error_message: assistantMessage.errorMessage ?? null
        });
      }

      turn.completion.resolve();
    } catch (error) {
      turn.completion.reject(error);
      throw error;
    } finally {
      if (session.activeTurn === turn) session.activeTurn = undefined;
    }
  }

  private async appendTelemetry(
    context: RuntimeContext,
    turn: RuntimeTurnContext,
    kind: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await context.bus.appendRuntimeTelemetry({
      workspace_id: turn.workspace_id,
      endpoint_id: turn.endpoint_id,
      delivery_id: turn.delivery_id,
      kind,
      payload: {
        runtime_turn_id: turn.runtime_turn_id,
        delivery_id: turn.delivery_id,
        delivery_attempt_id: turn.delivery_attempt_id,
        endpoint_id: turn.endpoint_id,
        thread_id: turn.thread_id,
        started_at: turn.started_at,
        ...payload
      }
    });
  }
}

function createDefaultAgent(input: AgentFactoryInput): AgentLike {
  return new Agent({
    initialState: {
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: input.tools
    },
    getApiKey: input.getApiKey
  });
}

function instructionHash(text: string): string {
  // FNV-1a 32-bit — cheap, no crypto import needed, good enough for cache key
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function deliveryToPrompt(bundle: DeliveryBundle): string {
  const lines = bundle.events.map((event) => {
    const text = typeof event.content?.text === "string" ? event.content.text : JSON.stringify(event.content ?? {});
    return `- [${event.type}] from ${event.source_endpoint_id} thread=${event.thread_id}: ${text}`;
  });
  return [
    `Floe delivery bundle ${bundle.delivery_id}`,
    lines.join("\n"),
    "Respond naturally to the user message.",
    "Use emit only for explicit substrate operations (routing/progress/structured events)."
  ].join("\n");
}

function extractText(message: any): string {
  if (!message?.content || !Array.isArray(message.content)) return "";
  return message.content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("");
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
