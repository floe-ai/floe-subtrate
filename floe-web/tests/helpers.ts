import { test as base, Page } from "@playwright/test";

const WORKSPACE_ID = "ws_test_qa";
const WORKSPACE_NAME = "QA Workspace";

export type FieldSummary = {
  id: string;
  title: string;
  item_count: number;
  connection_count: number;
  parent_count: number;
  updated_at: string;
};

export type FieldItem = {
  item_id: string;
  ref: string;
  metadata?: Record<string, unknown>;
};

export type FieldConnection = {
  id: string;
  from: string;
  to: string;
  label?: string;
  metadata?: Record<string, unknown>;
};

export type FieldSemantic = {
  schema: "floe.field.v1";
  id: string;
  title: string;
  description?: string;
  items: FieldItem[];
  connections: FieldConnection[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type FieldLayoutFloeweb = {
  schema: "floe.field.layout.floeweb.v1";
  field_id: string;
  viewport: { x: number; y: number; zoom: number };
  items: Record<string, { x: number; y: number; width?: number; height?: number }>;
};

type StoredField = { semantic: FieldSemantic; layout: FieldLayoutFloeweb | null };

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

async function installBaselineRoutes(page: Page): Promise<void> {
  await page.route("**/v1/workspaces", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspaces: [{
            workspace_id: WORKSPACE_ID,
            name: WORKSPACE_NAME,
            path: "/tmp/qa-ws",
            status: "attached",
            init_authorized: true,
            created_at: new Date().toISOString()
          }]
        })
      });
    }
    return route.fulfill({ status: 200, body: JSON.stringify({}) });
  });

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ endpoints: [] }) })
  );

  await page.route("**/v1/auth/profiles", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profiles: [] }) })
  );

  await page.route("**/v1/runtime/bindings**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bindings: [] }) })
  );

  await page.route("**/v1/events**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) })
  );

  await page.route("**/v1/runtime/telemetry**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [] }) })
  );

  await page.route("**/v1/auth/models**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) })
  );

  await page.route("**/v1/events/stream", (route) => route.abort());
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
 * Boots the app with mocked bus routes and an empty Field substrate. Specs
 * that don't care about Fields can call this and they get an empty field
 * list without leaking real network calls.
 */
export async function seedApp(page: Page): Promise<void> {
  await installBaselineRoutes(page);

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/fields`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ fields: [] })
      });
    }
    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/fields/*`, (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) })
  );

  await finishBoot(page);
}

/**
 * Boots the app with mocked bus routes and a substrate Field store seeded
 * with `fields`. Keeps an in-memory Map<string, StoredField> so PUTs,
 * DELETEs and subsequent GETs stay consistent inside a single test.
 */
