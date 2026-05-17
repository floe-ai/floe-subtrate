/**
 * E2E test: Verifies the full emit flow with a live floe-bus and floe-bridge.
 *
 * Prerequisites:
 * - floe-bus running on 127.0.0.1:5377
 * - floe-bridge running with a configured workspace
 * - floe-web dev server on 127.0.0.1:5173
 *
 * This test connects to the real bus, sends a message via the UI, and verifies
 * the agent's emitted reply appears as a readable message in the chat view.
 */
import { test, expect } from "@playwright/test";

const BUS_URL = "http://127.0.0.1:5377";
const WEB_URL = "http://127.0.0.1:5173";

test.describe("Live emit E2E", () => {
  test.skip(
    !process.env.FLOE_E2E_LIVE,
    "Set FLOE_E2E_LIVE=1 to run live E2E tests (requires bus+bridge+web running)"
  );

  test("agent emitted message appears as readable chat text", async ({ page }) => {
    // Navigate to floe-web
    await page.goto(WEB_URL);

    // Set bus URL in localStorage and reload
    await page.evaluate((busUrl) => {
      localStorage.setItem("floe.busUrl", busUrl);
    }, BUS_URL);
    await page.reload();
    await page.waitForTimeout(1000);

    // Wait for workspace to load (look for workspace name or home view)
    await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 10000 });

    const channelToggle = page.locator("button[aria-label='Open actor conversation panel']");
    if (await channelToggle.count() > 0) {
      await channelToggle.first().click();
      await page.waitForTimeout(500);
    }

    // Type a message in the composer
    const composer = page.locator(".channel-composer input, .channel-composer textarea");
    await expect(composer).toBeVisible({ timeout: 5000 });
    await composer.fill("Say hello briefly.");
    await composer.press("Enter");

    // Wait for the agent response to appear (up to 30s for model API call)
    const agentMessage = page.locator(".channel-message.floe .message-text");
    await expect(agentMessage.first()).toBeVisible({ timeout: 30000 });

    // Verify the response contains actual text (not just a tool call record)
    const text = await agentMessage.first().textContent();
    expect(text).toBeTruthy();
    expect(text!.length).toBeGreaterThan(5);
    // Should NOT contain raw tool call JSON
    expect(text).not.toContain('"type": "function"');
    expect(text).not.toContain("tool_call");
  });

  test("actor listing via delivery context works", async ({ page }) => {
    await page.goto(WEB_URL);
    await page.evaluate((busUrl) => {
      localStorage.setItem("floe.busUrl", busUrl);
    }, BUS_URL);
    await page.reload();
    await page.waitForTimeout(1000);
    await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 10000 });

    const channelToggle = page.locator("button[aria-label='Open actor conversation panel']");
    if (await channelToggle.count() > 0) {
      await channelToggle.first().click();
      await page.waitForTimeout(500);
    }

    const composer = page.locator(".channel-composer input, .channel-composer textarea");
    await expect(composer).toBeVisible({ timeout: 5000 });
    await composer.fill("What actors can you see in this workspace?");
    await composer.press("Enter");

    // Wait for agent response — model should produce a meaningful reply about what it can see
    await expect(agentMessages.last()).toBeVisible({ timeout: 30000 });
    const text = await agentMessages.last().textContent();
    expect(text).toBeTruthy();
    // The response should be non-trivial (agent actually answered)
    expect(text!.length).toBeGreaterThan(10);
  });

  test("multi-turn conversation works", async ({ page }) => {
    await page.goto(WEB_URL);
    await page.evaluate((busUrl) => {
      localStorage.setItem("floe.busUrl", busUrl);
    }, BUS_URL);
    await page.reload();
    await page.waitForTimeout(1000);
    await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 10000 });

    const channelToggle = page.locator("button[aria-label='Open actor conversation panel']");
    if (await channelToggle.count() > 0) {
      await channelToggle.first().click();
      await page.waitForTimeout(500);
    }

    const composer = page.locator(".channel-composer input, .channel-composer textarea");
    await expect(composer).toBeVisible({ timeout: 5000 });

    // First message
    await composer.fill("Remember the number 42.");
    await composer.press("Enter");

    const agentMessages = page.locator(".channel-message.floe .message-text");
    await expect(agentMessages.last()).toBeVisible({ timeout: 30000 });

    // Wait before second message
    await page.waitForTimeout(2000);

    // Second message referencing the first
    await composer.fill("What number did I just tell you?");
    await composer.press("Enter");

    // Wait for the second response
    await page.waitForTimeout(20000);
    const lastText = await agentMessages.last().textContent();
    expect(lastText).toBeTruthy();
    expect(lastText).toContain("42");
  });
});
