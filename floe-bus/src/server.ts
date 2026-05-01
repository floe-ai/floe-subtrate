import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { z } from "zod";
import type { LocalConfig } from "./config.js";
import { parseListen } from "./config.js";
import { BusStore, type EventCommand } from "./store.js";

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
      target: z.enum(["all", "agents", "humans", "active_agents", "active_humans"]),
      exclude_source: z.boolean().optional()
    })
  ]),
  thread_id: z.string().min(1),
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

type SocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "close" | "error", listener: () => void): void;
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

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const socket of sockets) socket.close();
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
    web: config.web,
    bridge: config.bridge
  }));

  app.get("/v1/events/stream", { websocket: true }, (socket) => {
    const client = socket as unknown as SocketLike;
    sockets.add(client);
    client.send(JSON.stringify({
      type: "hello",
      payload: { service: "floe-bus" },
      at: new Date().toISOString()
    }));
    client.on("close", () => sockets.delete(client));
    client.on("error", () => sockets.delete(client));
  });

  app.get("/v1/workspaces", async () => ({
    workspaces: store.listWorkspaces()
  }));

  app.post("/v1/workspaces/register", async (request, reply) => {
    const input = z.object({
      locator: z.string().min(1),
      name: z.string().optional(),
      init_authorized: z.boolean().optional()
    }).parse(request.body);
    const workspace = store.registerWorkspace(input, broadcast);
    return reply.code(201).send({ workspace });
  });

  app.post("/v1/workspaces/:workspace_id/select", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    return { workspace: store.selectWorkspace(params.workspace_id, broadcast) };
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
      state: z.enum(["injected_to_runtime", "acknowledged", "failed", "dead_lettered"]),
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

  app.post("/v1/endpoints/register", async (request, reply) => {
    const body = z.object({
      endpoint_id: z.string().min(1),
      workspace_id: z.string().min(1),
      actor_type: z.enum(["human", "agent"]),
      name: z.string().min(1),
      agent_id: z.string().nullable().optional(),
      bridge_id: z.string().nullable().optional(),
      status: z.string().optional(),
      metadata: z.record(z.unknown()).optional()
    }).parse(request.body);
    return reply.code(201).send({ endpoint: store.registerEndpoint(body, broadcast) });
  });

  app.post("/v1/endpoints/:endpoint_id/status", async (request) => {
    const params = z.object({ endpoint_id: z.string() }).parse(request.params);
    const body = z.object({ status: z.string().min(1) }).parse(request.body);
    return { endpoint: store.updateEndpointStatus(params.endpoint_id, body.status, broadcast) };
  });

  app.post("/v1/events/emit", async (request, reply) => {
    const command = EventCommandSchema.parse(request.body) as EventCommand;
    const result = store.submitEvent(command, broadcast);
    return reply.code(202).send({
      ok: true,
      event_id: result.event.event_id,
      accepted_at: result.event.created_at,
      deliveries_created: result.deliveries_created,
      event: result.event
    });
  });

  app.get("/v1/events", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      thread_id: z.string().optional(),
      limit: z.coerce.number().int().positive().optional()
    }).parse(request.query);
    return { events: store.listEvents(query) };
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
      limit: z.coerce.number().int().positive().max(500).optional()
    }).parse(request.query);
    return { records: store.listRuntimeTelemetry(query) };
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
    const event = store.ingestWebhook(params.workspace_id, params.route_id, request.body as Record<string, unknown>, broadcast);
    return reply.code(202).send({ ok: true, event });
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
