import { createHash, randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeConfig } from "../auth.js";
import type { DeliveryBundle, EventEnvelope } from "../bus-client.js";
import { appendWorkLog, buildSystemPrompt, renderDestinationContext, toNeutralEndpoint, toNeutralRef } from "../runtime-core/index.js";
import type { NeutralEndpoint, WorkLogEmitEntry, WorkLogToolEntry } from "../runtime-core/index.js";
import { createRuntimeTools, runtimeToolsFingerprint } from "../tools/runtime-tools.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import {
  CodexAppServerClient,
  type CodexDynamicToolCall,
  type CodexDynamicToolResult,
  type CodexRuntimeClient,
} from "./codex-app-server-client.js";
import { TurnFailedError } from "./turn-failed-error.js";

export const CODEX_APP_SERVER_PROVIDER = "openai-codex-app-server";

type ActiveTurn = {
  runtimeTurnId: string;
  bundle: DeliveryBundle;
  sourceEndpointId: string;
  contextId: string | null;
  threadId: string;
  correlationId: string | null;
  participants: string[];
  emitted: number;
  emittedEvents: WorkLogEmitEntry[];
  toolActivity: WorkLogToolEntry[];
  startedAt: string;
  scopeId: string | null;
  visibleOutput: string;
};

type Session = {
  threadId: string;
  model: string;
  instructionsHash: string;
  cursor: string | null;
  runtime: RuntimeContext;
  runtimeTools: Map<string, AgentTool>;
  runtimeToolsFingerprint: string;
  active?: ActiveTurn;
};

export class CodexAppServerAdapter implements RuntimeAdapter {
  readonly name = "codex-app-server";
  private readonly sessions = new Map<string, Session>();
  private client: CodexRuntimeClient | null = null;

  constructor(private readonly clientFactory: () => CodexRuntimeClient = () => new CodexAppServerClient()) {}

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const model = runtimeConfig?.model?.trim() ?? "";
    const trigger = bundle.events[0];
    const sourceEndpointId = trigger?.source_endpoint_id ?? `actor:${bundle.workspace_id}:operator`;
    const contextId = trigger?.context_id ?? null;
    const threadId = trigger?.thread_id ?? `thread:${bundle.workspace_id}:default`;
    const key = `${bundle.endpoint_id}:${contextId ?? "no-context"}`;
    const systemPrompt = buildSystemPrompt(runtimeConfig?.instructions?.trim() ?? "");
    const instructionsHash = createHash("sha256").update(systemPrompt).digest("hex");
    const toolsFingerprint = runtimeToolsFingerprint({
      workspaceLocator: context.workspace_locator,
      extensions: context.extensions,
    });

    let participants: string[] = [];
    if (contextId) {
      try { participants = (await context.bus.getContext(contextId))?.participants ?? []; } catch { /* prompt can proceed */ }
    }

    let session = this.sessions.get(key);
    if (
      !session ||
      session.model !== model ||
      session.instructionsHash !== instructionsHash ||
      session.runtimeToolsFingerprint !== toolsFingerprint
    ) {
      const provisional: Session = {
        threadId: "",
        model,
        instructionsHash,
        cursor: null,
        runtime: context,
        runtimeTools: new Map(),
        runtimeToolsFingerprint: toolsFingerprint,
      };
      const runtimeTools = uniqueTools(createRuntimeTools({
        bus: context.bus,
        workspaceId: bundle.workspace_id,
        workspaceLocator: context.workspace_locator,
        extensions: context.extensions,
        toolContext: {
          getActiveTurn: () => provisional.active
            ? { tool_activity: provisional.active.toolActivity, context_id: provisional.active.contextId }
            : undefined,
        },
      }));
      provisional.runtimeTools = new Map(runtimeTools.map(tool => [tool.name, tool]));
      const started = await this.getClient().startThread({
        model: model || undefined,
        cwd: context.workspace_locator,
        baseInstructions: systemPrompt,
        dynamicTools: codexTools(runtimeTools),
        toolHandler: (tool, args, call) => this.handleTool(provisional, tool, args, call),
      });
      provisional.threadId = started.threadId;
      provisional.model = model || started.model;
      session = provisional;
      this.sessions.set(key, session);
    }
    session.runtime = context;

    const active: ActiveTurn = {
      runtimeTurnId: randomUUID(),
      bundle,
      sourceEndpointId,
      contextId,
      threadId,
      correlationId: trigger?.correlation_id ?? null,
      participants,
      emitted: 0,
      emittedEvents: [],
      toolActivity: [],
      startedAt: new Date().toISOString(),
      scopeId: trigger?.scope_id ?? null,
      visibleOutput: "",
    };
    session.active = active;

