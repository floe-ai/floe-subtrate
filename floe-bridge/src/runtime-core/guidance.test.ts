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
});
