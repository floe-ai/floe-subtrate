import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { getGitHubCopilotBaseUrl } from "@mariozechner/pi-ai/oauth";
import type { AgentRuntimeConfig, BridgeAuthRuntime, RuntimeAuthResolved } from "../auth.js";
import { resolveRuntimeAuth } from "../auth.js";
import type { DeliveryBundle } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { HookPayload } from "../hooks.js";
import { buildSystemPrompt, renderDestinationContext, appendWorkLog, toNeutralRef, fromNeutralRef, toNeutralEndpoint } from "../runtime-core/index.js";
import type { NeutralEndpoint } from "../runtime-core/index.js";
import type { WorkLogEntry } from "../runtime-core/index.js";
import { createWorkspaceTools } from "../tools/index.js";
import type { ToolContext } from "../tools/index.js";
import { createPulseTools } from "../tools/pulse-tools.js";
import { createActorTools } from "../tools/actor-tools.js";

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
  context_id: string | null;
  current_context_participants: string[];
  visible_output: string;
  last_visible_telemetry_text: string;
  finalized: boolean;
  completion: Deferred<void>;
  tool_activity: Array<{ name: string; call_id?: string; summary?: string; is_error?: boolean; files_touched?: string[]; duration_ms?: number }>;
  emitted_events: Array<{ type: string; destination: string; text_preview: string; response_expected: boolean }>;
};