    try {
      const visible = (await context.bus.listEndpoints(bundle.workspace_id))
        .filter((endpoint: any) => endpoint.endpoint_id !== bundle.endpoint_id)
        .map((endpoint: any) => toNeutralEndpoint(endpoint));
      let history = "";
      let nextCursor = session.cursor;
      if (contextId) {
        try {
          const triggerIds = new Set(bundle.events.map(event => event.event_id));
          const page = await context.bus.listContextEvents(contextId, session.cursor);
          history = renderThreadSlice(page.events.filter(event => !triggerIds.has(event.event_id)));
          nextCursor = page.next_cursor ?? nextCursor;
        } catch { /* cold-start history is helpful but not required */ }
      }

      const prompt = [history, deliveryPrompt(bundle, visible, participants)].filter(Boolean).join("\n\n");
      const result = await this.getClient().startTurn(session.threadId, prompt, runtimeConfig?.thinking_level);
      session.cursor = nextCursor;
      active.visibleOutput = result.output;
      if (result.output.trim()) {
        await context.bus.appendRuntimeTelemetry({
          workspace_id: bundle.workspace_id,
          endpoint_id: bundle.endpoint_id,
          delivery_id: bundle.delivery_id,
          kind: "visible_output",
          payload: { text: result.output, runtime: this.name, emitted_events: active.emitted },
        });
      }
      if (context.hooks?.hasHandlers("TurnEnd")) {
        await context.hooks.fire("TurnEnd", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          visible_output: active.visibleOutput,
          tool_activity: active.toolActivity,
          emitted_events: active.emittedEvents,
        });
      }
      this.writeWorkLog(context, bundle, active, "completed");
    } catch (error) {
      this.sessions.delete(key);
      const message = error instanceof Error ? error.message : String(error);
      if (context.hooks?.hasHandlers("Error")) {
        await context.hooks.fire("Error", {
          endpoint_id: bundle.endpoint_id,
          workspace_id: bundle.workspace_id,
          delivery_id: bundle.delivery_id,
          trigger_event_id: bundle.trigger_event_id,
          error: message,
        });
      }
      this.writeWorkLog(context, bundle, active, "error");
      throw new TurnFailedError(
        bundle.delivery_id,
        sourceEndpointId,
        bundle.workspace_id,
        contextId,
        threadId,
        model || "default",
        CODEX_APP_SERVER_PROVIDER,
        null,
        message,
      );
    } finally {
      if (session.active === active) session.active = undefined;
    }
  }

  async dispose(): Promise<void> {
    this.sessions.clear();
    await this.client?.dispose();
    this.client = null;
  }

  private getClient(): CodexRuntimeClient {
    if (!this.client) this.client = this.clientFactory();
    return this.client;
  }

  private async handleTool(
    session: Session,
    tool: string,
    args: any,
    call?: CodexDynamicToolCall,
  ): Promise<CodexDynamicToolResult> {
    const turn = session.active;
    if (!turn) return toolResult("There is no active Floe turn", false);

    if (call?.namespace === "floe") {
      return this.handleRuntimeTool(session, turn, tool, args, call.callId);
    }

    if (tool === "list_endpoints") {
      const endpoints = await session.runtime.bus.listEndpoints(turn.bundle.workspace_id);
      const visible = endpoints
        .filter((endpoint: any) => endpoint.endpoint_id !== turn.bundle.endpoint_id)
        .map((endpoint: any) => toNeutralEndpoint(endpoint));
      turn.toolActivity.push({ name: tool, summary: `${visible.length} visible actors` });
      return toolResult(JSON.stringify(visible, null, 2));
    }

    if (tool === "resolve_destination") {
      const resolved = await session.runtime.bus.resolveEndpoint(turn.bundle.workspace_id, String(args?.ref ?? ""));
      turn.toolActivity.push({ name: tool, summary: String(args?.ref ?? ""), is_error: !resolved.found });
      return toolResult(JSON.stringify(resolved, null, 2), resolved.found);
    }

    if (tool !== "emit") {
      turn.toolActivity.push({ name: tool, summary: "unknown Floe tool", is_error: true });
      return toolResult(`Unknown Floe tool: ${tool}`, false);
    }

    const requestedDestination = String(args?.destination ?? toNeutralRef(turn.sourceEndpointId));
    const resolved = await session.runtime.bus.resolveEndpoint(turn.bundle.workspace_id, requestedDestination);
    if (!resolved.found) {
      turn.toolActivity.push({ name: tool, summary: `unknown destination ${requestedDestination}`, is_error: true });
      return toolResult(`Unknown destination: ${requestedDestination}`, false);
    }
    const targetEndpoint = resolved.endpoint_id;
    const sameContext = turn.contextId !== null
      && turn.participants.includes(turn.bundle.endpoint_id)
      && turn.participants.includes(targetEndpoint);

    await session.runtime.bus.emit({
      type: String(args?.type ?? "message"),
      workspace_id: turn.bundle.workspace_id,
      source_endpoint_id: turn.bundle.endpoint_id,
      destination: { kind: "endpoint", endpoint_id: targetEndpoint },
      thread_id: turn.threadId,
      context_id: args?.context_id ?? (sameContext ? turn.contextId : null),
      current_delivery_context_id: turn.contextId,
      correlation_id: args?.correlation_id ?? turn.correlationId,
      content: {
        text: String(args?.text ?? ""),
        data: { origin: "codex_emit_tool", runtime_turn_id: turn.runtimeTurnId, delivery_id: turn.bundle.delivery_id },
      },
      response: { expected: args?.response_expected === true },
      metadata: { runtime: this.name, origin: "codex_emit_tool", runtime_turn_id: turn.runtimeTurnId },
    });
    turn.emitted += 1;
    turn.toolActivity.push({ name: tool, summary: `message to ${requestedDestination}` });
    turn.emittedEvents.push({
      type: String(args?.type ?? "message"),
      destination: requestedDestination,
      text_preview: String(args?.text ?? "").slice(0, 120),
      response_expected: args?.response_expected === true,
    });
    return toolResult("emit accepted");
  }

  private async handleRuntimeTool(
    session: Session,
    turn: ActiveTurn,
    name: string,
    args: any,
    callId: string,
  ): Promise<CodexDynamicToolResult> {
    const tool = session.runtimeTools.get(name);
    if (!tool) {
      turn.toolActivity.push({ name, call_id: callId, summary: "unknown Floe runtime tool", is_error: true });
      return toolResult(`Unknown Floe runtime tool: ${name}`, false);
    }

    const entry: WorkLogToolEntry = { name, call_id: callId };
    turn.toolActivity.push(entry);
    const startedAt = Date.now();
    try {
      const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
      const result = await tool.execute(callId, prepared);
      const success = !isFailedToolResult(result);
      entry.summary ??= summarizeToolResult(result);
      entry.is_error ??= !success;
      entry.duration_ms ??= Date.now() - startedAt;
      return toCodexToolResult(result, success);
    } catch (error) {
      entry.summary = error instanceof Error ? error.message : String(error);
      entry.is_error = true;
      entry.duration_ms = Date.now() - startedAt;
      return toolResult(entry.summary, false);
    }
  }

  private writeWorkLog(context: RuntimeContext, bundle: DeliveryBundle, turn: ActiveTurn, outcome: string): void {
    if (!context.workspace_locator || !context.agent_id) return;
    try {
      appendWorkLog(context.workspace_locator, {
        runtime_turn_id: turn.runtimeTurnId,
        agent_id: context.agent_id,
        started_at: turn.startedAt,
        ended_at: new Date().toISOString(),
        trigger_type: bundle.events[0]?.type ?? "unknown",
        scope_id: turn.scopeId,
        thread_id: turn.threadId,
        delivery_id: bundle.delivery_id,
        delivered_events: bundle.events.map(event => ({
          event_id: event.event_id,
          type: event.type,
          source_endpoint_id: event.source_endpoint_id ?? "unknown",
          text: (typeof event.content?.text === "string" ? event.content.text : JSON.stringify(event.content ?? "")).slice(0, 200),
        })),
        visible_output: turn.visibleOutput || null,
        tool_activity: turn.toolActivity,
        emitted_events: turn.emittedEvents,
        lifecycle_outcome: outcome,
      });
    } catch (error) {
      console.error("[bridge] Codex work-log write failed", { agent_id: context.agent_id, error: String(error) });
    }
  }
}

