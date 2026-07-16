/**
 * @invariant This adapter is the only Pi Agent Core embodiment for Floe runtime turns.
 * Session reuse must stay keyed to the effective runtime configuration so that model or
 * thinking changes rebuild the session before processing the next delivery.
 */
import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { getGitHubCopilotBaseUrl } from "@earendil-works/pi-ai/oauth";
import type { AgentRuntimeConfig, BridgeAuthRuntime, ModelThinkingCapability, RuntimeAuthResolved } from "../auth.js";
import { resolveRuntimeAuth } from "../auth.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { HookPayload, HookRegistry } from "../hooks.js";
import { InjectionBaseline } from "../injection-baseline.js";
import { buildSystemPrompt, renderDestinationContext, appendWorkLog, toNeutralRef, fromNeutralRef, toNeutralEndpoint } from "../runtime-core/index.js";
import type { NeutralEndpoint } from "../runtime-core/index.js";
import type { WorkLogEntry } from "../runtime-core/index.js";
import { createWorkspaceTools } from "../tools/index.js";
import type { ToolContext } from "../tools/index.js";
import { createPulseTools } from "../tools/pulse-tools.js";
import { createActorTools } from "../tools/actor-tools.js";

/**
 * Thrown by the adapter when a pi runtime turn fails after the delivery was already
 * injected to the runtime. Carries structured fields so the daemon can emit a
 * runtime_error event to the originating endpoint.
 */
export class TurnFailedError extends Error {
  readonly code = "turn_failed" as const;
  constructor(
    readonly delivery_id: string,
    readonly source_endpoint_id: string,
    readonly workspace_id: string,
    readonly context_id: string | null,
    readonly thread_id: string,
    readonly model_id: string,
    readonly provider: string,
    readonly http_status: number | null,
    message: string
  ) {
    super(message);
    this.name = "TurnFailedError";
  }
}

/**
 * Internal sentinel thrown from finalizeTurn when pi completes a turn with
 * stopReason === 'error' (no HTTP throw from the runtime). Carries the pi
 * errorMessage so the handleBundle catch path can build a TurnFailedError
 * without re-recording telemetry that finalizeTurn already emitted.
 */
class PiErrorStopReasonSignal extends Error {
  readonly code = "pi_error_stop_reason" as const;
  constructor(
    readonly piErrorMessage: string | null,
    readonly piHttpStatus: number | null
  ) {
    super(piErrorMessage ?? "Pi runtime returned stop_reason 'error' with no error message.");
    this.name = "PiErrorStopReasonSignal";
  }
}

type AgentLike = {
  prompt(input: unknown): Promise<void>;
  subscribe(listener: (event: any) => void | Promise<void>): void;
};

type AgentFactoryInput = {
  model: RuntimeAuthResolved["model"];
  tools: AgentTool[];
  getApiKey: () => Promise<string>;
  systemPrompt: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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
  scope_id: string | null;
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
  contextId: string;          // The context this session is bound to ("no-context" when none)
  workspaceId: string;
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  instructionsHash: string;
  /** SESSION-LOCAL ephemeral cursor — tracks last-injected thread position for C-2/C-3.
   *  null = cold start (inject full thread). NOT persisted. NOT endpoint_watermarks.
   *  endpoint_watermarks stays the human-facing "read up to here" cursor. */
  threadCursor: string | null;
  /**
   * D5 Link-inclusion: the origin context_id if this session is for a PEER context.
   * Set during handleBundle when the current context has a parent_context_id.
   * null → this is a root/standalone context (no peer link).
   * Used to inject the originating slice so the actor knows what it serves and
   * where to relay back (the relay target is this context_id).
   */
  peerOriginContextId: string | null;
  /**
   * Side thread that triggered this session's CREATION, if any.
   * With the peer context model, new side threads are not created by routing —
   * this field is preserved for backward compatibility with the ThreadClosed
   * lifecycle hook but will always be null for new sessions.
   * null → no side thread (all new sessions after the peer context pivot).
   */
  sideThreadId: string | null;
  context?: RuntimeContext;
  activeTurn?: RuntimeTurnContext;
};

