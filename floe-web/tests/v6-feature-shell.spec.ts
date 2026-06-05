import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type EndpointRecord,
  type EventRecord,
  type TelemetryRecord,
  type WorkspaceContextRecord,
  type WorkspaceRecord
} from "./helpers";

const workspaceA = WORKSPACE_ID;
const workspaceB = "ws_research_lab";
const operatorId = `actor:${workspaceA}:operator`;
const floeId = `actor:${workspaceA}:floe`;

test.describe("V6 feature-complete shell", () => {
  test("switches Workspaces from the top shell while Home stays a Workspace index", async ({ page }) => {
    const workspaces: WorkspaceRecord[] = [
      {
        workspace_id: workspaceA,
        name: "Writing System",
        locator: "local://writing-system",
        path: "local://writing-system",
        status: "attached",
        init_authorized: true,
        created_at: "2026-05-24T00:00:00.000Z"
      },
      {
        workspace_id: workspaceB,
        name: "Research Lab",
        locator: "local://research-lab",
        path: "local://research-lab",
        status: "attached",
        init_authorized: true,
        created_at: "2026-05-24T00:00:00.000Z"
      }
    ];
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: workspaceA, name: "Operator", status: "online", metadata_json: "{}" },
      { endpoint_id: floeId, workspace_id: workspaceA, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" }
    ];
    const contexts: WorkspaceContextRecord[] = [{
      context_id: "ctx_workspace_thread",
      workspace_id: workspaceA,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: operatorId,
      created_at: "2026-05-24T00:01:00.000Z",
      last_event_at: "2026-05-24T00:02:00.000Z",
      participants: [operatorId, floeId],
      first_message_preview: "Workspace-level planning thread"
    }];

    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing System")],
      { scope_writing: emptyScopeProjection("scope_writing") },
      { workspaces, endpoints, workspaceContexts: contexts }
    );

    const topbar = page.getByTestId("v6-topbar");
    await expect(topbar.getByRole("button", { name: /Writing System/ })).toBeVisible();
    await expect(page.locator(".workspace-rail .workspace-row")).toHaveCount(0);

    const home = page.getByTestId("v6-workspace-home");
    await expect(home).toBeVisible();
    await expect(home.getByRole("heading", { name: /Writing System/ })).toBeVisible();
    await expect(home).toContainText("Home indexes Workspace state without becoming a Scope.");
    await expect(home.getByTestId("v6-home-actors")).toContainText("Floe");
    await expect(home.getByTestId("v6-home-scopes")).toContainText("Writing System");
    await expect(home.getByTestId("v6-home-contexts")).toContainText("Workspace-level planning thread");
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);

    await topbar.getByRole("button", { name: /Writing System/ }).click();
    await page.getByRole("menu").getByRole("button", { name: /^Research Lab / }).click();

    await expect(topbar.getByRole("button", { name: /Research Lab/ })).toBeVisible();
    await expect(home.getByRole("heading", { name: /Research Lab/ })).toBeVisible();
  });

  test("creates and opens a Workspace from the top shell", async ({ page }) => {
    const registerCalls: unknown[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing System")],
      { scope_writing: emptyScopeProjection("scope_writing") },
      {
        workspaces: [{
          workspace_id: workspaceA,
          name: "Writing System",
          locator: "local://writing-system",
          path: "local://writing-system",
          status: "attached",
          init_authorized: true,
          created_at: "2026-05-24T00:00:00.000Z"
        }],
        workspaceRegisterCalls: registerCalls
      }
    );

    const topbar = page.getByTestId("v6-topbar");
    await topbar.getByRole("button", { name: /Writing System/ }).click();
    await page.getByRole("menu").getByRole("button", { name: /New Workspace/ }).click();
    await page.getByRole("menu").getByLabel("Location").fill("C:\\Development\\research-lab");
    await page.getByRole("menu").getByLabel("Name").fill("Research Lab");
    await page.getByRole("button", { name: "Create Workspace" }).click();

    await expect(topbar.getByRole("button", { name: /Research Lab/ })).toBeVisible();
    await expect(page.getByTestId("v6-workspace-home").getByRole("heading", { name: /Research Lab/ })).toBeVisible();
    expect(registerCalls).toEqual([
      expect.objectContaining({
        locator: "C:\\Development\\research-lab",
        name: "Research Lab",
        init_authorized: true
      })
    ]);
  });

  test("composes Home as the v6 index with settings and recent activity instead of a Block Library", async ({ page }) => {
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: workspaceA, name: "Operator", status: "online", metadata_json: "{}" },
      { endpoint_id: floeId, workspace_id: workspaceA, name: "Floe", status: "active", agent_id: "floe", metadata_json: "{}" }
    ];
    const events: EventRecord[] = [{
      event_id: "evt_pulse_daily",
      type: "pulse.fired",
      workspace_id: workspaceA,
      source_endpoint_id: floeId,
      destination_json: { kind: "broadcast" },
      context_id: "ctx_workspace_thread",
      content: { text: "Daily writing pulse fired" },
      created_at: "2026-05-24T00:04:00.000Z"
    }];
    const telemetry: TelemetryRecord[] = [{
      telemetry_id: "tel_outline",
      workspace_id: workspaceA,
      endpoint_id: floeId,
      delivery_id: null,
      kind: "AfterToolUse",
      payload_json: JSON.stringify({ summary: "Updated the publication outline", context_id: "ctx_workspace_thread" }),
      created_at: "2026-05-24T00:05:00.000Z"
    }];

    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing System")],
      { scope_writing: emptyScopeProjection("scope_writing") },
      {
        workspaces: [{
          workspace_id: workspaceA,
          name: "Writing System",
          locator: "local://writing-system",
          path: "local://writing-system",
          status: "attached",
          init_authorized: true,
          created_at: "2026-05-24T00:00:00.000Z"
        }],
        endpoints,
        events,
        telemetry
      }
    );

    const home = page.getByTestId("v6-workspace-home");
    await expect(home.getByTestId("v6-home-workspace-settings")).toContainText("local://writing-system");
    await expect(home.getByTestId("v6-home-workspace-settings")).toContainText("attached");
    await expect(home.getByTestId("v6-home-recent-activity")).toContainText("pulse.fired");
    await expect(home.getByTestId("v6-home-recent-activity")).toContainText("Daily writing pulse fired");
    await expect(home.getByTestId("v6-home-recent-activity")).toContainText("Completed");
    await expect(page.getByText("Block Library")).toHaveCount(0);
  });
});
