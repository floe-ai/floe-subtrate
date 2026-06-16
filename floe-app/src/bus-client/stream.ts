/**
 * WebSocket stream client for /v1/events/stream.
 * Returns an unsubscribe function.
 */
import type { StreamMsg } from "./types.ts";

const BUS_WS_URL = "ws://127.0.0.1:5377/v1/events/stream";

export function subscribeEvents(handler: (msg: StreamMsg) => void): () => void {
  throw new Error("not implemented");
  // Stub: open WebSocket, parse JSON, call handler, return close fn.
  void handler;
  void BUS_WS_URL;
}
