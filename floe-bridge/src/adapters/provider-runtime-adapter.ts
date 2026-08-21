import type { AgentRuntimeConfig } from "../auth.js";
import { createBridgeAuthRuntime } from "../auth.js";
import type { LocalConfig } from "../config.js";
import type { DeliveryBundle } from "../bus-client.js";
import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import { CODEX_APP_SERVER_PROVIDER, CodexAppServerAdapter } from "./codex-app-server-adapter.js";

/**
 * Routes a resolved provider profile to its runtime implementation.
 * This composes the existing adapter seam; provider selection remains ordinary
 * runtime configuration and does not become a substrate primitive.
 */
export class ProviderRuntimeAdapter implements RuntimeAdapter {
  readonly name = "floe-runtime";

  constructor(
    private readonly configPath: string,
    private readonly config: LocalConfig,
    private readonly compatibility: RuntimeAdapter,
    private readonly codex: RuntimeAdapter = new CodexAppServerAdapter(),
  ) {}

  async handleBundle(context: RuntimeContext, bundle: DeliveryBundle, runtimeConfig?: AgentRuntimeConfig): Promise<void> {
    const provider = this.resolveProvider(runtimeConfig);
    const adapter = provider === CODEX_APP_SERVER_PROVIDER ? this.codex : this.compatibility;
    await adapter.handleBundle(context, bundle, { ...runtimeConfig, provider });
  }

  async dispose(reason?: "bridge_shutdown" | "session_replaced"): Promise<void> {
    await Promise.all([
      this.compatibility.dispose?.(reason),
      this.codex.dispose?.(reason),
    ]);
  }

  private resolveProvider(runtimeConfig?: AgentRuntimeConfig): string | undefined {
    const profileId = runtimeConfig?.auth_profile?.trim();
    if (profileId) {
      const runtime = createBridgeAuthRuntime(this.configPath, this.config);
      const profileProvider = runtime.profiles.profiles.find(profile => profile.id === profileId)?.provider?.trim();
      if (profileProvider) return profileProvider;
    }
    const declaredProvider = runtimeConfig?.provider?.trim();
    return declaredProvider && declaredProvider !== "configured_by_pi_ai" ? declaredProvider : undefined;
  }
}
