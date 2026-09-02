import { describe, expect, it } from "vitest";
import type { DeliveryRow, EventEnvelope } from "../../bus-client/types.ts";
import { scopeOperationState } from "./ScopeWorkView.tsx";

describe("Scope work projection", () => {
  it("reports whether the selected Context is working, settled, or needs attention", () => {
    const trigger = {
      event_id: "event-1",
      type: "work.requested",
      workspace_id: "workspace-1",
      source_endpoint_id: "actor:architect",
      thread_id: "context-1",
      context_id: "context-1",
      scope_id: "delivery",
      correlation_id: null,
      destination_json: { kind: "endpoint", endpoint_id: "actor:builder" },
      content: { text: "Build slice one." },
      response: { expected: false },
      metadata: {},
      created_at: "2026-08-28T00:00:00Z",
    } as EventEnvelope;
    const delivery = {
      delivery_id: "delivery-1",
      endpoint_id: "actor:builder",
      workspace_id: "workspace-1",
      trigger_event_id: "event-1",
      events_json: "[]",
      state: "acknowledged",
      lease_expires_at: null,
      attempt_count: 1,
      last_error: null,
      created_at: "2026-08-28T00:00:01Z",
      claimed_at: "2026-08-28T00:00:02Z",
    } as DeliveryRow;

    expect(scopeOperationState("context-1", [trigger], [delivery])).toEqual({
      state: "settled",
      activeCount: 0,
      attentionCount: 0,
    });

    expect(scopeOperationState("context-1", [trigger], [{
      ...delivery,
      state: "injected_to_runtime",
    }])).toEqual({
      state: "working",
      activeCount: 1,
      attentionCount: 0,
    });

    expect(scopeOperationState("context-1", [trigger], [{
      ...delivery,
      state: "dead_lettered",
      last_error: "runtime ownership lost",
    }])).toEqual({
      state: "attention",
      activeCount: 0,
      attentionCount: 1,
    });
  });
});
