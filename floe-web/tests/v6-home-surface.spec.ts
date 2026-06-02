import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type EndpointRecord,
  type EventRecord,
  type TelemetryRecord,
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
    await expect(home.locator(":scope > .hero")).toBeVisible();
    await expect(home.locator(":scope > .ws-settings")).toBeVisible();
    await expect(home.getByTestId("v6-home-scopes").getByRole("button", { name: /Writing System/i })).toBeVisible();
    const floeActor = home.getByTestId("v6-home-actors").locator(".home-actor-summary", { hasText: "Floe" });
    await expect(floeActor).toBeVisible();
    await expect(home.getByTestId("v6-home-contexts")).toContainText("Direct planning thread");
    await expect(home.getByTestId("v6-home-contexts")).toContainText("Workspace-level Context");
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);
    expect(projectionGets).toEqual([]);

    await floeActor.click();

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

  test("shows content-depth summaries from loaded Workspace substrate without prefetching Scope projections", async ({ page }) => {
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
      {
        endpoint_id: floeId,
        workspace_id: WORKSPACE_ID,
        name: "Floe",
        status: "idle",
        agent_id: "floe",
        metadata_json: JSON.stringify({ runtime_adapter: "pi" })
      },
      { endpoint_id: reviewerId, workspace_id: WORKSPACE_ID, name: "Reviewer", status: "idle", agent_id: "reviewer", metadata_json: "{}" }
    ];
    const contexts: WorkspaceContextRecord[] = [
      {
        context_id: "ctx_workspace_notes",
        workspace_id: WORKSPACE_ID,
        scope_id: null,
        parent_context_id: null,
        created_by_endpoint_id: operatorId,
        created_at: "2026-05-24T00:00:00.000Z",
        last_event_at: "2026-05-24T00:03:00.000Z",
        participants: [operatorId, floeId],
        first_message_preview: "Direct critique notes"
      },
      {
        context_id: "ctx_drafting_stream",
        workspace_id: WORKSPACE_ID,
        scope_id: "scope_writing",
        parent_context_id: null,
        created_by_endpoint_id: floeId,
        created_at: "2026-05-24T00:01:00.000Z",
        last_event_at: "2026-05-24T00:04:00.000Z",
        participants: [operatorId, floeId],
        first_message_preview: "Drafting evidence stream"
      },
      {
        context_id: "ctx_review",
        workspace_id: WORKSPACE_ID,
        scope_id: "scope_review",
        parent_context_id: null,
        created_by_endpoint_id: reviewerId,
        created_at: "2026-05-24T00:02:00.000Z",
        last_event_at: "2026-05-24T00:05:00.000Z",
        participants: [operatorId, reviewerId],
        first_message_preview: "Review handoff"
      }
    ];
    const events: EventRecord[] = [
      {
        event_id: "evt_workspace_note",
        type: "message",
        workspace_id: WORKSPACE_ID,
        source_endpoint_id: operatorId,
        destination_json: { kind: "endpoint", endpoint_id: floeId },
        context_id: "ctx_workspace_notes",
        content: { text: "Workspace conversation note" },
        created_at: "2026-05-24T00:03:00.000Z"
      },
      {
        event_id: "evt_scope_pulse",
        type: "pulse.fired",
        workspace_id: WORKSPACE_ID,
        source_endpoint_id: null,
        destination_json: { kind: "broadcast" },
        context_id: "ctx_drafting_stream",
        content: { text: "Daily drafting pulse fired" },
        created_at: "2026-05-24T00:04:00.000Z"
      }
    ];
    const telemetry: TelemetryRecord[] = [
      {
        telemetry_id: "tel_tool_check",
        workspace_id: WORKSPACE_ID,
        endpoint_id: floeId,
        delivery_id: "delivery_tool_check",
        kind: "BeforeToolUse",
        payload_json: JSON.stringify({
          context_id: "ctx_drafting_stream",
          summary: "checking references",
          toolName: "web-search"
        }),
        created_at: "2026-05-24T00:06:00.000Z"
      }
    ];
    const projectionGets: string[] = [];
    const legacyFieldRequests: string[] = [];
    const contextEventGets: string[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing Scope"), makeScope("scope_review", "Review Scope")],
      {
        scope_writing: emptyScopeProjection("scope_writing"),
        scope_review: emptyScopeProjection("scope_review")
      },
      {
        endpoints,
        workspaceContexts: contexts,
        events,
        telemetry,
        authProfiles: [{ id: "local-dev", provider: "openai", label: "Local Dev" }],
        runtimeBindings: [
          {
            binding_key: "workspace-default",
            scope: "workspace_default",
            workspace_id: WORKSPACE_ID,
            endpoint_id: null,
            auth_profile: "local-dev",
            model: "gpt-5"
          },
          {
            binding_key: "floe-agent",
            scope: "agent",
            workspace_id: WORKSPACE_ID,
            endpoint_id: floeId,
            auth_profile: "local-dev",
            model: "gpt-5"
          }
        ],
        runtimeAdapter: "pi",
        projectionGets,
        legacyFieldRequests,
        contextEventGets
      }
    );

    const home = page.getByTestId("v6-workspace-home");
    const sectionOrder = await home.locator("[data-testid^='v6-home-']").evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid"))
    );
    expect(sectionOrder).toEqual([
      "v6-home-workspace-settings",
      "v6-home-actors",
      "v6-home-scopes",
      "v6-home-recent-activity",
      "v6-home-contexts"
    ]);
    await expect(home.getByTestId("v6-home-workspace-settings")).toContainText("Runtime");
    await expect(home.getByTestId("v6-home-workspace-settings")).toContainText("Ready");
    await expect(home.getByTestId("v6-home-workspace-settings")).toContainText("pi");

    const activity = home.getByTestId("v6-home-recent-activity");
    await expect(activity).toContainText("checking references");
    await expect(activity).toContainText("Floe");
    await expect(activity).toContainText("Drafting evidence stream");
    await expect(activity).toContainText("Writing Scope");
    await expect(activity).toContainText("Workspace conversation note");
    await expect(activity).toContainText("Workspace-only");

    const scopes = home.getByTestId("v6-home-scopes");
    await expect(scopes.getByRole("button", { name: /Writing Scope/i })).toContainText("1 contexts");
    await expect(scopes.getByRole("button", { name: /Writing Scope/i })).toContainText("2 activity");

    const actors = home.getByTestId("v6-home-actors");
    const floeActor = actors.locator(".home-actor-summary", { hasText: "Floe" });
    await expect(floeActor).toContainText("Workspace-level 1");
    await expect(floeActor).toContainText("Scoped 1");
    await expect(floeActor).toContainText("Activity 1");
    await expect(floeActor).toContainText("local-dev / gpt-5");
    await expect(floeActor).toContainText("pi");

    await expect(home).not.toContainText("Workspace runtime default is not fully configured");
    await expect(page.getByText(/Default (Scope|Field)|Home Scope|\bThread\b|\.floe\/blocks/)).toHaveCount(0);
    expect(contextEventGets).toEqual([]);
    expect(projectionGets).toEqual([]);
    expect(legacyFieldRequests).toEqual([]);

    await scopes.getByRole("button", { name: /Writing Scope/i }).click();
    await expect(page.getByTestId("v6-scope-field-map")).toBeVisible();
    expect(projectionGets.length).toBeGreaterThan(0);
    expect(legacyFieldRequests).toEqual([]);
  });
});
