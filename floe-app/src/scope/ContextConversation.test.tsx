/**
 * Tests for ContextConversation participant gate.
 *
 * Gate rule: the compose/reply input is hidden (replaced by a non-participant
 * notice) when the currently selected "speaking as" actor is NOT in the
 * context's participants list.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  ContextConversation,
  conversationDeliveryState,
  mergeOperatorProgress,
  operatorProgressFromTelemetry,
} from "./ContextConversation.tsx";
import * as client from "../bus-client/client.ts";

const modelControl = vi.hoisted(() => ({ ready: true }));

vi.mock("../bus-client/client.ts", () => ({
  getContext: vi.fn(),
  listContextEvents: vi.fn(),
  listDeliveries: vi.fn(),
  listRuntimeTelemetry: vi.fn(),
  emit: vi.fn(),
}));

vi.mock("../bus-client/stream.ts", () => ({
  subscribeEvents: vi.fn(() => () => {}),
}));

vi.mock("../workspace/FloeModelControl.tsx", async () => {
  const ReactModule = await import("react");
  return {
    FloeModelControl: ({ onReadyChange }: { onReadyChange: (ready: boolean) => void }) => {
      ReactModule.useEffect(() => onReadyChange(modelControl.ready), [onReadyChange]);
      return <div data-testid="model-control">model</div>;
    },
  };
});

// contextLabel from ScopeDetail is a pure helper — mock ScopeDetail minimally
vi.mock("./ScopeDetail.tsx", () => ({
  contextLabel: (ctx: { title?: string | null; context_id: string }) =>
    ctx.title ?? ctx.context_id,
}));

const PARTICIPANT_EP = "ep-participant";
const NON_PARTICIPANT_EP = "ep-outsider";

const mockContext = {
  context_id: "ctx-1",
  workspace_id: "ws-1",
  scope_id: "scope-1",
  participants: [PARTICIPANT_EP],
  title: "Test Context",
  first_message_preview: null,
  created_at: "2026-01-01T00:00:00Z",
  last_event_at: null,
};

const endpoints = [
  { endpoint_id: PARTICIPANT_EP, workspace_id: "ws-1", name: "Alice", agent_id: null, bridge_id: null, status: "active", metadata_json: "{}", created_at: "", updated_at: "" },
  { endpoint_id: NON_PARTICIPANT_EP, workspace_id: "ws-1", name: "Bob", agent_id: null, bridge_id: null, status: "active", metadata_json: "{}", created_at: "", updated_at: "" },
];

function conversationEvent(
  eventId: string,
  sourceEndpointId: string,
  type: string,
  content: Record<string, unknown>,
) {
  return {
    event_id: eventId,
    type,
    workspace_id: "ws-1",
    source_endpoint_id: sourceEndpointId,
    thread_id: "thread-1",
    context_id: "ctx-1",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "context", context_id: "ctx-1" },
    content,
    response: { expected: false },
    metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  } as const;
}

beforeEach(() => {
  vi.clearAllMocks();
  modelControl.ready = true;
  vi.mocked(client.getContext).mockResolvedValue(mockContext as any);
  vi.mocked(client.listContextEvents).mockResolvedValue([]);
  vi.mocked(client.listDeliveries).mockResolvedValue([]);
  vi.mocked(client.listRuntimeTelemetry).mockResolvedValue([]);
  vi.mocked(client.emit).mockResolvedValue({} as never);

  // Clear localStorage between tests so speakingAs defaults are fresh
  try { localStorage.clear(); } catch { /* ignore */ }
});

afterEach(() => cleanup());

