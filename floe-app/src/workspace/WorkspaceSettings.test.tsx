import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkspaceSettings } from "./WorkspaceSettings.tsx";
import * as client from "../bus-client/client.ts";
import * as modelsForProfileHelper from "../actors/modelsForProfile.ts";

vi.mock("../bus-client/client.ts", () => ({
  getAuthProfiles: vi.fn(),
  getRuntimeBindings: vi.fn(),
  upsertRuntimeBinding: vi.fn(),
  clearRuntimeBindings: vi.fn(),
}));

vi.mock("../actors/modelsForProfile.ts", () => ({
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

const mockWorkspace = {
  workspace_id: "ws-1",
  name: "My Workspace",
  locator: "/path/to/ws",
  status: "active" as const,
  selected_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

describe("WorkspaceSettings - Effort reset behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.getAuthProfiles).mockResolvedValue({ profiles: mockProfiles });
    vi.mocked(client.getRuntimeBindings).mockResolvedValue([
      {
        binding_key: "ws-1:workspace_default",
        scope: "workspace_default",
        workspace_id: "ws-1",
        endpoint_id: null,
        auth_profile: "profile-1",
        model: "o1",
        thinking_level: "medium",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ]);
    vi.mocked(modelsForProfileHelper.modelsForProfile).mockResolvedValue(mockModels);
    vi.mocked(modelsForProfileHelper.providerForProfile).mockReturnValue("openai");
    vi.mocked(modelsForProfileHelper.withSelectedModelOption).mockReturnValue(mockModels);
  });

  it("resets Effort dropdown to 'off' when a non-reasoning model is selected", async () => {
    render(<WorkspaceSettings workspace={mockWorkspace} onRemove={vi.fn()} />);

    // Wait for the elements to be rendered and binding data to load
    await waitFor(() => {
      const modelSelect = screen.getByRole("combobox", { name: "Default model" });
      expect(modelSelect).toBeDefined();
    });

    const modelSelect = screen.getByRole("combobox", { name: "Default model" }) as HTMLSelectElement;
    const effortSelect = screen.getByRole("combobox", { name: "Default effort" }) as HTMLSelectElement;

    // Verify initial values
    expect(modelSelect.value).toBe("o1");
    expect(effortSelect.value).toBe("medium");

    // Change model to "gpt-4o" (which is a non-reasoning model)
    fireEvent.change(modelSelect, { target: { value: "gpt-4o" } });

    // Effort should reset to "off"
    expect(effortSelect.value).toBe("off");

    // Verify upsertRuntimeBinding is called with "off" as thinking_level
    expect(client.upsertRuntimeBinding).toHaveBeenCalledWith({
      scope: "workspace_default",
      workspace_id: "ws-1",
      auth_profile: "profile-1",
      model: "gpt-4o",
      thinking_level: "off",
    });
  });
});
