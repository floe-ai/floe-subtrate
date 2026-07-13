/**
 * Handoff — applyColumnAssignment batch behavior.
 *
 * Validates that applyColumnAssignment produces the correct participant +
 * subscription state using a single applyContextSubscriptions call.
 *
 * These tests use StubBusClient to inspect resulting state directly, without
 * exercising HTTP handlers. They complement no-context-churn.test.ts (which
 * tests the full HTTP handler flow).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { StubBusClient, type ContextRef } from "../stub/bus-client.js";
import { applyColumnAssignment, actorEndpointId } from "../handoff.js";

const WS_ID = "ws-handoff-test";
const SCOPE = "scope:board";
const CARD_CTX = "ctx_card_1";
const ACTING_EP = `actor:${WS_ID}:operator`;

function makeCtx(id = CARD_CTX): ContextRef {
  return {
    context_id: id,
    workspace_id: WS_ID,
    scope_id: SCOPE,
    created_at: new Date().toISOString(),
    title: "Test card",
    first_message_preview: null,
    participants: [],
  };
}

function baseParams(bus: StubBusClient, overrides: Partial<Parameters<typeof applyColumnAssignment>[0]> = {}) {
  return {
    cardContextId: CARD_CTX,
    destAssignedActors: [],
    priorAssignedActors: [],
    actingActorEp: ACTING_EP,
    workspaceId: WS_ID,
    scope_id: SCOPE,
    cardId: "card-1",
    cardTitle: "Test card",
    toColumnId: "col-b",
    toColumnName: "In Progress",
    fromColumnId: "col-a",
    bus,
    ...overrides,
  };
}

describe("applyColumnAssignment — uses single batch call", () => {
  let bus: StubBusClient;

  beforeEach(() => {
    bus = new StubBusClient();
    bus.seedContext(makeCtx());
  });

  it("acting actor is added as participant only (not subscribed) when no dest actors", async () => {
    await applyColumnAssignment(baseParams(bus));

    const ctx = (await bus.listContextsForScope(WS_ID, SCOPE))[0];
    expect(ctx.participants).toContain(ACTING_EP);

    const subs = await bus.listContextSubscriptions(CARD_CTX);
    // acting actor has NO subscription (participants_only path)
    expect(subs.find((s) => s.endpoint_id === ACTING_EP)).toBeUndefined();
  });

  it("dest actors are added as participants and subscribed with their event_types", async () => {
    const destEp = actorEndpointId(WS_ID, "my-agent");

    await applyColumnAssignment(
      baseParams(bus, {
        destAssignedActors: [{ actor_ref: "my-agent", event_types: ["*"] }],
      })
    );

    const ctx = (await bus.listContextsForScope(WS_ID, SCOPE))[0];
    expect(ctx.participants).toContain(destEp);

    const subs = await bus.listContextSubscriptions(CARD_CTX);
    const sub = subs.find((s) => s.endpoint_id === destEp);
    expect(sub?.event_types).toEqual(["*"]);
  });

  it("prior actors are demoted to silent watchers (event_types:[])", async () => {
    const priorEp = actorEndpointId(WS_ID, "old-agent");

    await applyColumnAssignment(
      baseParams(bus, {
        priorAssignedActors: [{ actor_ref: "old-agent", event_types: ["*"] }],
      })
    );

    const ctx = (await bus.listContextsForScope(WS_ID, SCOPE))[0];
    expect(ctx.participants).toContain(priorEp);

    const subs = await bus.listContextSubscriptions(CARD_CTX);
    const sub = subs.find((s) => s.endpoint_id === priorEp);
    expect(sub?.event_types).toEqual([]);
  });

  it("combined: acting=participant-only, dest=subscribed, prior=silent watcher", async () => {
    const destEp = actorEndpointId(WS_ID, "dest-agent");
    const priorEp = actorEndpointId(WS_ID, "prior-agent");

    await applyColumnAssignment(
      baseParams(bus, {
        destAssignedActors: [{ actor_ref: "dest-agent", event_types: ["snowball.card.entered_column"] }],
        priorAssignedActors: [{ actor_ref: "prior-agent", event_types: ["*"] }],
      })
    );

    const ctx = (await bus.listContextsForScope(WS_ID, SCOPE))[0];
    expect(ctx.participants).toContain(ACTING_EP);
    expect(ctx.participants).toContain(destEp);
    expect(ctx.participants).toContain(priorEp);

    const subs = await bus.listContextSubscriptions(CARD_CTX);
    // acting: no subscription
    expect(subs.find((s) => s.endpoint_id === ACTING_EP)).toBeUndefined();
    // dest: subscribed to entered_column
    expect(subs.find((s) => s.endpoint_id === destEp)?.event_types)
      .toEqual(["snowball.card.entered_column"]);
    // prior: silent watcher
    expect(subs.find((s) => s.endpoint_id === priorEp)?.event_types).toEqual([]);
  });

  it("no entered_column emitted when dest column has no assigned actors", async () => {
    await applyColumnAssignment(baseParams(bus, { destAssignedActors: [] }));
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column")).toHaveLength(0);
  });

  it("emits entered_column when dest column has assigned actors", async () => {
    await applyColumnAssignment(
      baseParams(bus, {
        destAssignedActors: [{ actor_ref: "my-agent", event_types: ["*"] }],
      })
    );

    const entered = bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column");
    expect(entered).toHaveLength(1);
    expect(entered[0].destination?.kind).toBe("context");
    expect(entered[0].destination?.context_id).toBe(CARD_CTX);
    expect(entered[0].source_endpoint_id).toBe(ACTING_EP);
    expect(entered[0].response?.expected).toBe(true);
  });

  it("is a no-op when cardContextId is null", async () => {
    await applyColumnAssignment(
      baseParams(bus, {
        cardContextId: null,
        destAssignedActors: [{ actor_ref: "my-agent", event_types: ["*"] }],
      })
    );
    expect(bus.emittedEvents).toHaveLength(0);
    const ctx = (await bus.listContextsForScope(WS_ID, SCOPE))[0];
    expect(ctx.participants).toHaveLength(0);
  });

  it("is idempotent — applying the same assignment twice yields the same state", async () => {
    const params = baseParams(bus, {
      destAssignedActors: [{ actor_ref: "agent-x", event_types: ["*"] }],
      priorAssignedActors: [{ actor_ref: "agent-y", event_types: ["message"] }],
    });

    await applyColumnAssignment(params);
    await applyColumnAssignment(params);

    const ctx = (await bus.listContextsForScope(WS_ID, SCOPE))[0];
    const destEp = actorEndpointId(WS_ID, "agent-x");
    const priorEp = actorEndpointId(WS_ID, "agent-y");

    // Each actor appears exactly once as a participant
    expect(ctx.participants.filter((p) => p === ACTING_EP)).toHaveLength(1);
    expect(ctx.participants.filter((p) => p === destEp)).toHaveLength(1);
    expect(ctx.participants.filter((p) => p === priorEp)).toHaveLength(1);

    const subs = await bus.listContextSubscriptions(CARD_CTX);
    // Subscriptions should not be duplicated
    expect(subs.filter((s) => s.endpoint_id === destEp)).toHaveLength(1);
    expect(subs.filter((s) => s.endpoint_id === priorEp)).toHaveLength(1);
    // Second run emits another entered_column — that's expected (two apply calls = two emits)
    expect(bus.emittedEvents.filter((e) => e.type === "snowball.card.entered_column")).toHaveLength(2);
  });
});
