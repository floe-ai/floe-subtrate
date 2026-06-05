import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test
} from "./helpers";

test.describe("V6 shell frame", () => {
  test("uses the v6 skeleton shell instead of the legacy hybrid frame", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing System")],
      { scope_writing: emptyScopeProjection("scope_writing") },
      { legacyFieldRequests }
    );

    const shell = page.getByTestId("v6-shell");
    await expect(shell).toBeVisible();
    await expect(shell.locator(":scope > [data-testid='v6-topbar']")).toBeVisible();
    await expect(shell.getByTestId("v6-left-nav")).toBeVisible();
    await expect(shell.getByTestId("v6-main-surface")).toBeVisible();
    await expect(shell.getByTestId("v6-inspector")).toBeVisible();

    await expect(page.getByTestId("v6-left-nav").getByRole("button", { name: "Home" })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByText("Activity", { exact: true })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByText("Scopes", { exact: true })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByRole("button", { name: /Writing System/i })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByText("Actors", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("v6-channel")).toHaveCount(0);
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);

    const mainWidth = await page.getByTestId("v6-main-surface").evaluate((element) => element.getBoundingClientRect().width);
    const leftNavWidth = await page.getByTestId("v6-left-nav").evaluate((element) => element.getBoundingClientRect().width);
    const inspectorWidth = await page.getByTestId("v6-inspector").evaluate((element) => element.getBoundingClientRect().width);
    expect(mainWidth).toBeGreaterThan(600);
    expect(leftNavWidth).toBeGreaterThan(220);
    expect(inspectorWidth).toBeGreaterThan(280);

    const background = await shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--canvas").trim());
    const accent = await shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--accent").trim());
    expect(background).toContain("hsl");
    expect(accent).toBeTruthy();

    await page.getByTestId("v6-left-nav").getByRole("button", { name: /Writing System/i }).click();
    await expect(page.getByRole("heading", { name: "Writing System" })).toBeVisible();
    await expect(page.getByTestId("v6-scope-stage-header")).toContainText("Scope Map");
    await expect(page.locator(".react-flow")).toBeVisible();

    await page.getByTestId("v6-left-nav").getByRole("button", { name: "Home" }).click();
    await expect(page.getByRole("heading", { name: "QA Workspace" })).toBeVisible();
    expect(legacyFieldRequests).toEqual([]);
  });
});
