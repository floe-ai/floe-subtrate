import { expect } from "@playwright/test";
import { test, seedApp, WORKSPACE_ID, WORKSPACE_NAME } from "./helpers";

test.describe("Workspace management", () => {

  test("shows directory-not-found confirmation when workspace path does not exist", async ({ page }) => {
    await seedApp(page);

    // Intercept register call to return directory_not_found
    let registerCalls = 0;
    await page.route("**/v1/workspaces/register", (route) => {
      registerCalls++;
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (!body.create_directory) {
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            error: "directory_not_found",
            message: "Directory does not exist: C:\\fake\\path",
            locator: "C:\\fake\\path"
          })
        });
      }
      // Second call with create_directory: true should succeed
      return route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          workspace: {
            workspace_id: "workspace:new-ws",
            name: "New WS",
            locator: "C:\\fake\\path",
            status: "registered",
            init_authorized: 1
          }
        })
      });
    });

    // Type a workspace path in the sidebar input
    const sidebarInput = page.locator(".rail-new input");
    await sidebarInput.fill("C:\\fake\\path");

    // Set up dialog handler to accept the confirmation
    page.on("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("does not exist");
      await dialog.accept();
    });

    // Click create workspace button
    await page.locator(".rail-new button").click();

    // Wait for the retry to happen
    await page.waitForTimeout(1000);

    // Verify two register calls were made (first without create_directory, second with)
    expect(registerCalls).toBe(2);
  });

  test("cancels workspace creation when user dismisses directory confirmation", async ({ page }) => {
    await seedApp(page);

    let registerCalls = 0;
    await page.route("**/v1/workspaces/register", (route) => {
      registerCalls++;
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "directory_not_found",
          message: "Directory does not exist: C:\\nope",
          locator: "C:\\nope"
        })
      });
    });

    const sidebarInput = page.locator(".rail-new input");
    await sidebarInput.fill("C:\\nope");

    page.on("dialog", async (dialog) => {
      await dialog.dismiss();
    });

    await page.locator(".rail-new button").click();
    await page.waitForTimeout(500);

    // Only one call made - user cancelled, no retry
    expect(registerCalls).toBe(1);
  });

  test("delete button appears on workspace hover and removes workspace", async ({ page }) => {
    await seedApp(page);

    // Verify workspace is visible
    const workspaceRow = page.locator(".workspace-row").first();
    await expect(workspaceRow).toBeVisible();
    await expect(workspaceRow.locator(".workspace-button span")).toHaveText(WORKSPACE_NAME);

    // Intercept delete call
    let deleteCalled = false;
    await page.route(`**/v1/workspaces/${WORKSPACE_ID}/delete`, (route) => {
      deleteCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, workspace_id: WORKSPACE_ID })
      });
    });

    // After deletion, the workspaces list should be empty
    await page.route("**/v1/workspaces", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ workspaces: [] })
        });
      }
      return route.fulfill({ status: 200, body: JSON.stringify({}) });
    });

    // Hover to reveal delete button
    await workspaceRow.hover();

    // Accept the confirmation dialog
    page.on("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("Delete workspace");
      await dialog.accept();
    });

    // Click delete button
    const deleteButton = workspaceRow.locator(".workspace-delete-button");
    await deleteButton.click({ force: true }); // force because opacity might not be fully visible

    await page.waitForTimeout(500);
    expect(deleteCalled).toBe(true);
  });
});

test.describe("Spinner behavior", () => {

  test("spinner does not appear when endpoint is idle even with stale streaming turns", async ({ page }) => {
    // Seed with an endpoint that's idle and telemetry with stale visible_output
    const floeEndpointId = `endpoint:${WORKSPACE_ID}:agent:floe`;

    await page.route("**/v1/workspaces", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            workspaces: [{
              workspace_id: WORKSPACE_ID,
              name: WORKSPACE_NAME,
              locator: "/tmp/qa-ws",
              status: "attached",
              init_authorized: 1
            }]
          })
        });
      }
      return route.fulfill({ status: 200, body: JSON.stringify({}) });
    });

    await page.route("**/v1/endpoints**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          endpoints: [{
            endpoint_id: floeEndpointId,
            workspace_id: WORKSPACE_ID,
            actor_type: "agent",
            name: "Floe",
            agent_id: "floe",
            status: "idle"
          }, {
            endpoint_id: `endpoint:${WORKSPACE_ID}:user:operator`,
            workspace_id: WORKSPACE_ID,
            actor_type: "human",
            name: "Operator",
            status: "online"
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

    await page.route("**/v1/auth/models**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) })
    );

    await page.route("**/v1/events**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: [] }) })
    );

    // Stale telemetry with visible_output that has no matching response event
    await page.route("**/v1/runtime/telemetry**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          telemetry: [{
            telemetry_id: "stale-1",
            endpoint_id: floeEndpointId,
            kind: "visible_output",
            payload_json: JSON.stringify({
              runtime_turn_id: "rt_stale_turn",
              text: "Stale streaming text from a failed turn"
            }),
            created_at: "2026-05-07T12:00:00.000Z"
          }]
        })
      })
    );

    await page.route("**/v1/events/stream", (route) => route.abort());

    await page.goto("/");
    await page.evaluate(({ wsId }) => {
      localStorage.setItem("floe.busUrl", "http://127.0.0.1:5377");
    }, { wsId: WORKSPACE_ID });
    await page.reload();
    await page.waitForTimeout(1000);

    // Select the workspace
    await page.locator(".workspace-button").first().click();
    await page.waitForTimeout(500);

    // Open the channel
    const channelToggle = page.locator("button[title='Toggle Channel']");
    await channelToggle.click();
    await page.waitForTimeout(500);

    // The "is working" spinner should NOT appear since endpoint is idle
    const thinkingStrip = page.locator(".thinking-strip");
    await expect(thinkingStrip).not.toBeVisible();
  });
});
