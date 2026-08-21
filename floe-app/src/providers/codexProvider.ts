import { isTauri } from "../fs/workspaceFs.ts";

export const CODEX_PROVIDER_ID = "openai-codex-app-server";
export const CODEX_PROFILE_ID = "chatgpt-codex";

export type CodexModel = {
  id: string;
  name: string;
  description: string;
  is_default: boolean;
  reasoning_efforts: string[];
};

export type CodexProviderStatus = {
  provider: typeof CODEX_PROVIDER_ID;
  available: boolean;
  connected: boolean;
  account_type: string | null;
  plan_type: string | null;
  models: CodexModel[];
  error?: string;
};

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error("Provider setup is available in the Floe desktop app");
  const { invoke: invokeTauri } = await import("@tauri-apps/api/core");
  return invokeTauri<T>(command, args);
}

export function getCodexProviderStatus(): Promise<CodexProviderStatus> {
  return invoke("get_codex_provider_status");
}

export function connectCodexProvider(model?: string | null): Promise<CodexProviderStatus> {
  return invoke("connect_codex_provider", { model: model || null });
}

export function preferredCodexModel(status: CodexProviderStatus): string {
  return status.models.find(model => model.is_default)?.id ?? status.models[0]?.id ?? "";
}
