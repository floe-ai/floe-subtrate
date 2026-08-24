import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContextRef, EndpointRef, EventEnvelope } from "../../bus-client/types.ts";
import {
  OperatorConversations,
  summarizeOperatorConversation,
} from "./OperatorConversations.tsx";
import * as client from "../../bus-client/client.ts";

vi.mock("../../bus-client/client.ts", () => ({
  listContextsByParticipant: vi.fn(),
  listContextEvents: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("summarizeOperatorConversation", () => {
  const architectContext = context(
    "context-architect",
    ARCHITECT,
    "Define Snowball",
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
});

describe("OperatorConversations", () => {
  it("shows operator conversations by attention and opens the selected existing context", async () => {
    const onOpenContext = vi.fn();
    const architectContext = context("context-architect", ARCHITECT, "Define Snowball", "2026-08-24T02:00:00Z");
    const floeContext = context("context-floe", FLOE, "Build the pipeline", "2026-08-24T01:00:00Z");
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([floeContext, architectContext]);
    vi.mocked(client.listContextEvents).mockImplementation(async contextId => (
      contextId === architectContext.context_id
        ? [message("event-1", ARCHITECT, OPERATOR, "I need your decision.", true, "2026-08-24T02:00:00Z")]
        : [message("event-2", FLOE, OPERATOR, "The pipeline is ready.", false, "2026-08-24T01:00:00Z")]
    ));

    render(
      <OperatorConversations
        workspaceId="workspace"
        endpoints={endpoints}
        onOpenContext={onOpenContext}
      />,
    );

    expect(await screen.findByRole("list", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Recent" })).toBeTruthy();
    expect(screen.getByText("I need your decision.")).toBeTruthy();
    expect(screen.getByText("The pipeline is ready.")).toBeTruthy();
    expect(client.listContextsByParticipant).toHaveBeenCalledWith({
      participant: OPERATOR,
      workspace_id: "workspace",
    });

    fireEvent.click(screen.getByRole("button", { name: "Open conversation with Product Architect" }));
    expect(onOpenContext).toHaveBeenCalledWith("context-architect");
    await waitFor(() => expect(client.listContextEvents).toHaveBeenCalledTimes(2));
  });
});