describe("ContextConversation — participant gate", () => {
  it("shows the compose input when the first (participant) actor is selected", async () => {
    // First endpoint is the participant; localStorage is empty so it defaults to endpoints[0]
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
      />,
    );

    // Wait for context to load
    const textarea = await screen.findByLabelText("Compose message");
    expect(textarea).toBeTruthy();
    expect(screen.queryByLabelText("Not a participant")).toBeNull();
  });

  it("hides the compose input and shows notice when acting actor is NOT a participant", async () => {
    // Force speakingAs to the non-participant endpoint via localStorage
    try { localStorage.setItem("floe.speakingAsEndpointId", NON_PARTICIPANT_EP); } catch { /* ignore */ }

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
      />,
    );

    // Wait for context to load
    const notice = await screen.findByLabelText("Not a participant");
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain("not a participant");
    expect(screen.queryByLabelText("Compose message")).toBeNull();
  });

  it("shows compose input when acting actor IS a participant (saved in localStorage)", async () => {
    try { localStorage.setItem("floe.speakingAsEndpointId", PARTICIPANT_EP); } catch { /* ignore */ }

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
      />,
    );

    const textarea = await screen.findByLabelText("Compose message");
    expect(textarea).toBeTruthy();
    expect(screen.queryByLabelText("Not a participant")).toBeNull();
  });

  it("presents the fixed operator conversation without substrate-oriented identity controls", async () => {
    const onNewConversation = vi.fn();
    const onDeleteConversation = vi.fn();
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ speakingAsEndpointId: PARTICIPANT_EP, onNewConversation, onDeleteConversation }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Floe" })).toBeTruthy();
    expect(screen.getByLabelText("Compose message")).toBeTruthy();
    expect(screen.queryByLabelText("Speaking as")).toBeNull();
    expect(screen.queryByText("Context")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onNewConversation).toHaveBeenCalledOnce();
    expect(onDeleteConversation).toHaveBeenCalledOnce();
  });

  it("presents another collaborator by name when opened from operator conversations", async () => {
    const onBackToConversations = vi.fn();
    vi.mocked(client.getContext).mockResolvedValue({
      ...mockContext,
      participants: [PARTICIPANT_EP, NON_PARTICIPANT_EP],
      title: "Decide the product audience",
    } as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{
          speakingAsEndpointId: PARTICIPANT_EP,
          showContextIdentity: true,
          onBackToConversations,
        }}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Bob" })).toBeTruthy();
    expect(screen.getByText("Decide the product audience")).toBeTruthy();
    expect(screen.getByPlaceholderText("Message Bob…")).toBeTruthy();
    expect(screen.queryByLabelText("Speaking as")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Conversations/ }));
    expect(onBackToConversations).toHaveBeenCalledOnce();
  });

  it("marks an operator message as expecting a reply", async () => {
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ speakingAsEndpointId: PARTICIPANT_EP }}
      />,
    );

    const input = await screen.findByLabelText("Compose message");
    fireEvent.change(input, { target: { value: "Help me reach this outcome" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(client.emit).toHaveBeenCalledWith(expect.objectContaining({
      response: { expected: true },
    })));
  });

  it("disables an existing operator conversation until the workspace model is ready", async () => {
    modelControl.ready = false;
    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ speakingAsEndpointId: PARTICIPANT_EP }}
      />,
    );

    const input = await screen.findByLabelText("Compose message") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByText("Choose a provider and model before talking to Floe.")).toBeTruthy();
    expect(client.emit).not.toHaveBeenCalled();
  });

  it("renders Markdown and places the operator on the right and collaborators on the left", async () => {
    vi.mocked(client.getContext).mockResolvedValue({
      ...mockContext,
      participants: [PARTICIPANT_EP, NON_PARTICIPANT_EP],
    } as any);
    vi.mocked(client.listContextEvents).mockResolvedValue([
      conversationEvent("event-operator", PARTICIPANT_EP, "message", { text: "**Outcome** accepted" }),
      conversationEvent("event-collaborator", NON_PARTICIPANT_EP, "message", { text: "- First step\n- Second step" }),
    ] as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ speakingAsEndpointId: PARTICIPANT_EP }}
      />,
    );

    const operatorMessage = await screen.findByLabelText("Message from Alice");
    const collaboratorMessage = screen.getByLabelText("Message from Bob");
    expect(operatorMessage.getAttribute("data-message-side")).toBe("right");
    expect(collaboratorMessage.getAttribute("data-message-side")).toBe("left");
    expect(screen.getByText("Outcome").tagName).toBe("STRONG");
    expect(screen.getByText("First step").tagName).toBe("LI");
  });

  it("renders files deliberately attached to a conversation message", async () => {
    vi.mocked(client.listContextEvents).mockResolvedValue([
      conversationEvent("event-attachment", PARTICIPANT_EP, "message", {
        text: "This is what I see.",
        attachments: [{
          path: ".floe/state/attachments/ctx-1/screen.png",
          name: "screen.png",
          media_type: "image/png",
          bytes: 2048,
        }],
      }),
    ] as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        operatorEntry={{ speakingAsEndpointId: PARTICIPANT_EP }}
      />,
    );

    expect(await screen.findByText("This is what I see.")).toBeTruthy();
    expect(screen.getByText("screen.png")).toBeTruthy();
    expect(screen.getByText("2 KB")).toBeTruthy();
  });

  it("shows public work events in a read-only inspector without exposing a composer", async () => {
    vi.mocked(client.listContextEvents).mockResolvedValue([
      conversationEvent("event-work", NON_PARTICIPANT_EP, "application.slice.dispatched", {
        summary: "Implement the first vertical slice",
      }),
    ] as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        alignRightEndpointId={PARTICIPANT_EP}
        showWorkEvents
        readOnly
      />,
    );

    expect(await screen.findByText("Implement the first vertical slice")).toBeTruthy();
    expect(screen.getByText("application.slice.dispatched")).toBeTruthy();
    expect(screen.queryByLabelText("Compose message")).toBeNull();
    expect(screen.queryByLabelText("Not a participant")).toBeNull();
  });
});

