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

    await expect(page.locator(".scope-card", { hasText: "Default" })).toBeVisible();
    await page.locator(".scope-card", { hasText: "Default" }).click();

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

    await page.getByRole("button", { name: /Add Scope/i }).click();
    await page.getByLabel("Scope name").fill("Planning Scope");
    await page.getByTestId("dialog-layer").getByRole("button", { name: "Create" }).click();
    await expect(page.getByRole("heading", { name: "Planning Scope" })).toBeVisible();

    await page.getByRole("button", { name: /Rename Scope/i }).click();
    await page.getByLabel("Scope title").fill("Renamed Planning");
    await page.getByRole("button", { name: "Save Scope" }).click();
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
      await page.getByRole("button", { name: /Add Scope/i }).click();
      await page.getByLabel("Scope name").fill("Shared Planning");
      await page.getByTestId("dialog-layer").getByRole("button", { name: "Create" }).click();
      await expect(page.getByRole("heading", { name: "Shared Planning" })).toBeVisible();
      await expect(page.getByText("Empty Scope")).toBeVisible();
      await expect(page.getByText(/POST .*scope_already_exists/)).toHaveCount(0);
      await page.getByRole("button", { name: "Workspace Home" }).click();
    }

    await expect(page.locator(".scope-card", { hasText: "Shared Planning" })).toHaveCount(2);
    expect(scopePosts.map((body) => JSON.parse(body))).toEqual([
      { title: "Shared Planning" },
      { title: "Shared Planning" }
    ]);
    expect(legacyFieldRequests).toEqual([]);
  });

  test("persists Scope Projection node positions as renderer layout without semantic Field membership", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    const layoutPuts: string[] = [];
    const projection: ScopeProjection = {
      ...emptyScopeProjection("default"),
      refs: {
        ...emptyScopeProjection("default").refs,
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
        }]
      },
      relationships: {
        context_participants: [
          { context_id: "ctx_research", endpoint_id: `actor:${WORKSPACE_ID}:operator` },
          { context_id: "ctx_research", endpoint_id: `actor:${WORKSPACE_ID}:floe` }
        ],
        pulse_subscribers: [],
        event_context_ownership: []
      }
    };

    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true)],
      { default: projection },
      { legacyFieldRequests, layoutPuts }
    );
    await page.locator(".scope-card", { hasText: "Default" }).click();
    const node = page.locator(`[data-id="context:ctx_research"]`);
    await expect(node).toBeVisible();
    const box = await node.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 180, box!.y + box!.height / 2 + 90, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => layoutPuts.length).toBeGreaterThan(0);
    const saved = JSON.parse(layoutPuts.at(-1) ?? "{}");
    expect(saved.items["context:ctx_research"]).toEqual(expect.objectContaining({
      x: expect.any(Number),
      y: expect.any(Number)
    }));
    expect(legacyFieldRequests).toEqual([]);

    await page.reload();
    await expect(page.locator(".scope-card", { hasText: "Default" })).toBeVisible();
    await page.locator(".scope-card", { hasText: "Default" }).click();
    await expect(node).toBeVisible();
    const style = await node.evaluate((element) => element.getAttribute("style") ?? "");
    const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(style);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeCloseTo(saved.items["context:ctx_research"].x, 0);
    expect(Number(match![2])).toBeCloseTo(saved.items["context:ctx_research"].y, 0);
    expect(legacyFieldRequests).toEqual([]);
  });

  test("connects and disconnects Pulse to Context through Pulse subscriber APIs", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    const pulseSubscribes: string[] = [];
    const pulseUnsubscribes: string[] = [];
    const projection: ScopeProjection = {
      ...emptyScopeProjection("default"),
      refs: {
        ...emptyScopeProjection("default").refs,
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
        }]
      },
      relationships: {
        context_participants: [
          { context_id: "ctx_research", endpoint_id: `actor:${WORKSPACE_ID}:operator` },
          { context_id: "ctx_research", endpoint_id: `actor:${WORKSPACE_ID}:floe` }
        ],
        pulse_subscribers: [],
        event_context_ownership: []
      }
    };

    await seedAppWithScopes(
      page,
      [makeScope("default", "Default", true)],
      { default: projection },
      { legacyFieldRequests, pulseSubscribes, pulseUnsubscribes }
    );
    await page.locator(".scope-card", { hasText: "Default" }).click();
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);

    const pulseHandle = page.locator(`[data-id="pulse:pulse_daily"] .react-flow__handle.source`).first();
    const contextHandle = page.locator(`[data-id="context:ctx_research"] .react-flow__handle.target`).first();
    await expect(pulseHandle).toBeVisible();
    await expect(contextHandle).toBeVisible();
    await expect(pulseHandle).toHaveClass(/connectionindicator/);
    await expect(contextHandle).toHaveClass(/connectionindicator/);
    const pulseCenter = await pulseHandle.evaluate((handle) => {
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const contextCenter = await contextHandle.evaluate((handle) => {
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(pulseCenter.x, pulseCenter.y);
    await page.mouse.down();
    await page.mouse.move(contextCenter.x, contextCenter.y, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => pulseSubscribes.length).toBe(1);
    expect(JSON.parse(pulseSubscribes[0])).toEqual({ kind: "context", context_id: "ctx_research" });
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    const edgePoint = await page.locator(".react-flow__edge-interaction").evaluate((edge) => {
      const path = edge as SVGGeometryElement;
      const midpoint = path.getPointAtLength(path.getTotalLength() / 2);
      const matrix = path.getScreenCTM();
      if (!matrix) throw new Error("Missing edge screen transform");
      return {
        x: midpoint.x * matrix.a + midpoint.y * matrix.c + matrix.e,
        y: midpoint.x * matrix.b + midpoint.y * matrix.d + matrix.f
      };
    });
    await page.mouse.click(edgePoint.x, edgePoint.y);
    await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
    await page.keyboard.press("Backspace");
    await expect.poll(() => pulseUnsubscribes.length).toBe(1);
    expect(JSON.parse(pulseUnsubscribes[0])).toEqual({ kind: "context", context_id: "ctx_research" });
    await expect(page.locator(".react-flow__edge")).toHaveCount(0);
    expect(legacyFieldRequests).toEqual([]);
  });
});
