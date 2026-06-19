import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ActorInspector } from "./ActorInspector.tsx";
import * as client from "../bus-client/client.ts";
import * as modelsForProfileHelper from "./modelsForProfile.ts";

vi.mock("../bus-client/client.ts", () => ({
  registerEndpoint: vi.fn(),
  deleteEndpoint: vi.fn(),
  getAuthProfiles: vi.fn(),
  resolveRuntimeBinding: vi.fn(),
  upsertRuntimeBinding: vi.fn(),
  clearRuntimeBindings: vi.fn(),
  listContextsByParticipant: vi.fn(),
}));

vi.mock("./modelsForProfile.ts", () => ({
  modelsForProfile: vi.fn(),
  withSelectedModelOption: vi.fn(),
  providerForProfile: vi.fn(),
}));

const mockProfiles = [
  { id: "profile-1", provider: "openai" },
];

const mockModels = [
  { id: "gpt-4o", name: "GPT-4o", provider: "openai", api: "openai", reasoning: false },
  { id: "o1", name: "o1", provider: "openai", api: "openai", reasoning: true },
];

const mockActor = {
  endpoint_id: "ep-1",
  workspace_id: "ws-1",
  name: "My Actor",
  agent_id: "agent-1",
  bridge_id: "bridge-1",
  status: "active",
  metadata_json: JSON.stringify({ file: "agents/ep-1.md" }),
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("ActorInspector - Effort reset behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.getAuthProfiles).mockResolvedValue({ profiles: mockProfiles, default_auth_profile: null });
    vi.mocked(client.resolveRuntimeBinding).mockResolvedValue({
      endpoint_auth_profile: "profile-1",
      workspace_auth_profile: null,
      global_auth_profile: null,
      endpoint_model: "o1",
      workspace_model: null,
      global_model: null,
      endpoint_thinking_level: "medium",
      workspace_thinking_level: null,
      global_thinking_level: null,
    });
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
    vi.mocked(modelsForProfileHelper.modelsForProfile).mockResolvedValue(mockModels);
    vi.mocked(modelsForProfileHelper.providerForProfile).mockReturnValue("openai");
    vi.mocked(modelsForProfileHelper.withSelectedModelOption).mockReturnValue(mockModels);
  });

  it("resets Effort dropdown to 'off' when a non-reasoning model is selected", async () => {
    render(<ActorInspector actor={mockActor} workspaceId="ws-1" />);

    // Wait for elements to load
    await waitFor(() => {
      const modelSelect = screen.getByRole("combobox", { name: "Model" });
      expect(modelSelect).toBeDefined();
    });

    const modelSelect = screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement;
    const effortSelect = screen.getByRole("combobox", { name: "Effort" }) as HTMLSelectElement;

    // Verify initial values from resolved bindings
    expect(modelSelect.value).toBe("o1");
    expect(effortSelect.value).toBe("medium");

    // Change model to "gpt-4o" (which is a non-reasoning model)
    fireEvent.change(modelSelect, { target: { value: "gpt-4o" } });

    // Effort should reset to "off"
    expect(effortSelect.value).toBe("off");

    // Verify upsertRuntimeBinding is called with "off" as thinking_level
    expect(client.upsertRuntimeBinding).toHaveBeenCalledWith({
      scope: "agent",
      workspace_id: "ws-1",
      endpoint_id: "ep-1",
      auth_profile: "profile-1",
      model: "gpt-4o",
      thinking_level: "off",
    });
  });
});
