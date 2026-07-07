/**
 * Snowball extension — entry point.
 *
 * This file is the `entry` declared in extension.json.  The extension loader
 * calls the default export (factory) with an ExtensionContext and expects an
 * array of tools back.
 *
 * Side effects at load time:
 *  - Hook registration (BeforeTurn board injection, Pulse heartbeat)
 *  - HTTP handler registration (board state + card move relay; requires Track S)
 *
 * Contract sections implemented:
 *  §1 — extension manifest (extension.json)
 *  §2 — overseer agent bundling (overseer-instructions.md)
 *  §3 — sidecar state management (sidecar.ts)
 *  §4 — event routing (hooks.ts, tools/index.ts)
 *  §5 — tool surface (tools/index.ts)
 *  §6 — stub seam (stub/bus-client.ts, stub/extension-context.ts)
 */

import type { ExtensionContext } from "./stub/extension-context.js";
import { createTools } from "./tools/index.js";
import { registerHooks } from "./hooks.js";
import { registerHttpHandlers } from "./handlers.js";

/**
 * Extension factory — called once per workspace attach.
 * Returns the tool array; hook and HTTP handler registration are side effects.
 */
export default function createSnowballExtension(ctx: ExtensionContext) {
  // Register lifecycle hooks (BeforeTurn board injection, Pulse heartbeat)
  registerHooks(ctx);

  // Register HTTP handlers for the board UI relay (no-op if relay not yet available)
  registerHttpHandlers(ctx);

  // Return tools (loader adds "snowball_" prefix to each name)
  return createTools(ctx);
}
