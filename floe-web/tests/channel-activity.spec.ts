import { test as base, expect, Page } from "@playwright/test";

const WORKSPACE_ID = "ws_test_qa";
const WORKSPACE_NAME = "QA Workspace";
const FLOE_ENDPOINT_ID = `endpoint:${WORKSPACE_ID}:agent:floe`;
const HUMAN_ENDPOINT_ID = `endpoint:${WORKSPACE_ID}:user:operator`;
const THREAD_ID = `thread:${WORKSPACE_ID}:floe`;

const test = base;

// ─── Mock data builders ───────────────────────────────────────────────────────

function makeEvent(overrides: Partial<{
  event_id: string;
  type: string;
  source_endpoint_id: string;
  thread_id: string;
  content: { text?: string; data?: Record<string, unknown> };
  metadata: Record<string, unknown>;
  created_at: string;
}>): Record<string, unknown> {
  return {
    event_id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    workspace_id: WORKSPACE_ID,
    source_endpoint_id: HUMAN_ENDPOINT_ID,
    destination_json: { kind: "endpoint", endpoint_id: FLOE_ENDPOINT_ID },
    thread_id: THREAD_ID,
    content: { text: "Hello" },
    metadata: {},
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeHumanMessage(text: string, createdAt: string) {
  return makeEvent({
    event_id: `evt_human_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "message",
    source_endpoint_id: HUMAN_ENDPOINT_ID,
    thread_id: THREAD_ID,
    content: { text },
    metadata: {},
    created_at: createdAt,
  });
}

function makeFloeMessage(text: string, createdAt: string) {
  return makeEvent({
    event_id: `evt_floe_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    type: "message",
    source_endpoint_id: FLOE_ENDPOINT_ID,
    thread_id: THREAD_ID,
    content: { text },
    metadata: { origin: "runtime_turn_output" },
    created_at: createdAt,
  });
}

function makeTelemetry(kind: string, toolName: string, createdAt: string) {
  return {
    telemetry_id: `tel_${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: WORKSPACE_ID,
    endpoint_id: FLOE_ENDPOINT_ID,
    delivery_id: null,
    kind,  // use PascalCase: "BeforeToolUse", "AfterToolUse", "ToolUseFailed"
    payload_json: JSON.stringify({ toolName }),
    created_at: createdAt,
  };
}

// ─── Route setup helper ───────────────────────────────────────────────────────

async function setupRoutes(
  page: Page,
  options: {
    events?: unknown[];
    telemetry?: unknown[];
    agentStatus?: string;
  } = {}
) {
  const { events = [], telemetry = [], agentStatus = "idle" } = options;

  const floeEndpoint = {
    endpoint_id: FLOE_ENDPOINT_ID,
    workspace_id: WORKSPACE_ID,
    actor_type: "agent",
    name: "Floe",
    status: agentStatus,
    agent_id: "floe",
    metadata_json: "{}",
  };

  const humanEndpoint = {
    endpoint_id: HUMAN_ENDPOINT_ID,
    workspace_id: WORKSPACE_ID,
    actor_type: "human",
    name: "Operator",
    status: "idle",
    agent_id: null,
    metadata_json: "{}",
  };

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
            created_at: new Date().toISOString(),
          }],
        }),
      });
    }
    return route.fulfill({ status: 200, body: JSON.stringify({}) });
  });

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ endpoints: [floeEndpoint, humanEndpoint] }),
    })
  );

  await page.route("**/v1/auth/profiles", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ profiles: [{ id: "prof_1", provider: "openai", model: "gpt-4", label: "GPT-4" }] }),
    })
  );

  await page.route("**/v1/runtime/bindings**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bindings: [{
          binding_key: "b1",
          scope: "agent",
          workspace_id: WORKSPACE_ID,
          endpoint_id: FLOE_ENDPOINT_ID,
          auth_profile: "prof_1",
          model: "gpt-4",
        }],
      }),
    })
  );

  await page.route("**/v1/events**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events }),
    })
  );

  await page.route("**/v1/runtime/telemetry**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ records: telemetry }),
    })
  );

  await page.route("**/v1/auth/models**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ models: [] }),
    })
  );

  // Swallow WebSocket
  await page.route("**/v1/events/stream", (route) => route.abort());
}

async function seedAndOpenChannel(
  page: Page,
  options: Parameters<typeof setupRoutes>[1] = {}
) {
  await setupRoutes(page, options);
  await page.goto("/");

  // Seed localStorage with busUrl so app fetches from mocked routes
  await page.evaluate(({ workspaceId, busUrl }) => {
    localStorage.setItem("floe.busUrl", busUrl);
  }, { workspaceId: WORKSPACE_ID, busUrl: "http://127.0.0.1:5377" });

  await page.reload();
  await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);

  // Open channel
  await page.click('.icon-button[title="Toggle Channel"]');
  await page.waitForTimeout(400);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe("Channel activity groups", () => {
  test("activity group renders collapsed between messages", async ({ page }) => {
    const t0 = "2024-06-01T10:00:00.000Z";
    const t1 = "2024-06-01T10:00:01.000Z";
    const t2 = "2024-06-01T10:00:02.000Z";
    const t3 = "2024-06-01T10:00:03.000Z";

    const events = [
      makeHumanMessage("What is the status?", t0),
      makeFloeMessage("Everything looks good.", t3),
    ];
    const telemetry = [
      makeTelemetry("BeforeToolUse", "checkJira", t1),
      makeTelemetry("AfterToolUse", "checkJira", t2),
    ];

    await seedAndOpenChannel(page, { events, telemetry });

    // Verify messages are visible
    await expect(page.locator(".channel-message.human")).toBeVisible();
    await expect(page.locator(".channel-message.floe:not(.streaming)")).toBeVisible();

    // Verify activity group exists and is done state
    const activityGroup = page.locator(".activity-group.done");
    await expect(activityGroup).toBeVisible();

    // Label should mention the tool name or activity count
    const label = activityGroup.locator(".activity-group-label");
    await expect(label).toBeVisible();
    const labelText = await label.textContent();
    expect(labelText!.length).toBeGreaterThan(0);
    // Should contain "checkJira" or "tool call" or "Activity"
    expect(
      labelText!.includes("checkJira") || labelText!.includes("tool call") || labelText!.includes("Activity")
    ).toBeTruthy();

    // Details should NOT be visible by default
    await expect(page.locator(".activity-group-details")).not.toBeVisible();
  });

  test("clicking activity group toggle expands and collapses it", async ({ page }) => {
    const t0 = "2024-06-01T10:00:00.000Z";
    const t1 = "2024-06-01T10:00:01.000Z";
    const t2 = "2024-06-01T10:00:02.000Z";
    const t3 = "2024-06-01T10:00:03.000Z";

    const events = [
      makeHumanMessage("Check the logs", t0),
      makeFloeMessage("Logs are clean.", t3),
    ];
    const telemetry = [
      makeTelemetry("BeforeToolUse", "readLogs", t1),
      makeTelemetry("AfterToolUse", "readLogs", t2),
    ];

    await seedAndOpenChannel(page, { events, telemetry });

    // Click the toggle to expand
    await page.click(".activity-group-toggle");
    await page.waitForTimeout(300);

    // Details panel should appear
    const details = page.locator(".activity-group-details");
    await expect(details).toBeVisible();

    // Each entry shows kind, summary (tool name), and time
    const items = details.locator(".activity-detail-item");
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // Check first item has kind, summary, and time
    const firstKind = items.nth(0).locator(".activity-detail-kind");
    const firstSummary = items.nth(0).locator(".activity-detail-summary");
    const firstTime = items.nth(0).locator(".activity-detail-time");
    await expect(firstKind).toBeVisible();
    await expect(firstSummary).toBeVisible();
    await expect(firstTime).toBeVisible();
    expect(await firstSummary.textContent()).toContain("readLogs");

    // Click toggle again to collapse
    await page.click(".activity-group-toggle");
    await page.waitForTimeout(300);

    await expect(page.locator(".activity-group-details")).not.toBeVisible();
  });

  test("working state shows spinner and live label", async ({ page }) => {
    const t0 = "2024-06-01T10:00:00.000Z";
    const t1 = "2024-06-01T10:00:01.000Z";

    const events = [
      makeHumanMessage("Deploy the service", t0),
    ];
    const telemetry = [
      makeTelemetry("BeforeToolUse", "deployService", t1),
    ];

    await seedAndOpenChannel(page, { events, telemetry, agentStatus: "active" });

    // Should see activity-group.working
    const workingGroup = page.locator(".activity-group.working");
    await expect(workingGroup).toBeVisible();

    // Spinner icon should be present (Loader with class .spin)
    await expect(workingGroup.locator(".spin")).toBeVisible();

    // Label should show "Running deployService…"
    const label = workingGroup.locator(".activity-group-label");
    const labelText = await label.textContent();
    expect(labelText).toContain("Running");
    expect(labelText).toContain("deployService");
  });

  test("multiple activity groups between multiple messages", async ({ page }) => {
    const t0 = "2024-06-01T10:00:00.000Z";
    const t1 = "2024-06-01T10:00:01.000Z";
    const t2 = "2024-06-01T10:00:02.000Z";
    const t3 = "2024-06-01T10:00:03.000Z";
    const t4 = "2024-06-01T10:00:04.000Z";
    const t5 = "2024-06-01T10:00:05.000Z";
    const t6 = "2024-06-01T10:00:06.000Z";
    const t7 = "2024-06-01T10:00:07.000Z";

    const events = [
      makeHumanMessage("First question", t0),
      makeFloeMessage("First answer", t3),
      makeHumanMessage("Second question", t4),
      makeFloeMessage("Second answer", t7),
    ];
    const telemetry = [
      makeTelemetry("BeforeToolUse", "toolAlpha", t1),
      makeTelemetry("AfterToolUse", "toolAlpha", t2),
      makeTelemetry("BeforeToolUse", "toolBeta", t5),
      makeTelemetry("AfterToolUse", "toolBeta", t6),
    ];

    await seedAndOpenChannel(page, { events, telemetry });

    // Should see two separate activity groups
    const activityGroups = page.locator(".activity-group");
    await expect(activityGroups).toHaveCount(2);
  });

  test("empty channel shows welcome message", async ({ page }) => {
    await seedAndOpenChannel(page, { events: [], telemetry: [] });

    // Channel should show .channel-empty with welcome text
    await expect(page.locator(".channel-empty")).toBeVisible();
    await expect(page.locator(".channel-empty strong")).toBeVisible();
  });

  test("channel with only messages (no activity) renders cleanly", async ({ page }) => {
    const t0 = "2024-06-01T10:00:00.000Z";
    const t1 = "2024-06-01T10:00:01.000Z";

    const events = [
      makeHumanMessage("Hi Floe", t0),
      makeFloeMessage("Hello! How can I help?", t1),
    ];

    await seedAndOpenChannel(page, { events, telemetry: [] });

    // Messages should be visible
    await expect(page.locator(".channel-message.human")).toBeVisible();
    await expect(page.locator(".channel-message.floe:not(.streaming)")).toBeVisible();

    // No activity groups should be rendered
    await expect(page.locator(".activity-group")).toHaveCount(0);
  });

  test("visible_output telemetry is not shown in activity groups", async ({ page }) => {
    const t0 = "2024-06-01T10:00:00.000Z";
    const t1 = "2024-06-01T10:00:01.000Z";
    const t2 = "2024-06-01T10:00:02.000Z";
    const t3 = "2024-06-01T10:00:03.000Z";
    const t4 = "2024-06-01T10:00:04.000Z";

    const events = [
      makeHumanMessage("Run the deploy", t0),
      makeFloeMessage("Deploy complete.", t4),
    ];
    const telemetry = [
      makeTelemetry("BeforeToolUse", "runDeploy", t1),
      makeTelemetry("visible_output", "stdout", t2),
      makeTelemetry("AfterToolUse", "runDeploy", t3),
    ];

    await seedAndOpenChannel(page, { events, telemetry });

    // Activity group should exist
    const activityGroup = page.locator(".activity-group.done");
    await expect(activityGroup).toBeVisible();

    // Expand the group to see details
    await page.click(".activity-group-toggle");
    await page.waitForTimeout(300);

    const details = page.locator(".activity-group-details");
    await expect(details).toBeVisible();

    // Only tool-related items should appear (BeforeToolUse + AfterToolUse = 2)
    const items = details.locator(".activity-detail-item");
    await expect(items).toHaveCount(2);

    // Verify none of the items show visible_output content
    const allSummaries = await items.locator(".activity-detail-summary").allTextContents();
    for (const summary of allSummaries) {
      expect(summary).not.toContain("stdout");
    }

    // The label should reference the tool, not visible_output
    const label = activityGroup.locator(".activity-group-label");
    const labelText = await label.textContent();
    expect(labelText).toContain("runDeploy");
    expect(labelText).not.toContain("visible_output");
  });
});
