import { expect } from "@playwright/test";
import { test, seedApp, makeField, makeFieldNode, WORKSPACE_ID } from "./helpers";

test.describe("Inspector name input reflects current selection", () => {
  test("selecting a nested Field shows its name, not the parent name", async ({ page }) => {
    const childFieldId = "field_child_1";
    const childNode = makeFieldNode("node_c1", childFieldId, "Child Alpha", { x: 200, y: 150 });
    const parentField = makeField("field_parent", "Parent Root", undefined, [childNode]);
    const childField = makeField(childFieldId, "Child Alpha", "field_parent");

    await seedApp(page, [childField, parentField]);

    // Open the parent field surface
    await page.locator(".field-block").first().dblclick();
    await page.waitForTimeout(400);

    // Select the child node on canvas
    const canvasNode = page.locator(".canvas-field-node").first();
    await canvasNode.click();
    await page.waitForTimeout(300);

    // Inspector should show the child field name
    const nameInput = page.locator(".inspector input").first();
    await expect(nameInput).toHaveValue("Child Alpha");
  });

  test("switching selection between two nested Fields updates the input", async ({ page }) => {
    const child1Id = "field_c1";
    const child2Id = "field_c2";
    const node1 = makeFieldNode("node_1", child1Id, "First Child", { x: 100, y: 100 });
    const node2 = makeFieldNode("node_2", child2Id, "Second Child", { x: 300, y: 100 });
    const parentField = makeField("field_parent", "Parent", undefined, [node1, node2]);
    const childField1 = makeField(child1Id, "First Child", "field_parent");
    const childField2 = makeField(child2Id, "Second Child", "field_parent");

    await seedApp(page, [childField1, childField2, parentField]);

    // Open parent field
    await page.locator(".field-block").first().dblclick();
    await page.waitForTimeout(400);

    // Select first child
    const nodes = page.locator(".canvas-field-node");
    await nodes.first().click();
    await page.waitForTimeout(300);

    const nameInput = page.locator(".inspector input").first();
    await expect(nameInput).toHaveValue("First Child");

    // Select second child
    await nodes.nth(1).click();
    await page.waitForTimeout(300);

    await expect(nameInput).toHaveValue("Second Child");
  });
});

test.describe("Renaming a nested Field updates the canvas node label", () => {
  test("canvas node label updates after rename via inspector", async ({ page }) => {
    const childFieldId = "field_child_rename";
    const childNode = makeFieldNode("node_rename", childFieldId, "Original Name", { x: 200, y: 150 });
    const parentField = makeField("field_parent_r", "Parent Field", undefined, [childNode]);
    const childField = makeField(childFieldId, "Original Name", "field_parent_r");

    await seedApp(page, [childField, parentField]);

    // Open parent field
    await page.locator(".field-block").first().dblclick();
    await page.waitForTimeout(400);

    // Select child node
    await page.locator(".canvas-field-node").first().click();
    await page.waitForTimeout(300);

    // Rename via inspector input
    const nameInput = page.locator(".inspector input").first();
    await nameInput.fill("Renamed Child");
    await nameInput.blur();
    await page.waitForTimeout(300);

    // Canvas node label should update
    const nodeLabel = page.locator(".canvas-field-node span").first();
    await expect(nodeLabel).toHaveText("Renamed Child");
  });

  test("rename persists to localStorage", async ({ page }) => {
    const childFieldId = "field_child_persist";
    const childNode = makeFieldNode("node_persist", childFieldId, "Before Rename", { x: 200, y: 150 });
    const parentField = makeField("field_parent_p", "Persist Parent", undefined, [childNode]);
    const childField = makeField(childFieldId, "Before Rename", "field_parent_p");

    await seedApp(page, [childField, parentField]);

    // Open parent field
    await page.locator(".field-block").first().dblclick();
    await page.waitForTimeout(400);

    // Select and rename
    await page.locator(".canvas-field-node").first().click();
    await page.waitForTimeout(300);
    const nameInput = page.locator(".inspector input").first();
    await nameInput.fill("After Rename");
    await nameInput.blur();
    await page.waitForTimeout(500);

    // Check localStorage
    const stored = await page.evaluate((wsId) => {
      const raw = localStorage.getItem(`floe.web.local-fields.${wsId}`);
      return raw ? JSON.parse(raw) : null;
    }, WORKSPACE_ID);

    const renamedField = stored?.find((f: { id: string }) => f.id === childFieldId);
    expect(renamedField?.name).toBe("After Rename");

    // Check that parent node label also updated
    const parentInStorage = stored?.find((f: { id: string }) => f.id === "field_parent_p");
    const nodeInParent = parentInStorage?.nodes?.find((n: { id: string }) => n.id === "node_persist");
    expect(nodeInParent?.data?.label).toBe("After Rename");
  });
});

test.describe("Field icons are consistent across UI areas", () => {
  test("home field list and canvas node use the same icon", async ({ page }) => {
    const childFieldId = "field_icon_test";
    const childNode = makeFieldNode("node_icon", childFieldId, "Icon Field", { x: 200, y: 150 });
    const parentField = makeField("field_parent_icon", "Icon Parent", undefined, [childNode]);
    const childField = makeField(childFieldId, "Icon Field", "field_parent_icon");

    await seedApp(page, [childField, parentField]);

    // Get the SVG class/content in the home field list
    const homeIcon = page.locator(".field-block .field-icon svg").first();
    const homeIconTag = await homeIcon.evaluate((el) => el.querySelector("rect, path, polyline, line")?.tagName ?? "");

    // Open field and check canvas node icon
    await page.locator(".field-block").first().dblclick();
    await page.waitForTimeout(400);

    const canvasIcon = page.locator(".canvas-field-node svg").first();
    const canvasIconTag = await canvasIcon.evaluate((el) => el.querySelector("rect, path, polyline, line")?.tagName ?? "");

    // Both should use the same icon element structure (both are LayoutPanelLeft)
    expect(homeIconTag).toBe(canvasIconTag);
    expect(homeIconTag).not.toBe("");
  });

  test("library card icon matches canvas and home list icons", async ({ page }) => {
    const parentField = makeField("field_lib_test", "Library Test", undefined, []);
    await seedApp(page, [parentField]);

    // Get library icon SVG children (path data)
    const libraryIcon = page.locator(".library-card-icon svg").first();
    const libraryPaths = await libraryIcon.evaluate((el) =>
      Array.from(el.querySelectorAll("rect, path, polyline, line")).map((e) => e.tagName).join(",")
    );

    // Get home field list icon SVG children
    await page.waitForSelector(".field-block .field-icon svg", { timeout: 5000 });
    const homeIcon = page.locator(".field-block .field-icon svg").first();
    const homePaths = await homeIcon.evaluate((el) =>
      Array.from(el.querySelectorAll("rect, path, polyline, line")).map((e) => e.tagName).join(",")
    );

    // Icons should have the same structure (same Lucide icon renders same SVG paths)
    expect(libraryPaths).toBe(homePaths);
  });
});
