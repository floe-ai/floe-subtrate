/**
 * Slice 8 — No-actor-bleed test.
 *
 * Verifies that selecting different contexts shows only the events for that
 * context and no cross-bleed occurs. Uses three actors: operator, floe, reviewer.
 */
import { test as base, expect } from "@playwright/test";

const test = base;

const WORKSPACE_ID = "ws_bleed";
const OPERATOR_ID = `actor:${WORKSPACE_ID}:operator`;
const FLOE_ID = `actor:${WORKSPACE_ID}:floe`;
const REVIEWER_ID = `actor:${WORKSPACE_ID}:reviewer`;

const CONTEXT_A = "ctx_a";
const CONTEXT_B = "ctx_b";

const EVENTS_A = [
  {
    event_id: "evt_a1",
    type: "message",
    workspace_id: WORKSPACE_ID,
    context_id: CONTEXT_A,
    source_endpoint_id: OPERATOR_ID,
    destination_json: { kind: "endpoint", endpoint_id: FLOE_ID },
    content: { text: "Context-A message from operator" },
    metadata: {},
    created_at: "2025-01-01T00:00:01Z"
  },
  {
    event_id: "evt_a2",
    type: "message",
    workspace_id: WORKSPACE_ID,
    context_id: CONTEXT_A,
    source_endpoint_id: FLOE_ID,
    destination_json: { kind: "endpoint", endpoint_id: OPERATOR_ID },
    content: { text: "Context-A reply from floe" },
    metadata: { origin: "runtime_turn_output" },
    created_at: "2025-01-01T00:00:02Z"
  }
];

const EVENTS_B = [
  {
    event_id: "evt_b1",
    type: "message",
    workspace_id: WORKSPACE_ID,
    context_id: CONTEXT_B,
    source_endpoint_id: FLOE_ID,
    destination_json: { kind: "endpoint", endpoint_id: REVIEWER_ID },
    content: { text: "Context-B message from floe to reviewer" },
    metadata: {},
    created_at: "2025-01-01T00:01:01Z"
  },
  {
    event_id: "evt_b2",
    type: "message",
    workspace_id: WORKSPACE_ID,
    context_id: CONTEXT_B,
    source_endpoint_id: REVIEWER_ID,
    destination_json: { kind: "endpoint", endpoint_id: FLOE_ID },
    content: { text: "Context-B reply from reviewer" },
    metadata: { origin: "runtime_turn_output" },
    created_at: "2025-01-01T00:01:02Z"
  }
];

