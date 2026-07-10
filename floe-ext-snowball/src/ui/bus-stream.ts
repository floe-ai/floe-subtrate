/**
 * WebSocket event stream subscription utility for the Snowball extension UI.
 *
 * Mirrors floe-app/src/bus-client/stream.ts but derives the WS URL from the
 * bus HTTP base URL passed as a prop, so the extension works regardless of
 * which port the bus is on.
 *
 * Provides auto-reconnect with exponential back-off; the cleanup function is
 * cancel-safe even when the socket is still CONNECTING (avoids the
 * "WebSocket closed before connection established" Chrome warning that would
 * occur when React strict-mode cleanup runs on an in-flight socket).
 */

const INITIAL_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 16_000;

export type BusStreamMsg = {
  type: string;
  payload?: Record<string, unknown>;
};

/**
 * Subscribe to the bus event stream at `wsUrl`.
 * Returns an unsubscribe/cleanup function.
 */
export function subscribeBusStream(
  wsUrl: string,
  handler: (msg: BusStreamMsg) => void
): () => void {
  let cancelled = false;
  let ws: WebSocket | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (cancelled) return;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      // WebSocket unavailable (test/SSR env without browser globals)
      return;
    }

    ws.onmessage = (event) => {
      if (cancelled) return;
      try {
        handler(JSON.parse(event.data) as BusStreamMsg);
      } catch {
        // ignore non-JSON frames
      }
    };

    ws.onopen = () => {
      if (cancelled) {
        ws?.close();
        return;
      }
      backoffMs = INITIAL_BACKOFF_MS;
    };

    ws.onclose = () => {
      if (cancelled) return;
      retryTimer = setTimeout(() => {
        if (!cancelled) connect();
      }, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    };

    ws.onerror = () => {
      // onclose fires after onerror; reconnect is handled there.
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
      // If CONNECTING: onopen will close it; if CLOSING/CLOSED: no-op.
      ws = null;
    }
  };
}
