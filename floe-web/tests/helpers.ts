import { test as base, Page } from "@playwright/test";

const WORKSPACE_ID = "ws_test_qa";
const WORKSPACE_NAME = "QA Workspace";

export type WorkspaceRecord = {
  workspace_id: string;
  name: string;
  locator?: string;
  path?: string;
  status: string;
  init_authorized?: boolean | number;
  created_at?: string;
};

export type FieldLayoutFloeweb = {
  schema: "floe.field.layout.floeweb.v1";
  field_id: string;
  viewport: { x: number; y: number; zoom: number };
  items: Record<string, { x: number; y: number; width?: number; height?: number }>;
  };

export type ScopeRecord = {
  scope_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export type ScopeProjection = {
  workspace_id: string;
  scope_id: string;
  generated_at: string;
  refs: {
    contexts: Array<{
      context_id: string;
      workspace_id: string;
      scope_id: string;
      parent_context_id: string | null;
      created_by_endpoint_id: string;
      created_at: string;
      last_event_at: string | null;
      first_message_preview: string | null;
    }>;
    pulses: Array<{
      pulse_id: string;
      workspace_id: string;
      scope_id: string;
      persistence: "workspace" | "local";
      status: string;
      trigger: unknown;
      next_fire_at: string | null;
      last_fired_at: string | null;
      fire_count: number;
      created_at: string;
      updated_at: string;
    }>;
    events: Array<{
      event_id: string;
      type: string;
      workspace_id: string;
      scope_id: string;
      context_id: string | null;
      source_endpoint_id: string | null;
      created_at: string;
    }>;
    activity: Array<{
      telemetry_id: string;
      workspace_id: string;
      endpoint_id: string;
      delivery_id: string;
      kind: string;
      context_id: string | null;
      event_id: string | null;
      created_at: string;
    }>;
    };
  relationships: {
    context_participants: Array<{ context_id: string; endpoint_id: string }>;
    pulse_subscribers: Array<{ pulse_id: string; subscriber: { kind?: string; context_id?: string | null; endpoint_ref?: string } }>;
    event_context_ownership: Array<{ event_id: string; context_id: string }>;
  };
  unsupported: Array<{ kind: string; reason: string }>;
};

export type WorkspaceContextRecord = {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  last_event_at: string | null;
  participants: string[];
  first_message_preview: string | null;
};

export type EndpointRecord = {
  endpoint_id: string;
  workspace_id: string;
  name: string;
  status: string;
  agent_id?: string | null;
  metadata_json?: string;
};

export type EventRecord = {
  event_id: string;
  type: string;
  workspace_id: string;
  source_endpoint_id: string | null;
  destination_json: { kind: "endpoint" | "broadcast"; endpoint_id?: string };
  thread_id?: string | null;
  context_id?: string | null;
  content: { text?: string; data?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
  created_at: string;
};

export type TelemetryRecord = {
  telemetry_id: string;
  workspace_id: string;
  endpoint_id: string;
  delivery_id: string | null;
  kind: string;
  payload_json: string;
  created_at: string;
};

type AuthProfileRecord = { id: string; provider: string; model?: string | null; label?: string | null };

type RuntimeBindingRecord = {
  binding_key: string;
  scope: "agent" | "workspace_default" | "global_default";
  workspace_id: string | null;
  endpoint_id: string | null;
  auth_profile: string;
  model: string | null;
};

type ContextEventRecord = {
  event_id: string;
  context_id: string;
  type: string;
  workspace_id?: string;
  source_endpoint_id?: string | null;
  destination_json?: unknown;
  content?: unknown;
  metadata?: unknown;
  created_at?: string;
};

async function installBaselineRoutes(
  page: Page,
  options: {
    workspaces?: WorkspaceRecord[];
    endpoints?: EndpointRecord[];
    authProfiles?: AuthProfileRecord[];
    runtimeBindings?: RuntimeBindingRecord[];
    runtimeAdapter?: string | null;
    contextEventsById?: Record<string, ContextEventRecord[]>;
    emitCalls?: unknown[];
    workspaceRegisterCalls?: unknown[];
    events?: EventRecord[];
    telemetry?: TelemetryRecord[];
  } = {}
): Promise<void> {
  const authProfiles = options.authProfiles ?? [];
  const runtimeBindings = options.runtimeBindings ?? [];
  const contextEventsById = options.contextEventsById ?? {};
  const emitCalls = options.emitCalls ?? [];
  const workspaces = [...(options.workspaces ?? [{
    workspace_id: WORKSPACE_ID,
    name: WORKSPACE_NAME,
    locator: "/tmp/qa-ws",
    path: "/tmp/qa-ws",
    status: "attached",
    init_authorized: true,
    created_at: new Date().toISOString()
  }])];

  await page.route("**/v1/workspaces", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ workspaces })
      });
    }
    return route.fulfill({ status: 200, body: JSON.stringify({}) });
  });

  await page.route(/\/v1\/workspaces\/[^/]+\/select$/, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
  );

  await page.route("**/v1/workspaces/register", async (route) => {
    const body = route.request().postDataJSON() as { locator?: string; name?: string; init_authorized?: boolean; create_directory?: boolean };
    options.workspaceRegisterCalls?.push(body);
    const createdAt = new Date().toISOString();
    const workspace: WorkspaceRecord = {
      workspace_id: `ws_registered_${workspaces.length + 1}`,
      name: body.name?.trim() || body.locator?.split(/[\\/]/).filter(Boolean).at(-1) || "Workspace",
      locator: body.locator,
      path: body.locator,
      status: "attached",
      init_authorized: body.init_authorized ?? true,
      created_at: createdAt
    };
    workspaces.push(workspace);
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ workspace })
    });
  });

  await page.route(/\/v1\/workspaces\/[^/]+\/endpoints$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ endpoints: options.endpoints ?? [] })
    })
  );

  await page.route("**/v1/auth/profiles", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profiles: authProfiles }) })
  );

  await page.route("**/v1/runtime/bindings**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bindings: runtimeBindings }) })
  );

  await page.route("**/v1/local-config/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ bridge: { runtime_adapter: options.runtimeAdapter ?? "fake" } })
    })
  );

  await page.route("**/v1/events**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/emit") || path.endsWith("/stream")) {
      return route.fallback();
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: options.events ?? [] }) });
  });

  await page.route("**/v1/runtime/telemetry**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: options.telemetry ?? [] }) })
  );

  await page.route("**/v1/auth/models**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) })
  );

  await page.route("**/v1/events/stream", (route) => route.abort());

  await page.route("**/v1/events/emit", async (route) => {
    const body = route.request().postDataJSON();
    emitCalls.push(body);
    const contextId = typeof body?.context_id === "string" ? body.context_id : "ctx-emitted";
    const event: ContextEventRecord = {
      event_id: `evt-${emitCalls.length}`,
      context_id: contextId,
      type: body?.type ?? "message",
      workspace_id: body?.workspace_id,
      source_endpoint_id: body?.source_endpoint_id,
      destination_json: body?.destination,
      content: body?.content ?? {},
      metadata: body?.metadata ?? {},
      created_at: new Date(0).toISOString()
    };
    contextEventsById[contextId] = [...(contextEventsById[contextId] ?? []), event];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, event })
    });
  });
}