function toolResult(text: string, success = true): CodexDynamicToolResult {
  return { contentItems: [{ type: "inputText", text }], success };
}

function codexTools(runtimeTools: AgentTool[]): unknown[] {
  const tools: unknown[] = [
    {
      type: "function",
      name: "emit",
      description: "Send an Event to another actor. Normal assistant output is private runtime activity; use emit to communicate or reply.",
      inputSchema: {
        type: "object",
        properties: {
          destination: { type: "string", description: "Neutral actor ref such as operator or floe. Omit to reply to the sender." },
          text: { type: "string" },
          type: { type: "string", default: "message" },
          response_expected: { type: "boolean", default: false },
          context_id: { type: ["string", "null"] },
          correlation_id: { type: ["string", "null"] },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "list_endpoints",
      description: "List actors visible in the current workspace. Use their ref with emit.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: "resolve_destination",
      description: "Resolve a neutral actor ref to a workspace endpoint.",
      inputSchema: {
        type: "object",
        properties: { ref: { type: "string" } },
        required: ["ref"],
        additionalProperties: false,
      },
    },
  ];
  if (runtimeTools.length > 0) {
    tools.push({
      type: "namespace",
      name: "floe",
      description:
        "Floe substrate, workspace, and installed-extension capabilities. Use these to form and operate persistent work; provider-native coding tools do not replace substrate composition.",
      tools: runtimeTools.map(tool => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.parameters,
      })),
    });
  }
  return tools;
}

