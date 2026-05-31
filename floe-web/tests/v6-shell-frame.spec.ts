import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test
} from "./helpers";

test.describe("V6 shell frame", () => {
  test("keeps Workspace, Field, inspector, and transitional Channel entry points in the dark shell", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing System")],
      { scope_writing: emptyScopeProjection("scope_writing") },
      { legacyFieldRequests }
    );

    const shell = page.getByTestId("v6-shell");
    await expect(shell).toBeVisible();
    await expect(page.getByTestId("v6-topbar")).toBeVisible();
    await expect(page.getByTestId("v6-left-nav")).toBeVisible();
    await expect(page.getByTestId("v6-main-surface")).toBeVisible();
    await expect(page.getByTestId("v6-inspector")).toBeVisible();

    await expect(page.getByTestId("v6-left-nav").getByRole("button", { name: "Home" })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByText("Activity", { exact: true })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByText("Scopes", { exact: true })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByRole("button", { name: /Writing System/i })).toBeVisible();
    await expect(page.getByTestId("v6-left-nav").getByText("Actors", { exact: true })).toBeVisible();
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);

    const background = await shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--canvas").trim());
    const accent = await shell.evaluate((element) => getComputedStyle(element).getPropertyValue("--accent").trim());
    expect(background).toContain("oklch");
    expect(accent).toContain("oklch");

    await page.getByTestId("v6-left-nav").getByRole("button", { name: /Writing System/i }).click();
    await expect(page.getByRole("heading", { name: "Writing System" })).toBeVisible();
    await expect(page.locator(".react-flow")).toBeVisible();

    await page.getByTestId("v6-left-nav").getByRole("button", { name: "Home" }).click();
    await expect(page.getByRole("heading", { name: "QA Workspace" })).toBeVisible();

    await page.getByRole("button", { name: "Open actor conversation panel" }).click();
    await expect(page.getByTestId("v6-inspector")).toBeVisible();
    await expect(page.getByTestId("v6-channel")).toBeVisible();
    await expect(page.getByTestId("v6-channel").getByText("Actor conversations")).toBeVisible();
    expect(legacyFieldRequests).toEqual([]);
  });
});