describe("conversation delivery state", () => {
  const row = (state: string, error: string | null = null) => ({
    delivery_id: `delivery-${state}`,
    endpoint_id: "ep-floe",
    workspace_id: "ws-1",
    trigger_event_id: "event-1",
    events_json: JSON.stringify([{ context_id: "ctx-1" }]),
    state,
    lease_expires_at: null,
    attempt_count: 1,
    last_error: error,
    created_at: "2026-01-01T00:00:00Z",
    claimed_at: null,
  });

  it("restores a working indicator when the conversation mounts after delivery began", () => {
    const result = conversationDeliveryState([row("injected_to_runtime")], "ctx-1");
    expect(result.working.get("ep-floe")).toBe("delivery-injected_to_runtime");
    expect(result.notice).toBeNull();
  });

  it("turns a deferred authentication failure into an actionable operator notice", () => {
    const result = conversationDeliveryState([
      row("deferred", "provider_auth_missing: no credential"),
    ], "ctx-1");
    expect(result.notice).toMatch(/connected model/i);
  });
});

describe("runtime interruption", () => {
  it("replaces stale working state with an explicit service failure", async () => {
    vi.mocked(client.listDeliveries).mockResolvedValue([{
      delivery_id: "delivery-active",
      endpoint_id: PARTICIPANT_EP,
      workspace_id: "ws-1",
      trigger_event_id: "event-1",
      events_json: JSON.stringify([{ context_id: "ctx-1" }]),
      state: "injected_to_runtime",
      lease_expires_at: null,
      attempt_count: 1,
      last_error: null,
      created_at: "2026-01-01T00:00:00Z",
      claimed_at: null,
    }] as any);

    render(
      <ContextConversation
        contextId="ctx-1"
        workspaceId="ws-1"
        endpoints={endpoints}
        runtimeHealth={{
          state: "offline",
          label: "Floe needs attention",
          detail: "Local services stopped.",
        }}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toMatch(/local services stopped while this work was active/i);
    await waitFor(() => expect(screen.queryByText("Alice is working")).toBeNull());
  });
});

describe("operator work progress", () => {
  const telemetry = (kind: string, payload: Record<string, unknown>, createdAt = "2026-01-01T00:00:00Z") => ({
    telemetry_id: `telemetry-${kind}-${createdAt}`,
    workspace_id: "ws-1",
    endpoint_id: "ep-floe",
    delivery_id: "delivery-1",
    kind,
    payload_json: JSON.stringify(payload),
    created_at: createdAt,
  });

  it("turns tool telemetry into concise progress without exposing command arguments", () => {
    const result = operatorProgressFromTelemetry(telemetry("BeforeToolUse", {
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "secret command text" },
    }));

    expect(result?.text).toBe("Running and verifying workspace automation");
    expect(JSON.stringify(result)).not.toContain("secret command text");
  });

  it("replaces a running action with its completion and keeps recent actions bounded", () => {
    const rows = [
      telemetry("BeforeToolUse", { toolCallId: "call-1", toolName: "write", args: { path: "pipeline.ts" } }),
      telemetry("AfterToolUse", { toolCallId: "call-1", toolName: "write", files_touched: ["pipeline.ts"] }, "2026-01-01T00:00:01Z"),
      ...Array.from({ length: 6 }, (_, index) => telemetry(
        "BeforeToolUse",
        { toolCallId: `call-${index + 2}`, toolName: "read" },
        `2026-01-01T00:00:0${index + 2}Z`,
      )),
    ];

    const result = mergeOperatorProgress([], rows);
    expect(result).toHaveLength(5);
    expect(result.some(progress => progress.toolCallId === "call-1")).toBe(false);
  });

  it("describes a failed command as adaptation rather than exposing raw output", () => {
    const result = operatorProgressFromTelemetry(telemetry("AfterToolUse", {
      toolCallId: "call-1",
      toolName: "bash",
      summary: "bash: private details (timeout, 30000ms)",
    }));

    expect(result?.text).toBe("A step did not succeed; Floe is adapting");
  });
});
