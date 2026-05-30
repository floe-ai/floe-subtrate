import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type WorkspaceContextRecord
} from "./helpers";

test.describe("Workspace Home Scope assignment", () => {
  test("assigns an unscoped actor Context to a named Scope without Default Scope fallback", async ({ page }) => {
    const createdAt = "2026-05-24T00:00:00.000Z";
    const workspaceContext: WorkspaceContextRecord = {
      context_id: "ctx_direct_planning",
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
      created_at: createdAt,
      last_event_at: createdAt,
      participants: [`actor:${WORKSPACE_ID}:operator`, `actor:${WORKSPACE_ID}:floe`],
      first_message_preview: "Direct planning thread"
    };
    const contextAssignments: string[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_launch", "Launch Scope")],
      { scope_launch: emptyScopeProjection("scope_launch") },
      { workspaceContexts: [workspaceContext], contextAssignments }
    );

    const contextRow = page.locator(".workspace-context-block", { hasText: "Direct planning thread" });
    await expect(contextRow).toBeVisible();
    await expect(contextRow).toContainText("Not assigned to a Scope");
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);

    await expect(contextRow.getByRole("button", { name: "Assign to Scope" })).toBeDisabled();
    await contextRow.getByLabel("Scope for Direct planning thread").selectOption("scope_launch");
    await contextRow.getByRole("button", { name: "Assign to Scope" }).click();

    await expect(contextRow).toHaveCount(0);
    expect(contextAssignments).toEqual([
      JSON.stringify({
        scope_id: "scope_launch",
        assigned_by: `actor:${WORKSPACE_ID}:operator`
      })
    ]);

    await page.getByRole("button", { name: "Launch Scope Scope projection" }).click();
    await expect(page.getByRole("heading", { name: "Launch Scope" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "Direct planning thread" })).toBeVisible();
  });
});