export async function seedAppWithFields(
  page: Page,
  fields: Array<{ semantic: FieldSemantic; layout?: FieldLayoutFloeweb | null }>
): Promise<void> {
  await installBaselineRoutes(page);

  const store = new Map<string, StoredField>();
  for (const f of fields) {
    store.set(f.semantic.id, { semantic: f.semantic, layout: f.layout ?? null });
  }

  function summariesPayload(): string {
    const fieldIds = new Set(store.keys());
    const parentCounts = new Map<string, Set<string>>();
    for (const [parentId, { semantic }] of store.entries()) {
      const children = new Set<string>();
      for (const item of semantic.items) {
        if (!item.ref.startsWith("field:")) continue;
        const childId = item.ref.slice("field:".length);
        if (fieldIds.has(childId)) children.add(childId);
      }
      for (const childId of children) {
        const parents = parentCounts.get(childId) ?? new Set<string>();
        parents.add(parentId);
        parentCounts.set(childId, parents);
      }
    }
    const summaries: FieldSummary[] = Array.from(store.values()).map(({ semantic }) => ({
      id: semantic.id,
      title: semantic.title,
      item_count: semantic.items.length,
      connection_count: semantic.connections.length,
      parent_count: parentCounts.get(semantic.id)?.size ?? 0,
      updated_at: semantic.updated_at
    }));
    return JSON.stringify({ fields: summaries });
  }

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/fields`, (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: summariesPayload()
      });
    }
    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/fields/*/layout/floeweb`, async (route) => {
    const url = new URL(route.request().url());
    const segments = url.pathname.split("/");
    const fieldId = decodeURIComponent(segments[segments.length - 3] ?? "");
    const method = route.request().method();

    if (method === "PUT") {
      let layout: FieldLayoutFloeweb;
      try {
        layout = JSON.parse(route.request().postData() ?? "{}") as FieldLayoutFloeweb;
      } catch {
        return route.fulfill({ status: 400, body: JSON.stringify({ error: "bad_json" }) });
      }
      const prev = store.get(fieldId);
      if (!prev) {
        return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
      }
      store.set(fieldId, { semantic: prev.semantic, layout });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ layout })
      });
    }

    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/fields/*`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/layout/floeweb")) {
      return route.fallback();
    }
    const segments = url.pathname.split("/");
    const fieldId = decodeURIComponent(segments[segments.length - 1] ?? "");
    const method = route.request().method();

    if (method === "GET") {
      const existing = store.get(fieldId);
      if (!existing) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "not_found" })
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ semantic: existing.semantic, layout: existing.layout })
      });
    }

    if (method === "PUT") {
      let semantic: FieldSemantic;
      try {
        semantic = JSON.parse(route.request().postData() ?? "{}") as FieldSemantic;
      } catch {
        return route.fulfill({ status: 400, body: JSON.stringify({ error: "bad_json" }) });
      }
      const prev = store.get(fieldId);
      store.set(fieldId, { semantic, layout: prev?.layout ?? null });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ semantic })
      });
    }

    if (method === "DELETE") {
      const had = store.delete(fieldId);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ semanticDeleted: had, layoutsDeleted: [] })
      });
    }

    return route.fulfill({ status: 405, body: JSON.stringify({ error: "method not allowed" }) });
  });

  await finishBoot(page);
}

export async function seedAppWithScopes(
  page: Page,
  scopes: ScopeRecord[],
  projections: Record<string, ScopeProjection>,
  options: { legacyFieldRequests?: string[]; scopePosts?: string[]; scopePatches?: string[] } = {}
): Promise<void> {
  await installBaselineRoutes(page);

  const scopeStore = new Map(scopes.map((scope) => [scope.scope_id, scope]));
  const projectionStore = new Map(Object.entries(projections));
  let generatedScopeCounter = 1;
  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/fields**`, (route) => {
    options.legacyFieldRequests?.push(route.request().url());
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "legacy_fields_endpoint_called" })
    });
  });
  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/scopes`, async (route) => {
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
  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/scopes/*/projection`, (route) => {
    const segments = new URL(route.request().url()).pathname.split("/");
    const scopeId = decodeURIComponent(segments[segments.length - 2] ?? "");
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
  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/scopes/*`, async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/projection")) {
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
  await page.route("**/v1/contexts/*/events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [] })
    })
  );

  await finishBoot(page);
}

export function makeFieldSummary(
  id: string,
  title: string,
  items = 0,
  connections = 0
): FieldSummary {
  return {
    id,
    title,
    item_count: items,
    connection_count: connections,
    parent_count: 0,
    updated_at: new Date().toISOString()
  };
}

export function makeFieldSemantic(
  id: string,
  title: string,
  items: Array<{ item_id: string; ref: string; metadata?: Record<string, unknown> }> = [],
  connections: Array<{ id: string; from: string; to: string; label?: string; metadata?: Record<string, unknown> }> = []
): FieldSemantic {
  const now = new Date().toISOString();
  return {
    id,
    schema: "floe.field.v1",
    title,
    items,
    connections,
    created_at: now,
    updated_at: now
  };
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
