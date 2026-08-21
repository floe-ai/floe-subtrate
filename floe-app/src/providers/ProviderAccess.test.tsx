import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAccess } from "./ProviderAccess.tsx";
import * as provider from "./codexProvider.ts";

vi.mock("./codexProvider.ts", async importOriginal => {
  const actual = await importOriginal<typeof import("./codexProvider.ts")>();
  return {
    ...actual,
    getCodexProviderStatus: vi.fn(),
    connectCodexProvider: vi.fn(),
  };
});

const status: provider.CodexProviderStatus = {
  provider: provider.CODEX_PROVIDER_ID,
  available: true,
  connected: true,
  account_type: "chatgpt",
  plan_type: "business",
  models: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", description: "", is_default: true, reasoning_efforts: ["high"] },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", description: "", is_default: false, reasoning_efforts: ["high"] },
  ],
};

describe("ProviderAccess", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("presents the official ChatGPT account and current Codex models in user language", () => {
    render(<ProviderAccess initialStatus={status} />);
    expect(screen.getByText("ChatGPT")).toBeTruthy();
    expect(screen.getByText(/Connected · business/)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "ChatGPT default model" }) as HTMLSelectElement).value).toBe("gpt-5.6-sol");
    expect(screen.queryByText(/profile id|api key|auth token/i)).toBeNull();
  });

  it("syncs the selected model through Codex without exposing a credential", async () => {
    vi.mocked(provider.connectCodexProvider).mockResolvedValue(status);
    const onReady = vi.fn();
    render(<ProviderAccess initialStatus={status} onReady={onReady} />);
    fireEvent.change(screen.getByRole("combobox", { name: "ChatGPT default model" }), {
      target: { value: "gpt-5.6-terra" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use this account" }));
    await waitFor(() => {
      expect(provider.connectCodexProvider).toHaveBeenCalledWith("gpt-5.6-terra");
      expect(onReady).toHaveBeenCalledWith(status, "gpt-5.6-terra");
    });
  });

  it("explains when Codex is unavailable instead of offering technical profile fields", () => {
    render(<ProviderAccess initialStatus={{ ...status, available: false, connected: false, models: [], error: "Codex command not found" }} />);
    expect(screen.getByRole("alert").textContent).toContain("Codex is not available on this device");
    expect((screen.getByRole("button", { name: "Continue with ChatGPT" }) as HTMLButtonElement).disabled).toBe(true);
  });

});
