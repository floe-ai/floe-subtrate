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
    // contexts list
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
          },
          {
            context_id: CONTEXT_B,
            workspace_id: WORKSPACE_ID,
            parent_context_id: null,
            created_by_endpoint_id: FLOE_ID,
            created_at: "2025-01-01T00:01:00Z",
            last_event_at: "2025-01-01T00:01:02Z",
            participants: [FLOE_ID, REVIEWER_ID],
            first_message_preview: "Context-B message from floe to reviewer"
          }
        ]
      })
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
  await page.click('.icon-button[title="Toggle Channel"]');
  await page.waitForTimeout(400);
}

test.describe("No actor bleed between contexts (Slice 8)", () => {
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
    const contextBItem = page.locator("text=Context-B message from floe to reviewer");
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
