import { test as base, Page } from "@playwright/test";

const WORKSPACE_ID = "ws_test_qa";
const WORKSPACE_NAME = "QA Workspace";

export type FieldSummary = {
  id: string;
  title: string;
  item_count: number;
  connection_count: number;
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
    const summaries: FieldSummary[] = Array.from(store.values()).map(({ semantic }) => ({
      id: semantic.id,
      title: semantic.title,
      item_count: semantic.items.length,
      connection_count: semantic.connections.length,
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

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/fields/*`, async (route) => {
    const url = new URL(route.request().url());
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

export { WORKSPACE_ID, WORKSPACE_NAME };

export const test = base;
