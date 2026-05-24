import { describe, expect, it } from "vitest";
import { projectionToReactFlow, type ScopeProjection } from "./scope-projection";

const projection: ScopeProjection = {
  workspace_id: "workspace:test",
  scope_id: "research",
  generated_at: "2026-05-24T00:00:00.000Z",
  refs: {
    contexts: [{
      context_id: "ctx_research",
      workspace_id: "workspace:test",
      scope_id: "research",
      parent_context_id: null,
      created_by_endpoint_id: "actor:workspace:test:operator",
      created_at: "2026-05-24T00:00:00.000Z",
      last_event_at: "2026-05-24T00:01:00.000Z",
      first_message_preview: "Research kickoff"
    }],
    pulses: [{
      pulse_id: "pulse_daily",
      workspace_id: "workspace:test",
      scope_id: "research",
      persistence: "workspace",
      status: "active",
      trigger: { type: "cron", schedule: "0 9 * * *" },
      next_fire_at: "2026-05-25T09:00:00.000Z",
      last_fired_at: null,
      fire_count: 0,
      created_at: "2026-05-24T00:00:00.000Z",
      updated_at: "2026-05-24T00:00:00.000Z"
    }],
    events: [{
      event_id: "evt_one",
      type: "message",
      workspace_id: "workspace:test",
      scope_id: "research",
      context_id: "ctx_research",
      source_endpoint_id: "actor:workspace:test:operator",
      created_at: "2026-05-24T00:01:00.000Z"
    }],
    activity: []
  },
  relationships: {
    context_participants: [
      { context_id: "ctx_research", endpoint_id: "actor:workspace:test:operator" },
      { context_id: "ctx_research", endpoint_id: "actor:workspace:test:floe" }
    ],
    pulse_subscribers: [
      { pulse_id: "pulse_daily", subscriber: { kind: "context", context_id: "ctx_research" } }
    ],
    event_context_ownership: [
      { event_id: "evt_one", context_id: "ctx_research" }
    ]
  },
  unsupported: []
};

describe("projectionToReactFlow", () => {
  it("renders substrate refs as stable nodes and relationships without actor containment nodes", () => {
    const flow = projectionToReactFlow(projection);

    expect(flow.nodes.map((node) => node.id)).toEqual([
      "context:ctx_research",
      "pulse:pulse_daily",
      "event:evt_one"
    ]);
    expect(flow.nodes.map((node) => (node.data as { kind: string }).kind)).toEqual([
      "context",
      "pulse",
      "event"
    ]);
    expect(flow.nodes.some((node) => node.id.startsWith("actor:"))).toBe(false);
    expect(flow.nodes[0].data).toMatchObject({
      kind: "context",
      label: "Research kickoff",
      context_id: "ctx_research",
      participant_count: 2,
      participants: [
        "actor:workspace:test:operator",
        "actor:workspace:test:floe"
      ]
    });
    expect(flow.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "pulse-subscriber:pulse_daily:context:ctx_research",
        source: "pulse:pulse_daily",
        target: "context:ctx_research"
      }),
      expect.objectContaining({
        id: "event-context:evt_one:ctx_research",
        source: "event:evt_one",
        target: "context:ctx_research"
      })
    ]));
  });

  it("merges renderer layout by stable substrate ref and keeps unsupported entries out of nodes", () => {
    const flow = projectionToReactFlow({
      ...projection,
      unsupported: [{ kind: "webhook", reason: "webhook projection not rendered yet" }]
    }, {
      schema: "floe.field.layout.floeweb.v1",
      field_id: "research",
      viewport: { x: 10, y: 20, zoom: 1.2 },
      items: {
        "context:ctx_research": { x: 345, y: 456 }
      }
    });

    expect(flow.nodes.find((node) => node.id === "context:ctx_research")?.position).toEqual({ x: 345, y: 456 });
    expect(flow.nodes.some((node) => node.id.includes("webhook"))).toBe(false);
    expect(flow.unsupported).toEqual([{ kind: "webhook", reason: "webhook projection not rendered yet" }]);
  });
});
