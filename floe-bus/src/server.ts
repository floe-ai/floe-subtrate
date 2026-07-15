/**
 * @invariant This file is the only public HTTP/WebSocket boundary for floe-bus.
 * API handlers must expose bus-owned truth without bypassing BusStore precedence,
 * bridge-reported runtime state, or the shared auth/model registry.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import { parseListen } from "./config.js";
import { BROADCAST_TARGETS, BusStore, ContextAnchorError, ContextNotFoundError, ContextParticipantError, ContextScopeAssignmentError, PulseNotFoundError, ScopeRequiredError, type EventCommand, type PulsePersistence, type PulseSubscriber } from "./store.js";
import { PulseScheduler } from "./pulse-scheduler.js";
import {
  loadScopeProjectionLayout,
  upsertScopeProjectionLayout
} from "./scope-projection-layout-store.js";
import { ScopeAlreadyExistsError, ScopeNotEmptyError, ScopeNotFoundError, ScopeReservedIdError } from "./scopes/store.js";
import { encodeEventCursor, InvalidEventCursorError } from "./event-cursor.js";
import { buildScopeProjection } from "./scopes/projection.js";
import { listAuthModels, listAuthProfiles } from "./auth.js";
import { browseDir } from "./fs/browseDir.js";
import { listAgentFiles } from "./fs/agentFiles.js";
import { PathEscapesRootError, resolveWithinRoot, RootNotFoundError } from "./fs/resolveWithinRoot.js";

const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
const BRIDGE_LIVENESS_MS = 90_000;

const EventCommandSchema = z.object({
  type: z.string().min(1),
  workspace_id: z.string().min(1),
  source_endpoint_id: z.string().min(1),
  destination: z.union([
    z.object({
      kind: z.literal("endpoint"),
      endpoint_id: z.string().min(1)
    }),
    z.object({
      kind: z.literal("broadcast"),
      scope: z.literal("workspace"),
      target: z.enum(BROADCAST_TARGETS),
      exclude_source: z.boolean().optional()
    }),
    z.object({
      kind: z.literal("context"),
      context_id: z.string().min(1)
    })
  ]),
  thread_id: z.string().min(1).optional(),
  context_id: z.string().min(1).nullable().optional(),
  current_delivery_context_id: z.string().min(1).nullable().optional(),
  scope_id: z.string().min(1).nullable().optional(),
  correlation_id: z.string().nullable().optional(),
  content: z.record(z.unknown()),
  response: z.object({
    expected: z.boolean(),
    mode: z.enum(["open", "thread_affine", "correlated"]).optional(),
    correlation_id: z.string().nullable().optional(),
    timeout_at: z.string().nullable().optional()
  }).optional(),
  metadata: z.record(z.unknown()).optional(),
  idempotency_key: z.string().nullable().optional()
});

const RuntimeBindingUpsertSchema = z.object({
  scope: z.enum(["agent", "workspace_default", "global_default"]),
  workspace_id: z.string().nullable().optional(),
  endpoint_id: z.string().nullable().optional(),
  auth_profile: z.string().min(1),
  model: z.string().nullable().optional(),
  thinking_level: ThinkingLevelSchema.nullable().optional()
});

const PulseSubscriberSchema = z.union([
  z.object({
    kind: z.literal("context"),
    context_id: z.string().min(1)
  }),
  z.object({
    kind: z.literal("endpoint").optional(),
    endpoint_ref: z.string().min(1),
    context_id: z.string().min(1).nullable().optional()
  })
]);

const RuntimeBindingClearSchema = z.object({
  scope: z.enum(["agent", "workspace_default", "global_default"]),
  workspace_id: z.string().nullable().optional(),
  endpoint_id: z.string().nullable().optional()
});

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "close" | "error", listener: () => void): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
};

export async function createBusServer(configPath: string, config: LocalConfig): Promise<{
  app: ReturnType<typeof Fastify>;
  store: BusStore;
  broadcast: (type: string, payload?: Record<string, unknown>) => void;
  listen: () => Promise<void>;
}> {
  const app = Fastify({ logger: true });
  const store = new BusStore(configPath, config);
  const sockets = new Set<SocketLike>();
  /** Maps bridge_id → the WS socket it opened; used for socket-presence liveness (D4). */
  const bridgeSockets = new Map<string, SocketLike>();

  function broadcast(type: string, payload: Record<string, unknown> = {}): void {
    const message = JSON.stringify({
      type,
      payload,
      at: new Date().toISOString()
    });
    for (const socket of sockets) {
      try {
        if (socket.readyState === 1) socket.send(message);
      } catch {
        sockets.delete(socket);
      }
    }
  }

  // Inject broadcast into the store so lease-expiry requeue can self-schedule (D5).
  store.setBroadcast(broadcast);

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const socket of sockets) socket.close();
    bridgeSockets.clear();
    store.close();
  });

  const timer = setInterval(() => undefined, 60_000);

  app.get("/health", async () => ({
    ok: true,
    service: "floe-bus",
    time: new Date().toISOString()
  }));

  app.get("/v1/local-config/status", async () => ({
    ok: true,
    config_path: configPath,
    home: config.home,
    bus: config.bus,
    app: config.app,
    bridge: config.bridge
  }));

  app.get("/v1/runtime/status", async () => {
    // D4: liveness is determined by socket presence, not a time-window check.
    // A bridge is online if and only if its WS socket is currently connected.
    const onlineBridges = store.listBridges().filter((bridge) => {
      const s = bridgeSockets.get(bridge.bridge_id);
      return s !== undefined && s.readyState === 1;
    });
    const runtimeAdapter = onlineBridges
      .flatMap((bridge) => {
        const adapters = Array.isArray(bridge.capabilities.runtime_adapters)
          ? bridge.capabilities.runtime_adapters
          : [];
        return adapters.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      })[0] ?? null;
    return {
      bridge: {
        online: onlineBridges.length > 0,
        runtime_adapter: runtimeAdapter
      }
    };
  });

  app.get("/v1/events/stream", { websocket: true }, (socket) => {
    const client = socket as unknown as SocketLike;
    sockets.add(client);
    let connectedBridgeId: string | null = null;
    client.send(JSON.stringify({
      type: "hello",
      payload: { service: "floe-bus" },
      at: new Date().toISOString()
    }));
    // D4: handle bridge_hello from the connecting bridge to establish WS-based liveness.
    client.on("message", (raw) => {
      try {
        const msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as Record<string, unknown>;
        if (msg.type === "bridge_hello" && typeof msg.bridge_id === "string") {
          const bridgeId = msg.bridge_id;
          connectedBridgeId = bridgeId;
          bridgeSockets.set(bridgeId, client);
          // Also update the DB last_seen_at so stored timestamps stay fresh.
          store.reportBridgeLiveness(bridgeId);
        }
      } catch {
        // ignore malformed frames
      }
    });
    client.on("close", () => {
      sockets.delete(client);
      if (connectedBridgeId !== null && bridgeSockets.get(connectedBridgeId) === client) {
        bridgeSockets.delete(connectedBridgeId);
      }
    });
    client.on("error", () => {
      sockets.delete(client);
      if (connectedBridgeId !== null && bridgeSockets.get(connectedBridgeId) === client) {
        bridgeSockets.delete(connectedBridgeId);
      }
    });
  });

  app.get("/v1/workspaces", async () => ({
    workspaces: store.listWorkspaces()
  }));

  app.get("/v1/workspaces/:workspace_id/scopes", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    return { scopes: store.listScopes(params.workspace_id) };
  });

  app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/projection", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    return { projection: buildScopeProjection(store, params.workspace_id, params.scope_id) };
  });

  app.post("/v1/workspaces/:workspace_id/scopes", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      scope_id: z.string().min(1).optional(),
      title: z.string().min(1),
      description: z.string().nullable().optional()
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    try {
      const scope = store.createScope({
        workspace_id: params.workspace_id,
        scope_id: body.scope_id,
        title: body.title,
        description: body.description ?? null
      }, broadcast);
      return reply.code(201).send({ scope });
    } catch (err) {
      if (err instanceof ScopeAlreadyExistsError) {
        return reply.code(409).send({
          error: "scope_already_exists",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ScopeReservedIdError) {
        return reply.code(400).send({
          error: "scope_id_reserved",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      throw err;
    }
  });

  app.patch("/v1/workspaces/:workspace_id/scopes/:scope_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({
      title: z.string().min(1).optional(),
      description: z.string().nullable().optional()
    }).refine((value) => "title" in value || "description" in value, {
      message: "At least one Scope metadata field is required"
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    const scope = store.updateScope({
      workspace_id: params.workspace_id,
      scope_id: params.scope_id,
      title: body.title,
      description: body.description
    }, broadcast);
    if (!scope) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    return { scope };
  });

  app.delete("/v1/workspaces/:workspace_id/scopes/:scope_id", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    try {
      store.deleteScope(params.workspace_id, params.scope_id, broadcast);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ScopeReservedIdError) {
        return reply.code(400).send({
          error: "scope_id_reserved",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ScopeNotEmptyError) {
        return reply.code(409).send({
          error: "scope_not_empty",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id,
          context_count: err.context_count,
          pulse_count: err.pulse_count
        });
      }
      throw err;
    }
  });

  function resolveWorkspaceLocator(workspaceId: string, reply: any): string | null {
    const ws = store.getWorkspace(workspaceId) as { locator?: string } | undefined;
    if (!ws?.locator) {
      reply.code(404);
      reply.send({ error: "workspace_not_found" });
      return null;
    }
    return ws.locator;
  }

  function mapScopeProjectionLayoutError(err: unknown, reply: any): { error: string; message: string } | null {
    if (!(err instanceof Error)) return null;
    switch (err.name) {
      case "ScopeProjectionLayoutValidationError":
        reply.code(400);
        return { error: "scope_projection_layout_validation_error", message: err.message };
      case "ScopeProjectionLayoutIdMismatchError":
        reply.code(400);
        return { error: "scope_projection_layout_id_mismatch", message: err.message };
      case "ScopeProjectionLayoutRendererInvalidError":
        reply.code(400);
        return { error: "scope_projection_layout_renderer_invalid", message: err.message };
      default:
        return null;
    }
  }

  app.get("/v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string(),
      renderer: z.string()
    }).parse(request.params);
    if (params.renderer !== "floeweb") {
      reply.code(400);
      return { error: "scope_projection_layout_renderer_invalid", message: `renderer '${params.renderer}' not supported (only 'floeweb')` };
    }
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const layout = loadScopeProjectionLayout(locator, params.scope_id, params.renderer);
      if (!layout) {
        reply.code(404);
        return { error: "scope_projection_layout_not_found" };
      }
      return { layout };
    } catch (err) {
      const mapped = mapScopeProjectionLayoutError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.put("/v1/workspaces/:workspace_id/scopes/:scope_id/projection/layout/:renderer", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      scope_id: z.string(),
      renderer: z.string()
    }).parse(request.params);
    if (params.renderer !== "floeweb") {
      reply.code(400);
      return { error: "scope_projection_layout_renderer_invalid", message: `renderer '${params.renderer}' not supported (only 'floeweb')` };
    }
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    if (!store.getScope(params.workspace_id, params.scope_id)) {
      return reply.code(404).send({
        error: "scope_not_found",
        workspace_id: params.workspace_id,
        scope_id: params.scope_id
      });
    }
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const layout = upsertScopeProjectionLayout(locator, params.scope_id, params.renderer, request.body);
      broadcast("scope_projection.layout.upserted", {
        workspace_id: params.workspace_id,
        scope_id: params.scope_id,
        source: "api",
        renderer: params.renderer
      });
      return { layout };
    } catch (err) {
      const mapped = mapScopeProjectionLayoutError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post("/v1/workspaces/register", async (request, reply) => {
    const input = z.object({
      locator: z.string().min(1),
      name: z.string().optional(),
      init_authorized: z.boolean().optional(),
      create_directory: z.boolean().optional()
    }).parse(request.body);
    const resolved = resolve(input.locator);
    if (!existsSync(resolved)) {
      if (!input.create_directory) {
        return reply.code(400).send({
          error: "directory_not_found",
          message: `Directory does not exist: ${resolved}`,
          locator: resolved
        });
      }
      mkdirSync(resolved, { recursive: true });
    }
    const workspace = store.registerWorkspace(input, broadcast);
    return reply.code(201).send({ workspace });
  });

  // ---------------------------------------------------------------------------
  // Workspace filesystem surface
  // ---------------------------------------------------------------------------
  // Plain HTTP direct disk I/O on the box that runs the bus — the same shape
  // as /v1/workspaces/register above. Exists because the console (floe-app)
  // is usually NOT co-located with workspace files (e.g. a Windows console
  // tunneled into a Linux substrate), so a Tauri/browser-local FS read can't
  // see `.floe/agents/`. Gated on workspace_access.local_paths; everything
  // here is additive and does not change any existing route's behavior.

  function fsAccessEnabled(): boolean {
    return config.bridge.workspace_access.local_paths === true;
  }

  function sendFsDisabled(reply: any) {
    return reply.code(403).send({ error: "fs_disabled", message: "workspace_access.local_paths is disabled" });
  }

  function mapFsError(err: unknown, reply: any): { error: string; message: string } {
    if (err instanceof PathEscapesRootError) {
      reply.code(400);
      return { error: "path_escapes_root", message: err.message };
    }
    if (err instanceof RootNotFoundError) {
      reply.code(404);
      return { error: "workspace_root_not_found", message: err.message };
    }
    const code = (err as { code?: string } | null)?.code;
    if (code === "ENOENT") {
      reply.code(404);
      return { error: "file_not_found", message: err instanceof Error ? err.message : "Not found" };
    }
    reply.code(500);
    return { error: "fs_error", message: err instanceof Error ? err.message : String(err) };
  }

  /** GET /v1/fs/capability — cheap probe so floe-app can decide whether to show file-editing UI. */
  app.get("/v1/fs/capability", async () => ({
    local_paths: fsAccessEnabled()
  }));

  /** GET /v1/fs/browse?path=<abs> — directory browser for the register-workspace folder picker. */
  app.get("/v1/fs/browse", async (request, reply) => {
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const query = z.object({ path: z.string().optional() }).parse(request.query);
    return browseDir(query.path);
  });

  app.get("/v1/workspaces/:workspace_id/fs/agents", async (request, reply) => {
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    return { files: listAgentFiles(locator) };
  });

  app.get("/v1/workspaces/:workspace_id/fs/file", async (request, reply) => {
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const query = z.object({ path: z.string().min(1) }).parse(request.query);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const resolved = resolveWithinRoot(locator, query.path);
      const contents = readFileSync(resolved, "utf8");
      return { contents };
    } catch (err) {
      return reply.send(mapFsError(err, reply));
    }
  });

  app.put("/v1/workspaces/:workspace_id/fs/file", async (request, reply) => {
    if (!fsAccessEnabled()) return sendFsDisabled(reply);
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      path: z.string().min(1),
      contents: z.string()
    }).parse(request.body);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const resolved = resolveWithinRoot(locator, body.path);
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, body.contents, "utf8");
      return { ok: true };
    } catch (err) {
      return reply.send(mapFsError(err, reply));
    }
  });

  app.post("/v1/workspaces/:workspace_id/select", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const workspace = store.selectWorkspace(params.workspace_id, broadcast);
    return { workspace };
  });

  app.post("/v1/workspaces/:workspace_id/delete", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      delete_locator: z.boolean().optional()
    }).parse(request.body ?? {});
    return store.deleteWorkspace(params.workspace_id, { delete_locator: body.delete_locator ?? false }, broadcast);
  });

  app.post("/v1/workspaces/:workspace_id/attachment-result", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      bridge_id: z.string(),
      status: z.string(),
      config_hash: z.string().nullable().optional(),
      error_code: z.string().nullable().optional(),
      validation: z.unknown().optional()
    }).parse(request.body);
    return {
      workspace: store.reportAttachment({
        workspace_id: params.workspace_id,
        bridge_id: body.bridge_id,
        status: body.status,
        config_hash: body.config_hash ?? null,
        error_code: body.error_code ?? null,
        validation: body.validation
      }, broadcast)
    };
  });

  app.get("/v1/workspaces/:workspace_id/config-status", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return { workspace: store.getWorkspace(params.workspace_id) };
  });

  app.post("/v1/workspaces/:workspace_id/config-snapshot", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return store.requestConfigSnapshot(params.workspace_id, broadcast);
  });

  app.post("/v1/workspaces/:workspace_id/import-config", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return {
      workspace: store.importConfigSnapshot(params.workspace_id, request.body as Record<string, unknown>, broadcast)
    };
  });

  app.post("/v1/workspaces/:workspace_id/apply-config", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({ config_id: z.string().nullable().optional() }).parse(request.body ?? {});
    return store.requestApplyConfig(params.workspace_id, body.config_id ?? null, broadcast);
  });

  app.get("/v1/runtime/bindings", async (request) => {
    const query = z.object({ workspace_id: z.string().optional() }).parse(request.query);
    return { bindings: store.listRuntimeBindings(query.workspace_id) };
  });

  app.post("/v1/runtime/bindings", async (request, reply) => {
    const body = RuntimeBindingUpsertSchema.parse(request.body);
    const binding = store.upsertRuntimeBinding({
      scope: body.scope,
      workspace_id: body.workspace_id ?? null,
      endpoint_id: body.endpoint_id ?? null,
      auth_profile: body.auth_profile,
      model: body.model ?? null,
      thinking_level: body.thinking_level ?? null
    }, broadcast);
    if (body.scope === "agent" && body.endpoint_id && body.workspace_id) {
      const endpoint = store.getEndpoint(body.endpoint_id) as any;
      if (endpoint && String(endpoint.status) === "runtime_unconfigured") {
        const resolution = store.getRuntimeBindingResolution(body.workspace_id, body.endpoint_id);
        const hasModel = resolution.endpoint_model || resolution.workspace_model || resolution.global_model;
        if (hasModel) store.updateEndpointStatus(body.endpoint_id, "idle", broadcast);
      }
    }
    if (body.scope === "workspace_default" && body.workspace_id) {
      const endpoints = store.listEndpoints(body.workspace_id) as any[];
      for (const endpoint of endpoints) {
        if (endpoint.bridge_id && String(endpoint.status) === "runtime_unconfigured") {
          const resolution = store.getRuntimeBindingResolution(body.workspace_id, String(endpoint.endpoint_id));
          const hasModel = resolution.endpoint_model || resolution.workspace_model || resolution.global_model;
          if (hasModel) store.updateEndpointStatus(String(endpoint.endpoint_id), "idle", broadcast);
        }
      }
    }
    return reply.code(201).send({ binding });
  });

  app.post("/v1/runtime/bindings/clear", async (request) => {
    const body = RuntimeBindingClearSchema.parse(request.body);
    const result = store.clearRuntimeBinding({
      scope: body.scope,
      workspace_id: body.workspace_id ?? null,
      endpoint_id: body.endpoint_id ?? null
    }, broadcast);
    if (body.scope === "agent" && body.endpoint_id) {
      store.updateEndpointStatus(body.endpoint_id, "runtime_unconfigured", broadcast);
    }
    if (body.scope === "workspace_default" && body.workspace_id) {
      const endpoints = store.listEndpoints(body.workspace_id) as any[];
      for (const endpoint of endpoints) {
        if (endpoint.bridge_id) {
          store.updateEndpointStatus(String(endpoint.endpoint_id), "runtime_unconfigured", broadcast);
        }
      }
    }
    return result;
  });

  app.get("/v1/runtime/bindings/resolve", async (request) => {
    const query = z.object({
      workspace_id: z.string().min(1),
      endpoint_id: z.string().min(1)
    }).parse(request.query);
    return store.getRuntimeBindingResolution(query.workspace_id, query.endpoint_id);
  });

  app.get("/v1/auth/profiles", async () => {
    const profiles = listAuthProfiles(configPath, config);
    return {
      profiles,
      default_auth_profile: typeof config.runtime?.default_auth_profile === "string"
        ? config.runtime.default_auth_profile
        : null
    };
  });

  app.get("/v1/auth/models", async (request) => {
    const query = z.object({ provider: z.string().optional() }).parse(request.query);
    return { models: await listAuthModels(configPath, config, query.provider) };
  });

  app.post("/v1/bridges/register", async (request, reply) => {
    const body = z.object({
      bridge_id: z.string().min(1),
      capabilities: z.record(z.unknown()).optional()
    }).parse(request.body);
    return reply.code(201).send({ bridge: store.registerBridge(body, broadcast) });
  });

  app.post("/v1/bridges/:bridge_id/liveness", async (request) => {
    const params = z.object({ bridge_id: z.string() }).parse(request.params);
    store.reportBridgeLiveness(params.bridge_id);
    return { ok: true };
  });

  app.post("/v1/delivery/:delivery_id/status", async (request) => {
    const params = z.object({ delivery_id: z.string() }).parse(request.params);
    const body = z.object({
      bridge_id: z.string(),
      state: z.enum(["injected_to_runtime", "acknowledged", "failed", "dead_lettered", "deferred"]),
      error: z.string().nullable().optional()
    }).parse(request.body);
    return {
      delivery: store.reportDeliveryStatus({
        delivery_id: params.delivery_id,
        bridge_id: body.bridge_id,
        state: body.state,
        error: body.error ?? null
      }, broadcast)
    };
  });

  app.get("/v1/endpoints", async (request) => {
    const query = z.object({ workspace_id: z.string().optional() }).parse(request.query);
    return { endpoints: store.listEndpoints(query.workspace_id) };
  });

  app.get("/v1/workspaces/:workspace_id/endpoints", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return { endpoints: store.listEndpoints(params.workspace_id) };
  });

  app.get("/v1/workspaces/:workspace_id/resolve-endpoint", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const query = z.object({ ref: z.string().min(1) }).parse(request.query);
    const endpointId = store.resolveSubscriberEndpointId(params.workspace_id, query.ref);
    const endpoint = store.getEndpoint(endpointId);
    return { endpoint_id: endpointId, found: !!endpoint };
  });

  app.post("/v1/endpoints/register", async (request, reply) => {
    const body = z.object({
      endpoint_id: z.string().min(1),
      workspace_id: z.string().min(1),
      name: z.string().min(1),
      agent_id: z.string().nullable().optional(),
      bridge_id: z.string().nullable().optional(),
      status: z.string().optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(request.body);
    return reply.code(201).send({ endpoint: store.registerEndpoint(body, broadcast) });
  });

  app.delete("/v1/endpoints/:endpoint_id", async (request, reply) => {
    const params = z.object({ endpoint_id: z.string() }).parse(request.params);
    try {
      const result = store.deleteEndpoint(params.endpoint_id, broadcast);
      return reply.send(result);
    } catch (err) {
      return reply.code(404).send({ ok: false, error: err instanceof Error ? err.message : "Not found" });
    }
  });

  app.post("/v1/endpoints/:endpoint_id/status", async (request) => {
    const params = z.object({ endpoint_id: z.string() }).parse(request.params);
    const body = z.object({ status: z.string().min(1) }).parse(request.body);
    return { endpoint: store.updateEndpointStatus(params.endpoint_id, body.status, broadcast) };
  });

  app.post("/v1/events/emit", async (request, reply) => {
    const parsed = EventCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: "invalid_event_command",
          message: "Invalid event command",
          issues: parsed.error.issues
        }
      });
    }
    const command = parsed.data as EventCommand;
    try {
      const result = store.submitEvent(command, broadcast);
      return reply.code(202).send({
        ok: true,
        event_id: result.event.event_id,
        accepted_at: result.event.created_at,
        deliveries_created: result.deliveries_created,
        event: result.event
      });
    } catch (err) {
      if (err instanceof ContextParticipantError) {
        return reply.code(409).send({ ok: false, error: err.payload });
      }
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      throw err;
    }
  });

  app.get("/v1/events", async (request, reply) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      thread_id: z.string().optional(),
      context_id: z.string().optional(),
      scope_id: z.string().optional(),
      since: z.string().optional(),
      limit: z.coerce.number().int().positive().optional()
    }).parse(request.query);
    let events;
    try {
      events = store.listEvents(query);
    } catch (err) {
      if (err instanceof InvalidEventCursorError) {
        return reply.code(400).send({ error: "invalid_event_cursor", since: err.value });
      }
      throw err;
    }
    // The cursor of the last Event returned, for the caller to page or advance a
    // watermark from. Null when nothing came back, so the caller holds position.
    const last = events[events.length - 1];
    const next_cursor = last ? encodeEventCursor({ created_at: last.created_at, event_id: last.event_id }) : null;
    return { events, next_cursor };
  });

  app.get("/v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      endpoint_id: z.string().min(1)
    }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    return { watermark: store.getEndpointWatermark(params.workspace_id, params.endpoint_id) };
  });

  app.put("/v1/workspaces/:workspace_id/endpoints/:endpoint_id/watermark", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      endpoint_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({ cursor: z.string().min(1) }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    try {
      const watermark = store.setEndpointWatermark(params.workspace_id, params.endpoint_id, body.cursor);
      return { watermark };
    } catch (err) {
      if (err instanceof InvalidEventCursorError) {
        return reply.code(400).send({ error: "invalid_event_cursor", cursor: err.value });
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // Context API (Slice 2) — thin wrappers over ContextStore
  // ---------------------------------------------------------------------------

  function serializeContextListRow(r: {
    context_id: string;
    workspace_id: string;
    scope_id: string | null;
    parent_context_id: string | null;
    created_by_endpoint_id: string | null;
    created_at: string;
    last_event_at: string | null;
    participants: string[];
    title?: string | null;
  }) {
    return {
      context_id: r.context_id,
      workspace_id: r.workspace_id,
      scope_id: r.scope_id,
      parent_context_id: r.parent_context_id,
      created_by_endpoint_id: r.created_by_endpoint_id,
      created_at: r.created_at,
      last_event_at: r.last_event_at,
      participants: r.participants,
      title: (r.title as string | null | undefined) ?? null,
      first_message_preview: store.contextStore.getFirstMessagePreview(r.context_id)
    };
  }

  app.get("/v1/workspaces/:workspace_id/contexts", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const query = z.object({
      scope: z.enum(["all", "scoped", "unscoped"]).optional().default("all"),
      scope_id: z.string().min(1).optional(),
      limit: z.coerce.number().int().positive().max(200).optional().default(50)
    }).parse(request.query);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    // Scope-filtered query uses the indexed listContextsForScope path
    if (query.scope_id) {
      const rows = store.contextStore.listContextsForScope(params.workspace_id, query.scope_id);
      return { contexts: rows.map(serializeContextListRow) };
    }
    const rows = store.contextStore.listContextsForWorkspace(params.workspace_id, {
      scope: query.scope,
      limit: query.limit
    });
    return { contexts: rows.map(serializeContextListRow) };
  });

  app.get("/v1/contexts", async (request) => {
    const query = z.object({
      participant: z.string().min(1),
      workspace_id: z.string().optional(),
      scope_id: z.string().optional()
    }).parse(request.query);
    const rows = store.contextStore.listContextsForParticipant(query.participant);
    const filtered = rows.filter((r) => {
      if (query.workspace_id && r.workspace_id !== query.workspace_id) return false;
      if (query.scope_id && r.scope_id !== query.scope_id) return false;
      return true;
    });
    return {
      contexts: filtered.map(serializeContextListRow)
    };
  });

  app.get("/v1/contexts/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return {
      context_id: ctx.context_id,
      workspace_id: ctx.workspace_id,
      scope_id: ctx.scope_id,
      parent_context_id: ctx.parent_context_id,
      created_by_endpoint_id: ctx.created_by_endpoint_id,
      created_at: ctx.created_at,
      title: ctx.title,
      participants: store.contextStore.getContextParticipants(ctx.context_id),
      first_message_preview: store.contextStore.getFirstMessagePreview(ctx.context_id)
    };
  });

  app.get("/v1/contexts/:id/events", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().positive().optional()
    }).parse(request.query);
    if (!store.contextStore.getContext(params.id)) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return { events: store.listEvents({ context_id: params.id, limit: query.limit }) };
  });

  app.post("/v1/workspaces/:workspace_id/contexts", async (request, reply) => {
    const params = z.object({ workspace_id: z.string().min(1) }).parse(request.params);
    const bodySchema = z.object({
      participants: z.array(z.string().min(1)).optional().default([]),
      scope_id: z.string().min(1).nullable().optional(),
      context_id: z.string().min(1).optional(),
      created_by_endpoint_id: z.string().min(1).nullable().optional(),
      title: z.string().min(1).nullable().optional(),
      // Slice 1 Track B — parent context linking
      parent_context_id: z.string().min(1).nullable().optional(),
    });
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: "invalid_request", issues: parsed.error.issues });
    }
    const body = parsed.data;
    // Require at least participants OR scope_id
    if (body.participants.length === 0 && !body.scope_id) {
      return reply.code(400).send({ ok: false, error: "invalid_request", issues: [{ message: "participants must be non-empty when scope_id is absent" }] });
    }
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    // Guard: self-reference on parent_context_id (when context_id is explicitly provided)
    if (body.parent_context_id && body.context_id && body.parent_context_id === body.context_id) {
      return reply.code(400).send({ ok: false, error: "invalid_request", issues: [{ message: "parent_context_id must not equal the context's own id" }] });
    }
    // Guard: parent context must exist
    if (body.parent_context_id) {
      const parentCtx = store.contextStore.getContext(body.parent_context_id);
      if (!parentCtx) {
        return reply.code(404).send({ ok: false, error: "parent_context_not_found", context_id: body.parent_context_id });
      }
      // Guard: cycle detection — walk the parent chain from the proposed parent;
      // if it already contains body.context_id (explicit) we know it would cycle.
      // For auto-generated IDs we cannot check pre-insert, so we skip (UUID collision is astronomically unlikely).
      if (body.context_id && store.contextStore.wouldCreateCycle(body.parent_context_id, body.context_id)) {
        return reply.code(400).send({ ok: false, error: "invalid_request", issues: [{ message: "parent_context_id would create a cycle" }] });
      }
    }
    const contextId = store.contextStore.createContext({
      workspace_id: params.workspace_id,
      scope_id: body.scope_id ?? null,
      participants: body.participants,
      created_by_endpoint_id: body.created_by_endpoint_id ?? null,
      context_id: body.context_id,
      title: body.title ?? null,
      parent_context_id: body.parent_context_id ?? null,
    });
    // Post-insert self-reference guard (when context_id was auto-generated)
    if (body.parent_context_id && body.parent_context_id === contextId) {
      store.contextStore.db.prepare("DELETE FROM contexts WHERE context_id = ?").run(contextId);
      return reply.code(400).send({ ok: false, error: "invalid_request", issues: [{ message: "parent_context_id must not equal the context's own id" }] });
    }
    const ctx = store.contextStore.getContext(contextId)!;
    const participants = store.contextStore.getContextParticipants(contextId);
    const serialized = serializeContextListRow({
      ...ctx,
      last_event_at: null,
      participants,
    });
    broadcast("context_created", { context: serialized });
    return reply.code(201).send({ context: serialized });
  });

  app.post("/v1/workspaces/:workspace_id/contexts/:context_id/assign-scope", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string().min(1),
      context_id: z.string().min(1)
    }).parse(request.params);
    const body = z.object({
      scope_id: z.string().min(1),
      assigned_by: z.string().min(1).nullable().optional(),
      reason: z.string().min(1).nullable().optional()
    }).parse(request.body);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ ok: false, error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    try {
      return store.assignContextScope({
        workspace_id: params.workspace_id,
        context_id: params.context_id,
        scope_id: body.scope_id,
        assigned_by: body.assigned_by ?? null,
        reason: body.reason ?? null
      }, broadcast);
    } catch (err) {
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      if (err instanceof ContextScopeAssignmentError) {
        return reply.code(409).send({
          ok: false,
          error: "context_scope_assignment_invalid",
          workspace_id: err.workspace_id,
          context_id: err.context_id,
          reason: err.reason
        });
      }
      throw err;
    }
  });

  app.delete("/v1/contexts/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const result = store.deleteContext(params.id, broadcast);
    if (!result) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return result;
  });

  // Slice 1 Track A — dynamic participants
  app.post("/v1/contexts/:id/participants", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({ endpoint_id: z.string().min(1) }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const added = store.contextStore.addParticipant(params.id, body.endpoint_id);
    broadcast("participant_added", { workspace_id: ctx.workspace_id, context_id: params.id, endpoint_id: body.endpoint_id });
    return { ok: true, context_id: params.id, endpoint_id: body.endpoint_id, added };
  });

  app.delete("/v1/contexts/:id/participants/:endpoint_id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), endpoint_id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const removed = store.contextStore.removeParticipant(params.id, params.endpoint_id);
    broadcast("participant_removed", { workspace_id: ctx.workspace_id, context_id: params.id, endpoint_id: params.endpoint_id });
    return { ok: true, context_id: params.id, endpoint_id: params.endpoint_id, removed };
  });

  // Slice 1 Track B — context linking (children query)
  app.get("/v1/contexts/:id/children", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!store.contextStore.getContext(params.id)) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const rows = store.contextStore.listContextsForParent(params.id);
    return { contexts: rows.map(serializeContextListRow) };
  });

  // Slice 2 — per-actor, per-context, per-event-type subscriptions
  app.post("/v1/contexts/:id/subscriptions", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      endpoint_id: z.string().min(1),
      event_types: z.array(z.string().min(1)).optional().default(["*"]),
    }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    store.contextStore.subscribeToContext(params.id, body.endpoint_id, body.event_types);
    return { ok: true, context_id: params.id, endpoint_id: body.endpoint_id, event_types: body.event_types };
  });

  app.delete("/v1/contexts/:id/subscriptions/:endpoint_id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1), endpoint_id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    store.contextStore.unsubscribeFromContext(params.id, params.endpoint_id);
    return { ok: true, context_id: params.id, endpoint_id: params.endpoint_id };
  });

  app.get("/v1/contexts/:id/subscriptions", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    if (!store.contextStore.getContext(params.id)) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return { subscriptions: store.contextStore.getContextSubscriptions(params.id) };
  });

  // Batch apply — participants + subscriptions in one atomic operation
  app.post("/v1/contexts/:id/subscriptions:batch", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      entries: z.array(
        z.object({
          endpoint_id: z.string().min(1),
          event_types: z.array(z.string()),
        })
      ),
      participants_only: z.array(z.string().min(1)).optional().default([]),
    }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    store.contextStore.applyContextSubscriptions(params.id, body.entries, body.participants_only);
    return { ok: true, context_id: params.id };
  });

  // Slice 0 — context compaction + clear-history
  app.post("/v1/contexts/:id/compact", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const body = z.object({
      summary: z.string().min(1),
      before_event_id: z.string().min(1).optional(),
    }).parse(request.body);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const activeCheck = store.db
      .prepare("SELECT 1 AS x FROM delivery_bundles WHERE state = 'active' AND workspace_id = ? LIMIT 1")
      .get(ctx.workspace_id);
    if (activeCheck) {
      return reply.code(409).send({ error: "active_delivery_in_progress", message: "Cannot compact while a delivery is active" });
    }
    const summary_event_id = store.contextStore.compactContext(params.id, body.summary, body.before_event_id);
    broadcast("context_compacted", { context_id: params.id, summary_event_id });
    return { ok: true, context_id: params.id, summary_event_id };
  });

  app.post("/v1/contexts/:id/clear-history", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const ctx = store.contextStore.getContext(params.id);
    if (!ctx) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    const activeCheck = store.db
      .prepare("SELECT 1 AS x FROM delivery_bundles WHERE state = 'active' AND workspace_id = ? LIMIT 1")
      .get(ctx.workspace_id);
    if (activeCheck) {
      return reply.code(409).send({ error: "active_delivery_in_progress", message: "Cannot clear history while a delivery is active" });
    }
    const result = store.contextStore.clearContextHistory(params.id);
    broadcast("context_history_cleared", { context_id: params.id, events_deleted: result.events_deleted });
    return { ok: true, context_id: params.id, events_deleted: result.events_deleted };
  });

  app.get("/v1/delivery/claim", async (request) => {
    const query = z.object({
      bridge_id: z.string(),
      limit: z.coerce.number().int().positive().max(100).optional()
    }).parse(request.query);
    return { deliveries: store.claimDeliveries(query.bridge_id, query.limit ?? 10, broadcast) };
  });

  app.get("/v1/delivery", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(500).optional()
    }).parse(request.query);
    return { deliveries: store.listDeliveries(query) };
  });
  app.post("/v1/runtime/telemetry", async (request, reply) => {
    const body = z.object({
      workspace_id: z.string().min(1),
      endpoint_id: z.string().min(1),
      delivery_id: z.string().nullable().optional(),
      kind: z.string().min(1),
      payload: z.record(z.unknown())
    }).parse(request.body);
    const telemetry = store.appendRuntimeTelemetry({
      workspace_id: body.workspace_id,
      endpoint_id: body.endpoint_id,
      delivery_id: body.delivery_id ?? null,
      kind: body.kind,
      payload: body.payload
    }, broadcast);
    return reply.code(202).send({ ok: true, telemetry });
  });

  app.get("/v1/runtime/telemetry", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      delivery_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(500).optional()
    }).parse(request.query);
    return { records: store.listRuntimeTelemetry(query) };
  });

  app.get("/v1/events/:event_id/trace", async (request, reply) => {
    const params = z.object({ event_id: z.string().min(1) }).parse(request.params);
    const trace = store.getEventTrace(params.event_id);
    if (!trace) {
      return reply.code(404).send({ error: "event_not_found", event_id: params.event_id });
    }
    return trace;
  });

  app.post("/v1/endpoints/:endpoint_id/turn-end", async (request) => {
    const params = z.object({ endpoint_id: z.string().min(1) }).parse(request.params);
    return { endpoint: store.reportTurnEnd(params.endpoint_id, broadcast) };
  });

  app.get("/v1/pending-responses", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      limit: z.coerce.number().int().positive().max(500).optional()
    }).parse(request.query);
    return { pending: store.listPendingResponses(query) };
  });

  app.get("/v1/configs", async () => ({ configs: store.listConfigs() }));

  app.post("/v1/configs", async (request, reply) => {
    const body = z.object({
      name: z.string().min(1),
      config: z.record(z.unknown())
    }).parse(request.body);
    return reply.code(201).send({ config: store.createConfig(body, broadcast) });
  });

  app.post("/v1/webhooks/:workspace_id/:route_id", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), route_id: z.string() }).parse(request.params);
    try {
      const event = store.ingestWebhook(params.workspace_id, params.route_id, request.body as Record<string, unknown>, broadcast);
      return reply.code(202).send({ ok: true, event });
    } catch (err) {
      if (err instanceof ScopeRequiredError) {
        return reply.code(400).send({
          ok: false,
          error: "scope_required",
          workspace_id: err.workspace_id,
          reason: err.reason
        });
      }
      throw err;
    }
  });

  // ---------------------------------------------------------------------------
  // Extension registry (Track S — runtime state, not persisted to SQLite)
  // The bridge reports loaded extension metadata here after each workspace attach.
  // `GET /v1/extensions` lets the app discover registered views.
  // `GET|POST /v1/extensions/:name/*` relays to the extension's registered handler.
  // ---------------------------------------------------------------------------

  /** in-memory registry: extension name → metadata */
  const extensionRegistry = new Map<string, {
    name: string;
    workspace_id: string;
    views: Array<{ slot: string; label: string; component: string }>;
    errors: string[];
    relay_url: string | null;
    reported_at: string;
  }>();

  app.post("/v1/extensions/report", async (request, reply) => {
    const body = z.object({
      workspace_id: z.string().min(1),
      extensions: z.array(z.object({
        name: z.string().min(1),
        views: z.array(z.object({
          slot: z.string(),
          label: z.string(),
          component: z.string()
        })).optional().default([]),
        errors: z.array(z.string()).optional().default([]),
        relay_url: z.string().url().nullable().optional()
      }))
    }).parse(request.body);
    for (const ext of body.extensions) {
      extensionRegistry.set(`${body.workspace_id}:${ext.name}`, {
        name: ext.name,
        workspace_id: body.workspace_id,
        views: ext.views,
        errors: ext.errors,
        relay_url: ext.relay_url ?? null,
        reported_at: new Date().toISOString()
      });
    }
    // Notify connected app clients so they re-fetch without polling or page refresh
    broadcast("extensions_updated", { workspace_id: body.workspace_id });
    return reply.code(201).send({ ok: true, registered: body.extensions.length });
  });

  app.get("/v1/extensions", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional()
    }).parse(request.query);
    const all = Array.from(extensionRegistry.values());
    const filtered = query.workspace_id
      ? all.filter(e => e.workspace_id === query.workspace_id)
      : all;
    return { extensions: filtered };
  });

  /** Generic relay: proxies GET/POST /v1/extensions/:name/* to the extension's relay_url */
  async function handleExtensionRelay(
    request: any,
    reply: any,
    method: "GET" | "POST"
  ): Promise<unknown> {
    const params = z.object({ name: z.string().min(1), "*": z.string().optional() }).parse(request.params);
    const workspaceId = (request.query as any)?.workspace_id as string | undefined;

    // Find the extension entry (prefer workspace-scoped match)
    let entry = workspaceId
      ? extensionRegistry.get(`${workspaceId}:${params.name}`)
      : undefined;
    if (!entry) {
      // fallback: any entry with this name
      for (const [, v] of extensionRegistry) {
        if (v.name === params.name) { entry = v; break; }
      }
    }
    if (!entry) {
      return reply.code(404).send({ error: "extension_not_found", name: params.name });
    }
    if (!entry.relay_url) {
      return reply.code(503).send({
        error: "extension_relay_not_available",
        name: params.name,
        message: "Extension has not registered an HTTP relay URL. The bridge must start an extension HTTP relay server and report relay_url via POST /v1/extensions/report."
      });
    }
    // Forward the request
    const subPath = params["*"] ? `/${params["*"]}` : "/";
    const qs = new URLSearchParams(request.query as Record<string, string>);
    qs.delete("workspace_id"); // already handled by registry lookup
    const targetUrl = `${entry.relay_url}${subPath}${qs.toString() ? `?${qs}` : ""}`;
    try {
      const fetchOpts: RequestInit = { method };
      if (method === "POST" && request.body) {
        fetchOpts.headers = { "content-type": "application/json" };
        fetchOpts.body = JSON.stringify(request.body);
      }
      const upstream = await fetch(targetUrl, fetchOpts);
      const upstreamBody = await upstream.text();
      reply.code(upstream.status);
      reply.header("content-type", upstream.headers.get("content-type") ?? "application/json");
      return reply.send(upstreamBody);
    } catch (err) {
      return reply.code(502).send({ error: "extension_relay_error", message: err instanceof Error ? err.message : String(err) });
    }
  }

  app.get("/v1/extensions/:name/*", async (request, reply) => {
    return handleExtensionRelay(request, reply, "GET");
  });

  app.post("/v1/extensions/:name/*", async (request, reply) => {
    return handleExtensionRelay(request, reply, "POST");
  });

  // ---------------------------------------------------------------------------
  // Pulse API
  // ---------------------------------------------------------------------------

  const pulseScheduler = new PulseScheduler((pulseId) => {
    firePulse(pulseId, store, broadcast, pulseScheduler);
  });

  app.post("/v1/pulses", async (request, reply) => {
    const parsed = z.object({
      pulse_id: z.string().min(1),
      workspace_id: z.string().min(1),
      persistence: z.enum(["workspace", "local"]).optional(),
      scope_id: z.string().min(1).nullable().optional(),
      current_context_id: z.string().min(1).nullable().optional(),
      trigger: z.object({
        type: z.enum(["once", "cron"]),
        at: z.string().optional(),
        schedule: z.string().optional(),
          timezone: z.string().optional()
      }),
      event: z.object({
        type: z.literal("pulse.fired"),
        content: z.record(z.unknown()).optional()
      }).optional(),
      content: z.record(z.unknown()).optional(),
      subscribers: z.array(PulseSubscriberSchema),
      created_by: z.string().optional()
    }).strict().safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: {
          code: "invalid_pulse_command",
          message: "Invalid pulse command",
          issues: parsed.error.issues
        }
      });
    }
    const body = parsed.data;
    let pulse: unknown;
    try {
      pulse = store.createPulse({
        ...body,
        persistence: body.persistence as PulsePersistence | undefined,
        content: body.event?.content ?? body.content ?? {},
        subscribers: body.subscribers as PulseSubscriber[]
      }, broadcast);
    } catch (err) {
      if (err instanceof ScopeNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "scope_not_found",
          workspace_id: err.workspace_id,
          scope_id: err.scope_id
        });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      if (err instanceof ContextAnchorError) {
        return reply.code(400).send({
          ok: false,
          error: "context_anchor_invalid",
          workspace_id: err.workspace_id,
          context_id: err.context_id,
          reason: err.reason
        });
      }
      if (err instanceof ScopeRequiredError) {
        return reply.code(400).send({
          ok: false,
          error: "scope_required",
          workspace_id: err.workspace_id,
          reason: err.reason
        });
      }
      throw err;
    }
    // Schedule in the priority queue
    const record = pulse as any;
    if (record.status === "active" && record.next_fire_at) {
      pulseScheduler.addPulse(record.pulse_id, new Date(record.next_fire_at));
    }
    return reply.code(201).send({ pulse });
  });

  app.get("/v1/pulses", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      status: z.string().optional(),
      scope_id: z.string().optional()
    }).parse(request.query);
    return { pulses: store.listPulses(query) };
  });

  app.post("/v1/pulses/:pulse_id/pause", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    pulseScheduler.removePulse(params.pulse_id);
    return { pulse: store.updatePulseStatus(params.pulse_id, "paused", broadcast) };
  });

  app.post("/v1/pulses/:pulse_id/resume", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    const pulse = store.updatePulseStatus(params.pulse_id, "active", broadcast) as any;
    if (pulse) {
      const trigger = pulse.trigger as { type: string; schedule?: string; timezone?: string; at?: string };
      if (trigger.type === "cron") {
        // Recalculate next fire from now on resume
        const nextFireAt = store.calculateNextFireAt(trigger);
        if (nextFireAt) {
          store.db.prepare("UPDATE pulses SET next_fire_at = ? WHERE pulse_id = ?").run(nextFireAt, params.pulse_id);
          pulseScheduler.addPulse(params.pulse_id, new Date(nextFireAt));
        }
      } else if (pulse.next_fire_at) {
        pulseScheduler.addPulse(params.pulse_id, new Date(pulse.next_fire_at));
      }
    }
    return { pulse: store.getPulse(params.pulse_id) };
  });

  app.post("/v1/pulses/:pulse_id/cancel", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    pulseScheduler.removePulse(params.pulse_id);
    return { pulse: store.updatePulseStatus(params.pulse_id, "cancelled", broadcast) };
  });

  app.post("/v1/pulses/:pulse_id/subscribe", async (request, reply) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    const body = PulseSubscriberSchema.parse(request.body) as PulseSubscriber;
    try {
      store.addPulseSubscriber(params.pulse_id, body);
    } catch (err) {
      if (err instanceof PulseNotFoundError) {
        return reply.code(404).send({ ok: false, error: "pulse_not_found", pulse_id: err.pulse_id });
      }
      if (err instanceof ContextNotFoundError) {
        return reply.code(404).send({
          ok: false,
          error: "context_not_found",
          workspace_id: err.workspace_id,
          context_id: err.context_id
        });
      }
      if (err instanceof ContextAnchorError) {
        return reply.code(400).send({
          ok: false,
          error: "context_anchor_invalid",
          workspace_id: err.workspace_id,
          context_id: err.context_id,
          reason: err.reason
        });
      }
      if (err instanceof ScopeRequiredError) {
        return reply.code(400).send({
          ok: false,
          error: "scope_required",
          workspace_id: err.workspace_id,
          reason: err.reason
        });
      }
      throw err;
    }
    const pulse = store.getPulse(params.pulse_id);
    broadcast("pulse_subscriber_changed", { pulse_id: params.pulse_id, subscriber: body, pulse });
    return { ok: true, pulse };
  });

  app.post("/v1/pulses/:pulse_id/unsubscribe", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    const body = PulseSubscriberSchema.parse(request.body) as PulseSubscriber;
    store.removePulseSubscriber(params.pulse_id, body);
    const pulse = store.getPulse(params.pulse_id);
    broadcast("pulse_subscriber_changed", { pulse_id: params.pulse_id, subscriber: body, pulse });
    return { ok: true, pulse };
  });

  // Hydrate scheduler from persisted pulse state on startup
  const activePulses = store.getActivePulsesForScheduler();
  for (const pulse of activePulses) {
    if (pulse.next_fire_at) {
      pulseScheduler.addPulse(pulse.pulse_id, new Date(pulse.next_fire_at));
    }
  }
  pulseScheduler.start();

  app.addHook("onClose", async () => {
    pulseScheduler.stop();
  });

  return {
    app,
    store,
    broadcast,
    listen: async () => {
      const { host, port } = parseListen(config.bus.listen);
      await app.listen({ host, port });
    }
  };
}

