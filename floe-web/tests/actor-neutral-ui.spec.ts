/**
 * Slice 8 — Actor-neutral UI facade tests.
 *
 * Asserts that the FloeWeb chat shell does not leak substrate category
 * information (no "Humans"/"Agents" section headers, no `endpoint:` ids,
 * no `.channel-message.human` class, no `actor_type` text).
 */
import { test as base, expect } from "@playwright/test";

const test = base;

const WORKSPACE_ID = "ws_neutral";
const OPERATOR_ID = `actor:${WORKSPACE_ID}:operator`;
const FLOE_ID = `actor:${WORKSPACE_ID}:floe`;

function setupRoutesForNeutralUI(page: import("@playwright/test").Page) {
  return Promise.all([
    page.route("**/v1/workspaces", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workspaces: [{
              workspace_id: WORKSPACE_ID,
              name: "Neutral Test",
              locator: "/tmp/neutral-ws",
              status: "attached",
              init_authorized: 1
            }]
          })
        });
      }
      return route.fulfill({ status: 200, body: JSON.stringify({}) });
    }),

    page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          endpoints: [
            { endpoint_id: FLOE_ID, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" },
            { endpoint_id: OPERATOR_ID, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
          ]
        })
      })
    ),

    page.route("**/v1/endpoints/register", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    ),

    page.route("**/v1/auth/profiles", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profiles: [] }) })
    ),

    page.route("**/v1/runtime/bindings**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ bindings: [] }) })
    ),

    page.route(/\/v1\/contexts\/[^/]+\/events/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          events: [{
            event_id: "evt1",
            type: "message",
            workspace_id: WORKSPACE_ID,
            context_id: "ctx_default",
            source_endpoint_id: OPERATOR_ID,
            destination_json: { kind: "endpoint", endpoint_id: FLOE_ID },
            content: { text: "Hello Floe" },
            metadata: {},
            created_at: "2025-01-01T00:00:30Z"
          }, {
            event_id: "evt2",
            type: "message",
            workspace_id: WORKSPACE_ID,
            context_id: "ctx_default",
            source_endpoint_id: FLOE_ID,
            destination_json: { kind: "endpoint", endpoint_id: OPERATOR_ID },
            content: { text: "Hello operator" },
            metadata: { origin: "runtime_turn_output" },
            created_at: "2025-01-01T00:01:00Z"
          }]
        })
      })
    ),

    page.route(/\/v1\/contexts\?/, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          contexts: [{
            context_id: "ctx_default",
            workspace_id: WORKSPACE_ID,
            parent_context_id: null,
            created_by_endpoint_id: OPERATOR_ID,
            created_at: "2025-01-01T00:00:00Z",
            last_event_at: "2025-01-01T00:01:00Z",
            participants: [OPERATOR_ID, FLOE_ID],
            first_message_preview: "Hello"
          }]
        })
      })
    ),

    page.route("**/v1/runtime/telemetry**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: [] }) })
    ),

    page.route("**/v1/events/stream", (route) => route.abort()),

    page.route("**/v1/events/emit", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) })
    ),

    page.route("**/v1/events**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) })
    ),
  ]);
}

async function gotoAndOpenChannel(page: import("@playwright/test").Page) {
  await setupRoutesForNeutralUI(page);
  await page.goto("/");
  // Wait for workspace to load
  await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
  // Open channel panel
  await page.click('.icon-button[title="Toggle Channel"]');
  await page.waitForTimeout(400);
}

test.describe("Actor-neutral UI (Slice 8)", () => {
  test("no 'Humans' or 'Agents' section headers in rendered DOM", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    const bodyText = await page.locator("body").innerText();
    // Must not have category section headers
    expect(bodyText).not.toMatch(/\bHumans\b/);
    expect(bodyText).not.toMatch(/\bAgents\b/);
  });

  test("no 'endpoint:' substring visible in DOM text", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toMatch(/endpoint:/);
  });

  test("no 'actor_type' text visible in DOM", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("actor_type");
  });

  test("no category badge text (human/agent) rendered alongside actor names", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    const bodyText = await page.locator("body").innerText();
    // Friendly names are fine; bare category words as labels are not
    // Check that "human" or "agent" don't appear as standalone labels near actor sections
    expect(bodyText).not.toMatch(/^\s*(human|agent)\s*$/im);
  });

  test("self-vs-other styling uses .channel-message.self, not .channel-message.human", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    // .channel-message.human should not exist
    const humanMessages = await page.locator(".channel-message.human").count();
    expect(humanMessages).toBe(0);

    // .channel-message.self should exist for operator's messages
    const selfMessages = await page.locator(".channel-message.self").count();
    expect(selfMessages).toBeGreaterThan(0);
  });

  test("Inspector does not show Humans/Agents counts", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    // The inspector area should not contain "Humans" or "Agents" as labels
    const inspectorText = await page.locator("body").innerText();
    expect(inspectorText).not.toMatch(/\bHumans\b.*\d/);
    expect(inspectorText).not.toMatch(/\bAgents\b.*\d/);
  });

  test("no 'Default channel' label in inspector — uses 'Actors' instead", async ({ page }) => {
    await gotoAndOpenChannel(page);
    await page.waitForSelector(".channel-message", { timeout: 5000 });

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("Default channel");
    expect(bodyText).toContain("Actors");
  });

  test("no 'agent endpoint' in placeholder text", async ({ page }) => {
    await setupRoutesForNeutralUI(page);
    // Override endpoints to return none so we see the no-agent placeholder
    await page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          endpoints: [
            { endpoint_id: OPERATOR_ID, workspace_id: WORKSPACE_ID, name: "You", status: "online", metadata_json: "{}" },
          ]
        })
      })
    );
    await page.goto("/");
    await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.click('.icon-button[title="Toggle Channel"]');
    await page.waitForTimeout(400);

    const bodyText = await page.locator("body").innerText();
    expect(bodyText).not.toContain("agent endpoint");
    expect(bodyText).toContain("No actors available");
  });
});
