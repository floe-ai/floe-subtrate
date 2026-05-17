import { describe, expect, it } from "vitest";
import {
  contextLabel,
  sortContextsForAgent,
  findDefaultContextId,
  buildEmitBody,
  type ContextSummary,
  type ContextEvent
} from "./contexts";

const WS = "ws_1";
const OP = "actor:ws_1:operator";
const FLOE = "actor:ws_1:floe";
const REVIEWER = "actor:ws_1:reviewer";

function makeCtx(overrides: Partial<ContextSummary>): ContextSummary {
  return {
    context_id: overrides.context_id ?? "ctx_x",
    workspace_id: WS,
    parent_context_id: null,
    created_by_endpoint_id: OP,
    created_at: "2024-06-01T10:00:00.000Z",
    last_event_at: "2024-06-01T10:00:00.000Z",
    participants: [OP, FLOE],
    first_message_preview: null,
    ...overrides
  };
}

describe("contextLabel", () => {
  it("uses first_message_preview when present", () => {
    const ctx = makeCtx({ first_message_preview: "hello floe what's up" });
    expect(contextLabel(ctx, null)).toBe("hello floe what's up");
  });

  it("falls back to 'Pulse: <name>' when preview null and first event is a pulse trigger", () => {
    const ctx = makeCtx({ first_message_preview: null });
    const ev: ContextEvent = {
      event_id: "e1",
      type: "pulse.fired",
      context_id: ctx.context_id,
      source_endpoint_id: null,
      destination_json: { kind: "endpoint", endpoint_id: FLOE },
      content: {},
      metadata: { trigger_kind: "pulse", pulse_name: "morning_check" },
      created_at: ctx.created_at
    };
    expect(contextLabel(ctx, ev)).toBe("Pulse: morning_check");
  });

  it("falls back to 'Conversation' when preview is null and no pulse metadata", () => {
    const ctx = makeCtx({ first_message_preview: null });
    expect(contextLabel(ctx, null)).toBe("Conversation");
    const ev: ContextEvent = {
      event_id: "e1",
      type: "message",
      context_id: ctx.context_id,
      source_endpoint_id: OP,
      destination_json: { kind: "endpoint", endpoint_id: FLOE },
      content: {},
      metadata: {},
      created_at: ctx.created_at
    };
    expect(contextLabel(ctx, ev)).toBe("Conversation");
  });

  it("treats empty/whitespace preview as null", () => {
    expect(contextLabel(makeCtx({ first_message_preview: "" }), null)).toBe("Conversation");
    expect(contextLabel(makeCtx({ first_message_preview: "   " }), null)).toBe("Conversation");
  });
});

describe("findDefaultContextId", () => {
  it("returns the earliest-created operator↔agent context", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({ context_id: "c2", created_at: "2024-06-02T00:00:00.000Z", participants: [OP, FLOE] }),
      makeCtx({ context_id: "c1", created_at: "2024-06-01T00:00:00.000Z", participants: [OP, FLOE] }),
      makeCtx({ context_id: "c3", created_at: "2024-05-30T00:00:00.000Z", participants: [OP, FLOE, REVIEWER] })
    ];
    expect(findDefaultContextId(ctxs, OP, FLOE)).toBe("c1");
  });

  it("returns null when no operator↔agent pair exists", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({ context_id: "c1", participants: [OP, REVIEWER] }),
      makeCtx({ context_id: "c2", participants: [FLOE] })
    ];
    expect(findDefaultContextId(ctxs, OP, FLOE)).toBeNull();
  });

  it("ignores contexts with extra participants", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({ context_id: "c1", participants: [OP, FLOE, REVIEWER] })
    ];
    expect(findDefaultContextId(ctxs, OP, FLOE)).toBeNull();
  });
});

