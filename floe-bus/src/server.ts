import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import YAML from "yaml";
import { getModels, getProviders } from "@mariozechner/pi-ai";
import type { LocalConfig } from "./config.js";
import { parseListen, resolveLocalPath } from "./config.js";
import { BROADCAST_TARGETS, BusStore, ContextNotFoundError, ContextParticipantError, type EventCommand, type PulsePersistence, type PulseSubscriber } from "./store.js";
import { PulseScheduler } from "./pulse-scheduler.js";
import {
  loadAllFields,
  loadField,
  upsertFieldSemantic,
  upsertFieldLayout,
  deleteField
} from "./fields-store.js";
import { FieldsWatcherRegistry } from "./fields-watcher.js";
import { ScopeAlreadyExistsError, ScopeNotFoundError } from "./scopes/store.js";

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
  model: z.string().nullable().optional()
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

  const fieldWatchers = new FieldsWatcherRegistry(
    broadcast,
    (error) => app.log.error({ err: error }, "field watcher error")
  );
  fieldWatchers.watchWorkspaces(store.listWorkspaces() as { workspace_id?: unknown; locator?: unknown }[]);

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const socket of sockets) socket.close();
    await fieldWatchers.close();
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

  app.get("/v1/workspaces/:workspace_id/scopes", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    if (!store.getWorkspace(params.workspace_id)) {
      return reply.code(404).send({ error: "workspace_not_found", workspace_id: params.workspace_id });
    }
    return { scopes: store.listScopes(params.workspace_id) };
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

  function resolveWorkspaceLocator(workspaceId: string, reply: any): string | null {
    const ws = store.getWorkspace(workspaceId) as { locator?: string } | undefined;
    if (!ws?.locator) {
      reply.code(404);
      reply.send({ error: "workspace_not_found" });
      return null;
    }
    return ws.locator;
  }

  function mapFieldError(err: unknown, reply: any): { error: string; message: string } | null {
    if (!(err instanceof Error)) return null;
    switch (err.name) {
      case "FieldValidationError":
        reply.code(400);
        return { error: "field_validation_error", message: err.message };
      case "FieldIdMismatchError":
        reply.code(400);
        return { error: "field_id_mismatch", message: err.message };
      case "FieldAlreadyExistsError":
        reply.code(409);
        return { error: "field_already_exists", message: err.message };
      case "FieldRendererInvalidError":
        reply.code(400);
        return { error: "field_renderer_invalid", message: err.message };
      default:
        return null;
    }
  }

  app.get("/v1/workspaces/:workspace_id/fields", async (request, reply) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      return { fields: loadAllFields(locator) };
    } catch (err) {
      const mapped = mapFieldError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get("/v1/workspaces/:workspace_id/fields/:field_id", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), field_id: z.string() }).parse(request.params);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const loaded = loadField(locator, params.field_id);
      if (!loaded) {
        reply.code(404);
        return { error: "field_not_found" };
      }
      return { semantic: loaded.semantic, layout: loaded.layout ?? null };
    } catch (err) {
      const mapped = mapFieldError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.put("/v1/workspaces/:workspace_id/fields/:field_id", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), field_id: z.string() }).parse(request.params);
    const query = z.object({ if_absent: z.enum(["true", "false"]).optional() }).parse(request.query);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const existed = loadField(locator, params.field_id) !== null;
      const semantic = upsertFieldSemantic(locator, params.field_id, request.body, {
        ifAbsent: query.if_absent === "true"
      });
      broadcast("field.upserted", {
        workspace_id: params.workspace_id,
        field_id: params.field_id,
        source: "api",
        changed: "semantic"
      });
      reply.code(existed ? 200 : 201);
      return { semantic };
    } catch (err) {
      const mapped = mapFieldError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.put("/v1/workspaces/:workspace_id/fields/:field_id/layout/:renderer", async (request, reply) => {
    const params = z.object({
      workspace_id: z.string(),
      field_id: z.string(),
      renderer: z.string()
    }).parse(request.params);
    if (params.renderer !== "floeweb") {
      reply.code(400);
      return { error: "field_renderer_invalid", message: `renderer '${params.renderer}' not supported in slice 1 (only 'floeweb')` };
    }
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const layout = upsertFieldLayout(locator, params.field_id, params.renderer, request.body);
      broadcast("field.upserted", {
        workspace_id: params.workspace_id,
        field_id: params.field_id,
        source: "api",
        changed: "layout",
        renderer: params.renderer,
      });
      return { layout };
    } catch (err) {
      const mapped = mapFieldError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.delete("/v1/workspaces/:workspace_id/fields/:field_id", async (request, reply) => {
    const params = z.object({ workspace_id: z.string(), field_id: z.string() }).parse(request.params);
    const locator = resolveWorkspaceLocator(params.workspace_id, reply);
    if (locator === null) return reply;
    try {
      const result = deleteField(locator, params.field_id);
      if (!result.semanticDeleted && result.layoutsDeleted.length === 0) {
        reply.code(404);
        return { error: "field_not_found" };
      }
      broadcast("field.deleted", { workspace_id: params.workspace_id, field_id: params.field_id });
      return result;
    } catch (err) {
      const mapped = mapFieldError(err, reply);
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
    await fieldWatchers.watchWorkspace(workspace as { workspace_id?: unknown; locator?: unknown });
    return reply.code(201).send({ workspace });
  });

  app.post("/v1/workspaces/:workspace_id/select", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const workspace = store.selectWorkspace(params.workspace_id, broadcast);
    await fieldWatchers.watchWorkspace(workspace as { workspace_id?: unknown; locator?: unknown });
    return { workspace };
  });

  app.post("/v1/workspaces/:workspace_id/delete", async (request) => {
    const params = z.object({ workspace_id: z.string() }).parse(request.params);
    const body = z.object({
      delete_locator: z.boolean().optional()
    }).parse(request.body ?? {});
    await fieldWatchers.unwatchWorkspace(params.workspace_id);
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
      model: body.model ?? null
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
    const profiles = loadAuthProfiles(configPath, config);
    return {
      profiles,
      default_auth_profile: typeof config.runtime?.default_auth_profile === "string"
        ? config.runtime.default_auth_profile
        : null
    };
  });

  app.get("/v1/auth/models", async (request) => {
    const query = z.object({ provider: z.string().optional() }).parse(request.query);
    const providers = getProviders();
    const allModels = query.provider
      ? (providers.includes(query.provider as any) ? getModels(query.provider as any) : [])
      : providers.flatMap((p) => getModels(p as any));
    const models = allModels.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      api: m.api,
      reasoning: m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: m.input
    }));
    return { models };
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

  app.get("/v1/events", async (request) => {
    const query = z.object({
      workspace_id: z.string().optional(),
      thread_id: z.string().optional(),
      context_id: z.string().optional(),
      scope_id: z.string().optional(),
      limit: z.coerce.number().int().positive().optional()
    }).parse(request.query);
    return { events: store.listEvents(query) };
  });

  // ---------------------------------------------------------------------------
  // Context API (Slice 2) — thin wrappers over ContextStore
  // ---------------------------------------------------------------------------

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
      contexts: filtered.map((r) => ({
        context_id: r.context_id,
        workspace_id: r.workspace_id,
        scope_id: r.scope_id,
        parent_context_id: r.parent_context_id,
        created_by_endpoint_id: r.created_by_endpoint_id,
        created_at: r.created_at,
        last_event_at: r.last_event_at,
        participants: r.participants,
        first_message_preview: store.contextStore.getFirstMessagePreview(r.context_id)
      }))
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
      participants: store.contextStore.getContextParticipants(ctx.context_id)
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

  app.delete("/v1/contexts/:id", async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    const result = store.deleteContext(params.id, broadcast);
    if (!result) {
      return reply.code(404).send({ error: "context_not_found", context_id: params.id });
    }
    return result;
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

  app.post("/v1/pulses/:pulse_id/subscribe", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    const body = z.object({
      endpoint_ref: z.string().min(1)
    }).parse(request.body);
    store.addPulseSubscriber(params.pulse_id, body);
    return { ok: true };
  });

  app.post("/v1/pulses/:pulse_id/unsubscribe", async (request) => {
    const params = z.object({ pulse_id: z.string() }).parse(request.params);
    const body = z.object({
      endpoint_ref: z.string().min(1)
    }).parse(request.body);
    store.removePulseSubscriber(params.pulse_id, body);
    return { ok: true };
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
        // Per design §3.1.6: pulse.fired is a non-actor trigger. Bus emits with
        // source_endpoint_id = null. No synthetic `system:*` source is created.
        store.emitTriggerEvent(
          {
            type: "pulse.fired",
            workspace_id: pulse.workspace_id,
            target_endpoint_id: endpointId,
            context_id: subscriber.context_id ?? null,
            scope_id: subscriber.context_id ? null : ((pulse as any).scope_id ?? null),
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

function loadAuthProfiles(configPath: string, config: LocalConfig): Array<{
  id: string;
  provider: string;
  model?: string;
  label?: string;
}> {
  const home = resolveLocalPath(configPath, config.home, ".");
  const path = join(home, "auth", "profiles.yaml");
  if (!existsSync(path)) return [];
  try {
    const parsed = YAML.parse(readFileSync(path, "utf8")) as any;
    const profiles = Array.isArray(parsed?.profiles) ? parsed.profiles : [];
    return profiles
      .filter((profile: any) => typeof profile?.id === "string" && typeof profile?.provider === "string")
      .map((profile: any) => ({
        id: String(profile.id),
        provider: String(profile.provider),
        model: typeof profile.model === "string" ? profile.model : undefined,
        label: typeof profile.label === "string" ? profile.label : undefined
      }));
  } catch {
    return [];
  }
}
