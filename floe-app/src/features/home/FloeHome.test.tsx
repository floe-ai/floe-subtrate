import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FloeHome, findFloePair, latestFloeContext } from "./FloeHome.tsx";
import * as client from "../../bus-client/client.ts";

vi.mock("../../bus-client/client.ts", () => ({
  createDirectContext: vi.fn(),
  emit: vi.fn(),
  listContexts: vi.fn(),
}));

vi.mock("../../scope/ContextConversation.tsx", () => ({
  ContextConversation: ({ contextId, operatorEntry }: {
    contextId: string;
    operatorEntry?: { speakingAsEndpointId: string };
  }) => <div data-testid="conversation">{contextId}:{operatorEntry?.speakingAsEndpointId}</div>,
}));

const operator = {
  endpoint_id: "actor:ws-1:operator", workspace_id: "ws-1", name: "Operator", agent_id: "operator",
  bridge_id: null, status: "idle", metadata_json: "{}", created_at: "", updated_at: "",
};
const floe = {
  endpoint_id: "actor:ws-1:floe", workspace_id: "ws-1", name: "Floe", agent_id: "floe",
  bridge_id: "bridge-1", status: "idle", metadata_json: "{}", created_at: "", updated_at: "",
};
const context = (id: string, lastEvent: string | null) => ({
  context_id: id, workspace_id: "ws-1", scope_id: null, parent_context_id: null,
  created_by_endpoint_id: operator.endpoint_id, created_at: "2026-01-01T00:00:00Z",
  last_event_at: lastEvent, participants: [operator.endpoint_id, floe.endpoint_id],
  title: null, first_message_preview: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.listContexts).mockResolvedValue([]);
  vi.mocked(client.emit).mockResolvedValue({} as never);
});

afterEach(cleanup);

describe("Floe operator entry", () => {
  it("finds the ordinary operator and Floe endpoints and selects their latest direct context", () => {
    const pair = findFloePair([floe, operator]);
    expect(pair).toEqual({ operator, floe });
    expect(latestFloeContext([
      context("older", "2026-01-02T00:00:00Z"),
      context("newer", "2026-01-03T00:00:00Z"),
    ], pair!)).toMatchObject({ context_id: "newer" });
  });

  it("reopens the latest direct Floe conversation without creating substrate state", async () => {
    vi.mocked(client.listContexts).mockResolvedValue([context("ctx-existing", "2026-01-03T00:00:00Z")]);

    render(<FloeHome workspaceId="ws-1" endpoints={[operator, floe]} />);

    expect((await screen.findByTestId("conversation")).textContent).toBe("ctx-existing:actor:ws-1:operator");
    expect(client.listContexts).toHaveBeenCalledWith("ws-1", { scope: "all" });
    expect(client.createDirectContext).not.toHaveBeenCalled();
  });

  it("creates a direct context only when the operator submits an outcome", async () => {
    vi.mocked(client.createDirectContext).mockResolvedValue(context("ctx-new", null));

    render(<FloeHome workspaceId="ws-1" endpoints={[operator, floe]} />);

    const input = await screen.findByLabelText("Outcome");
    expect(client.createDirectContext).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Ship the customer report" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(client.emit).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: "ws-1",
      source_endpoint_id: operator.endpoint_id,
      destination: { kind: "endpoint", endpoint_id: floe.endpoint_id },
      context_id: "ctx-new",
      content: { text: "Ship the customer report" },
      response: { expected: true },
    })));
    expect(client.createDirectContext).toHaveBeenCalledWith("ws-1", {
      participants: [operator.endpoint_id, floe.endpoint_id],
      created_by_endpoint_id: operator.endpoint_id,
    });
    expect(await screen.findByTestId("conversation")).toBeTruthy();
  });
});
