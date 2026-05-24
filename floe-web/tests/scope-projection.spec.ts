import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type ScopeProjection
} from "./helpers";

test.describe("Scope Projection Fields", () => {
  test("lists and opens Scopes as Fields without legacy Field endpoint calls", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    const projection: ScopeProjection = {
      ...emptyScopeProjection("default"),
      refs: {
        contexts: [{
          context_id: "ctx_research",
          workspace_id: WORKSPACE_ID,
          scope_id: "default",
          parent_context_id: null,
          created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
          created_at: "2026-05-24T00:00:00.000Z",
          last_event_at: "2026-05-24T00:01:00.000Z",
          first_message_preview: "Research kickoff"
        }],
        pulses: [{
          pulse_id: "pulse_daily",
          workspace_id: WORKSPACE_ID,
          scope_id: "default",
          persistence: "workspace",
          status: "active",
          trigger: { type: "cron", schedule: "0 9 * * *" },
          next_fire_at: null,
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
      unsupported: [{ kind: "webhook", reason: "not rendered yet" }]
    };

    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true), makeScope("research", "Research")],
      {
        default: projection,
        research: emptyScopeProjection("research")
      },
      { legacyFieldRequests }
    );

    await expect(page.locator(".field-block", { hasText: "Default" })).toBeVisible();
    await page.locator(".field-block", { hasText: "Default" }).click();

    await expect(page.locator(".react-flow__node", { hasText: "Research kickoff" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "2 participants" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "pulse_daily" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "message" })).toHaveCount(0);
    await expect(page.locator(".react-flow__node", { hasText: "BeforeToolUse" })).toHaveCount(0);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
    await expect(page.getByText("not rendered yet")).toHaveCount(0);
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
    expect(scopePosts.map((body) => JSON.parse(body))).toContainEqual({ title: "Planning Scope" });
    expect(scopePatches.some((body) => body.includes("Renamed Planning"))).toBe(true);
    expect(legacyFieldRequests).toEqual([]);
  });

  test("allows duplicate Field titles by using bus-generated Scope ids", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    const scopePosts: string[] = [];
    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true)],
      { default: emptyScopeProjection("default") },
      { legacyFieldRequests, scopePosts }
    );

    for (const _ of [0, 1]) {
      await page.getByRole("button", { name: /Add field/i }).click();
      await page.getByLabel("Field name").fill("Shared Planning");
      await page.getByTestId("dialog-layer").getByRole("button", { name: "Create" }).click();
      await expect(page.getByRole("heading", { name: "Shared Planning" })).toBeVisible();
      await expect(page.getByText("Empty Field")).toBeVisible();
      await expect(page.getByText(/POST .*scope_already_exists/)).toHaveCount(0);
      await page.getByRole("button", { name: "Workspace Home" }).click();
    }

    await expect(page.locator(".field-block", { hasText: "Shared Planning" })).toHaveCount(2);
    expect(scopePosts.map((body) => JSON.parse(body))).toEqual([
      { title: "Shared Planning" },
      { title: "Shared Planning" }
    ]);
    expect(legacyFieldRequests).toEqual([]);
  });
});
