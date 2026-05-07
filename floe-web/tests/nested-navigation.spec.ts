import { expect } from "@playwright/test";
import { test, seedApp, makeField, makeFieldNode } from "./helpers";

function buildThreeLevelHierarchy() {
  const parentNode = makeFieldNode("node_p", "field_p", "Parent", { x: 200, y: 150 });
  const childNode = makeFieldNode("node_c", "field_c", "Child", { x: 200, y: 150 });

  const grandparentField = makeField("field_gp", "Grandparent", undefined, [parentNode]);
  const parentField = makeField("field_p", "Parent", "field_gp", [childNode]);
  const childField = makeField("field_c", "Child", "field_p");

  return [childField, parentField, grandparentField];
}

test.describe("Nested field navigation", () => {
  test("back button from nested field goes to parent, not workspace home", async ({ page }) => {
    await seedApp(page, buildThreeLevelHierarchy());

    // Open grandparent from home
    await page.dblclick(".field-block");
    await page.waitForTimeout(500);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Grandparent");

    // Double-click parent node on canvas
    await page.dblclick(".canvas-field-node");
    await page.waitForTimeout(500);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Parent");

    // Double-click child node on canvas
    await page.dblclick(".canvas-field-node");
    await page.waitForTimeout(500);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Child");

    // Click back → should go to Parent
    await page.click(".field-toolbar .icon-button");
    await page.waitForTimeout(400);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Parent");

    // Click back → should go to Grandparent
    await page.click(".field-toolbar .icon-button");
    await page.waitForTimeout(400);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Grandparent");

    // Click back → should be at workspace home
    await page.click(".field-toolbar .icon-button");
    await page.waitForTimeout(400);
    await expect(page.locator(".workspace-home")).toBeVisible();
  });

  test("breadcrumb shows full ancestor chain and is clickable", async ({ page }) => {
    await seedApp(page, buildThreeLevelHierarchy());

    // Navigate to the deepest child: home → grandparent → parent → child
    await page.dblclick(".field-block");
    await page.waitForTimeout(500);
    await page.dblclick(".canvas-field-node");
    await page.waitForTimeout(500);
    await page.dblclick(".canvas-field-node");
    await page.waitForTimeout(500);

    // Verify breadcrumb segments: Workspace > Grandparent > Parent > Child
    const breadcrumbButtons = page.locator(".breadcrumb button");
    const count = await breadcrumbButtons.count();
    expect(count).toBe(4);
    await expect(breadcrumbButtons.nth(0)).toContainText("Workspace");
    await expect(breadcrumbButtons.nth(1)).toContainText("Grandparent");
    await expect(breadcrumbButtons.nth(2)).toContainText("Parent");
    await expect(breadcrumbButtons.nth(3)).toContainText("Child");

    // Click "Grandparent" breadcrumb → should jump to grandparent surface
    await breadcrumbButtons.nth(1).click();
    await page.waitForTimeout(400);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Grandparent");

    // Breadcrumb should now show only: Workspace > Grandparent
    const updatedButtons = page.locator(".breadcrumb button");
    const updatedCount = await updatedButtons.count();
    expect(updatedCount).toBe(2);
    await expect(updatedButtons.nth(0)).toContainText("Workspace");
    await expect(updatedButtons.nth(1)).toContainText("Grandparent");
  });

  test("back button from top-level field goes to workspace home", async ({ page }) => {
    const topField = makeField("field_top", "TopLevel");
    await seedApp(page, [topField]);

    // Open the top-level field
    await page.dblclick(".field-block");
    await page.waitForTimeout(500);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("TopLevel");

    // Click back → should go to workspace home
    await page.click(".field-toolbar .icon-button");
    await page.waitForTimeout(400);
    await expect(page.locator(".workspace-home")).toBeVisible();
  });

  test("double-clicking a nested node opens that child field surface", async ({ page }) => {
    const childNode = makeFieldNode("node_c", "field_c", "Child", { x: 200, y: 150 });
    const parentField = makeField("field_p", "Parent", undefined, [childNode]);
    const childField = makeField("field_c", "Child", "field_p");

    await seedApp(page, [childField, parentField]);

    // Open parent from home
    await page.dblclick(".field-block");
    await page.waitForTimeout(500);
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Parent");

    // Double-click the child's canvas node
    await page.dblclick(".canvas-field-node");
    await page.waitForTimeout(500);

    // Should now be on child surface
    expect(await page.locator(".field-toolbar h2").textContent()).toBe("Child");

    // Breadcrumb should show parent in chain
    const breadcrumbButtons = page.locator(".breadcrumb button");
    await expect(breadcrumbButtons.nth(1)).toContainText("Parent");
  });
});
