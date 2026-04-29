import type { RuntimeAdapter, RuntimeContext } from "./runtime-adapter.js";
import type { DeliveryBundle } from "../bus-client.js";

export class CopilotSdkAdapter implements RuntimeAdapter {
  readonly name = "copilot-sdk";

  async handleBundle(_context: RuntimeContext, _bundle: DeliveryBundle): Promise<void> {
    if (process.env.FLOE_LIVE_COPILOT !== "1") {
      throw new Error("CopilotSdkAdapter is gated. Set FLOE_LIVE_COPILOT=1 only for sparse live smoke tests.");
    }
    throw new Error("CopilotSdkAdapter live integration is intentionally deferred until the fake adapter contract is proven.");
  }
}
