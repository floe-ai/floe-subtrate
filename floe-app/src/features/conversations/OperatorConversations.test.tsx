import React, { useCallback, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContextRef, EndpointRef, EventEnvelope } from "../../bus-client/types.ts";
import {
  latestConversationWith,
  OperatorConversations,
  summarizeOperatorConversation,
} from "./OperatorConversations.tsx";
import * as client from "../../bus-client/client.ts";

const modelControl = vi.hoisted(() => ({ ready: true }));
const attachmentStage = vi.hoisted(() => vi.fn());

vi.mock("../../fs/conversationAttachments.ts", async importOriginal => ({
  ...(await importOriginal<typeof import("../../fs/conversationAttachments.ts")>()),
  stageConversationAttachments: attachmentStage,
}));

vi.mock("../../bus-client/client.ts", () => ({
  createDirectContext: vi.fn(),
  deleteContext: vi.fn(),
  emit: vi.fn(),
  listContextsByParticipant: vi.fn(),
  listContextEventHistoryPage: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));

vi.mock("../../scope/ContextConversation.tsx", () => ({
  ContextConversation: ({ contextId, operatorEntry }: {
    contextId: string;
    operatorEntry?: {
      showContextIdentity?: boolean;
      onBackToConversations?: () => void;
      onNewConversation?: () => void;
      onDeleteConversation?: () => void;
      onOpenWork?: () => void;
    };
  }) => (
    <div data-testid="conversation">
      <span>{contextId}:{String(operatorEntry?.showContextIdentity)}</span>
      <button type="button" onClick={operatorEntry?.onBackToConversations}>Conversations</button>
      {operatorEntry?.onOpenWork && <button type="button" onClick={operatorEntry.onOpenWork}>Work</button>}
      {operatorEntry?.onNewConversation && (
        <button type="button" onClick={operatorEntry.onNewConversation}>New conversation</button>
      )}
      <button type="button" onClick={operatorEntry?.onDeleteConversation}>Delete</button>
    </div>
  ),
}));

vi.mock("../work/ContextWorkView.tsx", () => ({
  ContextWorkView: ({ rootContextId, onBackToConversation }: {
    rootContextId: string;
    onBackToConversation: () => void;
  }) => (
    <div data-testid="work-view">
      <span>Work for {rootContextId}</span>
      <button type="button" onClick={onBackToConversation}>Conversation</button>
    </div>
  ),
}));

vi.mock("../work/ScopeWorkView.tsx", () => ({
  ScopeWorkView: ({ scope, onBack }: { scope: { title: string }; onBack: () => void }) => (
    <div data-testid="scope-work-view">
      <span>{scope.title}</span>
      <button type="button" onClick={onBack}>Workspace</button>
    </div>
  ),
}));

vi.mock("../../workspace/FloeModelControl.tsx", async () => {
  const ReactModule = await import("react");
  return {
    FloeModelControl: ({ onReadyChange }: { onReadyChange: (ready: boolean) => void }) => {
      ReactModule.useEffect(() => onReadyChange(modelControl.ready), [onReadyChange]);
      return <div data-testid="model-control">model</div>;
    },
  };
});

const OPERATOR = "workspace:operator";
const FLOE = "workspace:floe";
const ARCHITECT = "workspace:architect";

const endpoints: EndpointRef[] = [
  endpoint(OPERATOR, "Operator", "operator"),
  endpoint(FLOE, "Floe", "floe"),
  endpoint(ARCHITECT, "Product Architect", "product-architect"),
];

function endpoint(endpointId: string, name: string, agentId: string): EndpointRef {
  return {
    endpoint_id: endpointId,
    workspace_id: "workspace",
    name,
    agent_id: agentId,
    bridge_id: null,
    status: "active",
    metadata_json: "{}",
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
  };
}

function context(
  contextId: string,
  participant: string,
  title: string,
  lastEventAt: string,
): ContextRef {
  return {
    context_id: contextId,
    workspace_id: "workspace",
    scope_id: null,
    parent_context_id: null,
    created_by_endpoint_id: OPERATOR,
    created_at: "2026-08-24T00:00:00Z",
    last_event_at: lastEventAt,
    participants: [OPERATOR, participant],
    title,
    first_message_preview: "Initial request",
  };
}

function message(
  eventId: string,
  source: string,
  destination: string,
  text: string,
  expected: boolean,
  createdAt: string,
): EventEnvelope {
  return {
    event_id: eventId,
    type: "message",
    workspace_id: "workspace",
    source_endpoint_id: source,
    thread_id: "thread",
    context_id: "context",
    scope_id: null,
    correlation_id: null,
    destination_json: { kind: "endpoint", endpoint_id: destination },
    content: { text },
    response: { expected },
    metadata: {},
    created_at: createdAt,
  };
}

function Harness(): React.ReactElement {
  const [selectedContextId, setSelectedContextId] = useState<string | null>("context-floe");
  const open = useCallback((contextId: string) => setSelectedContextId(contextId), []);
  const close = useCallback(() => setSelectedContextId(null), []);
  return (
    <OperatorConversations
      workspaceId="workspace"
      workspaceLocator={"C:\\workspace"}
      endpoints={endpoints}
      scopes={[]}
      selectedContextId={selectedContextId}
      onOpenContext={open}
      onCloseContext={close}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  modelControl.ready = true;
  vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
  vi.mocked(client.listContextEventHistoryPage).mockResolvedValue({ events: [], previous_cursor: null });
  vi.mocked(client.deleteContext).mockResolvedValue({} as never);
  vi.mocked(client.emit).mockResolvedValue({} as never);
  attachmentStage.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("operator conversation projection", () => {
  const architectContext = context(
    "context-architect",
    ARCHITECT,
    "Define Acme",
    "2026-08-24T02:00:00Z",
  );

  it("marks a direct expected response from a collaborator as needing the operator", () => {
    const result = summarizeOperatorConversation(
      architectContext,
      [message("event-1", ARCHITECT, OPERATOR, "Which audience should we serve first?", true, "2026-08-24T02:00:00Z")],
      OPERATOR,
      endpoints,
    );

    expect(result.needsOperator).toBe(true);
    expect(result.collaborators).toBe("Product Architect");
    expect(result.preview).toBe("Which audience should we serve first?");
  });

  it("moves the conversation out of attention after the operator replies", () => {
    const result = summarizeOperatorConversation(
      architectContext,
      [
        message("event-1", ARCHITECT, OPERATOR, "Which audience should we serve first?", true, "2026-08-24T02:00:00Z"),
        message("event-2", OPERATOR, ARCHITECT, "Start with environment artists.", true, "2026-08-24T02:01:00Z"),
      ],
      OPERATOR,
      endpoints,
    );

    expect(result.needsOperator).toBe(false);
    expect(result.preview).toBe("Start with environment artists.");
  });

  it("finds the latest sorted conversation involving a collaborator", () => {
    const floeContext = context("context-floe", FLOE, "Build it", "2026-08-24T01:00:00Z");
    const architectSummary = summarizeOperatorConversation(architectContext, [], OPERATOR, endpoints);
    const floeSummary = summarizeOperatorConversation(floeContext, [], OPERATOR, endpoints);
    expect(latestConversationWith([architectSummary, floeSummary], FLOE)?.context.context_id).toBe("context-floe");
  });
});

describe("unified operator conversations", () => {
  const architectContext = context("context-architect", ARCHITECT, "Define Acme", "2026-08-24T02:00:00Z");
  const floeContext = context("context-floe", FLOE, "Build the pipeline", "2026-08-24T01:00:00Z");

  beforeEach(() => {
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([architectContext, floeContext]);
    vi.mocked(client.listContextEventHistoryPage).mockImplementation(async contextId => ({
      events: contextId === architectContext.context_id
        ? [message("event-1", ARCHITECT, OPERATOR, "I need your decision.", true, "2026-08-24T02:00:00Z")]
        : [message("event-2", FLOE, OPERATOR, "The pipeline is ready.", false, "2026-08-24T01:00:00Z")],
      previous_cursor: null,
    }));
  });

  it("lands on the conversation index when conversations already exist", async () => {
    const onOpenContext = vi.fn();
    render(
      <OperatorConversations
        workspaceId="workspace"
        endpoints={endpoints}
        scopes={[]}
        selectedContextId={null}
        onOpenContext={onOpenContext}
        onCloseContext={vi.fn()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Conversations" })).toBeTruthy();
    expect(onOpenContext).not.toHaveBeenCalled();
    expect(client.listContextsByParticipant).toHaveBeenCalledWith({
      participant: OPERATOR,
      workspace_id: "workspace",
    });
  });

  it("opens active organised work from the same workspace index", async () => {
    render(
      <OperatorConversations
        workspaceId="workspace"
        endpoints={endpoints}
        scopes={[{
          scope_id: "acme-delivery",
          workspace_id: "workspace",
          title: "Acme delivery",
          description: "Build and judge one slice at a time.",
          status: "active",
          created_at: "2026-08-27T00:00:00Z",
          updated_at: "2026-08-27T00:00:00Z",
        }]}
        selectedContextId={null}
        onOpenContext={vi.fn()}
        onCloseContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open organised work Acme delivery" }));
    expect(screen.getByTestId("scope-work-view").textContent).toContain("Acme delivery");
  });

  it("returns from the selected Floe conversation to the one shared conversation list", async () => {
    render(<Harness />);

    expect((await screen.findByTestId("conversation")).textContent).toContain("context-floe:true");
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));

    expect(await screen.findByRole("list", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Recent" })).toBeTruthy();
    expect(screen.getByText("I need your decision.")).toBeTruthy();
    expect(screen.getByText("The pipeline is ready.")).toBeTruthy();
  });

  it("opens work as a view of the current conversation and returns to the same chat", async () => {
    render(<Harness />);

    expect(await screen.findByTestId("conversation")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.getByTestId("work-view").textContent).toContain("context-floe");

    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    expect(await screen.findByTestId("conversation")).toBeTruthy();
  });

  it("starts a new conversation with the currently selected collaborator", async () => {
    vi.mocked(client.createDirectContext).mockResolvedValue(
      context("context-new", ARCHITECT, "", "2026-08-24T03:00:00Z"),
    );
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "Open conversation with Product Architect" }));
    fireEvent.click(await screen.findByRole("button", { name: "New conversation" }));

    expect(await screen.findByText("New conversation with Product Architect")).toBeTruthy();
    expect(client.createDirectContext).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "Refine the audience" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(client.emit).toHaveBeenCalledWith(expect.objectContaining({
      source_endpoint_id: OPERATOR,
      destination: { kind: "endpoint", endpoint_id: ARCHITECT },
      context_id: "context-new",
      content: { text: "Refine the audience" },
      response: { expected: true },
    })));
    expect(client.createDirectContext).toHaveBeenCalledWith("workspace", {
      participants: [OPERATOR, ARCHITECT],
      created_by_endpoint_id: OPERATOR,
    });
  });

  it("deletes any selected operator conversation through the same controls", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Harness />);

    fireEvent.click(await screen.findByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "Open conversation with Product Architect" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => expect(client.deleteContext).toHaveBeenCalledWith("context-architect"));
    expect(await screen.findByRole("heading", { name: "Conversations" })).toBeTruthy();
  });

  it("starts with a new Floe outcome when the workspace has no conversations", async () => {
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
    vi.mocked(client.createDirectContext).mockResolvedValue(
      context("context-new", FLOE, "", "2026-08-24T03:00:00Z"),
    );
    render(<Harness />);

    expect(await screen.findByText("New conversation with Floe")).toBeTruthy();
    expect(client.createDirectContext).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "Ship the customer report" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(client.emit).toHaveBeenCalledWith(expect.objectContaining({
      destination: { kind: "endpoint", endpoint_id: FLOE },
      content: { text: "Ship the customer report" },
    })));
  });

  it("stages an operator-selected file and sends only its workspace reference", async () => {
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
    vi.mocked(client.createDirectContext).mockResolvedValue(
      context("context-new", FLOE, "", "2026-08-24T03:00:00Z"),
    );
    attachmentStage.mockResolvedValue([{
      path: ".floe/state/attachments/context-new/screen.png",
      name: "screen.png",
      media_type: "image/png",
      bytes: 3,
    }]);
    render(<Harness />);

    expect(await screen.findByText("New conversation with Floe")).toBeTruthy();
    const selected = new File(["png"], "screen.png", { type: "image/png" });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [selected] } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(attachmentStage).toHaveBeenCalledWith(
      { workspace_id: "workspace", locator: "C:\\workspace" },
      "context-new",
      [selected],
    ));
    expect(client.emit).toHaveBeenCalledWith(expect.objectContaining({
      content: {
        attachments: [{
          path: ".floe/state/attachments/context-new/screen.png",
          name: "screen.png",
          media_type: "image/png",
          bytes: 3,
        }],
      },
    }));
  });

  it("does not accept an outcome until the workspace model is ready", async () => {
    modelControl.ready = false;
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
    render(<Harness />);

    const input = await screen.findByLabelText("Outcome") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Start" })).toHaveProperty("disabled", true);
    expect(screen.getByText("Choose a provider and model before starting a conversation.")).toBeTruthy();
    expect(client.createDirectContext).not.toHaveBeenCalled();
    expect(client.emit).not.toHaveBeenCalled();
  });
});