async function setupRoutes(page: import("@playwright/test").Page) {
  await page.route("**/v1/workspaces", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          workspaces: [{
            workspace_id: WORKSPACE_ID,
            name: "Bleed Test",
            locator: "/tmp/bleed-ws",
            status: "attached",
            init_authorized: 1
          }]
        })
      });
    }
    return route.fulfill({ status: 200, body: JSON.stringify({}) });
  });

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        endpoints: [
          { endpoint_id: FLOE_ID, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" },
          { endpoint_id: REVIEWER_ID, workspace_id: WORKSPACE_ID, name: "Reviewer", status: "idle", agent_id: "reviewer", metadata_json: "{}" },
          { endpoint_id: OPERATOR_ID, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
        ]
      })
    })
  );

  await page.route("**/v1/endpoints/register", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
  );

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/scopes`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        scopes: [{
          scope_id: "scope_review",
          workspace_id: WORKSPACE_ID,
          title: "Review Scope",
          description: null,
          is_default: false,
          created_at: "2025-01-01T00:00:00Z",
          updated_at: "2025-01-01T00:00:00Z"
        }]
      })
    })
  );

  await page.route("**/v1/auth/profiles", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profiles: [] }) })
  );

  await page.route("**/v1/runtime/bindings**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bindings: [] }) })
  );

  await page.route("**/v1/contexts**", (route) => {
    const url = route.request().url();
    if (url.includes(`/contexts/${CONTEXT_A}/events`)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: EVENTS_A })
      });
    }
    if (url.includes(`/contexts/${CONTEXT_B}/events`)) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: EVENTS_B })
      });
    }
    const participant = new URL(url).searchParams.get("participant");
    const contexts = [
      {
        context_id: CONTEXT_A,
        workspace_id: WORKSPACE_ID,
        scope_id: null,
        parent_context_id: null,
        created_by_endpoint_id: OPERATOR_ID,
        created_at: "2025-01-01T00:00:00Z",
        last_event_at: "2025-01-01T00:00:02Z",
        participants: [OPERATOR_ID, FLOE_ID],
        first_message_preview: "Context-A message from operator"
      },
      {
        context_id: CONTEXT_B,
        workspace_id: WORKSPACE_ID,
        scope_id: "scope_review",
        parent_context_id: null,
        created_by_endpoint_id: FLOE_ID,
        created_at: "2025-01-01T00:01:00Z",
        last_event_at: "2025-01-01T00:01:02Z",
        participants: [FLOE_ID, REVIEWER_ID],
        first_message_preview: "Context-B message from floe to reviewer"
      }
    ].filter((context) => !participant || context.participants.includes(participant));

    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ contexts })
    });
  });

  await page.route("**/v1/runtime/telemetry**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [] }) })
  );

  await page.route("**/v1/events/stream", (route) => route.abort());

  await page.route("**/v1/events/emit", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
  );

  await page.route("**/v1/events**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) })
  );
}

async function gotoAndOpenChannel(page: import("@playwright/test").Page) {
  await setupRoutes(page);
  await page.goto("/");
  await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.getByLabel("Open Contexts for Floe").click();
  await page.waitForTimeout(400);
}

test.describe("No actor bleed between contexts (Slice 8)", () => {
  test("context query uses selected actor ID as participant, not operator self ID", async ({ page }) => {
    const contextRequests: string[] = [];
    await setupRoutes(page);
    // Intercept context list requests to capture URL
    await page.route(/\/v1\/contexts\?/, (route) => {
      contextRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          contexts: [
            {
              context_id: CONTEXT_A,
              workspace_id: WORKSPACE_ID,
              parent_context_id: null,
              created_by_endpoint_id: OPERATOR_ID,
              created_at: "2025-01-01T00:00:00Z",
              last_event_at: "2025-01-01T00:00:02Z",
              participants: [OPERATOR_ID, FLOE_ID],
              first_message_preview: "Context-A message from operator"
            }
          ]
        })
      });
    });
    await page.goto("/");
    await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.getByLabel("Open Contexts for Floe").click();
    await page.waitForTimeout(800);

    // Verify the context list query uses the selected actor's ID, not the operator's.
    const contextListReq = contextRequests.find(u => u.includes("/v1/contexts?"));
    expect(contextListReq).toBeDefined();
    expect(contextListReq).toContain(encodeURIComponent(FLOE_ID));
    expect(contextListReq).not.toContain(encodeURIComponent(OPERATOR_ID));
  });

  test("context list shows all Workspace Contexts involving the selected actor", async ({ page }) => {
    await setupRoutes(page);
    await page.goto("/");
    await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.getByLabel("Open Contexts for Floe").click();
    await page.waitForTimeout(400);

    const contextList = page.locator("[data-testid='context-list']");
    const listText = await contextList.innerText();
    expect(listText).toContain("Context-A message from operator");
    expect(listText).toContain("Context-B message from floe to reviewer");
    expect(listText).toContain("Workspace-level Context");
    expect(listText).toContain("Scoped Context · Review Scope");
    expect(listText).not.toMatch(/Default (Scope|Field)/);
  });

  test("non-operator selected-actor Contexts are opened read-only", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    await page.locator('[data-testid="context-list-item"][data-context-id="ctx_b"]').click();
    await page.waitForTimeout(500);

    await expect(page.getByText("Context-B message from floe to reviewer").last()).toBeVisible();
    await expect(page.getByText(/Floe ·/).last()).toBeVisible();
    await expect(page.getByText(/Reviewer ·/)).toBeVisible();
    await expect(page.getByText("Read-only Context: Floe participates")).toBeVisible();
    await expect(page.locator(".channel-composer input")).toBeDisabled();
  });

  test("context A shows only context-A messages, no context-B content", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    // Check only the channel message area, not the sidebar context list
    const messages = page.locator(".channel-message");
    const allMessageText = await messages.allInnerTexts();
    const messageContent = allMessageText.join(" ");
    // Context A messages should be visible (it's the default for floe agent)
    expect(messageContent).toContain("Context-A message from operator");
    expect(messageContent).toContain("Context-A reply from floe");
    // Context B messages must NOT appear in the channel messages
    expect(messageContent).not.toContain("Context-B message from floe to reviewer");
    expect(messageContent).not.toContain("Context-B reply from reviewer");
  });

  test("switching to context B shows only context-B messages", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    // Click context B in the context list
    const contextBItem = page.locator('[data-testid="context-list-item"][data-context-id="ctx_b"]');
    if (await contextBItem.isVisible()) {
      await contextBItem.click();
      await page.waitForTimeout(500);

      const messages = page.locator(".channel-message");
      const allMessageText = await messages.allInnerTexts();
      const messageContent = allMessageText.join(" ");
      expect(messageContent).toContain("Context-B message from floe to reviewer");
      expect(messageContent).toContain("Context-B reply from reviewer");
      expect(messageContent).not.toContain("Context-A message from operator");
    }
  });

  test("no endpoint: prefixed ids visible in any context view", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/endpoint:/);
    expect(bodyText).not.toContain("actor_type");
  });
});
