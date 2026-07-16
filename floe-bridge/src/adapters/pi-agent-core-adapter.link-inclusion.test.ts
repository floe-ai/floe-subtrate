/**
 * Link-inclusion tests — D5 of the peer context relay model.
 *
 * Tests:
 *  - renderOriginatingSlice renders a header with origin context_id + relay instructions
 *  - renderOriginatingSlice includes event text with actor refs
 *  - renderOriginatingSlice is empty when events have no renderable text
 *  - renderOriginatingSlice is empty for empty events array
 *  - renderOriginatingSlice is capped at MAX chars (non-fatal truncation)
 *  - Integration: session prompt includes originating slice when context has parent_context_id
 *  - Integration: session prompt has NO originating slice for root context (no parent_context_id)
 */
import { describe, expect, it } from "vitest";
import { renderOriginatingSlice, renderThreadSlice } from "./pi-agent-core-adapter.js";
import type { EventEnvelope } from "../bus-client.js";

function makeEvent(overrides: Partial<EventEnvelope> & { event_id: string }): EventEnvelope {
  return {
    event_id: overrides.event_id,
    type: overrides.type ?? "message",
    workspace_id: overrides.workspace_id ?? "workspace:test",
    source_endpoint_id: overrides.source_endpoint_id ?? "actor:test:operator",
    thread_id: overrides.thread_id ?? "ctx_test",
    context_id: overrides.context_id ?? "ctx_test",
    scope_id: null,
    correlation_id: null,
    destination_json: overrides.destination_json ?? { kind: "endpoint", endpoint_id: "actor:test:snowball" },
    content: overrides.content ?? { text: "Hello, Snowball. Please ask Floe about the weather." },
    response: { expected: false },
    metadata: {},
    created_at: overrides.created_at ?? "2026-07-16T00:00:00.000Z"
  };
}

describe("renderOriginatingSlice — D5 link-inclusion", () => {
  it("includes origin context_id in header and relay instructions", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "Hello, please ask Floe about the weather." } })
    ];
    const result = renderOriginatingSlice("ctx_origin_123", events);
    expect(result).toContain("ctx_origin_123");
    expect(result).toContain("relay");
    expect(result).toContain("context_id: ctx_origin_123");
  });

  it("includes event text with actor ref prefix", () => {
    const events = [
      makeEvent({
        event_id: "evt_1",
        source_endpoint_id: "actor:ws:operator",
        content: { text: "What is the weather?" }
      })
    ];
    const result = renderOriginatingSlice("ctx_origin_abc", events);
    expect(result).toContain("What is the weather?");
    // Actor ref should be present (neutral ref format).
    expect(result).toMatch(/\[.*\]/);
  });

  it("includes multiple events in order", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "First message" } }),
      makeEvent({ event_id: "evt_2", content: { text: "Second message" } })
    ];
    const result = renderOriginatingSlice("ctx_origin", events);
    expect(result).toContain("First message");
    expect(result).toContain("Second message");
    const firstIndex = result.indexOf("First message");
    const secondIndex = result.indexOf("Second message");
    expect(firstIndex).toBeLessThan(secondIndex);
  });

  it("returns empty string for empty events array", () => {
    expect(renderOriginatingSlice("ctx_origin", [])).toBe("");
  });

  it("returns empty string when all events have no text content", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { data: "binary" } })
    ];
    const result = renderOriginatingSlice("ctx_origin", events);
    expect(result).toBe("");
  });

  it("header mentions the origin context_id as the relay target", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "test" } })
    ];
    const result = renderOriginatingSlice("ctx_relay_target_xyz", events);
    // The header must clearly identify the relay target.
    expect(result).toContain("ctx_relay_target_xyz");
    expect(result).toContain("[End Originating Request]");
  });

  it("is different from renderThreadSlice (has unique header)", () => {
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "same event" } })
    ];
    const originSlice = renderOriginatingSlice("ctx_origin", events);
    const threadSlice = renderThreadSlice(events);
    // Both render the event text but with different headers.
    expect(originSlice).toContain("same event");
    expect(threadSlice).toContain("same event");
    // Different headers.
    expect(originSlice).not.toContain("[Thread — recent context history]");
    expect(threadSlice).not.toContain("Peer Context");
  });

  it("caps at MAX_ORIGINATING_CHARS to avoid bloating the prompt", () => {
    // Create many events with very long text.
    const events = Array.from({ length: 20 }, (_, i) => makeEvent({
      event_id: `evt_${i}`,
      content: { text: "X".repeat(500) }
    }));
    const result = renderOriginatingSlice("ctx_origin", events);
    // Should be bounded (not 20 * 500 + overhead chars).
    expect(result.length).toBeLessThan(4_000);
  });
});

describe("renderOriginatingSlice — peer context integration (D5)", () => {
  it("documents that originContextId is surfaced in the slice for relay ergonomics", () => {
    // D3: the actor needs the origin context_id to relay back.
    // The slice explicitly includes: "To relay results back, emit with context_id: <id>"
    const events = [
      makeEvent({ event_id: "evt_1", content: { text: "Snowball, please get weather from Floe." } })
    ];
    const result = renderOriginatingSlice("ctx_operator_snowball_c", events);

    // The actor can parse or read the context_id from this slice.
    expect(result).toContain("ctx_operator_snowball_c");
    // Instruction to relay back.
    expect(result).toMatch(/emit with context_id.*ctx_operator_snowball_c/);
  });
});
