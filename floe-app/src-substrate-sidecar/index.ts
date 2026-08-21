#!/usr/bin/env bun
/**
 * Packaged local substrate for the desktop app.
 *
 * The installed application starts this companion only when the bus is not
 * already listening. It deliberately reuses the real bus and bridge rather
 * than introducing a desktop-only runtime path.
 */
import { createBusServer } from "../../floe-bus/src/server.ts";
import { ensureConfig as ensureBusConfig } from "../../floe-bus/src/config.ts";
import { BridgeDaemon } from "../../floe-bridge/src/daemon.ts";
import { ensureConfig as ensureBridgeConfig } from "../../floe-bridge/src/config.ts";

export async function runSubstrate(): Promise<void> {
  const configuredPath = process.env.FLOE_CONFIG;
  const { configPath, config: busConfig } = ensureBusConfig(configuredPath);
  const bus = await createBusServer(configPath, busConfig);
  await bus.listen();

  const { config: bridgeConfig } = ensureBridgeConfig(configPath);
  const bridge = new BridgeDaemon(configPath, bridgeConfig);
  await bridge.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await bridge.stop();
    await bus.app.close();
  };

  process.on("SIGINT", () => void stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void stop().finally(() => process.exit(0)));
}
