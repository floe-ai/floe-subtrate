import { expect } from "@playwright/test";
import {
  test,
  seedApp,
  seedAppWithFields,
  makeFieldSemantic,
  WORKSPACE_ID
} from "./helpers";

test.describe("Field substrate (slice 1)", () => {
  test("lists existing substrate fields from the bus", async ({ page }) => {
    const semantic = makeFieldSemantic(
      "inbound-pr-review",
      "Inbound PR Review",
      [
        { item_id: "i1", ref: "actor:floe" },
        { item_id: "i2", ref: "context:default" },
        { item_id: "i3", ref: "pulse:nightly" }
      ],
      [
        { id: "c1", from: "i1", to: "i2" },
        { id: "c2", from: "i2", to: "i3" }
      ]
    );

    await seedAppWithFields(page, [{ semantic }]);

    const card = page.locator(".field-block", { hasText: "Inbound PR Review" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("3 items");
  });

  test("empty workspace shows empty-state instead of field cards", async ({ page }) => {
    await seedAppWithFields(page, []);

    await expect(page.locator(".field-block")).toHaveCount(0);
    await expect(page.getByText("No Fields yet")).toBeVisible();
  });

  test("opens a field and renders items as ReactFlow nodes", async ({ page }) => {
    const semantic = makeFieldSemantic(
      "two-items",
      "Two Items",
      [
        { item_id: "n1", ref: "actor:floe" },
        { item_id: "n2", ref: "context:default" }
      ]
    );

    await seedAppWithFields(page, [{ semantic }]);
    await page.locator(".field-block", { hasText: "Two Items" }).click();

    const nodes = page.locator(".react-flow__node");
    await expect(nodes).toHaveCount(2);
    const text = await nodes.allInnerTexts();
    const joined = text.join("|");
    expect(joined).toContain("floe");
    expect(joined).toContain("default");
  });

  test("opens a field and renders connections as edges", async ({ page }) => {
    const semantic = makeFieldSemantic(
      "with-edge",
      "With Edge",
      [
        { item_id: "n1", ref: "actor:floe" },
        { item_id: "n2", ref: "context:default" }
      ],
      [{ id: "e1", from: "n1", to: "n2" }]
    );

    await seedAppWithFields(page, [{ semantic }]);
    await page.locator(".field-block", { hasText: "With Edge" }).click();

    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  });

  test("create field — sends PUT and the new field appears in the list", async ({ page }) => {
    await seedAppWithFields(page, []);

    page.once("dialog", (dialog) => {
      void dialog.accept("My New Field");
    });

    const putWait = page.waitForRequest((request) =>
      request.method() === "PUT" &&
      request.url().includes(`/v1/workspaces/${WORKSPACE_ID}/fields/my-new-field`)
    );

    await page.getByRole("button", { name: /Add field/i }).click();

    const request = await putWait;
    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.id).toBe("my-new-field");
    expect(body.title).toBe("My New Field");

    // After creation the app opens the new field directly. Go back home, then
    // confirm the list reflects what the helper now has in its in-memory map.
    await page.getByRole("button", { name: /Workspace Home/i }).click();
    await expect(
      page.locator(".field-block", { hasText: "My New Field" })
    ).toBeVisible();
  });

  test("delete field — sends DELETE and field disappears", async ({ page }) => {
    const semantic = makeFieldSemantic("foo-field", "Foo");
    await seedAppWithFields(page, [{ semantic }]);

    // Open it
    await page.locator(".field-block", { hasText: "Foo" }).click();

    page.on("dialog", (dialog) => { void dialog.accept(); });

    const deleteWait = page.waitForRequest((request) =>
      request.method() === "DELETE" &&
      request.url().includes(`/v1/workspaces/${WORKSPACE_ID}/fields/foo-field`)
    );

    await page.getByRole("button", { name: /Delete field/i }).click();
    await deleteWait;

    // Returned to home with empty field list
    await expect(page.locator(".field-block")).toHaveCount(0);
    await expect(page.getByText("No Fields yet")).toBeVisible();
  });

  // App selects fields via in-memory `view` state only; there's no deep-link
  // URL routing for ?field=... in Wave C1. Skip until a routing layer exists.
  test.skip("non-existent field shows nothing (or empty canvas)", async () => {
    // intentionally skipped: no deep-link routing in current main.tsx
  });

  test("seedApp (default) still boots cleanly with no fields", async ({ page }) => {
    await seedApp(page);
    await expect(page.locator(".field-block")).toHaveCount(0);
  });
});
