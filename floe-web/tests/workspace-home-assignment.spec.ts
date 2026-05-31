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
  test("creates a named Scope inline and assigns the Workspace-level Context to it", async ({ page }) => {
    const createdAt = "2026-05-24T00:00:00.000Z";
    const workspaceContext: WorkspaceContextRecord = {
      context_id: "ctx_inline_scope",
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
      created_at: createdAt,
      last_event_at: createdAt,
      participants: [`actor:${WORKSPACE_ID}:operator`, `actor:${WORKSPACE_ID}:floe`],
      first_message_preview: "Inline assignment thread"
    };
    const scopePosts: string[] = [];
    const contextAssignments: string[] = [];

    await seedAppWithScopes(
      page,
      [],
      {},
      { workspaceContexts: [workspaceContext], scopePosts, contextAssignments }
    );

    const contextRow = page.locator(".workspace-context-block", { hasText: "Inline assignment thread" });
    await expect(contextRow).toBeVisible();
    await expect(contextRow.getByRole("button", { name: "Assign to Scope" })).toBeDisabled();

    await contextRow.getByRole("button", { name: "Create Scope and assign" }).click();
    await page.getByLabel("Scope name").fill("Research Sprint");
    await page.getByRole("dialog").getByRole("button", { name: "Create Scope and assign" }).click();

    await expect(contextRow).toHaveCount(0);
    expect(scopePosts).toEqual([JSON.stringify({ title: "Research Sprint" })]);
    expect(contextAssignments).toEqual([
      JSON.stringify({
        scope_id: "scope_1",
        assigned_by: `actor:${WORKSPACE_ID}:operator`
      })
    ]);
    await expect(page.getByRole("heading", { name: "Research Sprint" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "Inline assignment thread" })).toBeVisible();
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);
  });

  test("does not create or assign an inline Scope without a name", async ({ page }) => {
    const createdAt = "2026-05-24T00:00:00.000Z";
    const workspaceContext: WorkspaceContextRecord = {
      context_id: "ctx_blank_scope",
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
      created_at: createdAt,
      last_event_at: createdAt,
      participants: [`actor:${WORKSPACE_ID}:operator`, `actor:${WORKSPACE_ID}:floe`],
      first_message_preview: "Blank scope thread"
    };
    const scopePosts: string[] = [];
    const contextAssignments: string[] = [];

    await seedAppWithScopes(
      page,
      [],
      {},
      { workspaceContexts: [workspaceContext], scopePosts, contextAssignments }
    );

    const contextRow = page.locator(".workspace-context-block", { hasText: "Blank scope thread" });
    await contextRow.getByRole("button", { name: "Create Scope and assign" }).click();
    await page.getByLabel("Scope name").fill("   ");
    await page.getByRole("dialog").getByRole("button", { name: "Create Scope and assign" }).click();

    await expect(page.getByRole("alert")).toHaveText("Enter a Scope name.");
    await expect(contextRow).toBeVisible();
    expect(scopePosts).toEqual([]);
    expect(contextAssignments).toEqual([]);
  });

  test("does not create or assign an inline Scope with Default product language", async ({ page }) => {
    const createdAt = "2026-05-24T00:00:00.000Z";
    const workspaceContext: WorkspaceContextRecord = {
      context_id: "ctx_default_scope",
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
      created_at: createdAt,
      last_event_at: createdAt,
      participants: [`actor:${WORKSPACE_ID}:operator`, `actor:${WORKSPACE_ID}:floe`],
      first_message_preview: "Default language thread"
    };
    const scopePosts: string[] = [];
    const contextAssignments: string[] = [];

    await seedAppWithScopes(
      page,
      [],
      {},
      { workspaceContexts: [workspaceContext], scopePosts, contextAssignments }
    );

    const contextRow = page.locator(".workspace-context-block", { hasText: "Default language thread" });
    await contextRow.getByRole("button", { name: "Create Scope and assign" }).click();

    for (const reservedName of ["Default", "Default Scope", "Default Field"]) {
      await page.getByLabel("Scope name").fill(reservedName);
      await page.getByRole("dialog").getByRole("button", { name: "Create Scope and assign" }).click();
      await expect(page.getByRole("alert")).toHaveText("Choose a named Scope that is not Default.");
    }

    await expect(contextRow).toBeVisible();
    expect(scopePosts).toEqual([]);
    expect(contextAssignments).toEqual([]);
  });

  test("does not assign when inline Scope creation fails", async ({ page }) => {
    const createdAt = "2026-05-24T00:00:00.000Z";
    const workspaceContext: WorkspaceContextRecord = {
      context_id: "ctx_scope_create_failure",
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
      created_at: createdAt,
      last_event_at: createdAt,
      participants: [`actor:${WORKSPACE_ID}:operator`, `actor:${WORKSPACE_ID}:floe`],
      first_message_preview: "Creation failure thread"
    };
    const scopePosts: string[] = [];
    const contextAssignments: string[] = [];

    await seedAppWithScopes(
      page,
      [],
      {},
      {
        workspaceContexts: [workspaceContext],
        scopePosts,
        contextAssignments,
        scopePostFailure: { status: 500, body: { error: "scope_post_failed" } }
      }
    );

    const contextRow = page.locator(".workspace-context-block", { hasText: "Creation failure thread" });
    await contextRow.getByRole("button", { name: "Create Scope and assign" }).click();
    await page.getByLabel("Scope name").fill("Broken Sprint");
    await page.getByRole("dialog").getByRole("button", { name: "Create Scope and assign" }).click();

    await expect(page.getByRole("alert")).toContainText("scope_post_failed");
    await expect(contextRow).toBeVisible();
    expect(scopePosts).toEqual([JSON.stringify({ title: "Broken Sprint" })]);
    expect(contextAssignments).toEqual([]);
  });

  test("keeps a created Scope visible when inline assignment fails", async ({ page }) => {
    const createdAt = "2026-05-24T00:00:00.000Z";
    const workspaceContext: WorkspaceContextRecord = {
      context_id: "ctx_assignment_failure",
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: `actor:${WORKSPACE_ID}:operator`,
      created_at: createdAt,
      last_event_at: createdAt,
      participants: [`actor:${WORKSPACE_ID}:operator`, `actor:${WORKSPACE_ID}:floe`],
      first_message_preview: "Assignment failure thread"
    };
    const scopePosts: string[] = [];
    const contextAssignments: string[] = [];

    await seedAppWithScopes(
      page,
      [],
      {},
      {
        workspaceContexts: [workspaceContext],
        scopePosts,
        contextAssignments,
        contextAssignmentFailure: { status: 404, body: { error: "scope_not_found" } }
      }
    );

    const contextRow = page.locator(".workspace-context-block", { hasText: "Assignment failure thread" });
    await contextRow.getByRole("button", { name: "Create Scope and assign" }).click();
    await page.getByLabel("Scope name").fill("Retry Sprint");
    await page.getByRole("dialog").getByRole("button", { name: "Create Scope and assign" }).click();

    await expect(page.getByRole("alert")).toHaveText("That Scope no longer exists. Refresh Workspace Home and choose another Scope.");
    await expect(contextRow).toBeVisible();
    await expect(page.getByTestId("v6-home-scopes").getByRole("button", { name: /Retry Sprint/ })).toBeVisible();
    expect(scopePosts).toEqual([JSON.stringify({ title: "Retry Sprint" })]);
    expect(contextAssignments).toEqual([
      JSON.stringify({
        scope_id: "scope_1",
        assigned_by: `actor:${WORKSPACE_ID}:operator`
      })
    ]);
  });

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

    await expect(page.getByRole("heading", { name: "Launch Scope" })).toBeVisible();
    await expect(page.locator(".react-flow__node", { hasText: "Direct planning thread" })).toBeVisible();
  });
});
