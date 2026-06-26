import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ActorInspector, ActorContexts } from "./ActorInspector.tsx";
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
  createDirectContext: vi.fn(),
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
  afterEach(() => cleanup());

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

const mockEndpoints = [
  { endpoint_id: "ep-1", workspace_id: "ws-1", name: "Actor One", agent_id: null, bridge_id: null, status: "idle", metadata_json: "{}", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { endpoint_id: "ep-2", workspace_id: "ws-1", name: "Actor Two", agent_id: null, bridge_id: null, status: "idle", metadata_json: "{}", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
  { endpoint_id: "ep-3", workspace_id: "ws-1", name: "Actor Three", agent_id: null, bridge_id: null, status: "idle", metadata_json: "{}", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
];

describe("ActorContexts - New Context picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(client.listContextsByParticipant).mockResolvedValue([]);
  });
  afterEach(() => cleanup());

  it("renders '+ New' button", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "New context" })).toBeDefined());
  });

  it("opens participant picker when '+ New' is clicked", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));
    expect(screen.getByRole("combobox", { name: "Select participant" })).toBeDefined();
  });

  it("does not list self in the participant picker", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));
    const select = screen.getByRole("combobox", { name: "Select participant" }) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).not.toContain("ep-1");
    expect(options).toContain("ep-2");
    expect(options).toContain("ep-3");
  });

  it("calls createDirectContext with correct args on confirm and calls onOpenContext", async () => {
    const newCtx = {
      context_id: "ctx-new",
      workspace_id: "ws-1",
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: "ep-1",
      created_at: "2026-01-01T00:00:00Z",
      last_event_at: null,
      participants: ["ep-1", "ep-2"],
      first_message_preview: null,
    };
    vi.mocked(client.createDirectContext).mockResolvedValue(newCtx as any);
    const onOpenContext = vi.fn();

    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={onOpenContext}
        endpoints={mockEndpoints}
      />
    );

    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));

    const select = screen.getByRole("combobox", { name: "Select participant" }) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ep-2" } });

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(client.createDirectContext).toHaveBeenCalledWith("ws-1", {
        participants: ["ep-1", "ep-2"],
        created_by_endpoint_id: "ep-1",
      });
    });
    expect(onOpenContext).toHaveBeenCalledWith("ctx-new");
  });

  it("dismisses picker on cancel without calling createDirectContext", async () => {
    render(
      <ActorContexts
        endpointId="ep-1"
        workspaceId="ws-1"
        onOpenContext={vi.fn()}
        endpoints={mockEndpoints}
      />
    );
    await waitFor(() => screen.getByRole("button", { name: "New context" }));
    fireEvent.click(screen.getByRole("button", { name: "New context" }));
    expect(screen.getByRole("combobox", { name: "Select participant" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("combobox", { name: "Select participant" })).toBeNull();
    expect(client.createDirectContext).not.toHaveBeenCalled();
  });
});
