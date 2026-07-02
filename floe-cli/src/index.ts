#!/usr/bin/env node
// Fail-fast dependency preflight. This bootstrap deliberately imports nothing that
// pulls in the runtime dependencies (pi-ai / pi-agent-core), so it can detect a stale
// install and print a clear "run npm install" message before the real CLI is loaded
// and crashes deep in an import with a raw ERR_MODULE_NOT_FOUND.
import { assertRuntimeDepsResolvable } from "./require-deps.js";

try {
  assertRuntimeDepsResolvable();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

await import("./cli.js");
