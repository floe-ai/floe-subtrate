import type { BusClient, DeliveryBundle } from "../bus-client.js";
import type { AgentRuntimeConfig } from "../auth.js";
import type { LoadedExtension } from "../extension-loader.js";
import type { HookPayload, HookRegistry } from "../hooks.js";

export type RuntimeContext = {
  bridge_id: string;
  bus: BusClient;
  /** Workspace locator (filesystem path) for work-log writing */
  workspace_locator?: string;
  /** Agent ID extracted from the endpoint for work-log paths */
  agent_id?: string;
  /** Loaded extensions filtered for this agent */
  extensions?: LoadedExtension[];
  /** Hook registry for firing lifecycle hooks */
  hooks?: HookRegistry;
};

export interface RuntimeAdapter {
  readonly name: string;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void>;
  dispose?(reason?: HookPayload<"SessionEnd">["reason"]): Promise<void>;
}
