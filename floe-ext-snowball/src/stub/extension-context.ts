/**
 * Extension context type stub — mirrors ExtensionContext from the bridge loader.
 *
 * Used internally for type-safe access to ctx.busClient and ctx.hooks.
 * The real ExtensionContext is defined in floe-bridge/src/extension-loader.ts;
 * this file provides a typed equivalent so floe-ext-snowball compiles without
 * importing from the bridge package.
 *
 * Integration join: if the bridge exports ExtensionContext, import it directly
 * instead of this stub.
 */

export type HookName =
  | "SessionStart"
  | "BeforeTurn"
  | "TurnEnd"
  | "BeforeToolUse"
  | "AfterToolUse"
  | "ToolUseFailed"
  | "SessionResume"
  | "SessionEnd"
  | "Pulse"
  | "WebhookReceived"
  | "Error";

export type HookResult = {
  inject?: Record<string, unknown>;
};

export type HookHandler = (
  payload: Record<string, unknown>
) => void | HookResult | Promise<HookResult | void>;

export interface RegisterHttpHandler {
  (method: "GET" | "POST", path: string, handler: (req: unknown) => Promise<unknown>): void;
}

export interface ExtensionContext {
  workspacePath: string;
  /** The raw bus HTTP client — use asBusClient() for typed access */
  busClient: unknown;
  workspaceId: string;
  extensionName: string;
  hooks: {
    on(hook: HookName, handler: HookHandler): void;
  };
  /**
   * Optional HTTP handler registration — provided by Track S extension relay.
   * If absent (pre-Track-S integration), handler registration is skipped.
   */
  registerHttpHandler?: RegisterHttpHandler;
}
