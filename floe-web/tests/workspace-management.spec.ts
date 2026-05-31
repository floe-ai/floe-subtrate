import { expect } from "@playwright/test";
import { test, seedApp, WORKSPACE_ID, WORKSPACE_NAME } from "./helpers";

async function openWorkspaceMenu(page: import("@playwright/test").Page) {
  const topbar = page.getByTestId("v6-topbar");
  await topbar.getByRole("button", { name: new RegExp(WORKSPACE_NAME) }).click();
  return topbar;
}

async function openWorkspaceCreateForm(page: import("@playwright/test").Page) {
  const topbar = await openWorkspaceMenu(page);
  await page.getByRole("menuitem", { name: /New Workspace/ }).click();
  return topbar;
}

test.describe("Workspace management", () => {

  test("shows directory-not-found confirmation when workspace path does not exist", async ({ page }) => {
    await seedApp(page);

    let registerCalls = 0;
    const registerBodies: unknown[] = [];
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.route("**/v1/workspaces/register", (route) => {
      registerCalls++;
      const body = JSON.parse(route.request().postData() ?? "{}");
      registerBodies.push(body);
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

    const topbar = await openWorkspaceCreateForm(page);
    await topbar.getByLabel("Location").fill("C:\\fake\\path");

    await topbar.getByRole("button", { name: "Create Workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Create directory?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("C:\\fake\\path");
    await dialog.getByRole("button", { name: "Create folder" }).click();

    await expect.poll(() => registerCalls).toBe(2);
    expect(registerBodies[0]).not.toHaveProperty("create_directory", true);
    expect(registerBodies[1]).toHaveProperty("create_directory", true);
    expect(nativeDialogs).toEqual([]);
  });

  test("cancels workspace creation when user dismisses directory confirmation", async ({ page }) => {
    await seedApp(page);

    let registerCalls = 0;
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });
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

    const topbar = await openWorkspaceCreateForm(page);
    await topbar.getByLabel("Location").fill("C:\\nope");

    page.on("dialog", async (dialog) => {
      await dialog.dismiss();
    });

    await topbar.getByRole("button", { name: "Create Workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Create directory?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => registerCalls).toBe(1);
    expect(nativeDialogs).toEqual([]);
  });

  test("delete button appears on workspace hover and removes workspace while keeping files", async ({ page }) => {
    await seedApp(page);
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await openWorkspaceMenu(page);
    const workspaceRow = page.locator(".workspace-menu-row").first();
    await expect(workspaceRow).toBeVisible();
    await expect(workspaceRow.getByRole("menuitem", { name: new RegExp(WORKSPACE_NAME) })).toBeVisible();

    let deletePayload: unknown = null;
    await page.route(`**/v1/workspaces/${WORKSPACE_ID}/delete`, (route) => {
      deletePayload = JSON.parse(route.request().postData() ?? "{}");
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

    const deleteButton = workspaceRow.locator(".workspace-menu-delete");
    await deleteButton.click();
    const dialog = page.getByRole("dialog", { name: "Delete workspace" });
    await expect(dialog).toBeVisible();
    const checkbox = dialog.getByTestId("dialog-delete-locator-checkbox");
    await expect(checkbox).not.toBeChecked();
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect.poll(() => deletePayload).toEqual({ delete_locator: false });
    await expect(dialog).toHaveCount(0);
    expect(nativeDialogs).toEqual([]);
  });

  test("delete workspace can also remove files from disk", async ({ page }) => {
    await seedApp(page);
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await openWorkspaceMenu(page);
    const workspaceRow = page.locator(".workspace-menu-row").first();
    await expect(workspaceRow).toBeVisible();

    let deletePayload: unknown = null;
    await page.route(`**/v1/workspaces/${WORKSPACE_ID}/delete`, (route) => {
      deletePayload = JSON.parse(route.request().postData() ?? "{}");
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, workspace_id: WORKSPACE_ID, locator_deleted: true })
      });
    });
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

    await workspaceRow.locator(".workspace-menu-delete").click();
    const dialog = page.getByRole("dialog", { name: "Delete workspace" });
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("dialog-delete-locator-checkbox").check();
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect.poll(() => deletePayload).toEqual({ delete_locator: true });
    await expect(dialog).toHaveCount(0);
    expect(nativeDialogs).toEqual([]);
  });

  test("canceling workspace deletion has no side effects", async ({ page }) => {
    await seedApp(page);
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });

    await openWorkspaceMenu(page);
    const workspaceRow = page.locator(".workspace-menu-row").first();
    let deleteCalls = 0;
    await page.route(`**/v1/workspaces/${WORKSPACE_ID}/delete`, (route) => {
      deleteCalls++;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, workspace_id: WORKSPACE_ID })
      });
    });

    const deleteButton = workspaceRow.locator(".workspace-menu-delete");
    await deleteButton.click();
    const dialog = page.getByRole("dialog", { name: "Delete workspace" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toHaveCount(0);
    await expect(deleteButton).toBeFocused();
    await expect(workspaceRow).toBeVisible();
    expect(deleteCalls).toBe(0);
    expect(nativeDialogs).toEqual([]);
  });
});

test.describe("Spinner behavior", () => {

  test("spinner does not appear when endpoint is idle even with stale streaming turns", async ({ page }) => {
    // Seed with an endpoint that's idle and telemetry with stale visible_output
    const floeEndpointId = `actor:${WORKSPACE_ID}:floe`;

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

    await page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          endpoints: [{
            endpoint_id: floeEndpointId,
            workspace_id: WORKSPACE_ID,
            name: "Floe",
            agent_id: "floe",
            status: "idle"
          }, {
            endpoint_id: `actor:${WORKSPACE_ID}:operator`,
            workspace_id: WORKSPACE_ID,
            name: "Operator",
            status: "online"
          }]
        })
      })
    );

    await page.route(`**/v1/workspaces/${WORKSPACE_ID}/scopes`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          scopes: [{
            scope_id: "default",
            workspace_id: WORKSPACE_ID,
            title: "Default",
            description: null,
            is_default: true,
            created_at: "2026-05-07T12:00:00.000Z",
            updated_at: "2026-05-07T12:00:00.000Z"
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

    await page.route("**/v1/contexts**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ contexts: [] }) })
    );

    // Stale telemetry with visible_output that has no matching response event
    await page.route("**/v1/runtime/telemetry**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          records: [{
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

    await expect(page.getByTestId("v6-topbar").getByRole("button", { name: new RegExp(WORKSPACE_NAME) })).toBeVisible();

    // Open the channel
    const channelToggle = page.locator("button[aria-label='Open actor conversation panel']");
    await channelToggle.click();
    await page.waitForTimeout(500);

    // The "is working" spinner should NOT appear since endpoint is idle
    const thinkingStrip = page.locator(".thinking-strip");
    await expect(thinkingStrip).not.toBeVisible();
  });
});
