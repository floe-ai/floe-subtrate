/**
 * Context module tests.
 *
 * Tests cover:
 *  - TraceDrawer: structured trace display, work-log request, system-originated events
 *  - Composer: emits a "message" event with endpoint (or broadcast) destination
 *              and source = the acting actor (new contract)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Mock bus-client — all network calls go through here
// ---------------------------------------------------------------------------
vi.mock("../bus-client/client.ts", () => ({
  getEventTrace: vi.fn(),
  emit: vi.fn(),
  getContext: vi.fn(),
  listContextEvents: vi.fn(),
}));

import { getEventTrace, emit } from "../bus-client/client.ts";
import type { EventEnvelope, EventTrace, EmitInput, EndpointRef } from "../bus-client/types.ts";
import { TraceDrawer } from "./TraceDrawer.tsx";
import { Composer } from "./Composer.tsx";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: "evt-001",
    type: "floe.test.event",
    workspace_id: "ws-001",
    source_endpoint_id: "ep-actor-001",
    thread_id: "thread-001",
    context_id: "ctx-001",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "endpoint", endpoint_id: "ep-other" },
    content: {},
    response: { expected: false },
    metadata: {},
    created_at: "2026-06-12T00:00:00Z",
    ...overrides,
  };
}

function makeTrace(overrides: Partial<EventTrace> = {}): EventTrace {
  return {
    event_id: "evt-001",
    delivery_id: "del-001",
    telemetry: [
      { kind: "llm_call", tokens_in: 100, tokens_out: 50, model: "claude-sonnet-4-5" },
    ],
    ...overrides,
  };
}

function makeEndpoint(id: string, name: string): EndpointRef {
  return {
    endpoint_id: id,
    workspace_id: "ws-001",
    name,
    agent_id: null,
    bridge_id: null,
    status: "idle",
    metadata_json: "{}",
    created_at: "2026-06-12T00:00:00Z",
    updated_at: "2026-06-12T00:00:00Z",
  };
}

// ---------------------------------------------------------------------------
// TraceDrawer
// ---------------------------------------------------------------------------

describe("TraceDrawer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("shows structured trace synchronously", () => {
    const event = makeEvent();
    const trace = makeTrace();

    const { getByTestId, getByText, queryByTestId } = render(
      React.createElement(TraceDrawer, {
        event,
        trace,
        onRequestWorklog: vi.fn(),
      })
    );

    // Drawer is rendered
    expect(getByTestId("trace-drawer")).toBeTruthy();
    // Trace content section is present
    expect(getByTestId("trace-content")).toBeTruthy();
    // Telemetry entry is rendered (JSON stringified)
    expect(getByText(/llm_call/)).toBeTruthy();
    // Delivery ID is shown
    expect(getByText("del-001")).toBeTruthy();
    // System-originated notice is NOT shown
    expect(queryByTestId("system-originated-notice")).toBeNull();
  });

  it("requests work-log via actor on demand", () => {
    const event = makeEvent({ source_endpoint_id: "ep-actor-007" });
    const trace = makeTrace();
    const onRequestWorklog = vi.fn();

    const { getByTestId } = render(
      React.createElement(TraceDrawer, {
        event,
        trace,
        onRequestWorklog,
      })
    );

    // The button must be labelled clearly with the actor id
    const btn = getByTestId("request-worklog-btn");
    expect(btn).toBeTruthy();
    expect(btn.getAttribute("aria-label")).toContain("ep-actor-007");
    expect(getByTestId("actor-label").textContent).toBe("ep-actor-007");

    // Click the button — must call onRequestWorklog with correct args
    fireEvent.click(btn);
    expect(onRequestWorklog).toHaveBeenCalledTimes(1);
    expect(onRequestWorklog).toHaveBeenCalledWith("evt-001", "ep-actor-007");

    // Must NOT call emit automatically (no auto-fetch on expand)
    expect(emit).not.toHaveBeenCalled();
  });

  it("handles system-originated events with no trace", () => {
    // delivery_id === null → system-originated
    const event = makeEvent({ source_endpoint_id: null });
    const trace = makeTrace({ delivery_id: null, telemetry: [] });

    const { getByTestId, queryByTestId } = render(
      React.createElement(TraceDrawer, {
        event,
        trace,
        onRequestWorklog: vi.fn(),
      })
    );

    // Must show the system-originated fallback text
    const notice = getByTestId("system-originated-notice");
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain("System-originated");
    expect(notice.textContent).toContain("no runtime trace");

    // Trace content (telemetry rows) must NOT be rendered
    expect(queryByTestId("trace-content")).toBeNull();

    // Work-log button must NOT be rendered (no source actor)
    expect(queryByTestId("request-worklog-btn")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Composer — new contract: type "message", endpoint/broadcast destination,
// source = actingAsEndpointId
// ---------------------------------------------------------------------------

describe("Composer", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  const endpoints: EndpointRef[] = [
    makeEndpoint("ep-operator", "Operator"),
    makeEndpoint("ep-floe", "Floe"),
  ];

  it("emits a message event with type='message' and endpoint destination", async () => {
    const onEmit = vi.fn().mockResolvedValue(undefined);

    const { getByTestId } = render(
      React.createElement(Composer, {
        workspaceId: "ws-001",
        contextId: "ctx-001",
        actingAsEndpointId: "ep-operator",
        endpoints,
        participantEndpointIds: ["ep-operator", "ep-floe"],
        onEmit,
      })
    );

    const textarea = getByTestId("composer-input") as HTMLTextAreaElement;
    const sendBtn = getByTestId("composer-send") as HTMLButtonElement;

    // Type a message
    fireEvent.change(textarea, { target: { value: "Hello from the context surface" } });
    expect(textarea.value).toBe("Hello from the context surface");

    // Click send
    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(onEmit).toHaveBeenCalledTimes(1);
    });

    const emitted: EmitInput = onEmit.mock.calls[0][0];
    // New contract: type must be "message"
    expect(emitted.type).toBe("message");
    expect(emitted.workspace_id).toBe("ws-001");
    // Source is the acting actor
    expect(emitted.source_endpoint_id).toBe("ep-operator");
    // Destination is an endpoint (the other participant)
    expect(emitted.destination.kind).toBe("endpoint");
    expect(emitted.context_id).toBe("ctx-001");
    expect(emitted.content).toEqual({ text: "Hello from the context surface" });
    // Response expectation is present
    expect(emitted.response).toBeDefined();
    expect(emitted.response?.expected).toBe(true);
    expect(emitted.response?.mode).toBe("open");
    // metadata must be present
    expect(emitted.metadata).toMatchObject({ submitted_by: "floe-app" });

    // Input is cleared after successful send
    await waitFor(() => {
      expect(textarea.value).toBe("");
    });
  });

  it("submits on Enter key without Shift", async () => {
    const onEmit = vi.fn().mockResolvedValue(undefined);

    const { getByTestId } = render(
      React.createElement(Composer, {
        workspaceId: "ws-001",
        contextId: "ctx-001",
        actingAsEndpointId: "ep-operator",
        endpoints,
        participantEndpointIds: ["ep-operator", "ep-floe"],
        onEmit,
      })
    );

    const textarea = getByTestId("composer-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Keyboard submit test" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => {
      expect(onEmit).toHaveBeenCalledTimes(1);
    });

    const emitted: EmitInput = onEmit.mock.calls[0][0];
    expect(emitted.content).toEqual({ text: "Keyboard submit test" });
    expect(emitted.type).toBe("message");
  });

  it("does not submit on Shift+Enter", () => {
    const onEmit = vi.fn().mockResolvedValue(undefined);

    const { getByTestId } = render(
      React.createElement(Composer, {
        workspaceId: "ws-001",
        contextId: "ctx-001",
        actingAsEndpointId: "ep-operator",
        endpoints,
        participantEndpointIds: ["ep-operator", "ep-floe"],
        onEmit,
      })
    );

    const textarea = getByTestId("composer-input") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Multi-line draft" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(onEmit).not.toHaveBeenCalled();
  });

  it("does not emit when text is empty or whitespace only", () => {
    const onEmit = vi.fn().mockResolvedValue(undefined);

    const { getByTestId } = render(
      React.createElement(Composer, {
        workspaceId: "ws-001",
        contextId: "ctx-001",
        actingAsEndpointId: "ep-operator",
        endpoints,
        participantEndpointIds: ["ep-operator", "ep-floe"],
        onEmit,
      })
    );

    const sendBtn = getByTestId("composer-send") as HTMLButtonElement;
    // Button should be disabled when input is empty
    expect(sendBtn.disabled).toBe(true);

    // Try clicking anyway
    fireEvent.click(sendBtn);
    expect(onEmit).not.toHaveBeenCalled();
  });

  it("uses getEventTrace only via EventStream (not called by Composer)", async () => {
    // Regression: Composer must never call getEventTrace
    const onEmit = vi.fn().mockResolvedValue(undefined);

    const { getByTestId } = render(
      React.createElement(Composer, {
        workspaceId: "ws-001",
        contextId: "ctx-001",
        actingAsEndpointId: "ep-operator",
        endpoints,
        participantEndpointIds: ["ep-operator", "ep-floe"],
        onEmit,
      })
    );

    const textarea = getByTestId("composer-input");
    fireEvent.change(textarea, { target: { value: "Test" } });
    fireEvent.click(getByTestId("composer-send"));

    await waitFor(() => expect(onEmit).toHaveBeenCalledTimes(1));
    expect(getEventTrace).not.toHaveBeenCalled();
  });

  it("allows selecting a broadcast destination", async () => {
    const onEmit = vi.fn().mockResolvedValue(undefined);

    const { getByTestId } = render(
      React.createElement(Composer, {
        workspaceId: "ws-001",
        contextId: "ctx-001",
        actingAsEndpointId: "ep-operator",
        endpoints,
        participantEndpointIds: ["ep-operator", "ep-floe"],
        onEmit,
      })
    );

    // Change destination to broadcast:all
    const destSelect = getByTestId("composer-dest") as HTMLSelectElement;
    fireEvent.change(destSelect, { target: { value: "broadcast:all" } });

    const textarea = getByTestId("composer-input");
    fireEvent.change(textarea, { target: { value: "Broadcast message" } });
    fireEvent.click(getByTestId("composer-send"));

    await waitFor(() => expect(onEmit).toHaveBeenCalledTimes(1));

    const emitted: EmitInput = onEmit.mock.calls[0][0];
    expect(emitted.type).toBe("message");
    expect(emitted.destination).toEqual({ kind: "broadcast", scope: "workspace", target: "all" });
  });
});