function uniqueTools(tools: AgentTool[]): AgentTool[] {
  const seen = new Set<string>();
  return tools.filter(tool => {
    if (seen.has(tool.name)) {
      console.error("[bridge] duplicate Floe runtime tool ignored", { tool: tool.name });
      return false;
    }
    seen.add(tool.name);
    return true;
  });
}

function isFailedToolResult(result: AgentToolResult<any>): boolean {
  const details = result.details;
  return Boolean(details && typeof details === "object" && "ok" in details && (details as any).ok === false);
}

function summarizeToolResult(result: AgentToolResult<any>): string {
  const text = result.content.find(item => item.type === "text") as { type: "text"; text: string } | undefined;
  return (text?.text ?? "completed").split(/\r?\n/, 1)[0]!.slice(0, 200);
}

function toCodexToolResult(result: AgentToolResult<any>, success: boolean): CodexDynamicToolResult {
  const contentItems: CodexDynamicToolResult["contentItems"] = [];
  for (const item of result.content) {
    if (item.type === "text") {
      contentItems.push({ type: "inputText", text: item.text });
      continue;
    }
    if (item.type === "image") {
      const image = item as { type: "image"; data: string; mimeType: string };
      contentItems.push({ type: "inputImage", imageUrl: `data:${image.mimeType};base64,${image.data}` });
    }
  }
  if (contentItems.length === 0) contentItems.push({ type: "inputText", text: JSON.stringify(result.details ?? {}) });
  return { contentItems, success };
}

function deliveryPrompt(bundle: DeliveryBundle, visible: NeutralEndpoint[], participants: string[]): string {
  const trigger = bundle.events[0];
  const source = trigger?.source_endpoint_id ?? `actor:${bundle.workspace_id}:operator`;
  const responseExpected = bundle.events.some(event => event.response?.expected === true || (event.type === "message" && event.source_endpoint_id != null));
  const context = renderDestinationContext({
    source_endpoint_id: source,
    reply_destination_endpoint_id: source,
    thread_id: trigger?.thread_id ?? `thread:${bundle.workspace_id}:default`,
    correlation_id: trigger?.correlation_id ?? null,
    response_expected: responseExpected,
    current_context_id: trigger?.context_id ?? null,
    current_context_participants: participants,
  });
  const endpoints = visible.length > 0
    ? `\n[Visible Endpoints]\n${visible.map(endpoint => `  - ${endpoint.ref} (${endpoint.name}, ${endpoint.status})`).join("\n")}`
    : "";
  const events = bundle.events.map(event => {
    const text = typeof event.content?.text === "string" ? event.content.text : JSON.stringify(event.content ?? {});
    return event.type === "message" ? text : `[${event.type}] ${text}`;
  }).filter(Boolean).join("\n\n");
  return `${context}${endpoints}\n\n${events}`;
}

const MAX_THREAD_SLICE_EVENTS = 50;
const MAX_THREAD_SLICE_CHARS = 8_000;

function renderThreadSlice(events: EventEnvelope[]): string {
  const lines = ["[Thread — recent context history]"];
  let chars = 0;
  for (const event of events.slice(-MAX_THREAD_SLICE_EVENTS)) {
    const text = typeof event.content?.text === "string" ? event.content.text : "";
    if (!text) continue;
    const source = event.source_endpoint_id ? toNeutralRef(event.source_endpoint_id) : "system";
    const line = `[${source}] ${text}`;
    if (chars + line.length > MAX_THREAD_SLICE_CHARS) break;
    lines.push(line);
    chars += line.length;
  }
  if (lines.length === 1) return "";
  lines.push("[End Thread]");
  return lines.join("\n");
}
