import { Channel } from "@tauri-apps/api/core";
import { isTauri } from "../fs/workspaceFs.ts";

export type ModelProviderModel = {
  id: string;
  name: string;
  is_default: boolean;
  reasoning_efforts: string[];
};

export type ModelProviderStatus = {
  type: "provider_status";
  provider: string;
  name: string;
  auth_name: string;
  connected: boolean;
  profile_id: string;
  models: ModelProviderModel[];
};

export type ModelProviderAuthEvent =
  | { type: "info" | "progress"; message: string }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number };

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (!isTauri()) throw new Error("Provider setup is available in the Floe desktop app");
  const { invoke: invokeTauri } = await import("@tauri-apps/api/core");
  return invokeTauri<T>(command, args);
}

export function getModelProviders(): Promise<ModelProviderStatus[]> {
  return invoke("get_model_providers");
}

export function connectModelProvider(
  provider: string,
  onEvent: (event: ModelProviderAuthEvent) => void,
): Promise<ModelProviderStatus> {
  const channel = new Channel<ModelProviderAuthEvent>();
  channel.onmessage = onEvent;
  return invoke("connect_model_provider", { provider, onEvent: channel });
}

export function preferredModel(status: ModelProviderStatus): string {
  return status.models.find(model => model.is_default)?.id ?? status.models[0]?.id ?? "";
}
