import { test as base, Page } from "@playwright/test";

const WORKSPACE_ID = "ws_test_qa";
const WORKSPACE_NAME = "QA Workspace";

/**
 * Seed localStorage with a bus URL pointing to a mock, a workspace reference,
 * and optionally a set of pre-built fields. Then intercept bus API routes so
 * the app boots without a real floe-bus running.
 */
export async function seedApp(page: Page, fields?: unknown[]) {
  // Mock all bus API routes before navigating
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

  // Swallow the WebSocket connection attempt
  await page.route("**/v1/events/stream", (route) => route.abort());

  // Navigate to the app
  await page.goto("/");

  // Seed localStorage after page loads
  await page.evaluate(({ workspaceId, busUrl, fieldData }) => {
    localStorage.setItem("floe.busUrl", busUrl);
    if (fieldData) {
      localStorage.setItem(`floe.web.local-fields.${workspaceId}`, JSON.stringify(fieldData));
    }
  }, {
    workspaceId: WORKSPACE_ID,
    busUrl: "http://127.0.0.1:5377",
    fieldData: fields ?? null
  });

  // Reload so the app picks up the seeded localStorage
  await page.reload();
  await page.waitForSelector("[data-testid='workspace-loaded'], .workspace-home", { timeout: 8000 }).catch(() => {});
  // Give React time to render
  await page.waitForTimeout(500);
}

export function makeField(id: string, name: string, parentId?: string, nodes: unknown[] = [], edges: unknown[] = []) {
  return {
    id,
    name,
    parent_id: parentId ?? null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    nodes,
    edges
  };
}

export function makeFieldNode(nodeId: string, fieldId: string, label: string, position = { x: 200, y: 150 }) {
  return {
    id: nodeId,
    type: "default",
    data: { label, field_id: fieldId, block_type: "field" },
    position
  };
}

export { WORKSPACE_ID, WORKSPACE_NAME };

export const test = base;
