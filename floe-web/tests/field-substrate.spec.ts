import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type ScopeProjection
} from "./helpers";

function populatedDefaultProjection(): ScopeProjection {
  return {
    ...emptyScopeProjection("default"),
    refs: {
      contexts: [{
        context_id: "ctx_research",
        workspace_id: WORKSPACE_ID,
        scope_id: "default",
        parent_context_id: null,
        created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
        created_at: "2026-05-24T00:00:00.000Z",
        last_event_at: "2026-05-24T00:02:00.000Z",
        first_message_preview: "Research kickoff"
      }],
      pulses: [{
        pulse_id: "pulse_daily",
        workspace_id: WORKSPACE_ID,
        scope_id: "default",
        persistence: "workspace",
        status: "active",
        trigger: { type: "cron", schedule: "0 9 * * *" },
        next_fire_at: "2026-05-25T09:00:00.000Z",
        last_fired_at: null,
        fire_count: 0,
        created_at: "2026-05-24T00:00:00.000Z",
        updated_at: "2026-05-24T00:00:00.000Z"
      }],
      events: [{
        event_id: "evt_one",
        type: "message",
        workspace_id: WORKSPACE_ID,
        scope_id: "default",
        context_id: "ctx_research",
        source_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
        created_at: "2026-05-24T00:01:00.000Z"
      }],
      activity: [{
        telemetry_id: "tel_one",
        workspace_id: WORKSPACE_ID,
        endpoint_id: `actor:${WORKSPACE_ID}:floe`,
        delivery_id: "delivery_one",
        kind: "BeforeToolUse",
        context_id: "ctx_research",
        event_id: "evt_one",
        created_at: "2026-05-24T00:01:30.000Z"
      }]
    },
    relationships: {
      context_participants: [
        { context_id: "ctx_research", endpoint_id: `actor:${WORKSPACE_ID}:operator` },
        { context_id: "ctx_research", endpoint_id: `actor:${WORKSPACE_ID}:floe` }
      ],
      pulse_subscribers: [
        { pulse_id: "pulse_daily", subscriber: { kind: "context", context_id: "ctx_research" } }
      ],
      event_context_ownership: [
        { event_id: "evt_one", context_id: "ctx_research" }
      ]
    },
    unsupported: [{ kind: "webhook", reason: "webhook refs are not rendered yet" }]
  };
}

test.describe("Field surface as Scope Projection", () => {
  test("lists Scopes as Fields and renders projected substrate refs", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true), makeScope("research", "Research")],
      { default: populatedDefaultProjection(), research: emptyScopeProjection("research") },
      { legacyFieldRequests }
    );

    await expect(page.locator(".field-block", { hasText: "Default" })).toBeVisible();
    await expect(page.locator(".field-block", { hasText: "Research" })).toBeVisible();
    await page.locator(".field-block", { hasText: "Default" }).click();

    await expect(page.getByRole("heading", { name: "Default" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "Research kickoff" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "2 participants" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "pulse_daily" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "message" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "BeforeToolUse" })).toBeVisible();
    await expect(page.locator(".react-flow__edge")).toHaveCount(2);
    await expect(page.getByText("webhook refs are not rendered yet")).toHaveCount(0);
    await expect(page.getByText("Delete field")).toHaveCount(0);
    expect(legacyFieldRequests).toEqual([]);
  });

  test("opens a Context projection node through the existing conversation sidebar", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true)],
      { default: populatedDefaultProjection() },
      { legacyFieldRequests }
    );

    await page.locator(".field-block", { hasText: "Default" }).click();
    await page.locator(".react-flow__node", { hasText: "Research kickoff" }).getByRole("button", { name: "Open" }).click();

    await expect(page.getByText("Actor Conversations")).toBeVisible();
    await expect(page.getByText("Research kickoff")).toBeVisible();
    expect(legacyFieldRequests).toEqual([]);
  });

  test("creates and renames Fields through Scope APIs", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    const scopePosts: string[] = [];
    const scopePatches: string[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true)],
      { default: emptyScopeProjection("default") },
      { legacyFieldRequests, scopePosts, scopePatches }
    );

    await page.getByRole("button", { name: /Add field/i }).click();
    await page.getByLabel("Field name").fill("Planning Scope");
    await page.getByTestId("dialog-layer").getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: "Planning Scope" })).toBeVisible();

    await page.getByRole("button", { name: /Rename field/i }).click();
    await page.getByLabel("Field title").fill("Renamed Planning");
    await page.getByRole("button", { name: "Save rename" }).click();
    await expect(page.getByRole("heading", { name: "Renamed Planning" })).toBeVisible();

    expect(scopePosts.some((body) => body.includes("Planning Scope"))).toBe(true);
    expect(scopePatches.some((body) => body.includes("Renamed Planning"))).toBe(true);
    expect(legacyFieldRequests).toEqual([]);
  });

  test("keeps React Flow pan, zoom, selection and drag on the projection canvas without semantic writes", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true)],
      { default: populatedDefaultProjection() },
      { legacyFieldRequests }
    );

    await page.locator(".field-block", { hasText: "Default" }).click();
    const node = page.locator(".react-flow__node", { hasText: "Research kickoff" });
    await expect(node).toBeVisible();
    const before = await node.boundingBox();
    expect(before).not.toBeNull();

    await node.click();
    await expect(node).toHaveClass(/selected/);
    await page.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await page.mouse.down();
    await page.mouse.move(before!.x + 90, before!.y + 70, { steps: 4 });
    await page.mouse.up();
    const after = await node.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.x - before!.x) + Math.abs(after!.y - before!.y)).toBeGreaterThan(20);
    expect(legacyFieldRequests).toEqual([]);
  });
});
