import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type EndpointRecord,
  type EventRecord,
  type ScopeProjection,
  type TelemetryRecord,
  type WorkspaceContextRecord
} from "./helpers";

const operatorId = `actor:${WORKSPACE_ID}:operator`;
const floeId = `actor:${WORKSPACE_ID}:floe`;
const reviewerId = `actor:${WORKSPACE_ID}:reviewer`;

function writingProjection(): ScopeProjection {
  return {
    ...emptyScopeProjection("scope_writing"),
    refs: {
      contexts: [
        {
          context_id: "ctx_drafting_stream",
          workspace_id: WORKSPACE_ID,
          scope_id: "scope_writing",
          parent_context_id: null,
          created_by_endpoint_id: floeId,
          created_at: "2026-05-24T00:01:00.000Z",
          last_event_at: "2026-05-24T00:04:00.000Z",
          first_message_preview: "Drafting evidence stream"
        }
      ],
      pulses: [
        {
          pulse_id: "pulse_daily_drafting",
          workspace_id: WORKSPACE_ID,
          scope_id: "scope_writing",
          persistence: "workspace",
          status: "active",
          trigger: { type: "cron", schedule: "0 9 * * *" },
          next_fire_at: "2026-05-25T09:00:00.000Z",
          last_fired_at: "2026-05-24T09:00:00.000Z",
          fire_count: 3,
          created_at: "2026-05-24T00:00:00.000Z",
          updated_at: "2026-05-24T00:00:00.000Z"
        }
      ],
      events: [],
      activity: []
    },
    relationships: {
      context_participants: [
        { context_id: "ctx_drafting_stream", endpoint_id: operatorId },
        { context_id: "ctx_drafting_stream", endpoint_id: floeId }
      ],
      pulse_subscribers: [
        { pulse_id: "pulse_daily_drafting", subscriber: { kind: "context", context_id: "ctx_drafting_stream" } }
      ],
      event_context_ownership: []
    },
    unsupported: [{ kind: "webhook", reason: "Webhook refs are not projected yet" }]
  };
}

test.describe("V6 Inspector content depth", () => {
  test("selecting an Activity row updates the Inspector without opening Channel or fetching Context events", async ({ page }) => {
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
      { endpoint_id: floeId, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" }
    ];
    const contexts: WorkspaceContextRecord[] = [
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
    await page.getByTestId("v6-activity").getByRole("button", { name: /Inspect activity checking references/ }).click();

    const inspector = page.getByTestId("v6-inspector");
    await expect(inspector.getByRole("heading", { name: "Selected Activity" })).toBeVisible();
    await expect(inspector).toContainText("Runtime");
    await expect(inspector).toContainText("BeforeToolUse");
    await expect(inspector).toContainText("checking references");
    await expect(inspector).toContainText("Floe");
    await expect(inspector).toContainText("Drafting evidence stream");
    await expect(inspector).toContainText("Writing Scope");
    await expect(inspector).toContainText("ctx_drafting_stream");
    await expect(page.getByTestId("v6-channel")).toHaveCount(0);
    expect(emitCalls).toEqual([]);
    expect(contextEventGets).toEqual([]);
  });

  test("shows substrate-backed Home, Actor, and Scope Inspector summaries without treating Home as a Scope", async ({ page }) => {
    const endpoints: EndpointRecord[] = [
      { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
      { endpoint_id: floeId, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" },
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
        context_id: "ctx_reviewer_only",
        workspace_id: WORKSPACE_ID,
        scope_id: "scope_writing",
        parent_context_id: null,
        created_by_endpoint_id: reviewerId,
        created_at: "2026-05-24T00:02:00.000Z",
        last_event_at: "2026-05-24T00:05:00.000Z",
        participants: [operatorId, reviewerId],
        first_message_preview: "Reviewer notes"
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
    const projectionGets: string[] = [];
    const legacyFieldRequests: string[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_writing", "Writing Scope")],
      { scope_writing: writingProjection() },
      {
        endpoints,
        workspaceContexts: contexts,
        events,
        telemetry,
        projectionGets,
        legacyFieldRequests,
        authProfiles: [{ id: "local-dev", provider: "fake", model: "gpt-5" }],
        runtimeBindings: [
          {
            binding_key: "agent-floe",
            scope: "agent",
            workspace_id: null,
            endpoint_id: floeId,
            auth_profile: "local-dev",
            model: "gpt-5"
          }
        ],
        runtimeAdapter: "pi"
      }
    );

    const inspector = page.getByTestId("v6-inspector");
    await expect(inspector.getByRole("heading", { name: "Workspace", exact: true })).toBeVisible();
    await expect(inspector).toContainText("Workspace index");
    await expect(inspector).toContainText("Named Scopes");
    await expect(inspector).toContainText("Workspace-level Contexts");
    await expect(inspector).toContainText("All loaded Contexts");
    await expect(inspector).toContainText("Workspace Events");
    await expect(inspector).toContainText("Runtime records");
    await expect(inspector).toContainText("Actors");
    expect(projectionGets).toEqual([]);

    await page.getByTestId("v6-home-actors").getByRole("button", { name: /Floe/ }).click();
    await expect(inspector.getByRole("heading", { name: "Actor", exact: true })).toBeVisible();
    await expect(inspector).toContainText("Workspace Endpoint");
    await expect(inspector).toContainText("Runtime binding");
    await expect(inspector).toContainText("local-dev");
    await expect(inspector).toContainText("Workspace-level participation");
    await expect(inspector).toContainText("Scoped participation");
    await expect(inspector).toContainText("Actor Activity");
    await expect(inspector).toContainText("Direct critique notes");
    await expect(inspector).toContainText("Drafting evidence stream");
    await expect(page.locator(".react-flow__node", { hasText: "Floe" })).toHaveCount(0);

    await page.getByTestId("v6-home-scopes").getByRole("button", { name: /Writing Scope/ }).click();
    await expect(inspector.getByRole("heading", { name: "Scope", exact: true })).toBeVisible();
    await expect(inspector).toContainText("scope_writing");
    await expect(inspector).toContainText("Projected Contexts");
    await expect(inspector).toContainText("Drafting evidence stream");
    await expect(inspector).toContainText("Pulses");
    await expect(inspector).toContainText("pulse_daily_drafting");
    await expect(inspector).toContainText("Activity rows");
    await expect(inspector).toContainText("checking references");
    await expect(inspector).toContainText("Projection gaps");
    await expect(inspector).toContainText("webhook refs are pending substrate projection.");
    await expect(page.getByText(/Default (Scope|Field)|Home Scope|\bThread\b|\.floe\/blocks/)).toHaveCount(0);
    expect(legacyFieldRequests).toEqual([]);
  });
});
