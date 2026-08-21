import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingFlow } from "./OnboardingFlow.tsx";

vi.mock("../../providers/ProviderAccess.tsx", () => ({
  ProviderAccess: ({ onReady }: any) => (
    <button onClick={() => onReady({ profile_id: "openai-codex-subscription" }, "gpt-5.6-sol")}>
      Connect provider
    </button>
  ),
}));

vi.mock("../../workspace/WorkspaceSwitcher.tsx", () => ({
  RegisterWorkspaceScreen: ({ onRegistered }: any) => (
    <button onClick={() => onRegistered({ workspace_id: "ws-1", name: "Work" })}>Open workspace</button>
  ),
}));

describe("OnboardingFlow", () => {
  afterEach(() => cleanup());
  it("guides a clean install from provider to workspace and applies both before chat", async () => {
    const onReady = vi.fn().mockResolvedValue(undefined);
    render(<OnboardingFlow workspaces={[]} hasProvider={false} modelProviders={null} onReady={onReady} />);
    expect(screen.getByText(/First, connect a model provider/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open workspace" }));

    await waitFor(() => expect(onReady).toHaveBeenCalledWith({
      workspace: { workspace_id: "ws-1", name: "Work" },
      profileId: "openai-codex-subscription",
      model: "gpt-5.6-sol",
    }));
    expect(screen.getByText(/Opening your workspace/)).toBeTruthy();
  });

  it("does not make an existing user create another workspace after connecting", async () => {
    const workspace = { workspace_id: "ws-existing", name: "Existing", selected_at: null } as any;
    const onReady = vi.fn().mockResolvedValue(undefined);
    render(<OnboardingFlow workspaces={[workspace]} hasProvider={false} modelProviders={null} onReady={onReady} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    await waitFor(() => expect(onReady).toHaveBeenCalledWith({
      workspace,
      profileId: "openai-codex-subscription",
      model: "gpt-5.6-sol",
    }));
  });
});
