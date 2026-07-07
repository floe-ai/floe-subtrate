/**
 * Extension HTTP relay server.
 *
 * Starts a minimal Node.js HTTP server that routes requests to extension-
 * registered handlers.  The server's base URL is reported to the bus via
 * `reportExtensions({ relay_url })` so that the bus proxy route
 * `GET|POST /v1/extensions/:name/*` can forward incoming app requests here.
 *
 * URL scheme: `http://127.0.0.1:{port}/{extName}/{handlerPath}`
 * e.g.  GET  http://127.0.0.1:5378/snowball/board?scope_id=X
 *        POST http://127.0.0.1:5378/snowball/move
 *
 * The bus relay strips the extension name from the path before forwarding, so
 * the subPath it forwards is `/{handlerPath}` (e.g. `/board`). The bridge
 * server re-prefixes with the extension name in the URL to disambiguate which
 * extension's handler to invoke.
 *
 * Contract §1.6: extension HTTP relay.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ExtensionHttpHandler } from "./extension-loader.js";

export interface RelayExtensionEntry {
  name: string;
  handlers: ExtensionHttpHandler[];
}

/**
 * Start the bridge extension relay HTTP server.
 *
 * @param extensions — loaded extensions with their registered httpHandlers
 * @param preferredPort — try this port first; if taken, fall back to OS-assigned (0)
 * @returns `{ server, baseUrl }` — baseUrl is the per-extension base, i.e.
 *          `http://127.0.0.1:{port}` (extension name is included in paths below this)
 */
export async function startExtensionRelayServer(
  extensions: RelayExtensionEntry[],
  preferredPort = 5378
): Promise<{ server: Server; baseUrl: string }> {
  const handlerMap = buildHandlerMap(extensions);

  const server = createServer((req, res) => {
    handleRequest(req, res, handlerMap).catch(err => {
      console.error("[bridge:relay] unhandled error", err);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "relay_internal_error", message: String(err) }));
    });
  });

  const port = await listenOn(server, preferredPort);
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[bridge:relay] extension relay server started: ${baseUrl}`);
  return { server, baseUrl };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type HandlerKey = `${"GET"|"POST"}:/${string}/${string}`; // e.g. "GET:/snowball/board"

function buildHandlerMap(extensions: RelayExtensionEntry[]): Map<HandlerKey, ExtensionHttpHandler["handler"]> {
  const map = new Map<HandlerKey, ExtensionHttpHandler["handler"]>();
  for (const ext of extensions) {
    for (const h of ext.handlers) {
      // Normalise the handler path to ensure it starts with "/"
      const hp = h.path.startsWith("/") ? h.path : `/${h.path}`;
      const key = `${h.method}:/${ext.name}${hp}` as HandlerKey;
      map.set(key, h.handler);
    }
  }
  return map;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlerMap: Map<HandlerKey, ExtensionHttpHandler["handler"]>
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase() as "GET" | "POST";
  const rawUrl = req.url ?? "/";

  // Parse path + query
  const urlObj = new URL(rawUrl, "http://localhost");
  const pathname = urlObj.pathname; // e.g. "/snowball/board"
  const query: Record<string, string> = {};
  urlObj.searchParams.forEach((v, k) => { query[k] = v; });

  // Read body (for POST)
  let body: unknown = null;
  if (method === "POST") {
    body = await readBody(req);
  }

  const key = `${method}:${pathname}` as HandlerKey;
  const handler = handlerMap.get(key);

  if (!handler) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "handler_not_found", method, path: pathname }));
    return;
  }

  try {
    const result = await handler({ method, path: pathname, query, body });
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(JSON.stringify(result.body));
  } catch (err) {
    console.error("[bridge:relay] handler error", { method, path: pathname, err });
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "handler_error", message: String(err) }));
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve(text ? JSON.parse(text) : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

/** Try to listen on `preferredPort`; fall back to OS-assigned port. */
async function listenOn(server: Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve(addr.port);
        } else {
          reject(new Error("Server address unavailable"));
        }
      });
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port === preferredPort) {
          // Preferred port taken — let OS pick
          server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            if (addr && typeof addr === "object") {
              resolve(addr.port);
            } else {
              reject(new Error("Server address unavailable"));
            }
          });
        } else {
          reject(err);
        }
      });
    };
    tryListen(preferredPort);
  });
}
