import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";

const WS = "workspace:turn-result";
const A = `actor:${WS}:a`;
const B = `actor:${WS}:b`;
const C = `actor:${WS}:c`;
const OPERATOR = `actor:${WS}:operator`;
const noop = () => {};

function requestCommand(input: {
  source: string;
  destination: string;
  correlation: string;
  currentContext: string;
  parentDelivery?: string;
  continuation?: string | null;
}): EventCommand {
  return {
    type: "request",
    workspace_id: WS,
    source_endpoint_id: input.source,
    destination: { kind: "endpoint", endpoint_id: input.destination },
    correlation_id: input.correlation,
    current_delivery_context_id: input.currentContext,
    content: { text: `work for ${input.destination}` },
    response: {
      expected: true,
      mode: "correlated",
      correlation_id: input.correlation
    },
    metadata: {
      origin: "pi_request_tool",
      request_return_context_id: input.currentContext,
      request_parent_delivery_id: input.parentDelivery ?? null,
      request_continuation_event_id: input.continuation ?? null
    }
  };
}

describe("runtime turn results and causal requests", () => {
  let store: BusStore;
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "floe-turn-result-"));
    const configPath = join(root, "config.yaml");
    const config = defaultConfig(root);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    store = new BusStore(configPath, config);
    for (const [endpoint_id, bridge_id] of [[OPERATOR, null], [A, "bridge:a"], [B, "bridge:b"], [C, "bridge:c"]] as const) {
      store.registerEndpoint({ endpoint_id, workspace_id: WS, name: endpoint_id, bridge_id, status: "idle" }, noop);
    }
  });

  afterEach(() => {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  it("records ordinary completion in its originating Context with no result delivery", () => {
    const submitted = store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: B },
      content: { text: "answer naturally" },
      response: { expected: true }
    }, noop);
    const [delivery] = store.claimDeliveries("bridge:b", 10, noop);

    const recorded = store.recordRuntimeTurnResult({
      delivery_id: delivery.delivery_id,
      outcome: "completed",
      text: "A natural answer."
    }, noop);

    expect(recorded.request_resolved).toBe(false);
    expect(recorded.return_event).toBeNull();
    expect(recorded.result_event).toMatchObject({
      type: "message",
      context_id: submitted.event.context_id,
      source_endpoint_id: B,
      destination_json: { kind: "context", context_id: submitted.event.context_id },
      content: { text: "A natural answer." },
      response: { expected: false }
    });
    expect(store.db.prepare("SELECT count(*) AS c FROM event_queue WHERE event_id = ?")
      .get(recorded.result_event.event_id)).toEqual({ c: 0 });
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual([
      expect.objectContaining({ source_event_id: submitted.event.event_id, status: "resolved" })
    ]);
  });

  it("does not duplicate a stored result when its delivery acknowledgement is retried", () => {
    const submitted = store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: B },
      content: { text: "answer once" }
    }, noop);
    const [firstDelivery] = store.claimDeliveries("bridge:b", 10, noop);
    const first = store.recordRuntimeTurnResult({
      delivery_id: firstDelivery.delivery_id,
      outcome: "completed",
      text: "One durable answer."
    }, noop);

    store.reportDeliveryStatus({
      bridge_id: "bridge:b",
      delivery_id: firstDelivery.delivery_id,
      state: "failed",
      error: "acknowledgement lost"
    }, noop);
    store.reportTurnEnd(B, noop);
    const [retryDelivery] = store.claimDeliveries("bridge:b", 10, noop);
    const retried = store.recordRuntimeTurnResult({
      delivery_id: retryDelivery.delivery_id,
      outcome: "completed",
      text: "One durable answer."
    }, noop);

    expect(retried.result_event.event_id).toBe(first.result_event.event_id);
    const rows = store.db.prepare(`
      SELECT event_id FROM events
      WHERE context_id = ? AND source_endpoint_id = ? AND type = 'message'
    `).all(submitted.event.context_id, B);
    expect(rows).toEqual([{ event_id: first.result_event.event_id }]);
  });

  it("only the requested actor's natural completion resolves and resumes the exact request", () => {
    const parent = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: A,
      participants: [A, OPERATOR]
    });
    const request = store.submitEvent(requestCommand({
      source: A,
      destination: B,
      correlation: "corr-exact",
      currentContext: parent
    }), noop).event;
    const [deliveryB] = store.claimDeliveries("bridge:b", 10, noop);

    store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: C,
      destination: { kind: "endpoint", endpoint_id: A },
      correlation_id: "corr-exact",
      content: { text: "unrelated but same correlation" }
    }, noop);
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual([
      expect.objectContaining({ source_event_id: request.event_id, status: "pending" })
    ]);

    const recorded = store.recordRuntimeTurnResult({
      delivery_id: deliveryB.delivery_id,
      outcome: "completed",
      text: "B's exact result"
    }, noop);

    expect(recorded.request_resolved).toBe(true);
    expect(recorded.result_event.context_id).toBe(request.context_id);
    expect(recorded.result_event.source_endpoint_id).toBe(B);
    expect(recorded.return_event).toMatchObject({
      type: "request.result",
      context_id: parent,
      source_endpoint_id: null,
      destination_json: { kind: "endpoint", endpoint_id: A },
      content: {
        text: "B's exact result",
        data: expect.objectContaining({
          request_event_id: request.event_id,
          responding_endpoint_id: B,
          result_context_id: request.context_id
        })
      }
    });
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual([
      expect.objectContaining({ source_event_id: request.event_id, status: "resolved" })
    ]);
  });

  it("preserves a durable nested A to B to C return chain", () => {
    const parent = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: A,
      participants: [A, OPERATOR]
    });
    const requestAB = store.submitEvent(requestCommand({
      source: A,
      destination: B,
      correlation: "corr-ab",
      currentContext: parent
    }), noop).event;
    const [deliveryB1] = store.claimDeliveries("bridge:b", 10, noop);

    const requestBC = store.submitEvent(requestCommand({
      source: B,
      destination: C,
      correlation: "corr-bc",
      currentContext: requestAB.context_id,
      parentDelivery: deliveryB1.delivery_id,
      continuation: requestAB.event_id
    }), noop).event;
    const [deliveryC] = store.claimDeliveries("bridge:c", 10, noop);

    // C can finish before B's first processing cycle has fully ended. That
    // fast return must not let B's interim completion satisfy A's request.
    const resultC = store.recordRuntimeTurnResult({
      delivery_id: deliveryC.delivery_id,
      outcome: "completed",
      text: "C's result"
    }, noop);
    expect(resultC.request_resolved).toBe(true);
    expect(resultC.return_event?.metadata.request_continuation_event_id).toBe(requestAB.event_id);

    const interimB = store.recordRuntimeTurnResult({
      delivery_id: deliveryB1.delivery_id,
      outcome: "completed",
      text: "Waiting on C."
    }, noop);
    expect(interimB.request_resolved).toBe(false);
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_event_id: requestAB.event_id, status: "pending" }),
      expect.objectContaining({ source_event_id: requestBC.event_id, status: "resolved" })
    ]));
    store.reportDeliveryStatus({ bridge_id: "bridge:b", delivery_id: deliveryB1.delivery_id, state: "acknowledged" }, noop);
    store.reportTurnEnd(B, noop);

    const [deliveryB2] = store.claimDeliveries("bridge:b", 10, noop);
    expect(deliveryB2.events[0]).toMatchObject({
      type: "request.result",
      context_id: requestAB.context_id,
      content: { text: "C's result" }
    });
    const resultB = store.recordRuntimeTurnResult({
      delivery_id: deliveryB2.delivery_id,
      outcome: "completed",
      text: "B completed using C."
    }, noop);

    expect(resultB.request_resolved).toBe(true);
    expect(resultB.return_event).toMatchObject({
      context_id: parent,
      destination_json: { kind: "endpoint", endpoint_id: A },
      content: { text: "B completed using C." }
    });
    expect(store.listPendingResponses({ workspace_id: WS })).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_event_id: requestAB.event_id, status: "resolved" }),
      expect.objectContaining({ source_event_id: requestBC.event_id, status: "resolved" })
    ]));
  });

  it("returns terminal requested-actor failure through the same causal path", () => {
    const parent = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: A,
      participants: [A]
    });
    const request = store.submitEvent(requestCommand({
      source: A,
      destination: B,
      correlation: "corr-failure",
      currentContext: parent
    }), noop).event;
    const [deliveryB] = store.claimDeliveries("bridge:b", 10, noop);

    const failed = store.recordRuntimeTurnResult({
      delivery_id: deliveryB.delivery_id,
      outcome: "failed",
      text: "B failed after bounded delivery attempts."
    }, noop);

    expect(failed.request_resolved).toBe(true);
    expect(failed.result_event.metadata.outcome).toBe("failed");
    expect(failed.return_event).toMatchObject({
      context_id: parent,
      content: {
        text: "B failed after bounded delivery attempts.",
        data: expect.objectContaining({ outcome: "failed", request_event_id: request.event_id })
      }
    });
  });

  it("dead-letters a failed turn after three bounded delivery attempts", () => {
    store.submitEvent({
      type: "message",
      workspace_id: WS,
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: B },
      content: { text: "work that keeps failing" }
    }, noop);

    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      const [delivery] = store.claimDeliveries("bridge:b", 10, noop);
      expect(store.db.prepare("SELECT attempt_count FROM delivery_bundles WHERE delivery_id = ?")
        .get(delivery.delivery_id)).toEqual({ attempt_count: expectedAttempt });

      const reported = store.reportDeliveryStatus({
        bridge_id: "bridge:b",
        delivery_id: delivery.delivery_id,
        state: "failed",
        error: `attempt ${expectedAttempt} failed`
      }, noop) as { state: string; attempt_count: number };

      expect(reported.attempt_count).toBe(expectedAttempt);
      expect(reported.state).toBe(expectedAttempt === 3 ? "dead_lettered" : "failed");
      store.reportTurnEnd(B, noop);
    }

    expect(store.claimDeliveries("bridge:b", 10, noop)).toEqual([]);
  });
});
