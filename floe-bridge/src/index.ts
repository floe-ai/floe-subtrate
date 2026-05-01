#!/usr/bin/env node
import { ensureConfig } from "./config.js";
import { BridgeDaemon } from "./daemon.js";

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "daemon";
  if (command !== "daemon") {
    console.error(`Unknown floe-bridge command: ${command}`);
    process.exit(1);
  }
  const { configPath, config } = ensureConfig(getArgValue("--config"));
  const daemon = new BridgeDaemon(configPath, config);
  await daemon.start();
  process.on("SIGINT", () => void daemon.stop().finally(() => process.exit(0)));
  process.on("SIGTERM", () => void daemon.stop().finally(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
