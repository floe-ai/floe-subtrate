/**
 * Briefing module tests.
 *
 * sinceDiff — pure function, no mocks needed.
 * DecisionCard — React component tests via @testing-library/react.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import { sinceDiff } from "./sinceDiff.ts";
import type { EventEnvelope, DecisionCard as DecisionCardType } from "../bus-client/types.ts";

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
// DecisionCard — rendered via @testing-library/react
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

function makeCard(impactOverride: DecisionCardType["impact"]): DecisionCardType {
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
    impact: impactOverride,
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

describe("DecisionCard", () => {
  it("renders impact block", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { DecisionCard } = await import("./DecisionCard.tsx");

    const card = makeCard({
      architecture: "Adds new service boundary",
      product: "Enables offline mode",
      risk: "Low — reversible",
      cost: "$200/month",
    });

    render(
      DecisionCard({ card, onAct: vi.fn() })
    );

    // Impact block exists and is not the "missing" alert
    const impactSection = document.querySelector("[data-section='impact']");
    expect(impactSection).not.toBeNull();
    expect(impactSection?.getAttribute("data-missing-impact")).toBeNull();

    // All four impact fields are visible
    expect(screen.getByText(/Adds new service boundary/i)).toBeTruthy();
    expect(screen.getByText(/Enables offline mode/i)).toBeTruthy();
    expect(screen.getByText(/Low — reversible/i)).toBeTruthy();
    expect(screen.getByText(/\$200\/month/i)).toBeTruthy();

    // No missing-impact alert
    expect(document.querySelector("[data-missing-impact='true']")).toBeNull();
  });

  it("surfaces missing impact loudly", async () => {
    const { render, screen } = await import("@testing-library/react");
    const { DecisionCard } = await import("./DecisionCard.tsx");

    const card = makeCard(null);

    render(
      DecisionCard({ card, onAct: vi.fn() })
    );

    // Missing impact indicator must be present and loud
    const missing = document.querySelector("[data-missing-impact='true']");
    expect(missing).not.toBeNull();

    // Must attribute the omission to the asking actor by name (may appear in multiple nodes)
    expect(screen.getAllByText(/Planner Agent/i).length).toBeGreaterThan(0);

    // Must use role=alert (accessible loudness)
    expect(missing?.getAttribute("role")).toBe("alert");

    // The card should NOT be blank — "No impact summary" text must appear
    expect(screen.getByText(/No impact summary provided/i)).toBeTruthy();
  });
});
