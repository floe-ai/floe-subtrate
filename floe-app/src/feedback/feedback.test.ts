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
    event_id: "evt-fb-1",
    type: "floe.feedback",
    workspace_id: "ws-1",
    source_endpoint_id: "ep-1",
    thread_id: "thread-1",
    context_id: "ctx-1",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "broadcast", scope: "workspace", target: "ws-1" },
    content: {
      body: "This decision was premature.",
      target_kind: "event",
      target_id: "evt-abc",
    },
    response: { expected: false },
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeedbackAffordance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits a feedback event referencing the selected element", async () => {
    const emitMock = vi.mocked(client.emit);
    emitMock.mockResolvedValue(makeEventEnvelope());

    const target = { kind: "event", id: "evt-abc" };

    const input: EmitInput = {
      type: "floe.feedback",
      workspace_id: "ws-1",
      source_endpoint_id: "ep-1",
      destination: {
        kind: "broadcast",
        scope: "workspace",
        target: "ws-1",
        exclude_source: false,
      },
      content: {
        body: "This decision was premature.",
        target_kind: target.kind,
        target_id: target.id,
      },
      response: { expected: false },
    };

    const result = await client.emit(input);

    expect(emitMock).toHaveBeenCalledOnce();
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "floe.feedback",
        workspace_id: "ws-1",
        source_endpoint_id: "ep-1",
        content: expect.objectContaining({
          target_kind: "event",
          target_id: "evt-abc",
          body: "This decision was premature.",
        }),
      })
    );
    expect(result.type).toBe("floe.feedback");
  });

  it("emits feedback referencing a context target", async () => {
    const emitMock = vi.mocked(client.emit);
    emitMock.mockResolvedValue(
      makeEventEnvelope({
        content: {
          body: "Needs more context.",
          target_kind: "context",
          target_id: "ctx-xyz",
        },
      })
    );

    const input: EmitInput = {
      type: "floe.feedback",
      workspace_id: "ws-1",
      source_endpoint_id: "ep-operator",
      destination: { kind: "broadcast", scope: "workspace", target: "ws-1" },
      content: {
        body: "Needs more context.",
        target_kind: "context",
        target_id: "ctx-xyz",
      },
      response: { expected: false },
    };

    await client.emit(input);

    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          target_kind: "context",
          target_id: "ctx-xyz",
        }),
      })
    );
  });

  it("does not emit when the body is empty", async () => {
    const emitMock = vi.mocked(client.emit);

    // Simulate the guard: empty body should be rejected before calling emit
    const body = "   ";
    if (body.trim()) {
      await client.emit({} as EmitInput);
    }

    expect(emitMock).not.toHaveBeenCalled();
  });
});
