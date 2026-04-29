#!/usr/bin/env node
import { ensureConfig } from "./config.js";
import { createBusServer } from "./server.js";

function getArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.slice(name.length + 1) : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "daemon";
  if (command !== "daemon") {
    console.error(`Unknown floe-bus command: ${command}`);
    process.exit(1);
  }
  const configPathArg = getArgValue("--config");
  const { configPath, config } = ensureConfig(configPathArg);
  const server = await createBusServer(configPath, config);
  await server.listen();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
