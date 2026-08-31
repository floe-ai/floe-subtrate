import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ContextRef, DeliveryRow, EndpointRef } from "../../bus-client/types.ts";
import { buildContextWorkProjection, ContextWorkView } from "./ContextWorkView.tsx";
import * as client from "../../bus-client/client.ts";

vi.mock("../../bus-client/client.ts", () => ({
  listContextTree: vi.fn(),
  listDeliveries: vi.fn(),
  subscribeEvents: vi.fn(() => () => {}),
}));

vi.mock("../../scope/ContextConversation.tsx", () => ({
  ContextConversation: ({ contextId, readOnly, showWorkEvents }: {
    contextId: string;
    readOnly?: boolean;
    showWorkEvents?: boolean;
  }) => <div data-testid="context-inspector">{contextId}:{String(readOnly)}:{String(showWorkEvents)}</div>,
}));

const OPERATOR = "workspace:operator";
const ARCHITECT = "workspace:architect";
const BUILDER = "workspace:builder";

const endpoints: EndpointRef[] = [
  endpoint(OPERATOR, "Operator"),
  endpoint(ARCHITECT, "Product Architect"),
  endpoint(BUILDER, "Application Builder"),
];

function endpoint(endpointId: string, name: string): EndpointRef {
  return {
    endpoint_id: endpointId,
    workspace_id: "workspace",
    name,
    agent_id: endpointId.split(":").at(-1) ?? null,
    bridge_id: null,
    status: "active",
    metadata_json: "{}",
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
  };
}

function context(
  contextId: string,
  parentContextId: string | null,
  participants: string[],
  title: string,
  createdAt: string,
): ContextRef {
  return {
    context_id: contextId,
    workspace_id: "workspace",
    scope_id: null,
    parent_context_id: parentContextId,
    created_by_endpoint_id: participants[0] ?? null,
    created_at: createdAt,
    last_event_at: createdAt,
    participants,
    title,
    first_message_preview: null,
  };
}

function delivery(
  deliveryId: string,
  contextId: string,
  endpointId: string,
  state: string,
  createdAt: string,
  eventsJson?: string,
): DeliveryRow {
  return {
    delivery_id: deliveryId,
    endpoint_id: endpointId,
    workspace_id: "workspace",
    trigger_event_id: `${deliveryId}-event`,
    events_json: eventsJson ?? JSON.stringify([{ context_id: contextId }]),
    state,
    lease_expires_at: null,
    attempt_count: 1,
    last_error: null,
    created_at: createdAt,
    claimed_at: null,
  };
}

const root = context("context-root", null, [OPERATOR, ARCHITECT], "Build Acme", "2026-08-24T00:00:00Z");
const child = context("context-child", "context-root", [ARCHITECT, BUILDER], "Build the first slice", "2026-08-24T00:01:00Z");
const grandchild = context("context-grandchild", "context-child", [BUILDER], "Verify the slice", "2026-08-24T00:02:00Z");
const unrelated = context("context-unrelated", null, [OPERATOR], "Different conversation", "2026-08-24T00:03:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.listContextTree).mockResolvedValue({
    contexts: [grandchild, root, child],
    truncated: false,
  });
  vi.mocked(client.listDeliveries).mockResolvedValue([
    delivery("delivery-root", root.context_id, ARCHITECT, "acknowledged", "2026-08-24T00:01:00Z"),
    delivery("delivery-child", child.context_id, BUILDER, "injected_to_runtime", "2026-08-24T00:02:00Z"),
  ]);
});

afterEach(() => cleanup());

describe("Context work projection", () => {
  it("uses only real descendants, exact parent links, and current delivery status", () => {
    const projection = buildContextWorkProjection(
      [unrelated, grandchild, root, child],
      [
        delivery("delivery-root", root.context_id, ARCHITECT, "acknowledged", "2026-08-24T00:01:00Z"),
        delivery("delivery-child", child.context_id, BUILDER, "injected_to_runtime", "2026-08-24T00:02:00Z"),
      ],
      endpoints,
      root.context_id,
    );

    expect(projection.nodes.map(node => [node.context.context_id, node.depth, node.status])).toEqual([
      ["context-root", 0, "responded"],
      ["context-child", 1, "working"],
      ["context-grandchild", 2, "context"],
    ]);
    expect(projection.links).toEqual([
      { sourceContextId: "context-root", targetContextId: "context-child" },
      { sourceContextId: "context-child", targetContextId: "context-grandchild" },
    ]);
  });

  it("ignores malformed delivery history rather than inventing a status", () => {
    const projection = buildContextWorkProjection(
      [root],
      [delivery("delivery-bad", root.context_id, ARCHITECT, "failed", "2026-08-24T00:01:00Z", "not-json")],
      endpoints,
      root.context_id,
    );
    expect(projection.nodes[0]?.status).toBe("context");
  });

  it("renders an operator-stopped delivery as stopped rather than queued", () => {
    const projection = buildContextWorkProjection(
      [root],
      [delivery("delivery-stopped", root.context_id, ARCHITECT, "cancelled", "2026-08-24T00:01:00Z")],
      endpoints,
      root.context_id,
    );
    expect(projection.nodes[0]?.status).toBe("stopped");
  });
});

describe("ContextWorkView", () => {
  it("shows connected Contexts and opens the active Context read-only", async () => {
    render(
      <ContextWorkView
        workspaceId="workspace"
        rootContextId={root.context_id}
        endpoints={endpoints}
        operatorEndpointId={OPERATOR}
        onBackToConversation={vi.fn()}
      />,
    );

    expect(await screen.findByText("2 connected contexts")).toBeTruthy();
    expect(client.listContextTree).toHaveBeenCalledWith(root.context_id, 200);
    await waitFor(() => expect(screen.getByTestId("context-inspector").textContent).toBe("context-child:true:true"));
    fireEvent.click(screen.getByRole("button", { name: "Inspect Build Acme" }));
    expect(screen.getByTestId("context-inspector").textContent).toBe("context-root:true:true");
  });
});
