import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type EndpointRecord,
  type ScopeProjection
} from "./helpers";

const operatorId = `actor:${WORKSPACE_ID}:operator`;
const floeId = `actor:${WORKSPACE_ID}:floe`;
const piId = `actor:${WORKSPACE_ID}:pi`;

function writingProjection(): ScopeProjection {
  return {
    ...emptyScopeProjection("scope_writing"),
    refs: {
      contexts: [
        {
          context_id: "ctx_drafting",
          workspace_id: WORKSPACE_ID,
          scope_id: "scope_writing",
          parent_context_id: null,
          created_by_endpoint_id: operatorId,
          created_at: "2026-05-24T00:00:00.000Z",
          last_event_at: "2026-05-24T01:00:00.000Z",
          first_message_preview: "Drafting outline"
        },
        {
          context_id: "ctx_snippet_review",
          workspace_id: WORKSPACE_ID,
          scope_id: "scope_writing",
          parent_context_id: null,
          created_by_endpoint_id: floeId,
          created_at: "2026-05-24T00:00:00.000Z",
          last_event_at: "2026-05-24T01:05:00.000Z",
          first_message_preview: "Snippet review · with Floe"
        }
      ],
      pulses: [
        {
          pulse_id: "pulse_30m_nudge",
          workspace_id: WORKSPACE_ID,
          scope_id: "scope_writing",
          persistence: "workspace",
          status: "active",
          trigger: { type: "cron", schedule: "*/30 * * * *" },
          next_fire_at: "2026-05-24T01:30:00.000Z",
          last_fired_at: "2026-05-24T01:00:00.000Z",
          fire_count: 4,
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        }
      ],
      events: [
        {
          event_id: "evt_30m",
          type: "pulse.fired",
          workspace_id: WORKSPACE_ID,
          scope_id: "scope_writing",
          context_id: "ctx_drafting",
          source_endpoint_id: null,
          created_at: "2026-05-24T01:00:00.000Z"
        }
      ],
      activity: []
    },
    relationships: {
      context_participants: [
        { context_id: "ctx_drafting", endpoint_id: operatorId },
        { context_id: "ctx_drafting", endpoint_id: floeId },
        { context_id: "ctx_snippet_review", endpoint_id: operatorId },
        { context_id: "ctx_snippet_review", endpoint_id: piId }
      ],
      pulse_subscribers: [
        { pulse_id: "pulse_30m_nudge", subscriber: { kind: "context", context_id: "ctx_drafting" } }
      ],
      event_context_ownership: [
        { event_id: "evt_30m", context_id: "ctx_drafting" }
      ]
    },
    unsupported: []
  };
}

test.describe("V6 Scope Field map", () => {
  test("renders a named Scope as a v6 React Flow map without legacy Field ownership", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    const projectionGets: string[] = [];
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Producer", status: "online", metadata_json: "{}" },
      { endpoint_id: floeId, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" },
      { endpoint_id: piId, workspace_id: WORKSPACE_ID, name: "Pi", status: "idle", agent_id: "pi", metadata_json: "{}" }
    ];

    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Daily drafting")],
      { scope_writing: writingProjection() },
      { endpoints, legacyFieldRequests, projectionGets }
    );

    await page.getByTestId("v6-home-scopes").getByRole("button", { name: /Daily drafting/ }).click();

    const field = page.getByTestId("v6-scope-field-map");
    await expect(field).toBeVisible();
    await expect(page.getByTestId("v6-topbar")).toContainText("Daily drafting");
    await expect(page.getByRole("group", { name: "Scope mode" })).toContainText("Map");
    await expect(page.getByRole("group", { name: "Scope mode" })).toContainText("Ops");
    await expect(page.getByRole("button", { name: "Ops" })).toBeDisabled();
    await expect(page.getByText("Block Library")).toHaveCount(0);

    await expect(page.getByTestId("v6-scope-contexts")).toContainText("Drafting outline");
    await expect(page.getByTestId("v6-scope-contexts")).toContainText("Snippet review · with Floe");
    await expect(field.locator(".react-flow")).toBeVisible();
    await expect(field.locator(".react-flow__node", { hasText: "Drafting outline" })).toBeVisible();
    await expect(field.locator(".canvas-field-node[data-kind='pulse']", { hasText: "pulse_30m_nudge" })).toBeVisible();
    await expect(field.locator(".react-flow__handle.connectionindicator")).not.toHaveCount(0);
    await expect(field.getByTestId("v6-scope-map-legend")).toContainText("cron");
    await expect(field.getByTestId("v6-scope-map-legend")).toContainText("webhook");
    await expect(field.getByTestId("v6-scope-map-legend")).toContainText("file-watch");
    await expect(field.getByTestId("v6-scope-map-legend")).toContainText("manual");

    const inspector = page.getByTestId("v6-inspector");
    await expect(inspector.getByRole("heading", { name: "Scope" })).toBeVisible();
    await expect(inspector).toContainText("Daily drafting");
    await expect(inspector).toContainText("Contexts");
    await expect(inspector).toContainText("Events");
    await expect(inspector).toContainText("Actors");
    expect(legacyFieldRequests).toEqual([]);
    expect(projectionGets.some((url) => url.includes("/scopes/scope_writing/projection"))).toBe(true);
  });

  test("keeps the Scope creation drag affordance on the v6 map without semantic Field ownership", async ({ page }) => {
    const legacyFieldRequests: string[] = [];
    const scopePosts: string[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Daily drafting")],
      { scope_writing: writingProjection() },
      { legacyFieldRequests, scopePosts }
    );

    await page.getByTestId("v6-home-scopes").getByRole("button", { name: /Daily drafting/ }).click();
    await page.getByRole("button", { name: "New Scope" }).dragTo(page.getByTestId("v6-scope-field-map").locator(".react-flow"));

    await expect(page.getByRole("dialog", { name: "New Scope" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Enter a Scope name.")).toBeVisible();
    expect(scopePosts).toEqual([]);

    await page.getByLabel("Scope name").fill("Companion Scope");
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("heading", { name: "Companion Scope" })).toBeVisible();
    expect(scopePosts.map((body) => JSON.parse(body))).toContainEqual({ title: "Companion Scope" });
    expect(legacyFieldRequests).toEqual([]);
  });
});
