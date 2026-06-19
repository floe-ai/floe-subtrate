/**
 * WebSocket stream client for /v1/events/stream.
 * Returns an unsubscribe function.
 */
import type { StreamMsg } from "./types.ts";

const BUS_WS_URL = "ws://127.0.0.1:5377/v1/events/stream";

export function subscribeEvents(handler: (msg: StreamMsg) => void): () => void {
  const ws = new WebSocket(BUS_WS_URL);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data) as StreamMsg;
      handler(msg);
    } catch {}
  };
  return () => {
    ws.close();
  };
}