type SessionState = {
  agent: AgentLike;
  initialized: boolean;
  endpointId: string;
  workspaceId: string;
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
      // Fire SessionStart hook
      if (context.hooks?.hasHandlers("SessionStart")) {
        await context.hooks.fire("SessionStart", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          provider: resolved.provider,
          model_id: resolved.model.id,
          reason: "session_created"
        });
      }
    } else {
      console.log("[bridge] pi session reused", {
        endpoint_id: bundle.endpoint_id,
        provider: resolved.provider,
        model: resolved.model.id
      });
      // Fire SessionResume hook
      if (context.hooks?.hasHandlers("SessionResume")) {
        await context.hooks.fire("SessionResume", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          provider: resolved.provider,
          model_id: resolved.model.id,
          reason: "session_reused"
        });
      }
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

    // Fetch visible endpoints for inclusion in prompt context
    let visibleEndpoints: NeutralEndpoint[] = [];
    try {
      const eps = await context.bus.listEndpoints(bundle.workspace_id);
      console.log("[bridge] visible endpoints fetched", { count: eps.length, workspace_id: bundle.workspace_id, self: bundle.endpoint_id });
      visibleEndpoints = eps
        .filter((ep: any) => ep.endpoint_id !== bundle.endpoint_id)
        .map((ep: any) => toNeutralEndpoint({ endpoint_id: ep.endpoint_id, name: ep.name, status: ep.status }));
      console.log("[bridge] visible endpoints after filter", { count: visibleEndpoints.length });
    } catch (epErr) {
      console.error("[bridge] failed to fetch visible endpoints", epErr);
    }

    // Fetch current context participants if the trigger event belongs to a context.
    // Failure modes (network error, 404, malformed shape) are intentionally non-fatal:
    // the agent can still process the turn and the bus's resolver remains the
    // authority for participant-aware continue-vs-branch decisions. We log a warning
    // so the operator can see when the prompt was rendered with degraded context info.
    let currentContextParticipants: string[] = [];
    if (turn.context_id) {
      try {
        const ctx = await context.bus.getContext(turn.context_id);
        if (ctx && Array.isArray(ctx.participants)) {
          currentContextParticipants = ctx.participants.filter((p): p is string => typeof p === "string");
        } else if (ctx) {
          console.warn("[bridge] getContext returned unexpected shape; rendering empty participants", {
            context_id: turn.context_id
          });
        }
      } catch (ctxErr) {
        console.warn("[bridge] getContext failed; rendering empty participants", {
          context_id: turn.context_id,
          error: ctxErr instanceof Error ? ctxErr.message : String(ctxErr)
        });
      }
    }
    turn.current_context_participants = currentContextParticipants;

    const prompt = deliveryToPrompt(bundle, visibleEndpoints, currentContextParticipants);
    console.log("[bridge] pi prompt injected", {
      delivery_id: bundle.delivery_id,
      runtime_turn_id: turn.runtime_turn_id,
      endpoint_id: bundle.endpoint_id,
      prompt_length: prompt.length
    });
    try {
      // Fire BeforeTurn hook — collect injected context
      let injectedContext = "";
      if (context.hooks?.hasHandlers("BeforeTurn")) {
        const hookResults = await context.hooks.fire("BeforeTurn", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          thread_id: bundle.events[0]?.thread_id
        });
        injectedContext = renderHookInjections(hookResults);
        if (injectedContext) {
          await this.appendTelemetry(context, turn, "hook_injection", {
            hook: "BeforeTurn",
            injection_length: injectedContext.length,
            source_count: hookResults.filter(r => r.inject).length
          });
        }
      }

      // Fire Pulse hook when delivery contains pulse.fired events
      const pulseEvents = bundle.events.filter(e => e.type === "pulse.fired");
      if (pulseEvents.length > 0 && context.hooks?.hasHandlers("Pulse")) {
        for (const pulseEvent of pulseEvents) {
          await context.hooks.fire("Pulse", {
            endpoint_id: bundle.endpoint_id,
            workspace_id: bundle.workspace_id,
            delivery_id: bundle.delivery_id,
            trigger_event_id: bundle.trigger_event_id,
            pulse_id: (pulseEvent.content as any)?.pulse_id ?? (pulseEvent.metadata as any)?.pulse_id,
            event_id: pulseEvent.event_id,
            thread_id: pulseEvent.thread_id,
            content: pulseEvent.content
          });
        }
      }

      const finalPrompt = injectedContext ? `${injectedContext}\n\n${prompt}` : prompt;

      await session.agent.prompt({
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text: finalPrompt }]
      } as any);
      await this.awaitTurnCompletion(context, session, turn);

      // Fire TurnEnd hook
      if (context.hooks?.hasHandlers("TurnEnd")) {
        await context.hooks.fire("TurnEnd", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          visible_output: turn.visible_output,
          tool_activity: turn.tool_activity,
          emitted_events: turn.emitted_events
        });
      }

      // Write work log after successful turn completion
      this.writeWorkLog(context, bundle, turn, "completed");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error("[bridge] pi runtime error", {
        delivery_id: bundle.delivery_id,
        runtime_turn_id: turn.runtime_turn_id,
        endpoint_id: bundle.endpoint_id,
        error: errorMessage
      });
      // Surface runtime error as telemetry
      await this.appendTelemetry(context, turn, "runtime_error", {
        error_message: errorMessage,
        provider: resolved.provider,
        model: resolved.model.id
      });

      // Fire Error hook
      if (context.hooks?.hasHandlers("Error")) {
        await context.hooks.fire("Error", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          error: errorMessage
        });
      }

      if (session.activeTurn === turn) session.activeTurn = undefined;
      if (!turn.finalized) {
        turn.finalized = true;
        turn.completion.resolve();
      }
      // Write work log for failed turn
      this.writeWorkLog(context, bundle, turn, "error");
      // Invalidate session on request body errors (likely state corruption)
      if (errorMessage.includes("invalid_request_body") || errorMessage.includes("400")) {
        console.log("[bridge] pi session invalidated due to error", { endpoint_id: bundle.endpoint_id });
        this.sessions.delete(bundle.endpoint_id);
      }
      return; // Don't re-throw; error is surfaced via telemetry
    }
  }

  async dispose(reason: HookPayload<"SessionEnd">["reason"] = "bridge_shutdown"): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await this.fireSessionEnd(session, { reason });
    }
  }

  private async getOrCreateSession(context: RuntimeContext, bundle: DeliveryBundle, resolved: RuntimeAuthResolved, runtimeConfig?: AgentRuntimeConfig): Promise<SessionState> {
    const key = bundle.endpoint_id;
    const rawInstructions = runtimeConfig?.instructions?.trim() ?? "";
    // Build the full system prompt: agent instructions + Floe substrate guidance
    const systemPrompt = buildSystemPrompt(rawInstructions);

    const instructionsHash = instructionHash(systemPrompt);

    const existing = this.sessions.get(key);
    if (existing && existing.provider === resolved.provider && existing.modelId === resolved.model.id && existing.instructionsHash === instructionsHash) {
      existing.context = context;
      return existing;
    }
    if (existing) {
      await this.fireSessionEnd(existing, {
        reason: "session_replaced",
        delivery_id: bundle.delivery_id,
        trigger_event_id: bundle.trigger_event_id,
        next_session: {
          provider: resolved.provider,
          model_id: resolved.model.id
        }
      });
    }

    const state: SessionState = {
      agent: null as unknown as AgentLike,
      initialized: false,
      endpointId: bundle.endpoint_id,
      workspaceId: bundle.workspace_id,
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
    const listEndpointsTool = this.createListEndpointsTool(state);
    const resolveDestinationTool = this.createResolveDestinationTool(state);

    // Create workspace tools when workspace locator is available
    const workspaceTools = context.workspace_locator
      ? createWorkspaceTools({
          workspaceRoot: context.workspace_locator,
          getActiveTurn: () => state.activeTurn,
        } satisfies ToolContext)
      : [];

    const pulseTools = createPulseTools(context.bus, bundle.workspace_id, context.workspace_locator);
    const actorTools = createActorTools(context.bus, bundle.workspace_id, context.workspace_locator);

    // Collect extension tools
    const extensionTools = (context.extensions ?? []).flatMap(ext => ext.tools);

    state.agent = this.agentFactory({
      model,
      tools: [emitTool, listEndpointsTool, resolveDestinationTool, ...pulseTools, ...actorTools, ...extensionTools, ...workspaceTools],
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

  private async fireSessionEnd(
    session: SessionState,
    details: Omit<HookPayload<"SessionEnd">, "endpoint_id" | "workspace_id" | "previous_session">
  ): Promise<void> {
    if (!session.context?.hooks?.hasHandlers("SessionEnd")) return;
    await session.context.hooks.fire("SessionEnd", {
      ...details,
      endpoint_id: session.endpointId,
      workspace_id: session.workspaceId,
      previous_session: {
        provider: session.provider,
        model_id: session.modelId
      }
    });
  }

  private createEmitTool(session: SessionState): AgentTool {
    return {
      name: "emit",
      label: "Emit Floe Event",
      description: "Publish a canonical event to the Floe event bus. This is the ONLY way to communicate with other actors. Nothing you produce (text, tool results, reasoning) is visible to anyone unless you use this tool. Always call emit with type 'message' to reply to a delivered message. Use neutral actor refs from list_endpoints (e.g. 'operator', 'floe') as destination, or omit destination to reply to the source.",
      parameters: Type.Object({
        type: Type.String(),
        destination: Type.Optional(Type.String({ description: "Target actor's neutral ref (as returned by list_endpoints, e.g. 'operator' or 'floe'). Omit to reply to the delivery source." })),
        text: Type.String(),
        response_expected: Type.Optional(Type.Boolean()),
        correlation_id: Type.Optional(Type.String()),
        context_id: Type.Optional(Type.String({ description: "Optional context_id to emit into. If the destination is already a participant of the current delivery context, omit this to continue that context. Pass an explicit context_id only to intentionally land in a specific existing context. Omitting context_id when emitting to a non-participant opens a new context." }))
      }),
      execute: async (_toolCallId, params: any) => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context is available for emit.");

        let targetEndpoint = params?.destination ?? turn.reply_destination_endpoint_id;
        // Translate a neutral ref to a full actor id before forwarding to the bus.
        // If already a full actor: id, pass through directly.
        if (targetEndpoint && !String(targetEndpoint).startsWith("actor:")) {
          const ref = String(targetEndpoint);
          const endpoints = await context.bus.listEndpoints(turn.workspace_id);
          const resolved = fromNeutralRef(ref, endpoints);
          if (!resolved) {
            return {
              content: [{ type: "text", text: `emit: destination '${ref}' did not resolve to a known actor in this workspace. Use list_endpoints to discover valid refs.` }],
              details: { ok: false, error: "unknown_destination", ref }
            };
          }
          targetEndpoint = resolved;
        }
        await context.bus.emit({
          type: String(params?.type ?? "message"),
          workspace_id: turn.workspace_id,
          source_endpoint_id: turn.endpoint_id,
          destination: {
            kind: "endpoint",
            endpoint_id: String(targetEndpoint)
          },
          thread_id: turn.thread_id,
          context_id: params?.context_id ?? null,
          current_delivery_context_id: turn.context_id,
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
        // Track emitted event for work log
        turn.emitted_events.push({
          type: String(params?.type ?? "message"),
          destination: String(targetEndpoint),
          text_preview: String(params?.text ?? "").slice(0, 120),
          response_expected: !!params?.response_expected
        });
        return {
          content: [{ type: "text", text: "emit accepted" }],
          details: { ok: true }
        };
      }
    };
  }

  private createListEndpointsTool(session: SessionState): AgentTool {
    // TODO: Future visibility should be: workspace scope + subscriptions + permissions
    // For V0, workspace-scoped visibility is sufficient (no cross-workspace exposure).
    return {
      name: "list_endpoints",
      label: "List Visible Actors",
      description: "List actors visible/addressable in the current workspace. Returns a list of { ref, name, status }. Use the 'ref' value as the destination on emit. Results are only visible to you — you MUST use emit to share this information with other actors.",
      parameters: Type.Object({}),
      execute: async () => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context for list_endpoints.");

        // Scoped to current workspace only — no cross-workspace endpoints exposed
        const endpoints = await context.bus.listEndpoints(turn.workspace_id);
        const visible: NeutralEndpoint[] = endpoints
          .filter((ep: any) => ep.endpoint_id !== turn.endpoint_id)
          .map((ep: any) => toNeutralEndpoint({
            endpoint_id: ep.endpoint_id,
            name: ep.name,
            status: ep.status,
          }));

        return {
          content: [
            { type: "text", text: JSON.stringify(visible, null, 2) },
            { type: "text", text: "Remember: call emit with type 'message' to send this information to the requesting actor." }
          ],
          details: { ok: true, count: visible.length }
        };
      }
    };
  }

  private createResolveDestinationTool(session: SessionState): AgentTool {
    return {
      name: "resolve_destination",
      label: "Resolve Destination",
      description: "Resolve a neutral actor ref (like 'operator' or 'floe') to a known actor in this workspace. Use list_endpoints to discover refs.",
      parameters: Type.Object({
        ref: Type.String({ description: "Neutral actor ref (e.g. 'operator', 'floe')" })
      }),
      execute: async (_toolCallId, params: any) => {
        const turn = session.activeTurn;
        const context = session.context;
        if (!turn || !context) throw new Error("No active runtime turn context.");
        const ref = String(params.ref);
        const endpoints = await context.bus.listEndpoints(turn.workspace_id);
        const matched = endpoints.find((ep: any) => toNeutralRef(ep.endpoint_id) === ref || ep.endpoint_id === ref);
        if (!matched) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ref, found: false }, null, 2) }],
            details: { ok: false, ref, found: false }
          };
        }
        const neutral = toNeutralEndpoint({
          endpoint_id: matched.endpoint_id,
          name: matched.name,
          status: matched.status,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(neutral, null, 2) }],
          details: { ok: true, ...neutral }
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
          // Fire BeforeToolUse hook
          if (context.hooks?.hasHandlers("BeforeToolUse")) {
            await context.hooks.fire("BeforeToolUse", {
              endpoint_id: turn.endpoint_id,
              workspace_id: turn.workspace_id,
              delivery_id: turn.delivery_id,
              trigger_event_id: turn.trigger_event_id,
              toolCallId: event.toolCallId,
              toolName: event.toolName
            });
          }
          // Track tool activity for work log
          turn.tool_activity.push({
            name: event.toolName,
            call_id: event.toolCallId
          });
        }

        if (event.type === "tool_execution_end") {
          // Collect enriched data from tool activity (set by workspace tools during execute)
          const toolEntry = turn.tool_activity.find((t) => t.call_id === event.toolCallId);
          await this.appendTelemetry(context, turn, event.isError ? "ToolUseFailed" : "AfterToolUse", {
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            isError: event.isError,
            summary: toolEntry?.summary,
            files_touched: toolEntry?.files_touched,
            duration_ms: toolEntry?.duration_ms,
          });
          // Update tool activity with error status
          if (toolEntry) toolEntry.is_error = event.isError;
          // Fire AfterToolUse or ToolUseFailed hook
          const hookName = event.isError ? "ToolUseFailed" as const : "AfterToolUse" as const;
          if (context.hooks?.hasHandlers(hookName)) {
            await context.hooks.fire(hookName, {
              endpoint_id: turn.endpoint_id,
              workspace_id: turn.workspace_id,
              delivery_id: turn.delivery_id,
              trigger_event_id: turn.trigger_event_id,
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              isError: event.isError
            });
          }
        }

        // agent_end is the correct finalization signal — it fires ONCE after all
        // tool-call loops complete. turn_end fires after each inner iteration, so
        // finalizing on turn_end would cut the agent short when it uses multiple tools.
        if (event.type === "agent_end") {
          const messages = (event as any).messages as any[] | undefined;
          const lastAssistant = messages
            ?.filter((m: any) => m.role === "assistant")
            .pop() ?? null;
          console.log("[bridge] pi agent_end finalizing", {
            runtime_turn_id: turn.runtime_turn_id,
            last_assistant_stop_reason: lastAssistant?.stopReason,
            last_assistant_has_text: !!extractText(lastAssistant),
            visible_output_len: turn.visible_output.length
          });
          await this.finalizeTurn(context, session, turn, lastAssistant);
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
    const sourceEndpoint = trigger?.source_endpoint_id || `actor:${bundle.workspace_id}:operator`;
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
      context_id: trigger?.context_id ?? null,
      current_context_participants: [],
      visible_output: "",
      last_visible_telemetry_text: "",
      finalized: false,
      completion: createDeferred<void>(),
      tool_activity: [],
      emitted_events: []
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
        // Visible output is work-log/trace only — NOT auto-emitted as a message.
        // Communication happens only through explicit emit calls by the agent.
        // See docs/substrate-semantics.md §6.
        console.log("[bridge] visible_output recorded as work log (not emitted)", {
          runtime_turn_id: turn.runtime_turn_id,
          delivery_id: turn.delivery_id,
          output_length: output.length
        });
        await this.appendTelemetry(context, turn, "visible_output_worklog", {
          text: output,
          note: "Runtime visible output recorded as work log. Not emitted as message."
        });
      } else {
        const stopReason = assistantMessage?.stopReason ?? assistantMessage?.stop_reason ?? null;
        const errorMessage = assistantMessage?.errorMessage ?? null;
        console.log("[bridge] no visible output", {
          runtime_turn_id: turn.runtime_turn_id,
          delivery_id: turn.delivery_id,
          had_assistant_message: !!assistantMessage,
          stop_reason: stopReason
        });
        if (stopReason === "error") {
          await this.appendTelemetry(context, turn, "runtime_error", {
            note: "Pi runtime returned an error.",
            stop_reason: stopReason,
            error_message: errorMessage
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
        trigger_event_id: turn.trigger_event_id,
        context_id: turn.context_id,
        ...payload
      }
    });
  }

  private writeWorkLog(
    context: RuntimeContext,
    bundle: DeliveryBundle,
    turn: RuntimeTurnContext,
    outcome: string
  ): void {
    if (!context.workspace_locator || !context.agent_id) return;
    const entry: WorkLogEntry = {
      runtime_turn_id: turn.runtime_turn_id,
      agent_id: context.agent_id,
      started_at: turn.started_at,
      ended_at: new Date().toISOString(),
      trigger_type: bundle.events?.[0]?.type ?? "unknown",
      thread_id: turn.thread_id,
      delivery_id: turn.delivery_id,
      delivered_events: (bundle.events ?? []).map(e => ({
        event_id: e.event_id ?? "unknown",
        type: e.type ?? "unknown",
        source_endpoint_id: e.source_endpoint_id ?? "unknown",
        text: ((e.content as Record<string, unknown>)?.text as string ?? JSON.stringify(e.content ?? "")).slice(0, 200)
      })),
      visible_output: turn.visible_output || null,
      tool_activity: turn.tool_activity ?? [],
      emitted_events: turn.emitted_events ?? [],
      lifecycle_outcome: outcome
    };
    try {
      appendWorkLog(context.workspace_locator, entry);
    } catch (err) {
      console.error("[bridge] work-log write failed", { agent_id: context.agent_id, error: String(err) });
    }
  }
}