export class PiAgentCoreAdapter implements RuntimeAdapter {
  readonly name = "pi-agent-core";
  private sessions = new Map<string, SessionState>();
  private readonly agentFactory: AgentFactory;
  private readonly turnFinalizeTimeoutMs: number;
  /** Slice C: inject-once dedup — tracks last-injected content hash per (context, source). */
  private readonly baseline = new InjectionBaseline();
  /**
   * Slice C: registries we have already wired the lifecycle-reset handlers into.
   * WeakSet so GC can collect dead registries without explicit cleanup.
   */
  private readonly registeredHookRegistries = new WeakSet<HookRegistry>();

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
    // Apply thinking capability clamping (Fix 2): when a model has an explicit
    // thinking capability declaration, enforce it before handing off to pi-ai.
    const clampedRuntimeConfig = applyThinkingCapabilityClamp(runtimeConfig, resolved.thinkingCapability, resolved.model.id);
    const session = await this.getOrCreateSession(context, bundle, resolved, clampedRuntimeConfig);
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
    // Link-inclusion (D5): track whether this context is a peer context (has a parent link).
    let peerOriginContextId: string | null = null;
    if (turn.context_id) {
      try {
        const ctx = await context.bus.getContext(turn.context_id);
        if (ctx && Array.isArray(ctx.participants)) {
          currentContextParticipants = ctx.participants.filter((p): p is string => typeof p === "string");
          if (typeof ctx.scope_id === "string" && ctx.scope_id.trim()) {
            turn.scope_id = ctx.scope_id;
          }
          // D5: if this context has a parent_context_id, it is a peer context.
          // Surface the origin context_id for link-inclusion injection.
          if (ctx.parent_context_id) {
            peerOriginContextId = ctx.parent_context_id;
          }
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
    // Store peer origin in session for tool use (D3 relay ergonomics).
    session.peerOriginContextId = peerOriginContextId;

    const prompt = deliveryToPrompt(bundle, visibleEndpoints, currentContextParticipants);
    console.log("[bridge] pi prompt injected", {
      delivery_id: bundle.delivery_id,
      runtime_turn_id: turn.runtime_turn_id,
      endpoint_id: bundle.endpoint_id,
      prompt_length: prompt.length
    });
    try {
      // Slice C: lazily register lifecycle-reset handlers in the workspace HookRegistry
      // so the injection baseline is cleared when a context's history is reset.
      this.maybeRegisterLifecycleHooks(context.hooks);

      // Fire BeforeTurn hook — collect injected context
      let injectedContext = "";
      if (context.hooks?.hasHandlers("BeforeTurn")) {
        // Build a typed origin reference symmetric with the emit destination.
        // kind="context" when the trigger event belongs to a context thread;
        // kind="thread"  when it only has a thread_id.
        const triggerEvent = bundle.events[0];
        const origin: { id: string; kind: "context" | "thread" } | undefined =
          triggerEvent?.context_id
            ? { id: triggerEvent.context_id, kind: "context" as const }
            : triggerEvent?.thread_id
            ? { id: triggerEvent.thread_id, kind: "thread" as const }
            : undefined;
        const hookResults = await context.hooks.fire("BeforeTurn", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          thread_id: bundle.events[0]?.thread_id,
          origin
        });
        // Slice C (F2): apply inject-once dedup keyed on (context_id, source).
        // Content unchanged since last inject → stripped from filteredResults.
        // No context_id → all results pass through (can’t key without a context binding).
        const filteredResults = this.baseline.applyDedup(turn.context_id, hookResults);
        injectedContext = renderHookInjections(filteredResults);
        if (injectedContext) {
          await this.appendTelemetry(context, turn, "hook_injection", {
            hook: "BeforeTurn",
            injection_length: injectedContext.length,
            source_count: filteredResults.filter(r => r.inject).length
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

      // C-2: Fetch thread slice since this session's last-injected cursor.
      // Cold start (threadCursor=null) → fetches full thread (cursor 0 backfill).
      // Warm continue → fetches only the delta since last turn.
      // This is a SESSION-LOCAL ephemeral cursor — not endpoint_watermarks (human cursor).
      // Eviction: sessions are released on bridge restart (no context-close signal yet;
      // when a substrate context-closed event is available, evict on that signal instead).
      let threadSlice = "";
      let nextThreadCursor: string | null = session.threadCursor;
      if (turn.context_id) {
        try {
          const triggerEventIds = new Set(bundle.events.map(e => e.event_id));
          const { events: ctxEvents, next_cursor } = await context.bus.listContextEvents(
            turn.context_id,
            session.threadCursor
          );
          // Exclude the trigger events from the slice — they are rendered by deliveryToPrompt
          const sliceEvents = ctxEvents.filter(e => !triggerEventIds.has(e.event_id));
          if (sliceEvents.length > 0) {
            threadSlice = renderThreadSlice(sliceEvents);
          }
          // Record next cursor for advance after successful turn (C-3)
          if (next_cursor !== null) {
            nextThreadCursor = next_cursor;
          }
        } catch (sliceErr) {
          // Non-fatal: agent proceeds without thread history injection.
          // Cursor stays at session.threadCursor; next turn will retry.
          console.warn("[bridge] thread slice fetch failed; proceeding without thread context", {
            context_id: turn.context_id,
            error: sliceErr instanceof Error ? sliceErr.message : String(sliceErr)
          });
        }
      }

      // D5 Link-inclusion: if this is a peer context (has parent_context_id), inject a
      // read-only originating slice from the linked origin context.
      // This tells the actor which request spawned this peer context and where to relay back.
      // Only the originating request (first few events of origin) is injected; the rest of
      // the origin's thread remains discoverable via the link (not auto-injected).
      // Non-fatal: if origin fetch fails, actor proceeds without the originating slice.
      let originatingSlice = "";
      if (peerOriginContextId) {
        try {
          const ORIGINATING_LIMIT = 5;
          const { events: originEvents } = await context.bus.listContextEvents(
            peerOriginContextId,
            null,       // from the beginning
            ORIGINATING_LIMIT
          );
          if (originEvents.length > 0) {
            originatingSlice = renderOriginatingSlice(peerOriginContextId, originEvents);
          }
          console.log("[bridge] link-inclusion: injected originating slice", {
            peer_context_id: turn.context_id,
            origin_context_id: peerOriginContextId,
            events_count: originEvents.length
          });
        } catch (originErr) {
          console.warn("[bridge] link-inclusion: failed to fetch originating slice", {
            peer_context_id: turn.context_id,
            origin_context_id: peerOriginContextId,
            error: originErr instanceof Error ? originErr.message : String(originErr)
          });
        }
      }

      // Build final prompt: [extension overlay] + [originating slice] + [thread slice] + [trigger]
      // Originating slice comes before the peer context's own thread so the actor first
      // understands what it serves, then sees its own conversation, then the new trigger.
      const parts: string[] = [];
      if (injectedContext) parts.push(injectedContext);
      if (originatingSlice) parts.push(originatingSlice);
      if (threadSlice) parts.push(threadSlice);
      parts.push(prompt);
      const finalPrompt = parts.join("\n\n");

      await session.agent.prompt({
        role: "user",
        timestamp: Date.now(),
        content: [{ type: "text", text: finalPrompt }]
      } as any);
      await this.awaitTurnCompletion(context, session, turn);

      // C-3: Advance session-local thread cursor — ephemeral, in-memory only.
      // Done AFTER successful turn completion so a failed turn doesn't advance the cursor.
      session.threadCursor = nextThreadCursor;
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
      // PiErrorStopReasonSignal carries a pre-parsed http_status; for genuine
      // thrown errors, extract from the message text (e.g. "POST … failed: 400 …").
      const httpStatus =
        error instanceof PiErrorStopReasonSignal
          ? error.piHttpStatus
          : (() => {
              const m = errorMessage.match(/:\s*(\d{3})\b/);
              return m ? parseInt(m[1], 10) : null;
            })();

      console.error("[bridge] pi runtime error", {
        delivery_id: bundle.delivery_id,
        runtime_turn_id: turn.runtime_turn_id,
        endpoint_id: bundle.endpoint_id,
        http_status: httpStatus,
        error: errorMessage,
        source: error instanceof PiErrorStopReasonSignal ? "stop_reason_error" : "thrown"
      });
      // Surface runtime error as telemetry — but only for thrown errors; for
      // PiErrorStopReasonSignal the runtime_error entry was already written by
      // finalizeTurn before it rejected the completion promise.
      if (!(error instanceof PiErrorStopReasonSignal)) {
        await this.appendTelemetry(context, turn, "runtime_error", {
          error_message: errorMessage,
          http_status: httpStatus,
          provider: resolved.provider,
          model: resolved.model.id
        });
      }

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
        const errContextId = bundle.events[0]?.context_id ?? "no-context";
        const errKey = `${bundle.endpoint_id}:${errContextId}`;
        console.log("[bridge] pi session invalidated due to error", { endpoint_id: bundle.endpoint_id, context_id: errContextId });
        this.sessions.delete(errKey);
      }
      // Re-throw as TurnFailedError so the daemon can emit a runtime_error event
      // to the originating endpoint and mark the delivery as failed.
      throw new TurnFailedError(
        bundle.delivery_id,
        turn.source_endpoint_id,
        bundle.workspace_id,
        turn.context_id,
        turn.thread_id,
        resolved.model.id,
        resolved.provider,
        httpStatus,
        errorMessage
      );
    }
  }

  async dispose(reason: HookPayload<"SessionEnd">["reason"] = "bridge_shutdown"): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      await this.fireSessionEnd(session, { reason });
    }
  }

  /**
   * Evict sessions that were scoped exclusively to the given closed side thread.
   *
   * Only sessions whose `sideThreadId` matches `closedThreadId` are removed —
   * sessions for other (endpoint, context) pairs, and sessions that were created
   * on the main/root thread, are left untouched (conservative eviction).
   *
   * If a session has an in-progress turn it is skipped; the session will become
   * stale once the turn completes and the thread can no longer receive new events.
   */
  releaseSessionsForClosedThread(closedThreadId: string): void {
    for (const [key, session] of this.sessions) {
      if (session.sideThreadId !== closedThreadId) continue;
      if (session.activeTurn && !session.activeTurn.finalized) {
        console.log("[bridge] side thread closed mid-turn; deferring session eviction", {
          key,
          closed_thread_id: closedThreadId,
        });
        continue;
      }
      this.sessions.delete(key);
      console.log("[bridge] session evicted: side thread closed", {
        key,
        endpoint_id: session.endpointId,
        context_id: session.contextId,
        closed_thread_id: closedThreadId,
      });
    }
  }

  private async getOrCreateSession(context: RuntimeContext, bundle: DeliveryBundle, resolved: RuntimeAuthResolved, runtimeConfig?: AgentRuntimeConfig): Promise<SessionState> {
    // C-1: Session key per (endpoint, context) — each card/context gets an isolated
    // pi Agent instance with independent message history. Cross-context bleed is
    // structurally impossible: a session for context A can never see context B's data.
    const contextId = bundle.events[0]?.context_id ?? "no-context";
    const key = `${bundle.endpoint_id}:${contextId}`;
    const rawInstructions = runtimeConfig?.instructions?.trim() ?? "";
    // Build the full system prompt: agent instructions + Floe substrate guidance
    const systemPrompt = buildSystemPrompt(rawInstructions);
    const thinkingLevel = runtimeConfig?.thinking_level ?? "off";

    const instructionsHash = instructionHash(systemPrompt);

    const existing = this.sessions.get(key);
    if (
      existing &&
      existing.provider === resolved.provider &&
      existing.modelId === resolved.model.id &&
      existing.thinkingLevel === thinkingLevel &&
      existing.instructionsHash === instructionsHash
    ) {
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
      contextId,
      workspaceId: bundle.workspace_id,
      provider: resolved.provider,
      modelId: resolved.model.id,
      thinkingLevel,
      instructionsHash,
      threadCursor: null,  // cold start — will backfill full thread on first turn
      // Peer origin context_id: set during handleBundle after fetching the context.
      // Null initially; handleBundle sets session.peerOriginContextId when the current
      // context has a parent_context_id (i.e. it is a peer/linked context).
      peerOriginContextId: null,
      // sideThreadId: with the peer context model, routing no longer creates side threads.
      // This field is retained for compatibility with the ThreadClosed lifecycle hook
      // but will always be null for new sessions (side-thread routing retired).
      sideThreadId: null,
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
      thinking_level: thinkingLevel,
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

    const pulseTools = createPulseTools(context.bus, bundle.workspace_id, context.workspace_locator, {
      getActiveTurn: () => state.activeTurn,
    });
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
      },
      thinkingLevel
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

  /**
   * Slice C (F2): lazily register ContextHistoryCleared / ContextCompacted handlers
   * in a workspace HookRegistry so the injection baseline is reset when a context
   * is cleared. Called once per registry instance (tracked via WeakSet).
   *
   * The extension name "_substrate_inject_once" is intentionally prefixed with "_"
   * to distinguish it from user-registered extensions. It is extension-agnostic.
   */
  private maybeRegisterLifecycleHooks(hooks: HookRegistry | undefined): void {
    if (!hooks) return;
    if (this.registeredHookRegistries.has(hooks)) return;
    this.registeredHookRegistries.add(hooks);

    hooks.on("ContextHistoryCleared", "_substrate_inject_once", (payload) => {
      this.baseline.clearContext(payload.context_id);
    });
    hooks.on("ContextCompacted", "_substrate_inject_once", (payload) => {
      this.baseline.clearContext(payload.context_id);
    });
  }

  private createEmitTool(session: SessionState): AgentTool {
    return {
      name: "emit",
      label: "Emit Floe Event",
      description: "Publish a canonical event to the Floe event bus. This is the ONLY way to communicate with other actors. Nothing you produce (text, tool results, reasoning) is visible to anyone unless you use this tool. Always call emit with type 'message' to reply to a delivered message. Use neutral actor refs from list_endpoints (e.g. 'operator', 'floe') as destination, or omit destination to reply to the source. The tool returns the context_id the event landed in — use this to relay results back to an origin context if needed.",
      parameters: Type.Object({
        type: Type.String(),
        destination: Type.Optional(Type.String({ description: "Target actor's neutral ref (as returned by list_endpoints, e.g. 'operator' or 'floe'). Omit to reply to the delivery source." })),
        text: Type.String(),
        response_expected: Type.Optional(Type.Boolean()),
        correlation_id: Type.Optional(Type.String()),
        context_id: Type.Optional(Type.String({ description: "Optional context_id to emit into. If the destination is a participant of the current delivery context, omit this to continue that context. Pass an explicit context_id to relay into a specific context (e.g. the origin context from link-inclusion if you are acting in a peer context). When the destination is NOT a participant of the current context and context_id is omitted, a peer context is created/reused for that pair." }))
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
        const emitResult = await context.bus.emit({
          type: String(params?.type ?? "message"),
          workspace_id: turn.workspace_id,
          source_endpoint_id: turn.endpoint_id,
          destination: {
            kind: "endpoint",
            endpoint_id: String(targetEndpoint)
          },
          thread_id: turn.thread_id,
          // D-B: default the emit context to the delivery's origin context so replies
          // always land in the same context they came from. Explicit context_id overrides.
          // Guard 1: only apply D-B default when this actor IS a participant of the origin
          // context. Non-participants must leave context_id null so Rule 2 handles routing.
          // Guard 2: only apply D-B default when the DESTINATION is also a participant of
          // the origin context (a genuine reply). When the destination is NOT a participant,
          // leave context_id null so the resolver's Rule 3 creates a peer context linked
          // to the origin context for the cross-actor exchange.
          context_id: params?.context_id ?? (
            turn.context_id !== null &&
            (turn.current_context_participants ?? []).includes(turn.endpoint_id) &&
            (
              !targetEndpoint ||
              (turn.current_context_participants ?? []).includes(String(targetEndpoint))
            )
              ? turn.context_id
              : null
          ),
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
        // emitResult may be null/undefined in test stubs that return void.
        const resolvedContextId = (emitResult as any)?.context_id ?? null;
        // Track emitted event for work log
        turn.emitted_events.push({
          type: String(params?.type ?? "message"),
          destination: String(targetEndpoint),
          text_preview: String(params?.text ?? "").slice(0, 120),
          response_expected: !!params?.response_expected
        });
        // Include the resolved context_id in the tool result so the actor knows
        // which context the event landed in (important for peer context relay:
        // the resolved context_id may be a newly-created peer context distinct
        // from the current delivery context).
        const responseText = resolvedContextId
          ? `emit accepted (context_id: ${resolvedContextId})`
          : "emit accepted";
        return {
          content: [{ type: "text", text: responseText }],
          details: { ok: true, context_id: resolvedContextId }
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
      scope_id: typeof trigger?.scope_id === "string" && trigger.scope_id.trim() ? trigger.scope_id : null,
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
        const piErrorMessage = assistantMessage?.errorMessage ?? null;
        console.log("[bridge] no visible output", {
          runtime_turn_id: turn.runtime_turn_id,
          delivery_id: turn.delivery_id,
          had_assistant_message: !!assistantMessage,
          stop_reason: stopReason
        });
        if (stopReason === "error") {
          // Extract HTTP status from pi errorMessage if present (e.g. "400 Bad Request")
          const httpStatusMatch = piErrorMessage?.match(/\b(\d{3})\b/);
          const piHttpStatus = httpStatusMatch ? parseInt(httpStatusMatch[1], 10) : null;
          await this.appendTelemetry(context, turn, "runtime_error", {
            note: "Pi runtime returned stop_reason 'error' without throwing.",
            stop_reason: stopReason,
            error_message: piErrorMessage,
            http_status: piHttpStatus
          });
          // Record usage telemetry before signalling failure
          if (assistantMessage) {
            await this.appendTelemetry(context, turn, "usage", {
              usage: assistantMessage.usage ?? null,
              model: assistantMessage.model ?? null,
              provider: assistantMessage.provider ?? null,
              stop_reason: stopReason,
              error_message: piErrorMessage
            });
          }
          // Reject the completion so handleBundle's catch path emits the
          // runtime_error bus event and marks the delivery as failed.
          turn.completion.reject(new PiErrorStopReasonSignal(piErrorMessage, piHttpStatus));
          return;
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
        scope_id: turn.scope_id,
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
      scope_id: turn.scope_id,
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

export function summarizePiRequestPayload(payload: any, model: any) {
  const inputItems = Array.isArray(payload?.input) ? payload.input : [];
  const roles = inputItems.map((m: any) => m?.role ?? m?.type ?? "unknown");
  return {
    model_id: model?.id,
    provider: model?.provider,
    api: model?.api,
    input_items: inputItems.length,
    roles: roles.slice(0, 20),
    has_reasoning: !!payload?.reasoning,
    reasoning: payload?.reasoning ?? null,
    has_thinking: !!payload?.thinking,
    thinking: payload?.thinking ?? null,
    has_tools: Array.isArray(payload?.tools) && payload.tools.length > 0,
    tool_count: Array.isArray(payload?.tools) ? payload.tools.length : 0
  };
}

function createDefaultAgent(input: AgentFactoryInput): AgentLike {
  return new Agent({
    initialState: {
      model: input.model,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      thinkingLevel: input.thinkingLevel ?? "off"
    },
    getApiKey: input.getApiKey,
    onPayload: (payload: any, model: any) => {
      // Log request structure (no content/tokens) for diagnostics
      console.log("[bridge] pi request payload", summarizePiRequestPayload(payload, model));
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

/**
 * Render a slice of context thread events into a readable block for injection.
 *
 * Includes events with meaningful text content (message + domain events).
 * Never includes tool calls (those live only in the private pi session).
 * Format per event: "[ActorName] text", ordered chronologically.
 *
 * Bounded to MAX_THREAD_SLICE_EVENTS most-recent events and MAX_THREAD_SLICE_CHARS total.
 * This keeps cold-start backfill from overwhelming the context window.
 */
const MAX_THREAD_SLICE_EVENTS = 50;
const MAX_THREAD_SLICE_CHARS = 8_000;

export function renderThreadSlice(events: EventEnvelope[]): string {
  if (events.length === 0) return "";

  const lines: string[] = ["[Thread — recent context history]"];
  let totalChars = 0;
  // Keep the most-recent N events when over the cap
  const limited = events.length > MAX_THREAD_SLICE_EVENTS
    ? events.slice(-MAX_THREAD_SLICE_EVENTS)
    : events;

  for (const event of limited) {
    // Only inject events with meaningful text; skip structural noise without text
    const text = typeof event.content?.text === "string" ? event.content.text : null;
    if (!text) continue;

    const actorRef = event.source_endpoint_id
      ? (() => { try { return toNeutralRef(event.source_endpoint_id!); } catch { return event.source_endpoint_id!; } })()
      : "system";
    const line = `[${actorRef}] ${text}`;
    if (totalChars + line.length > MAX_THREAD_SLICE_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }

  if (lines.length === 1) return ""; // header only — no events had renderable text
  lines.push("[End Thread]");
  return lines.join("\n");
}

/**
 * D5 Link-inclusion: render the originating slice from the linked origin context.
 *
 * When an actor acts in a PEER context (a context linked to an origin via parent_context_id),
 * this slice is injected at the start of the prompt to tell the actor:
 * - what the origin context is (context_id for explicit relay)
 * - what the originating request was (the first events of the origin context)
 * - where to emit results back (emit with context_id = originContextId)
 *
 * Only the originating request (first few events) is injected; the rest of the origin's
 * thread is discoverable on demand, not auto-injected (D5 decision).
 */
export function renderOriginatingSlice(originContextId: string, events: EventEnvelope[]): string {
  if (events.length === 0) return "";

  const MAX_ORIGINATING_CHARS = 3_000;
  const lines: string[] = [
    `[Peer Context — this context is linked to origin context: ${originContextId}]`,
    `[To relay results back, emit with context_id: ${originContextId}]`,
    `[Originating request from the origin context:]`
  ];
  let totalChars = 0;

  for (const event of events) {
    const text = typeof event.content?.text === "string" ? event.content.text : null;
    if (!text) continue;

    const actorRef = event.source_endpoint_id
      ? (() => { try { return toNeutralRef(event.source_endpoint_id!); } catch { return event.source_endpoint_id!; } })()
      : "system";
    const line = `[${actorRef}] ${text}`;
    if (totalChars + line.length > MAX_ORIGINATING_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }

  if (lines.length === 3) return ""; // header only — no events had renderable text
  lines.push("[End Originating Request]");
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

/**
 * Apply thinking capability clamping at the bridge/bus boundary.
 *
 * When a model entry declares an explicit `thinking` capability, the requested
 * `thinking_level` is clamped before anything is handed to pi-ai, preventing
 * the pi runtime from sending thinking params the model cannot accept.
 *
 * Capability mapping:
 * - "always-on" / "none"  → force thinking_level to "off" (pi-ai will omit the
 *   thinking param when thinkingLevel="off", regardless of model.reasoning)
 * - "adaptive" / "budget" → pass through unchanged (pi-ai handles these correctly
 *   when reasoning=true; the custom registry entry should set reasoning accordingly)
 * - undefined             → no change (existing behaviour; pi-ai's own inference applies)
 */
export function applyThinkingCapabilityClamp(
  runtimeConfig: AgentRuntimeConfig | undefined,
  thinkingCapability: ModelThinkingCapability | undefined,
  modelId: string
): AgentRuntimeConfig | undefined {
  if (!thinkingCapability) return runtimeConfig;
  if (thinkingCapability === "always-on" || thinkingCapability === "none") {
    const requested = runtimeConfig?.thinking_level ?? "off";
    if (requested !== "off") {
      console.log(
        `[bridge] thinking_level '${requested}' clamped to 'off' for model '${modelId}' ` +
        `(declared capability: '${thinkingCapability}')`
      );
    }
    return { ...runtimeConfig, thinking_level: "off" };
  }
  // "adaptive" or "budget": pass through; pi-ai handles serialization
  return runtimeConfig;
}
