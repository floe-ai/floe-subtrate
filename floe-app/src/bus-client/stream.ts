/**
 * WebSocket stream client for /v1/events/stream.
 *
 * Provides an automatic reconnect loop with exponential back-off so components
 * do not lose their live-update channel when the bus restarts or the connection
 * drops briefly.  The returned cleanup function cancels the loop immediately —
 * even if the socket is still in the CONNECTING state — without triggering the
 * "WebSocket closed before connection established" Chrome warning.
 */
import type { StreamMsg } from "./types.ts";

const BUS_WS_URL = "ws://127.0.0.1:5377/v1/events/stream";

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 16_000;

export function subscribeEvents(
  handler: (msg: StreamMsg) => void,
  options: {
    onOpen?: () => void;
    onStateChange?: (state: "connecting" | "open" | "closed") => void;
  } = {},
): () => void {
  let cancelled = false;
  let ws: WebSocket | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (cancelled) return;
    options.onStateChange?.("connecting");
    try {
      ws = new WebSocket(BUS_WS_URL);
    } catch {
      // WebSocket unavailable (test/SSR env without browser globals)
      options.onStateChange?.("closed");
      return;
    }

    ws.onmessage = (event) => {
      if (cancelled) return;
      try {
        const msg = JSON.parse(event.data) as StreamMsg;
        handler(msg);
      } catch {
        // ignore non-JSON frames
      }
    };

    ws.onopen = () => {
      if (cancelled) {
        ws?.close();
        return;
      }
      // Reset back-off on successful connection.
      backoffMs = INITIAL_BACKOFF_MS;
      options.onStateChange?.("open");
      options.onOpen?.();
    };

    ws.onclose = () => {
      if (cancelled) return;
      options.onStateChange?.("closed");
      retryTimer = setTimeout(() => {
        if (!cancelled) connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };

    ws.onerror = () => {
      // `onclose` fires after `onerror`, so reconnect is handled there.
    };
  }

  connect();

  return () => {
    cancelled = true;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
      // If CONNECTING: let the socket finish opening; onopen will close it.
      // If CLOSING/CLOSED: no action needed.
      ws = null;
    }
  };
}
