import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FloeModelControl } from "./FloeModelControl.tsx";
import * as client from "../bus-client/client.ts";
import * as modelHelpers from "../actors/modelsForProfile.ts";

vi.mock("../bus-client/client.ts", () => ({
  getAuthProfiles: vi.fn(),
  getRuntimeBindings: vi.fn(),
  upsertRuntimeBinding: vi.fn(),
  clearRuntimeBindings: vi.fn(),
}));

vi.mock("../actors/modelsForProfile.ts", () => ({
  modelsForProfile: vi.fn(),
  providerForProfile: vi.fn(),
  withSelectedModelOption: vi.fn(),
}));

const profiles = [{ id: "chatgpt", provider: "openai-codex", label: "ChatGPT" }];
const models = [
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai-codex", api: "codex", reasoning: true },
  { id: "gpt-basic", name: "GPT Basic", provider: "openai-codex", api: "codex", reasoning: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(client.getAuthProfiles).mockResolvedValue({ profiles, default_auth_profile: null });
  vi.mocked(client.getRuntimeBindings).mockResolvedValue([]);
  vi.mocked(client.upsertRuntimeBinding).mockResolvedValue({} as never);
  vi.mocked(client.clearRuntimeBindings).mockResolvedValue({ ok: true, binding_key: "workspace" });
  vi.mocked(modelHelpers.modelsForProfile).mockResolvedValue(models);
  vi.mocked(modelHelpers.providerForProfile).mockReturnValue("openai-codex");
  vi.mocked(modelHelpers.withSelectedModelOption).mockImplementation(list => list);
});

afterEach(cleanup);

describe("FloeModelControl", () => {
  it("is not ready until a workspace provider and model are persisted", async () => {
    const onReadyChange = vi.fn();
    render(<FloeModelControl workspaceId="ws-1" onReadyChange={onReadyChange} />);

    const provider = await screen.findByRole("combobox", { name: "Floe provider" });
    expect(onReadyChange).not.toHaveBeenLastCalledWith(true);

    fireEvent.change(provider, { target: { value: "chatgpt" } });
    await waitFor(() => expect(client.upsertRuntimeBinding).toHaveBeenCalledWith({
      scope: "workspace_default",
      workspace_id: "ws-1",
      auth_profile: "chatgpt",
      model: null,
      thinking_level: null,
    }));
    expect(onReadyChange).not.toHaveBeenLastCalledWith(true);

    const model = await screen.findByRole("combobox", { name: "Floe model" }) as HTMLSelectElement;
    await waitFor(() => expect(model.disabled).toBe(false));
    fireEvent.change(model, { target: { value: "gpt-5.6-sol" } });

    await waitFor(() => expect(client.upsertRuntimeBinding).toHaveBeenLastCalledWith({
      scope: "workspace_default",
      workspace_id: "ws-1",
      auth_profile: "chatgpt",
      model: "gpt-5.6-sol",
      thinking_level: "off",
    }));
    await waitFor(() => expect(onReadyChange).toHaveBeenLastCalledWith(true));
  });

  it("changes reasoning effort inline and resets it for a non-reasoning model", async () => {
    vi.mocked(client.getRuntimeBindings).mockResolvedValue([{
      binding_key: "workspace",
      scope: "workspace_default",
      workspace_id: "ws-1",
      endpoint_id: null,
      auth_profile: "chatgpt",
      model: "gpt-5.6-sol",
      thinking_level: "high",
      created_at: "",
      updated_at: "",
    }]);
    render(<FloeModelControl workspaceId="ws-1" onReadyChange={vi.fn()} />);

    const effort = await screen.findByRole("combobox", { name: "Floe effort" }) as HTMLSelectElement;
    await waitFor(() => expect(effort.value).toBe("high"));
    fireEvent.change(effort, { target: { value: "xhigh" } });
    await waitFor(() => expect(client.upsertRuntimeBinding).toHaveBeenLastCalledWith(expect.objectContaining({ thinking_level: "xhigh" })));

    const model = screen.getByRole("combobox", { name: "Floe model" });
    fireEvent.change(model, { target: { value: "gpt-basic" } });
    await waitFor(() => expect(client.upsertRuntimeBinding).toHaveBeenLastCalledWith(expect.objectContaining({
      model: "gpt-basic",
      thinking_level: "off",
    })));
    expect(effort.value).toBe("off");
    expect(effort.disabled).toBe(true);
  });
});
