#!/usr/bin/env bun
const [command, ...args] = process.argv.slice(2);

try {
  if (command === "auth") {
    const { runAuthHelper } = await import("../src-auth-sidecar/index.ts");
    await runAuthHelper(args);
  } else if (command === "substrate") {
    const { runSubstrate } = await import("../src-substrate-sidecar/index.ts");
    await runSubstrate();
  }
  else throw new Error("Usage: floe-desktop <auth|substrate>");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
