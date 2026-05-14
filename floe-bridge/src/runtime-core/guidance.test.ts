import { describe, expect, it } from "vitest";
import { SUBSTRATE_GUIDANCE, buildSystemPrompt, renderDestinationContext } from "./guidance.js";

describe("SUBSTRATE_GUIDANCE", () => {
  it("contains conditional emit rule with response_expected", () => {
    expect(SUBSTRATE_GUIDANCE).toContain("response_expected");
    expect(SUBSTRATE_GUIDANCE).toContain("response_expected: true");
    expect(SUBSTRATE_GUIDANCE).toContain("response_expected: false");
    expect(SUBSTRATE_GUIDANCE).toContain("When to emit");
  });

  it("does not contain old unconditional MUST emit rule", () => {
    expect(SUBSTRATE_GUIDANCE).not.toContain(
      "MUST emit at least one message event before ending any turn"
    );
  });

  it("contains context model rules", () => {
    expect(SUBSTRATE_GUIDANCE).toContain("groups related events");
    expect(SUBSTRATE_GUIDANCE).toContain("non-participant");
    expect(SUBSTRATE_GUIDANCE).toContain("channels or broadcasts");
  });
});

describe("buildSystemPrompt", () => {
  it("appends substrate guidance to agent instructions", () => {
    const result = buildSystemPrompt("You are a helpful agent.");
    expect(result).toContain("You are a helpful agent.");
    expect(result).toContain(SUBSTRATE_GUIDANCE);
    // Instructions come first
    expect(result.indexOf("You are a helpful agent.")).toBeLessThan(
      result.indexOf("## Floe Substrate Context")
    );
  });

  it("returns substrate guidance when instructions empty", () => {
    expect(buildSystemPrompt("")).toBe(SUBSTRATE_GUIDANCE);
    expect(buildSystemPrompt("   ")).toBe(SUBSTRATE_GUIDANCE);
  });
});

describe("renderDestinationContext", () => {
  it("includes response_expected true", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "endpoint:ws:user:alice",
      reply_destination_endpoint_id: "endpoint:ws:user:alice",
      thread_id: "thread:ws:t1",
      correlation_id: null,
      response_expected: true,
    });
    expect(result).toContain("response_expected: true");
  });

  it("includes response_expected false", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "endpoint:ws:system:scheduler",
      reply_destination_endpoint_id: "endpoint:ws:system:scheduler",
      thread_id: "thread:ws:t2",
      correlation_id: null,
      response_expected: false,
    });
    expect(result).toContain("response_expected: false");
  });

  it("includes correlation_id when present", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "endpoint:ws:user:alice",
      reply_destination_endpoint_id: "endpoint:ws:user:alice",
      thread_id: "thread:ws:t1",
      correlation_id: "corr-123",
      response_expected: true,
    });
    expect(result).toContain("correlation_id: corr-123");
  });

  it("omits correlation_id when null", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "endpoint:ws:user:alice",
      reply_destination_endpoint_id: "endpoint:ws:user:alice",
      thread_id: "thread:ws:t1",
      correlation_id: null,
      response_expected: true,
    });
    expect(result).not.toContain("correlation_id");
  });

  it("includes current_context_id and current_context_participants when provided", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "endpoint:ws:user:alice",
      reply_destination_endpoint_id: "endpoint:ws:user:alice",
      thread_id: "thread:ws:t1",
      correlation_id: null,
      response_expected: true,
      current_context_id: "ctx_abc",
      current_context_participants: [
        "endpoint:ws:user:alice",
        "endpoint:ws:agent:floe",
      ],
    });
    expect(result).toContain("current_context");
    expect(result).toContain("ctx_abc");
    // Strict: each participant is rendered as a list item under participants:
    expect(result).toMatch(/participants:\s*\n\s*-\s+endpoint:ws:user:alice/);
    expect(result).toMatch(/participants:\s*\n[\s\S]*-\s+endpoint:ws:agent:floe/);
    // Negative: not rendered as the literal placeholder "[]"
    expect(result).not.toMatch(/participants:\s*\[\]/);
  });

  it("does NOT include a global contexts list (no 'available_contexts', no 'all_contexts')", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "endpoint:ws:user:alice",
      reply_destination_endpoint_id: "endpoint:ws:user:alice",
      thread_id: "thread:ws:t1",
      correlation_id: null,
      response_expected: true,
      current_context_id: "ctx_abc",
      current_context_participants: ["endpoint:ws:user:alice", "endpoint:ws:agent:floe"],
    });
    expect(result).not.toContain("available_contexts");
    expect(result).not.toContain("all_contexts");
    expect(result).not.toContain("source_contexts");
  });

  it("omits current_context block when no context_id provided (back-compat)", () => {
    const result = renderDestinationContext({
      source_endpoint_id: "endpoint:ws:user:alice",
      reply_destination_endpoint_id: "endpoint:ws:user:alice",
      thread_id: "thread:ws:t1",
      correlation_id: null,
      response_expected: true,
    });
    expect(result).not.toContain("current_context");
  });
});
