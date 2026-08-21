import { describe, expect, it, vi } from "vitest";
import { CodexAppServerAdapter } from "./codex-app-server-adapter.js";
import type { CodexDynamicToolCall, CodexDynamicToolHandler, CodexRuntimeClient, CodexThreadInput } from "./codex-app-server-client.js";
import type { DeliveryBundle } from "../bus-client.js";

class FakeCodexClient implements CodexRuntimeClient {
  threadInput: CodexThreadInput | null = null;
  handler: CodexDynamicToolHandler | null = null;
  turns: Array<{ threadId: string; text: string; effort?: string }> = [];
  onTurn?: (handler: CodexDynamicToolHandler) => Promise<void>;

  async startThread(input: CodexThreadInput) {
    this.threadInput = input;
    this.handler = input.toolHandler;
    return { threadId: "codex-thread-1", model: input.model ?? "gpt-default" };
  }

  async startTurn(threadId: string, text: string, effort?: string) {
    this.turns.push({ threadId, text, effort });
    if (this.onTurn) await this.onTurn(this.handler!);
    else await this.handler!("emit", { text: "I can help with that." });
    return { output: "Private runtime acknowledgement", turnId: "turn-1" };
  }

  async dispose() {}
}

const bundle: DeliveryBundle = {
  delivery_id: "delivery-1",
  endpoint_id: "actor:ws-1:floe",
  workspace_id: "ws-1",
  trigger_event_id: "event-1",
  delivered_at: "2026-08-21T00:00:00Z",
  events: [{
    event_id: "event-1",
    type: "message",
    workspace_id: "ws-1",
    source_endpoint_id: "actor:ws-1:operator",
    thread_id: "thread-1",
    context_id: "context-1",
    correlation_id: null,
    destination_json: { kind: "endpoint", endpoint_id: "actor:ws-1:floe" },
    content: { text: "Plan the launch" },
    response: { expected: false },
    metadata: {},
    created_at: "2026-08-21T00:00:00Z",
  }],
};

describe("CodexAppServerAdapter", () => {
  it("runs an isolated Codex thread and preserves explicit Floe emit semantics", async () => {
    const client = new FakeCodexClient();
    const emit = vi.fn().mockResolvedValue(undefined);
    const telemetry = vi.fn().mockResolvedValue(undefined);
    const bus = {
      getContext: vi.fn().mockResolvedValue({ participants: ["actor:ws-1:operator", "actor:ws-1:floe"] }),
      listEndpoints: vi.fn().mockResolvedValue([
        { endpoint_id: "actor:ws-1:operator", name: "Operator", status: "idle" },
        { endpoint_id: "actor:ws-1:floe", name: "Floe", status: "idle" },
      ]),
      listContextEvents: vi.fn().mockResolvedValue({ events: bundle.events, next_cursor: "cursor-1" }),
      resolveEndpoint: vi.fn().mockResolvedValue({ endpoint_id: "actor:ws-1:operator", found: true }),
      emit,
      appendRuntimeTelemetry: telemetry,
    };
    const adapter = new CodexAppServerAdapter(() => client);

    await adapter.handleBundle({
      bridge_id: "bridge-1",
      bus: bus as any,
      workspace_locator: "C:/work",
      agent_id: "floe",
    }, bundle, {
      provider: "openai-codex-app-server",
      model: "gpt-5.6-sol",
      thinking_level: "high",
      instructions: "Help the operator achieve outcomes.",
    });

    expect(client.threadInput).toMatchObject({ model: "gpt-5.6-sol", cwd: "C:/work" });
    expect(client.threadInput!.baseInstructions).toContain("Help the operator achieve outcomes.");
    expect(client.turns[0]).toMatchObject({ threadId: "codex-thread-1", effort: "high" });
    expect(client.turns[0]!.text).toContain("Plan the launch");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      source_endpoint_id: "actor:ws-1:floe",
      destination: { kind: "endpoint", endpoint_id: "actor:ws-1:operator" },
      context_id: "context-1",
      current_delivery_context_id: "context-1",
      content: expect.objectContaining({ text: "I can help with that." }),
    }));
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({ kind: "visible_output" }));
  });

  it("exposes the shared Floe runtime catalogue under a provider-neutral namespace", async () => {
    const client = new FakeCodexClient();
    const extensionExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "extension worked" }],
      details: { ok: true },
    });
    let extensionResult: any;
    client.onTurn = async (handler) => {
      extensionResult = await handler(
        "inspect_media",
        { path: "concept.png" },
        { namespace: "floe", callId: "call-extension" } satisfies CodexDynamicToolCall,
      );
    };
    const bus = {
      getContext: vi.fn().mockResolvedValue({ participants: [] }),
      listEndpoints: vi.fn().mockResolvedValue([]),
      listContextEvents: vi.fn().mockResolvedValue({ events: [], next_cursor: null }),
      appendRuntimeTelemetry: vi.fn().mockResolvedValue(undefined),
    };
    const adapter = new CodexAppServerAdapter(() => client);

    await adapter.handleBundle({
      bridge_id: "bridge-1",
      bus: bus as any,
      extensions: [{
        name: "media",
        tools: [{
          name: "inspect_media",
          label: "Inspect Media",
          description: "Inspect an image using the installed media capability.",
          parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          execute: extensionExecute,
        }],
        pulses: [],
        views: [],
        bundledAgents: [],
        httpHandlers: [],
        errors: [],
      } as any],
    }, bundle, {
      provider: "openai-codex-app-server",
      model: "gpt-5.6-sol",
      instructions: "Form persistent work for operator outcomes.",
    });

    const namespace = (client.threadInput!.dynamicTools as any[]).find(tool => tool.type === "namespace" && tool.name === "floe");
    const toolNames = namespace.tools.map((tool: any) => tool.name);
    expect(toolNames).toContain("create_actor");
    expect(toolNames).toContain("create_pulse");
    expect(toolNames).toContain("inspect_media");
    expect(extensionExecute).toHaveBeenCalledWith("call-extension", { path: "concept.png" });
    expect(extensionResult).toEqual({ contentItems: [{ type: "inputText", text: "extension worked" }], success: true });
  });
});
