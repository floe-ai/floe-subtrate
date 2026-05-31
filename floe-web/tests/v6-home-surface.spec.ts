import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type EndpointRecord,
  type WorkspaceContextRecord
} from "./helpers";

const operatorId = `actor:${WORKSPACE_ID}:operator`;
const floeId = `actor:${WORKSPACE_ID}:floe`;
const reviewerId = `actor:${WORKSPACE_ID}:reviewer`;

test.describe("V6 Workspace Home surface", () => {
  test("keeps Home as a Workspace index while actor selection updates the inspector", async ({ page }) => {
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
      { endpoint_id: floeId, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" },
      { endpoint_id: reviewerId, workspace_id: WORKSPACE_ID, name: "Reviewer", status: "idle", agent_id: "reviewer", metadata_json: "{}" }
    ];
    const contexts: WorkspaceContextRecord[] = [
      {
        context_id: "ctx_direct",
        workspace_id: WORKSPACE_ID,
        scope_id: null,
        parent_context_id: null,
        created_by_endpoint_id: operatorId,
        created_at: "2026-05-24T00:00:00.000Z",
        last_event_at: "2026-05-24T00:01:00.000Z",
        participants: [operatorId, floeId],
        first_message_preview: "Direct planning thread"
      },
      {
        context_id: "ctx_scoped",
        workspace_id: WORKSPACE_ID,
        scope_id: "scope_review",
        parent_context_id: null,
        created_by_endpoint_id: floeId,
        created_at: "2026-05-24T00:02:00.000Z",
        last_event_at: "2026-05-24T00:03:00.000Z",
        participants: [floeId, reviewerId],
        first_message_preview: "Review handoff thread"
      }
    ];
    const projectionGets: string[] = [];
    const legacyFieldRequests: string[] = [];
    const contextEventGets: string[] = [];

    await seedAppWithScopes(
      page,
      [
        makeScope("scope_writing", "Writing System"),
        makeScope("scope_review", "Review Scope")
      ],
      {
        scope_writing: emptyScopeProjection("scope_writing"),
        scope_review: emptyScopeProjection("scope_review")
      },
      { endpoints, workspaceContexts: contexts, projectionGets, legacyFieldRequests, contextEventGets }
    );

    const home = page.getByTestId("v6-workspace-home");
    await expect(home).toBeVisible();
    await expect(home.getByText("Workspace index", { exact: true })).toBeVisible();
    await expect(home.getByTestId("v6-home-scopes").getByRole("button", { name: /Writing System/i })).toBeVisible();
    await expect(home.getByTestId("v6-home-actors").getByRole("button", { name: /Floe/i })).toBeVisible();
    await expect(home.getByTestId("v6-home-contexts")).toContainText("Direct planning thread");
    await expect(home.getByTestId("v6-home-contexts")).toContainText("Workspace-level Context");
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);
    expect(projectionGets).toEqual([]);

    await home.getByTestId("v6-home-actors").getByRole("button", { name: /Floe/i }).click();

    const inspector = page.getByTestId("v6-inspector");
    await expect(inspector.getByRole("heading", { name: "Actor", exact: true })).toBeVisible();
    await expect(inspector).toContainText("Floe");
    await expect(inspector).toContainText(floeId);
    await expect(inspector).toContainText("Direct planning thread");
    await expect(inspector).toContainText("Workspace-level Context");
    await expect(inspector).toContainText("Review handoff thread");
    await expect(inspector).toContainText("Scoped Context · Review Scope");
    await expect(page.getByTestId("v6-channel")).toHaveCount(0);
    await expect(page.locator(".react-flow__node", { hasText: "Floe" })).toHaveCount(0);
    expect(contextEventGets).toEqual([]);
    expect(projectionGets).toEqual([]);
    expect(legacyFieldRequests).toEqual([]);
  });
});