function createDefaultAgent(input: AgentFactoryInput): AgentLike {
  return new Agent({
    initialState: {
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: input.tools
    },
    getApiKey: input.getApiKey,
    onPayload: (payload: any, model: any) => {
      // Log request structure (no content/tokens) for diagnostics
      const inputItems = Array.isArray(payload?.input) ? payload.input : [];
      const roles = inputItems.map((m: any) => m?.role ?? m?.type ?? "unknown");
      console.log("[bridge] pi request payload", {
        model_id: model?.id,
        provider: model?.provider,
        api: model?.api,
        input_items: inputItems.length,
        roles: roles.slice(0, 20),
        has_thinking: !!payload?.thinking,
        has_tools: Array.isArray(payload?.tools) && payload.tools.length > 0,
        tool_count: Array.isArray(payload?.tools) ? payload.tools.length : 0
      });
      return payload;
    },
    onResponse: (response: any, model: any) => {
      console.log("[bridge] pi response received", {
        status: response?.status,
        model_id: model?.id,
        provider: model?.provider
      });
    }
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

/**
 * Render hook injection results into a labelled context block.
 *
 * Each injection is bounded to MAX_INJECTION_CHARS per source.
 * Total injection is bounded to MAX_TOTAL_INJECTION_CHARS.
 * Injections are ordered deterministically by their position in the results array.
 */
const MAX_INJECTION_CHARS = 4000;
const MAX_TOTAL_INJECTION_CHARS = 16000;

export function renderHookInjections(results: Array<{ inject?: Record<string, unknown> }>): string {
  const injections = results
    .filter((r): r is { inject: Record<string, unknown> } => r.inject != null)
    .map(r => r.inject);

  if (injections.length === 0) return "";

  const lines: string[] = ["[Injected Context — extension-provided, not a message]"];
  let totalChars = 0;

  for (const injection of injections) {
    const source = typeof injection.source === "string" ? injection.source : "extension";
    const content = typeof injection.content === "string"
      ? injection.content
      : JSON.stringify(injection, null, 2);

    // Bound per-source
    const bounded = content.length > MAX_INJECTION_CHARS
      ? content.slice(0, MAX_INJECTION_CHARS) + `\n... (truncated from ${content.length} chars)`
      : content;

    // Check total budget
    if (totalChars + bounded.length > MAX_TOTAL_INJECTION_CHARS) {
      lines.push(`\n[injection truncated — total limit reached]`);
      break;
    }

    lines.push(`\n--- from: ${source} ---`);
    lines.push(bounded);
    totalChars += bounded.length;
  }

  lines.push("\n[End Injected Context]");
  return lines.join("\n");
}

function deliveryToPrompt(
  bundle: DeliveryBundle,
  visibleEndpoints: NeutralEndpoint[] = [],
  currentContextParticipants: string[] = []
): string {
  // Render destination context so the agent knows source/reply/thread without hard-coded IDs
  const trigger = bundle.events[0];
  const sourceEndpoint = trigger?.source_endpoint_id || `actor:${bundle.workspace_id}:operator`;
  const threadId = trigger?.thread_id || `thread:${bundle.workspace_id}:default`;
  const correlationId = trigger?.correlation_id ?? null;
  const currentContextId = trigger?.context_id ?? null;

  const responseExpected = bundle.events.some((event) =>
    event.response?.expected === true ||
    (event.type === "message" && !!event.source_endpoint_id && toNeutralRef(event.source_endpoint_id) === "operator")
  );

  const contextBlock = renderDestinationContext({
    source_endpoint_id: sourceEndpoint,
    reply_destination_endpoint_id: sourceEndpoint,
    thread_id: threadId,
    correlation_id: correlationId,
    response_expected: responseExpected,
    current_context_id: currentContextId,
    current_context_participants: currentContextParticipants,
  });

  // Include visible endpoints in delivery context — neutral refs only
  let endpointsBlock = "";
  if (visibleEndpoints.length > 0) {
    const epLines = visibleEndpoints.map(ep => `  - ${ep.ref} (${ep.name}, ${ep.status})`);
    endpointsBlock = `\n[Visible Endpoints]\n${epLines.join("\n")}`;
  }

  // Render delivered events
  const eventLines = bundle.events.map((event) => {
    const text = typeof event.content?.text === "string" ? event.content.text : JSON.stringify(event.content ?? {});
    if (event.type === "message") return text;
    return `[${event.type}] ${text}`;
  }).filter((t) => t.length > 0);

  const eventsBlock = eventLines.join("\n\n");
  return `${contextBlock}${endpointsBlock}\n\n${eventsBlock}`;
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