function firePulse(pulseId: string, store: BusStore, broadcast: (type: string, payload: Record<string, unknown>) => void, pulseScheduler: PulseScheduler): void {
  const pulse = store.getPulse(pulseId) as any;
  if (!pulse || pulse.status !== "active") return;

  const subscribers = store.getPulseSubscribers(pulseId);
  if (subscribers.length === 0) return;

  const fireTimestamp = new Date().toISOString();
  const trigger = pulse.trigger as { type: string; schedule?: string; timezone?: string; at?: string };

  for (const subscriber of subscribers) {
    const content = {
      ...pulse.content,
      pulse_id: pulseId
    };
    const metadata = {
      trigger_kind: "pulse",
      pulse_id: pulseId,
      pulse_name: (pulse as any).name ?? pulseId,
      trigger_type: trigger.type,
      schedule: trigger.schedule ?? trigger.at ?? null,
      fire_number: (pulse.fire_count ?? 0) + 1
    };
    try {
      if (subscriber.kind === "context") {
        if (!subscriber.context_id) {
          console.error("[bus] pulse context subscriber missing context_id", { pulse_id: pulseId, subscriber });
          continue;
        }
        store.appendContextEvent({
          type: "pulse.fired",
          workspace_id: pulse.workspace_id,
          context_id: subscriber.context_id,
          correlation_id: null,
          content,
          metadata
        }, broadcast);
      } else {
        if (!subscriber.endpoint_ref) {
          console.error("[bus] pulse endpoint subscriber missing endpoint_ref", { pulse_id: pulseId, subscriber });
          continue;
        }
        const endpointId = store.resolveSubscriberEndpointId(pulse.workspace_id, subscriber.endpoint_ref);
        const contextId = subscriber.context_id ?? store.getOrCreatePulseDeliveryContext({
          pulse_id: pulseId,
          workspace_id: pulse.workspace_id,
          scope_id: (pulse as any).scope_id,
          subscriber,
          endpoint_id: endpointId
        });
        // Per design §3.1.6: pulse.fired is a non-actor trigger. Bus emits with
        // source_endpoint_id = null. No synthetic `system:*` source is created.
        store.emitTriggerEvent(
          {
            type: "pulse.fired",
            workspace_id: pulse.workspace_id,
            target_endpoint_id: endpointId,
            context_id: contextId,
            scope_id: null,
            correlation_id: null,
            content,
            metadata
          },
          broadcast
        );
      }
    } catch (error) {
      console.error("[bus] pulse event emission failed", { pulse_id: pulseId, subscriber, error });
    }
  }

  // For one-off pulses, mark as completed. For cron, calculate next fire time and re-schedule.
  let nextFireAt: string | null = null;
  if (trigger.type === "cron") {
    nextFireAt = store.calculateNextFireAt(trigger);
  }
  store.recordPulseFired(pulseId, nextFireAt);

  if (nextFireAt) {
    pulseScheduler.addPulse(pulseId, new Date(nextFireAt));
  }

  broadcast("pulse_fired", { pulse_id: pulseId, fired_at: fireTimestamp, subscriber_count: subscribers.length });
}
