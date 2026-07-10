/**
 * Tests for ContextConversation participant gate.
 *
 * Gate rule: the compose/reply input is hidden (replaced by a non-participant
 * notice) when the currently selected "speaking as" actor is NOT in the
 * context's participants list.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ContextConversation } from "./ContextConversation.tsx";
import * as client from "../bus-client/client.ts";

vi.mock("../bus-client/client.ts", () => ({
  getContext: vi.fn(),
  listContextEvents: vi.fn(),
  emit: vi.fn(),
}));

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

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.getContext).mockResolvedValue(mockContext as any);
  vi.mocked(client.listContextEvents).mockResolvedValue([]);

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
});
