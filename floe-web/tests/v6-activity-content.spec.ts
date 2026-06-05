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

test.describe("V6 Activity content", () => {
  test("shows real Workspace Events and runtime activity with content-first filters", async ({ page }) => {
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
      { endpoint_id: floeId, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" }
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
        created_at: "2026-05-24T00:05:00.000Z"
      }
    ];
    const emitCalls: unknown[] = [];
    const contextEventGets: string[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing Scope")],
      { scope_writing: emptyScopeProjection("scope_writing") },
      { endpoints, workspaceContexts: contexts, events, telemetry, emitCalls, contextEventGets }
    );

    await page.getByTestId("v6-left-nav").getByRole("button", { name: "Activity" }).click();

    const activity = page.getByTestId("v6-activity");
    const rows = activity.getByTestId("activity-row");
    await expect(activity.getByRole("heading", { name: "Workspace Activity" })).toBeVisible();
    await expect(activity.getByTestId("activity-summary")).toContainText("3 records total");
    await expect(activity.getByTestId("activity-summary")).toContainText("2 Events");
    await expect(activity.getByTestId("activity-summary")).toContainText("1 runtime activity");
    await expect(activity.getByTestId("activity-summary")).toContainText("2 Contexts");
    await expect(activity.getByText("Pick a Scope first")).toBeVisible();
    await expect(activity.getByText("Workspace conversation note")).toBeVisible();
    await expect(activity.getByText("Daily drafting pulse fired")).toBeVisible();
    await expect(activity.getByText("checking references")).toBeVisible();
    await expect(rows.filter({ hasText: "Direct critique notes" })).toBeVisible();
    await expect(rows.filter({ hasText: "Drafting evidence stream" })).toHaveCount(2);
    await expect(rows.filter({ hasText: "Writing Scope" })).toHaveCount(2);
    await expect(rows.filter({ hasText: "Workspace-only" })).toBeVisible();

    await activity.getByRole("button", { name: "Floe" }).click();
    await expect(activity.getByTestId("activity-summary")).toContainText("1 matching records");
    await expect(activity.getByTestId("activity-summary")).toContainText("0 Events");
    await expect(activity.getByTestId("activity-summary")).toContainText("1 runtime activity");
    await expect(activity.getByTestId("activity-summary")).toContainText("1 Contexts");
    await expect(activity.getByTestId("activity-summary")).toContainText("1 Scopes");
    await expect(activity.getByText("checking references")).toBeVisible();
    await expect(activity.getByText("Workspace conversation note")).toHaveCount(0);
    await activity.getByRole("button", { name: "Clear filters" }).click();

    await activity.getByRole("button", { name: "Runtime" }).click();
    await expect(activity.getByText("checking references")).toBeVisible();
    await expect(activity.getByText("Daily drafting pulse fired")).toHaveCount(0);
    await activity.getByRole("button", { name: "Clear filters" }).click();

    await activity.getByRole("button", { name: "Workspace only" }).click();
    await expect(activity.getByTestId("activity-summary")).toContainText("1 matching records");
    await expect(activity.getByTestId("activity-summary")).toContainText("1 Contexts");
    await expect(activity.getByTestId("activity-summary")).toContainText("0 Scopes");
    await expect(activity.getByText("Workspace conversation note")).toBeVisible();
    await expect(activity.getByText("Daily drafting pulse fired")).toHaveCount(0);
    await expect(activity.getByRole("button", { name: "Direct critique notes" })).toBeVisible();
    await activity.getByRole("button", { name: "Clear filters" }).click();

    await activity.getByRole("button", { name: "Writing Scope" }).click();
    await activity.getByRole("button", { name: "Drafting evidence stream" }).click();
    await expect(activity.getByText("Daily drafting pulse fired")).toBeVisible();
    await expect(activity.getByText("checking references")).toBeVisible();
    await expect(activity.getByText("Workspace conversation note")).toHaveCount(0);

    await expect(page.getByText(/Default (Scope|Field)|\bThread\b|\.floe\/blocks/)).toHaveCount(0);
    expect(emitCalls).toEqual([]);
    expect(contextEventGets).toEqual([]);
  });
});
