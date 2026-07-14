/**
 * Tests for Ops.tsx push subscriptions (P9 — zero-poll UI).
 *
 * Verifies that EventsSection and PulsesSection subscribe to the bus WS stream
 * and reload when the relevant bus broadcasts arrive — no polling required.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import { Ops } from "./Ops.tsx";
import * as client from "../bus-client/client.ts";
import * as stream from "../bus-client/stream.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../bus-client/client.ts", () => ({
  listContexts: vi.fn(),
  listEvents: vi.fn(),
  queryPulses: vi.fn(),
  createPulse: vi.fn(),
  pausePulse: vi.fn(),
  resumePulse: vi.fn(),
  cancelPulse: vi.fn(),
  subscribePulse: vi.fn(),
  unsubscribePulse: vi.fn(),
}));

vi.mock("./ScopeDetail.tsx", () => ({
  contextLabel: (ctx: { title?: string | null; context_id: string }) =>
    ctx.title ?? ctx.context_id,
}));

// We capture and expose the subscribeEvents handler so tests can trigger it.
type StreamHandler = (msg: { type: string; payload: Record<string, unknown> }) => void;
let capturedHandlers: StreamHandler[] = [];

vi.mock("../bus-client/stream.ts", () => ({
  subscribeEvents: vi.fn((handler: StreamHandler) => {
    capturedHandlers.push(handler);
    return () => {
      capturedHandlers = capturedHandlers.filter(h => h !== handler);
    };
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(type: string, payload: Record<string, unknown> = {}): void {
  for (const h of [...capturedHandlers]) {
    h({ type, payload });
  }
}

const WS_ID = "ws-1";
const SCOPE_ID = "scope-1";

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "ev-1",
    type: "test.event",
    workspace_id: WS_ID,
    scope_id: SCOPE_ID,
    context_id: "ctx-1",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makePulse(overrides: Record<string, unknown> = {}) {
  return {
    pulse_id: "pulse-1",
    workspace_id: WS_ID,
    scope_id: SCOPE_ID,
    status: "active",
    trigger: { type: "once", at: new Date(Date.now() + 86400000).toISOString() },
    subscribers: [],
    fire_count: 0,
    next_fire_at: null,
    last_fired_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  capturedHandlers = [];
  vi.clearAllMocks();

  vi.mocked(client.listContexts).mockResolvedValue([]);
  vi.mocked(client.listEvents).mockResolvedValue({ events: [], next_cursor: null });
  vi.mocked(client.queryPulses).mockResolvedValue([]);
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// EventsSection — push subscription
// ---------------------------------------------------------------------------

describe("Ops — EventsSection push subscription", () => {
  it("reloads events when event_submitted arrives for this scope", async () => {
    const ev1 = makeEvent({ event_id: "ev-1", type: "first.event" });
    vi.mocked(client.listEvents).mockResolvedValueOnce({ events: [], next_cursor: null });

    render(<Ops workspaceId={WS_ID} scopeId={SCOPE_ID} />);
    // Wait for initial load
    await screen.findByText("No events in this scope yet.");
    expect(vi.mocked(client.listEvents)).toHaveBeenCalledTimes(1);

    // Second call returns one event
    vi.mocked(client.listEvents).mockResolvedValueOnce({ events: [ev1 as any], next_cursor: null });

    await act(async () => {
      emit("event_submitted", {
        event: { workspace_id: WS_ID, scope_id: SCOPE_ID, event_id: "ev-1" },
      });
    });

    expect(vi.mocked(client.listEvents)).toHaveBeenCalledTimes(2);
    await screen.findByText("first.event");
  });

  it("does NOT reload events when event_submitted is for a different scope", async () => {
    vi.mocked(client.listEvents).mockResolvedValue({ events: [], next_cursor: null });
    render(<Ops workspaceId={WS_ID} scopeId={SCOPE_ID} />);
    await screen.findByText("No events in this scope yet.");
    const callsBefore = vi.mocked(client.listEvents).mock.calls.length;

    await act(async () => {
      emit("event_submitted", {
        event: { workspace_id: WS_ID, scope_id: "other-scope" },
      });
    });

    expect(vi.mocked(client.listEvents).mock.calls.length).toBe(callsBefore);
  });
});

// ---------------------------------------------------------------------------
// PulsesSection — push subscription
// ---------------------------------------------------------------------------

describe("Ops — PulsesSection push subscription", () => {
  it("reloads pulses when pulse_created arrives for this scope", async () => {
    const p1 = makePulse({ pulse_id: "daily_check" });
    vi.mocked(client.queryPulses).mockResolvedValueOnce([]);
    render(<Ops workspaceId={WS_ID} scopeId={SCOPE_ID} />);
    await screen.findByText("No pulses in this scope yet.");
    expect(vi.mocked(client.queryPulses)).toHaveBeenCalledTimes(1);

    vi.mocked(client.queryPulses).mockResolvedValueOnce([p1 as any]);
    await act(async () => {
      emit("pulse_created", {
        pulse: { workspace_id: WS_ID, scope_id: SCOPE_ID, pulse_id: "daily_check" },
      });
    });

    expect(vi.mocked(client.queryPulses)).toHaveBeenCalledTimes(2);
    await screen.findByText("daily_check");
  });

  it("reloads pulses when pulse_paused arrives for this scope", async () => {
    vi.mocked(client.queryPulses).mockResolvedValue([]);
    render(<Ops workspaceId={WS_ID} scopeId={SCOPE_ID} />);
    await screen.findByText("No pulses in this scope yet.");
    const callsBefore = vi.mocked(client.queryPulses).mock.calls.length;

    await act(async () => {
      emit("pulse_paused", {
        pulse: { workspace_id: WS_ID, scope_id: SCOPE_ID, pulse_id: "p1" },
      });
    });

    expect(vi.mocked(client.queryPulses).mock.calls.length).toBe(callsBefore + 1);
  });

  it("reloads pulses when pulse_fired arrives (no scope in payload)", async () => {
    vi.mocked(client.queryPulses).mockResolvedValue([]);
    render(<Ops workspaceId={WS_ID} scopeId={SCOPE_ID} />);
    await screen.findByText("No pulses in this scope yet.");
    const callsBefore = vi.mocked(client.queryPulses).mock.calls.length;

    await act(async () => {
      emit("pulse_fired", { pulse_id: "any-pulse", fired_at: new Date().toISOString(), subscriber_count: 1 });
    });

    // pulse_fired has no pulse object → unconditional reload
    expect(vi.mocked(client.queryPulses).mock.calls.length).toBe(callsBefore + 1);
  });

  it("does NOT reload pulses when pulse_created is for a different scope", async () => {
    vi.mocked(client.queryPulses).mockResolvedValue([]);
    render(<Ops workspaceId={WS_ID} scopeId={SCOPE_ID} />);
    await screen.findByText("No pulses in this scope yet.");
    const callsBefore = vi.mocked(client.queryPulses).mock.calls.length;

    await act(async () => {
      emit("pulse_created", {
        pulse: { workspace_id: WS_ID, scope_id: "other-scope", pulse_id: "p-other" },
      });
    });

    expect(vi.mocked(client.queryPulses).mock.calls.length).toBe(callsBefore);
  });

  it("cleans up subscriptions on unmount (no leaks)", async () => {
    vi.mocked(client.queryPulses).mockResolvedValue([]);
    const { unmount } = render(<Ops workspaceId={WS_ID} scopeId={SCOPE_ID} />);
    await screen.findByText("No pulses in this scope yet.");
    const handlersBeforeUnmount = capturedHandlers.length;

    unmount();

    expect(capturedHandlers.length).toBeLessThan(handlersBeforeUnmount);
  });
});
