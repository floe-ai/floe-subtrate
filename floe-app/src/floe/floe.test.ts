import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EventEnvelope, EmitInput } from "../bus-client/types.ts";

vi.mock("../bus-client/client.ts", () => ({
  emit: vi.fn(),
}));

import * as client from "../bus-client/client.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: "evt-cmd-1",
    type: "floe.command",
    workspace_id: "ws-1",
    source_endpoint_id: "ep-1",
    thread_id: "thread-1",
    context_id: "ctx-1",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "broadcast", scope: "workspace", target: "ws-1" },
    content: { command: "summarise decisions" },
    response: { expected: false },
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FloeCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a command event", async () => {
    const emitMock = vi.mocked(client.emit);
    emitMock.mockResolvedValue(makeEventEnvelope());

    const input: EmitInput = {
      type: "floe.command",
      workspace_id: "ws-1",
      source_endpoint_id: "ep-1",
      destination: {
        kind: "broadcast",
        scope: "workspace",
        target: "ws-1",
        exclude_source: false,
      },
      context_id: null,
      scope_id: null,
      content: { command: "summarise decisions" },
      response: { expected: false },
    };

    const result = await client.emit(input);

    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "floe.command",
        workspace_id: "ws-1",
        source_endpoint_id: "ep-1",
        content: expect.objectContaining({ command: "summarise decisions" }),
      })
    );
    expect(result.type).toBe("floe.command");
  });

  it("emits with broadcast destination scoped to the workspace", async () => {
    const emitMock = vi.mocked(client.emit);
    emitMock.mockResolvedValue(makeEventEnvelope());

    const input: EmitInput = {
      type: "floe.command",
      workspace_id: "ws-prod",
      source_endpoint_id: "ep-operator",
      destination: {
        kind: "broadcast",
        scope: "workspace",
        target: "ws-prod",
      },
      content: { command: "list pending" },
      response: { expected: false },
    };

    await client.emit(input);

    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: expect.objectContaining({
          kind: "broadcast",
          scope: "workspace",
        }),
      })
    );
  });
});
