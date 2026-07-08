import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { SubstrateSettingsView } from "./SubstrateSettingsView.tsx";
import * as workspaceFs from "../../fs/workspaceFs.ts";
import * as client from "../../bus-client/client.ts";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../../fs/workspaceFs.ts", () => ({
  isTauri: vi.fn(),
}));

vi.mock("../../bus-client/client.ts", () => ({
  getAuthProfiles: vi.fn(),
}));

// Tauri API is not present in jsdom; mock the dynamic import path so the
// desktop branch never actually tries to invoke it during tests.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const mockProfiles = [
  { id: "openai-personal", provider: "openai", model: "gpt-4o" },
  { id: "anthropic-work", provider: "anthropic" },
];

describe("SubstrateSettingsView — browser mode (isTauri = false)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceFs.isTauri).mockReturnValue(false);
    vi.mocked(client.getAuthProfiles).mockResolvedValue({
      profiles: mockProfiles,
      default_auth_profile: null,
    });
  });

  afterEach(() => cleanup());

  it("renders 'Browser — read-only' in the header", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/Browser — read-only/i)).toBeTruthy();
    });
  });

  it("shows profiles fetched from the bus", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText("openai-personal")).toBeTruthy();
      expect(screen.getByText("anthropic-work")).toBeTruthy();
    });
  });

  it("shows a read-only badge (no Add Profile button)", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.queryByText("+ Add Profile")).toBeNull();
      expect(screen.getByText("Read-only")).toBeTruthy();
    });
  });

  it("shows note directing user to CLI or desktop app", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      // The ADR-0005 note section is unique and always present in browser mode
      expect(screen.getByText(/ADR-0005/)).toBeTruthy();
    });
  });

  it("fetches via bus client, never calls Tauri invoke", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(vi.mocked(client.getAuthProfiles)).toHaveBeenCalledOnce();
    });
    // Give the component time to settle, then confirm invoke was never called
    const tauriCore = await import("@tauri-apps/api/core");
    expect(vi.mocked(tauriCore.invoke)).not.toHaveBeenCalled();
  });

  it("shows empty-state message when no profiles configured", async () => {
    vi.mocked(client.getAuthProfiles).mockResolvedValue({
      profiles: [],
      default_auth_profile: null,
    });
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/No auth profiles configured/i)).toBeTruthy();
      // Multiple 'floe login' code elements are expected (empty-state + note)
      expect(screen.getAllByText(/floe login/i).length).toBeGreaterThan(0);
    });
  });

  it("shows error alert when bus fetch fails", async () => {
    vi.mocked(client.getAuthProfiles).mockRejectedValue(new Error("bus unreachable"));
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.getByText(/bus unreachable/i)).toBeTruthy();
    });
  });
});

describe("SubstrateSettingsView — desktop mode (isTauri = true)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(workspaceFs.isTauri).mockReturnValue(true);
    // Desktop path: Tauri invoke returns the profiles
    const tauriCore = await import("@tauri-apps/api/core");
    vi.mocked(tauriCore.invoke).mockResolvedValue({ profiles: mockProfiles, default_auth_profile: null });
  });

  afterEach(() => cleanup());

  it("renders 'Desktop' in the header", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText(/Desktop/)).toBeTruthy();
    });
  });

  it("shows Add Profile write affordance", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(screen.getByText("+ Add Profile")).toBeTruthy();
    });
  });

  it("does NOT call the bus getAuthProfiles", async () => {
    render(<SubstrateSettingsView />);
    await waitFor(() => {
      expect(vi.mocked(client.getAuthProfiles)).not.toHaveBeenCalled();
    });
  });
});