describe("sortContextsForAgent", () => {
  it("filters to only contexts where both self and selected actor participate", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({ context_id: "ctx-a", participants: [OP, FLOE], last_event_at: "2024-06-01T00:00:00.000Z" }),
      makeCtx({ context_id: "ctx-b", participants: [FLOE, REVIEWER], last_event_at: "2024-06-03T00:00:00.000Z" }),
      makeCtx({ context_id: "ctx-c", participants: [OP, REVIEWER], last_event_at: "2024-06-02T00:00:00.000Z" }),
    ];
    const result = sortContextsForAgent(ctxs, OP, FLOE);
    expect(result.sorted).toHaveLength(1);
    expect(result.sorted[0].context_id).toBe("ctx-a");
  });

  it("returns empty when operator has no contexts with selected actor", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({ context_id: "ctx-b", participants: [FLOE, REVIEWER], last_event_at: "2024-06-03T00:00:00.000Z" }),
    ];
    const result = sortContextsForAgent(ctxs, OP, FLOE);
    expect(result.sorted).toHaveLength(0);
    expect(result.defaultContextId).toBeNull();
  });

  it("sorts filtered contexts by last_event_at desc when no default", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({ context_id: "c1", last_event_at: "2024-06-01T00:00:00.000Z", participants: [OP, FLOE, REVIEWER] }),
      makeCtx({ context_id: "c2", last_event_at: "2024-06-03T00:00:00.000Z", participants: [OP, FLOE, REVIEWER] }),
      makeCtx({ context_id: "c3", last_event_at: "2024-06-02T00:00:00.000Z", participants: [OP, FLOE, REVIEWER] })
    ];
    const result = sortContextsForAgent(ctxs, OP, FLOE);
    expect(result.defaultContextId).toBeNull();
    expect(result.sorted.map((c) => c.context_id)).toEqual(["c2", "c3", "c1"]);
  });

  it("orders conversations by recent meaningful activity instead of pinning the oldest pair", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({
        context_id: "c_default",
        created_at: "2024-06-01T00:00:00.000Z",
        last_event_at: "2024-06-01T00:00:00.000Z",
        participants: [OP, FLOE]
      }),
      makeCtx({
        context_id: "c_recent",
        created_at: "2024-06-05T00:00:00.000Z",
        last_event_at: "2024-06-05T00:00:00.000Z",
        participants: [OP, FLOE]
      })
    ];
    const result = sortContextsForAgent(ctxs, OP, FLOE);
    expect(result.defaultContextId).toBe("c_default");
    expect(result.sorted.map((c) => c.context_id)).toEqual(["c_recent", "c_default"]);
  });

  it("falls back to created_at when last_event_at is null", () => {
    const ctxs: ContextSummary[] = [
      makeCtx({ context_id: "a", last_event_at: null, created_at: "2024-06-01T00:00:00.000Z", participants: [OP, FLOE, REVIEWER] }),
      makeCtx({ context_id: "b", last_event_at: null, created_at: "2024-06-02T00:00:00.000Z", participants: [OP, FLOE, REVIEWER] })
    ];
    const result = sortContextsForAgent(ctxs, OP, FLOE);
    expect(result.sorted.map((c) => c.context_id)).toEqual(["b", "a"]);
  });
});

describe("buildEmitBody", () => {
  it("omits context_id on new conversation drafts", () => {
    const body = buildEmitBody({
      workspaceId: WS,
      source: OP,
      agentEndpointId: FLOE,
      selectedContextId: null,
      text: "first message"
    });
    expect(body).not.toHaveProperty("context_id");
    expect(body.destination).toEqual({ kind: "endpoint", endpoint_id: FLOE });
    expect(body.source_endpoint_id).toBe(OP);
    expect(body.workspace_id).toBe(WS);
    expect(body.type).toBe("message");
    expect(body.content.text).toBe("first message");
    // Must NOT carry current_delivery_context_id on UI emits
    expect((body as Record<string, unknown>).current_delivery_context_id).toBeUndefined();
  });

  it("sends explicit context_id when continuing", () => {
    const body = buildEmitBody({
      workspaceId: WS,
      source: OP,
      agentEndpointId: FLOE,
      selectedContextId: "ctx_42",
      text: "follow up"
    });
    expect(body.context_id).toBe("ctx_42");
  });

  it("does not send a thread_id (legacy field removed from chat path)", () => {
    const body = buildEmitBody({
      workspaceId: WS,
      source: OP,
      agentEndpointId: FLOE,
      selectedContextId: "ctx_42",
      text: "x"
    });
    expect((body as Record<string, unknown>).thread_id).toBeUndefined();
  });
});
