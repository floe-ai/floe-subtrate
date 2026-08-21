import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAccess } from "./ProviderAccess.tsx";
import type { ModelProviderStatus } from "./modelProviders.ts";
import * as provider from "./modelProviders.ts";

vi.mock("./modelProviders.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./modelProviders.ts")>();
  return { ...actual, getModelProviders: vi.fn(), connectModelProvider: vi.fn() };
});

const chatgpt: ModelProviderStatus = {
  type: "provider_status",
  provider: "openai-codex",
  name: "ChatGPT",
  auth_name: "OpenAI (ChatGPT Plus/Pro)",
  connected: false,
  profile_id: "openai-codex-subscription",
  models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", is_default: true, reasoning_efforts: ["high"] },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", is_default: false, reasoning_efforts: ["high"] },
  ],
};

const copilot: ModelProviderStatus = {
  type: "provider_status",
  provider: "github-copilot",
  name: "GitHub Copilot",
  auth_name: "GitHub Copilot",
  connected: true,
  profile_id: "github-copilot-subscription",
  models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", is_default: true, reasoning_efforts: ["high"] }],
};

describe("ProviderAccess", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("presents multiple subscription providers without profile ids or API keys", () => {
    render(<ProviderAccess initialProviders={[chatgpt, copilot]} />);
    const providerSelect = screen.getByRole("combobox", { name: "Subscription provider" });
    expect(providerSelect.textContent).toContain("ChatGPT");
    expect(providerSelect.textContent).toContain("GitHub Copilot · connected");
    expect(screen.queryByText(/profile id|api key|auth token/i)).toBeNull();
  });

  it("authenticates the selected provider through the desktop helper", async () => {
    const connected = { ...chatgpt, connected: true };
    vi.mocked(provider.connectModelProvider).mockResolvedValue(connected);
    const onReady = vi.fn();
    render(<ProviderAccess initialProviders={[chatgpt]} onReady={onReady} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Provider default model" }), {
      target: { value: "gpt-5.6-terra" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => {
      expect(provider.connectModelProvider).toHaveBeenCalledWith("openai-codex", expect.any(Function));
      expect(onReady).toHaveBeenCalledWith(connected, "gpt-5.6-terra");
    });
  });

  it("shows a provider device code while subscription login is pending", async () => {
    vi.mocked(provider.connectModelProvider).mockImplementation(async (_provider, onEvent) => {
      onEvent({ type: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" });
      return new Promise(() => {});
    });
    render(<ProviderAccess initialProviders={[chatgpt]} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(await screen.findByText(/ABCD-1234/)).toBeTruthy();
  });

  it("treats connected accounts as status when adding another provider", () => {
    render(<ProviderAccess initialProviders={[copilot, chatgpt]} purpose="add" />);

    const providerSelect = screen.getByRole("combobox", { name: "Subscription provider" }) as HTMLSelectElement;
    expect(providerSelect.value).toBe("openai-codex");
    expect(screen.queryByRole("combobox", { name: "Provider default model" })).toBeNull();

    fireEvent.change(providerSelect, { target: { value: "github-copilot" } });
    expect((screen.getByRole("button", { name: "Connected" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
