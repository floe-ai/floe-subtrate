/**
 * Briefing module tests.
 *
 * sinceDiff — pure function, no mocks needed.
 * WaitingItem — React component tests via @testing-library/react.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { sinceDiff } from "./sinceDiff.ts";
import type { EventEnvelope, WaitingItem as WaitingItemType } from "../bus-client/types.ts";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(
  overrides: Partial<EventEnvelope> & { event_id: string; created_at: string }
): EventEnvelope {
  return {
    type: "test.event",
    workspace_id: "ws-1",
    source_endpoint_id: null,
    thread_id: "thread-1",
    context_id: "ctx-1",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "broadcast", scope: "workspace", target: "all" },
    content: {},
    response: { expected: false },
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// sinceDiff
// ---------------------------------------------------------------------------

describe("sinceDiff", () => {
  it("marks events after the watermark as unseen", () => {
    const older = makeEnvelope({ event_id: "evt-1", created_at: "2026-06-01T10:00:00Z" });
    const boundary = makeEnvelope({ event_id: "evt-2", created_at: "2026-06-01T11:00:00Z" });
    const newer1 = makeEnvelope({ event_id: "evt-3", created_at: "2026-06-01T12:00:00Z" });
    const newer2 = makeEnvelope({ event_id: "evt-4", created_at: "2026-06-01T13:00:00Z" });

    const { seen, unseen } = sinceDiff(
      [older, boundary, newer1, newer2],
      { created_at: boundary.created_at, event_id: boundary.event_id }
    );

    // older and the boundary itself are seen
    expect(seen.map((e) => e.event_id)).toEqual(["evt-1", "evt-2"]);
    // only events strictly after the boundary are unseen
    expect(unseen.map((e) => e.event_id)).toEqual(["evt-3", "evt-4"]);
  });

  it("treats all events as unseen when boundary is null", () => {
    const ev1 = makeEnvelope({ event_id: "evt-a", created_at: "2026-06-01T09:00:00Z" });
    const ev2 = makeEnvelope({ event_id: "evt-b", created_at: "2026-06-01T10:00:00Z" });

    const { seen, unseen } = sinceDiff([ev1, ev2], null);

    expect(seen).toHaveLength(0);
    expect(unseen).toHaveLength(2);
  });

  it("uses event_id as tie-breaker when created_at is equal", () => {
    // Same timestamp, different event_ids; boundary is the lower id
    const same_ts = "2026-06-01T12:00:00Z";
    const evA = makeEnvelope({ event_id: "evt-aaa", created_at: same_ts });
    const evB = makeEnvelope({ event_id: "evt-bbb", created_at: same_ts });
    const evC = makeEnvelope({ event_id: "evt-ccc", created_at: same_ts });

    // boundary = evA; evB and evC come after it lexicographically
    const { seen, unseen } = sinceDiff([evA, evB, evC], {
      created_at: evA.created_at,
      event_id: evA.event_id,
    });

    expect(seen.map((e) => e.event_id)).toContain("evt-aaa");
    expect(unseen.map((e) => e.event_id)).toEqual(
      expect.arrayContaining(["evt-bbb", "evt-ccc"])
    );
  });

  it("returns empty unseen when all events are at or before the boundary", () => {
    const ev = makeEnvelope({ event_id: "evt-only", created_at: "2026-06-01T10:00:00Z" });

    const { seen, unseen } = sinceDiff([ev], {
      created_at: "2026-06-01T12:00:00Z",
      event_id: "evt-zzzz",
    });

    expect(seen).toHaveLength(1);
    expect(unseen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// WaitingItem — rendered via @testing-library/react
// ---------------------------------------------------------------------------
// We import dynamically inside the tests so that vi.mock is hoisted before
// any module-level imports.

vi.mock("../bus-client/client.ts", () => ({
  listPendingResponses: vi.fn().mockResolvedValue([]),
  listEndpoints: vi.fn().mockResolvedValue([]),
  listPulses: vi.fn().mockResolvedValue([]),
  getWatermark: vi.fn().mockResolvedValue(null),
  listEvents: vi.fn().mockResolvedValue({ events: [], next_cursor: null }),
  putWatermark: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn().mockResolvedValue({}),
}));

function makeItem(eventContent: Record<string, unknown>): WaitingItemType {
  return {
    source: {
      pending_id: "pd-1",
      workspace_id: "ws-1",
      waiting_endpoint_id: "ep-2",
      source_event_id: "evt-src",
      mode: "open",
      thread_id: null,
      correlation_id: null,
      timeout_at: null,
      status: "pending",
      created_at: "2026-06-01T10:00:00Z",
      resolved_at: null,
    },
    eventContent,
    askingActor: {
      endpoint_id: "ep-1",
      workspace_id: "ws-1",
      name: "Planner Agent",
      agent_id: "agent-42",
      bridge_id: null,
      status: "active",
      metadata_json: "{}",
      created_at: "2026-06-01T09:00:00Z",
      updated_at: "2026-06-01T09:00:00Z",
    },
  };
}

describe("WaitingItem", () => {
  it("renders actor attribution and event content block", async () => {
    const React = await import("react");
    const { render, screen } = await import("@testing-library/react");
    const { WaitingItem } = await import("./WaitingItem.tsx");

    const item = makeItem({ reason: "Need approval to proceed", scope: "auth-service" });

    render(React.createElement(WaitingItem, { item, onReply: vi.fn(), onOpenContext: vi.fn() }));

    expect(screen.getByText(/Planner Agent/i)).toBeTruthy();
    expect(screen.getByText(/is waiting for a response/i)).toBeTruthy();

    const contentBlock = document.querySelector("[data-section='content']");
    expect(contentBlock).not.toBeNull();
    expect(contentBlock?.textContent).toContain("auth-service");
    expect(contentBlock?.textContent).toContain("Need approval to proceed");
  });

  it("renders empty content gracefully", async () => {
    const React = await import("react");
    const { render } = await import("@testing-library/react");
    const { WaitingItem } = await import("./WaitingItem.tsx");

    const item = makeItem({});

    render(React.createElement(WaitingItem, { item, onReply: vi.fn(), onOpenContext: vi.fn() }));

    const contentBlock = document.querySelector("[data-section='content']");
    expect(contentBlock?.textContent).toContain("(empty)");
  });

  it("calls onReply with typed text when Send is clicked", async () => {
    const React = await import("react");
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { WaitingItem } = await import("./WaitingItem.tsx");

    const onReply = vi.fn();
    const item = makeItem({ question: "Can you proceed?" });

    render(React.createElement(WaitingItem, { item, onReply, onOpenContext: vi.fn() }));

    const textarea = screen.getByTestId("reply-textarea");
    fireEvent.change(textarea, { target: { value: "Yes, proceeding now." } });

    const sendBtn = screen.getByTestId("reply-send");
    fireEvent.click(sendBtn);

    expect(onReply).toHaveBeenCalledWith("Yes, proceeding now.");
  });

  it("calls onReply when Enter is pressed (without Shift)", async () => {
    const React = await import("react");
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { WaitingItem } = await import("./WaitingItem.tsx");

    const onReply = vi.fn();
    const item = makeItem({});

    render(React.createElement(WaitingItem, { item, onReply, onOpenContext: vi.fn() }));

    const textarea = screen.getByTestId("reply-textarea");
    fireEvent.change(textarea, { target: { value: "Quick reply" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    expect(onReply).toHaveBeenCalledWith("Quick reply");
  });

  it("does not call onReply when Send is disabled (empty text)", async () => {
    const React = await import("react");
    const { render, screen } = await import("@testing-library/react");
    const { WaitingItem } = await import("./WaitingItem.tsx");

    const onReply = vi.fn();
    const item = makeItem({});

    render(React.createElement(WaitingItem, { item, onReply, onOpenContext: vi.fn() }));

    const sendBtn = screen.getByTestId("reply-send") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });

  it("calls onOpenContext when 'Open in context' button is clicked", async () => {
    const React = await import("react");
    const { render, screen, fireEvent } = await import("@testing-library/react");
    const { WaitingItem } = await import("./WaitingItem.tsx");

    const onOpenContext = vi.fn();
    const item = makeItem({});

    render(React.createElement(WaitingItem, { item, onReply: vi.fn(), onOpenContext }));

    const openBtn = screen.getByTestId("open-context");
    fireEvent.click(openBtn);

    expect(onOpenContext).toHaveBeenCalledTimes(1);
  });
});
