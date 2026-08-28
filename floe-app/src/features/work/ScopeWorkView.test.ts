import { describe, expect, it } from "vitest";
import type { DeliveryRow, EventEnvelope, ScopeCompositionNode } from "../../bus-client/types.ts";
import { buildScopeWorkLinks, executionsForScopeNode } from "./ScopeWorkView.tsx";

describe("Scope work projection", () => {
  it("derives visible routing only from Event subscriptions and Command results", () => {
    const nodes: ScopeCompositionNode[] = [
      { node_id: "start", kind: "trigger", label: "Start", event_type: "work.requested" },
      { node_id: "checked", kind: "trigger", label: "Checked", event_type: "quality.checked" },
      { node_id: "builder", kind: "actor", endpoint_id: "actor:builder", event_types: ["work.requested"] },
      {
        node_id: "check",
        kind: "command",
        endpoint_id: "command:check",
        event_types: ["work.requested"],
        result_event_type: "quality.checked",
        command: "npm test",
      },
      { node_id: "judge", kind: "actor", endpoint_id: "actor:judge", event_types: ["quality.checked"] },
    ];

    expect(buildScopeWorkLinks(nodes)).toEqual([
      { source: "start", target: "builder", label: "work.requested" },
      { source: "start", target: "check", label: "work.requested" },
      { source: "checked", target: "judge", label: "quality.checked" },
      { source: "check", target: "checked", label: "quality.checked" },
    ]);
  });

  it("keeps the authored plan separate from executions associated with each node", () => {
    const actor: ScopeCompositionNode = {
      node_id: "builder",
      kind: "actor",
      endpoint_id: "actor:builder",
      event_types: ["work.requested"],
    };
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
    const result = {
      ...trigger,
      event_id: "event-2",
      type: "message",
      source_endpoint_id: "actor:builder",
      destination_json: { kind: "context", context_id: "context-1" },
      content: { text: "Slice one completed." },
      metadata: { delivery_id: "delivery-1" },
      created_at: "2026-08-28T00:05:00Z",
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

    expect(executionsForScopeNode(actor, [trigger, result], [delivery])).toEqual([
      expect.objectContaining({
        executionId: "delivery-1",
        state: "acknowledged",
        eventType: "work.requested",
        summary: "Slice one completed.",
      }),
    ]);
  });
});