async function finishBoot(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(({ busUrl }) => {
    localStorage.setItem("floe.busUrl", busUrl);
  }, { busUrl: "http://127.0.0.1:5377" });
  await page.reload();
  await page.waitForSelector("[data-testid='workspace-loaded'], .workspace-home", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

/**
 * Boots the app with mocked bus routes and an empty Scope Projection substrate.
 * Specs that don't care about Fields can call this without leaking real network calls.
 */
export async function seedApp(page: Page): Promise<void> {
  await installBaselineRoutes(page);

  await page.route(/\/v1\/workspaces\/[^/]+\/scopes$/, (route) => {
    if (route.request().method() === "GET") {
      const scope = makeScope("default", "Default", true);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scopes: [scope] })
      });
    }
    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/scopes/default/projection`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ projection: emptyScopeProjection("default") }) })
  );
  await page.route(/\/v1\/workspaces\/[^/]+\/fields(?:\?.*)?$/, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "legacy_fields_endpoint_called" }) })
  );

  await finishBoot(page);
}

export async function seedAppWithScopes(
  page: Page,
  scopes: ScopeRecord[],
  projections: Record<string, ScopeProjection>,
  options: {
    legacyFieldRequests?: string[];
    workspaces?: WorkspaceRecord[];
    scopePosts?: string[];
    scopePatches?: string[];
    layoutGets?: string[];
    layoutPuts?: string[];
    pulseSubscribes?: string[];
    pulseUnsubscribes?: string[];
    workspaceContexts?: WorkspaceContextRecord[];
    contextAssignments?: string[];
    endpoints?: EndpointRecord[];
    authProfiles?: AuthProfileRecord[];
    runtimeBindings?: RuntimeBindingRecord[];
    runtimeAdapter?: string | null;
    contextEventsById?: Record<string, ContextEventRecord[]>;
    emitCalls?: unknown[];
    contextEventGets?: string[];
    projectionGets?: string[];
    workspaceRegisterCalls?: unknown[];
    events?: EventRecord[];
    telemetry?: TelemetryRecord[];
    scopePostFailure?: { status: number; body: unknown };
    contextAssignmentFailure?: { status: number; body: unknown };
  } = {}
): Promise<void> {
  await installBaselineRoutes(page, {
    workspaces: options.workspaces,
    endpoints: options.endpoints,
    authProfiles: options.authProfiles,
    runtimeBindings: options.runtimeBindings,
    runtimeAdapter: options.runtimeAdapter,
    contextEventsById: options.contextEventsById,
    emitCalls: options.emitCalls,
    workspaceRegisterCalls: options.workspaceRegisterCalls,
    events: options.events,
    telemetry: options.telemetry
  });

  const scopeStore = new Map(scopes.map((scope) => [scope.scope_id, scope]));
  const projectionStore = new Map(Object.entries(projections));
  const workspaceContextStore = new Map((options.workspaceContexts ?? []).map((context) => [context.context_id, context]));
  const layoutStore = new Map<string, FieldLayoutFloeweb>();
  let generatedScopeCounter = 1;
  await page.route(/\/v1\/workspaces\/[^/]+\/fields(?:\?.*)?$/, async (route) => {
    options.legacyFieldRequests?.push(route.request().url());
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "legacy_fields_endpoint_called" })
    });
  });
  await page.route("**/v1/pulses/*/subscribe", async (route) => {
    options.pulseSubscribes?.push(route.request().postData() ?? "");
    const segments = new URL(route.request().url()).pathname.split("/");
    const pulseId = decodeURIComponent(segments[segments.length - 2] ?? "");
    const subscriber = JSON.parse(route.request().postData() ?? "{}") as ScopeProjection["relationships"]["pulse_subscribers"][number]["subscriber"];
    for (const [scopeId, projection] of projectionStore.entries()) {
      if (!projection.refs.pulses.some((pulse) => pulse.pulse_id === pulseId)) continue;
      const exists = projection.relationships.pulse_subscribers.some((relationship) =>
        relationship.pulse_id === pulseId &&
        relationship.subscriber.kind === subscriber.kind &&
        relationship.subscriber.context_id === subscriber.context_id
      );
      if (exists) continue;
      projectionStore.set(scopeId, {
        ...projection,
        relationships: {
          ...projection.relationships,
          pulse_subscribers: [...projection.relationships.pulse_subscribers, { pulse_id: pulseId, subscriber }]
        }
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/v1/pulses/*/unsubscribe", async (route) => {
    options.pulseUnsubscribes?.push(route.request().postData() ?? "");
    const segments = new URL(route.request().url()).pathname.split("/");
    const pulseId = decodeURIComponent(segments[segments.length - 2] ?? "");
    const subscriber = JSON.parse(route.request().postData() ?? "{}") as ScopeProjection["relationships"]["pulse_subscribers"][number]["subscriber"];
    for (const [scopeId, projection] of projectionStore.entries()) {
      projectionStore.set(scopeId, {
        ...projection,
        relationships: {
          ...projection.relationships,
          pulse_subscribers: projection.relationships.pulse_subscribers.filter((relationship) =>
            !(
              relationship.pulse_id === pulseId &&
              relationship.subscriber.kind === subscriber.kind &&
              relationship.subscriber.context_id === subscriber.context_id
            )
          )
        }
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
  });
  await page.route(/\/v1\/workspaces\/[^/]+\/scopes$/, async (route) => {
    const method = route.request().method();
    if (method === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ scopes: Array.from(scopeStore.values()) })
      });
    }
    if (method === "POST") {
      options.scopePosts?.push(route.request().postData() ?? "");
      if (options.scopePostFailure) {
        return route.fulfill({
          status: options.scopePostFailure.status,
          contentType: "application/json",
          body: JSON.stringify(options.scopePostFailure.body)
        });
      }
      const body = JSON.parse(route.request().postData() ?? "{}") as { scope_id?: string; title: string; description?: string | null };
      const now = new Date().toISOString();
      let scopeId = body.scope_id;
      if (scopeId && scopeStore.has(scopeId)) {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "scope_already_exists", workspace_id: WORKSPACE_ID, scope_id: scopeId })
        });
      }
      if (!scopeId) {
        do {
          scopeId = `scope_${generatedScopeCounter++}`;
        } while (scopeStore.has(scopeId));
      }
      const scope: ScopeRecord = {
        workspace_id: WORKSPACE_ID,
        scope_id: scopeId,
        title: body.title,
        description: body.description ?? null,
        is_default: false,
        created_at: now,
        updated_at: now
      };
      scopeStore.set(scope.scope_id, scope);
      projectionStore.set(scope.scope_id, emptyScopeProjection(scope.scope_id, scope.created_at));
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ scope })
      });
    }
    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });
  await page.route(/\/v1\/workspaces\/[^/]+\/scopes\/[^/]+\/projection\/layout\/floeweb$/, async (route) => {
    const segments = new URL(route.request().url()).pathname.split("/");
    const scopeId = decodeURIComponent(segments[segments.length - 4] ?? "");
    const method = route.request().method();
    if (method === "GET") {
      options.layoutGets?.push(route.request().url());
      const layout = layoutStore.get(scopeId);
      if (!layout) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "scope_projection_layout_not_found" })
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ layout })
      });
    }
    if (method === "PUT") {
      options.layoutPuts?.push(route.request().postData() ?? "");
      const layout = JSON.parse(route.request().postData() ?? "{}") as FieldLayoutFloeweb;
      layoutStore.set(scopeId, layout);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ layout })
      });
    }
    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });
  await page.route(/\/v1\/workspaces\/[^/]+\/scopes\/[^/]+\/projection$/, (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/projection/layout/floeweb")) {
      return route.fallback();
    }
    const segments = new URL(route.request().url()).pathname.split("/");
    const scopeId = decodeURIComponent(segments[segments.length - 2] ?? "");
    options.projectionGets?.push(route.request().url());
    const projection = projectionStore.get(scopeId);
    if (!projection) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "scope_not_found", workspace_id: WORKSPACE_ID, scope_id: scopeId })
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ projection })
    });
  });
  await page.route(/\/v1\/workspaces\/[^/]+\/scopes\/[^/]+$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/projection") || path.endsWith("/projection/layout/floeweb")) {
      return route.fallback();
    }
    const segments = new URL(route.request().url()).pathname.split("/");
    const scopeId = decodeURIComponent(segments[segments.length - 1] ?? "");
    if (route.request().method() !== "PATCH") {
      return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
    }
    options.scopePatches?.push(route.request().postData() ?? "");
    const current = scopeStore.get(scopeId);
    if (!current) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "scope_not_found", workspace_id: WORKSPACE_ID, scope_id: scopeId })
      });
    }
    const body = JSON.parse(route.request().postData() ?? "{}") as { title?: string; description?: string | null };
    const scope: ScopeRecord = {
      ...current,
      title: body.title ?? current.title,
      description: body.description === undefined ? current.description : body.description,
      updated_at: new Date().toISOString()
    };
    scopeStore.set(scopeId, scope);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ scope })
    });
  });
  await page.route(/\/v1\/workspaces\/[^/]+\/contexts(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith("/assign-scope") && route.request().method() === "POST") {
      options.contextAssignments?.push(route.request().postData() ?? "");
      if (options.contextAssignmentFailure) {
        return route.fulfill({
          status: options.contextAssignmentFailure.status,
          contentType: "application/json",
          body: JSON.stringify(options.contextAssignmentFailure.body)
        });
      }
      const contextId = decodeURIComponent(path.split("/").at(-2) ?? "");
      const body = JSON.parse(route.request().postData() ?? "{}") as { scope_id?: string; assigned_by?: string | null };
      const context = workspaceContextStore.get(contextId);
      const scopeId = body.scope_id ?? "";
      const scope = scopeStore.get(scopeId);
      if (!context) {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "context_not_found" }) });
      }
      if (!scope) {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "scope_not_found" }) });
      }
      const assigned = { ...context, scope_id: scopeId };
      workspaceContextStore.set(contextId, assigned);
      const currentProjection = projectionStore.get(scopeId) ?? emptyScopeProjection(scopeId);
      projectionStore.set(scopeId, {
        ...currentProjection,
        refs: {
          ...currentProjection.refs,
          contexts: [...currentProjection.refs.contexts, {
            context_id: assigned.context_id,
            workspace_id: assigned.workspace_id,
            scope_id: scopeId,
            parent_context_id: assigned.parent_context_id,
            created_by_endpoint_id: assigned.created_by_endpoint_id ?? "",
            created_at: assigned.created_at,
            last_event_at: assigned.last_event_at,
            first_message_preview: assigned.first_message_preview
          }]
        },
        relationships: {
          ...currentProjection.relationships,
          context_participants: [
            ...currentProjection.relationships.context_participants,
            ...assigned.participants.map((endpoint_id) => ({ context_id: assigned.context_id, endpoint_id }))
          ]
        }
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, context: assigned, audit_event: { event_id: "evt_assignment" } })
      });
    }
    if (route.request().method() === "GET") {
      const scopeFilter = url.searchParams.get("scope") ?? "all";
      const contexts = Array.from(workspaceContextStore.values()).filter((context) => {
        if (scopeFilter === "unscoped") return context.scope_id === null;
        if (scopeFilter === "scoped") return context.scope_id !== null;
        return true;
      });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ contexts })
      });
    }
    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });
  await page.route(/\/v1\/contexts(?:\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET") {
      return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
    }
    const participant = url.searchParams.get("participant");
    const workspaceId = url.searchParams.get("workspace_id");
    const contexts = Array.from(workspaceContextStore.values()).filter((context) => {
      if (workspaceId && context.workspace_id !== workspaceId) return false;
      if (participant && !context.participants.includes(participant)) return false;
      return true;
    });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ contexts })
    });
  });
  await page.route("**/v1/contexts/*/events**", (route) => {
    const match = route.request().url().match(/\/v1\/contexts\/([^/]+)\/events/);
    const contextId = match ? decodeURIComponent(match[1]) : "";
    options.contextEventGets?.push(contextId);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: options.contextEventsById?.[contextId] ?? [] })
    });
  });

  await finishBoot(page);
}

export function makeScope(scopeId: string, title: string, isDefault = false): ScopeRecord {
  const now = new Date().toISOString();
  return {
    scope_id: scopeId,
    workspace_id: WORKSPACE_ID,
    title,
    description: null,
    is_default: isDefault,
    created_at: now,
    updated_at: now
  };
}

export function emptyScopeProjection(scopeId: string, generatedAt = new Date().toISOString()): ScopeProjection {
  return {
    workspace_id: WORKSPACE_ID,
    scope_id: scopeId,
    generated_at: generatedAt,
    refs: { contexts: [], pulses: [], events: [], activity: [] },
    relationships: {
      context_participants: [],
      pulse_subscribers: [],
      event_context_ownership: []
    },
    unsupported: []
  };
}

export { WORKSPACE_ID, WORKSPACE_NAME };

export const test = base;
