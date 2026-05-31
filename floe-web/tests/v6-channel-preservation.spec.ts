import { expect } from "@playwright/test";
import {
  emptyScopeProjection,
  makeScope,
  seedAppWithScopes,
  test,
  WORKSPACE_ID,
  type EndpointRecord,
  type ScopeProjection,
  type WorkspaceContextRecord
} from "./helpers";

const operatorId = `actor:${WORKSPACE_ID}:operator`;
const floeId = `actor:${WORKSPACE_ID}:floe`;
const reviewerId = `actor:${WORKSPACE_ID}:reviewer`;

test.describe("V6 transitional Channel preservation", () => {
  test("opens actor participation Contexts in the Channel and sends through the existing emit path", async ({ page }) => {
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
        context_id: "ctx_review_only",
        workspace_id: WORKSPACE_ID,
        scope_id: "scope_delivery",
        parent_context_id: null,
        created_by_endpoint_id: reviewerId,
        created_at: "2026-05-24T00:02:00.000Z",
        last_event_at: "2026-05-24T00:03:00.000Z",
        participants: [floeId, reviewerId],
        first_message_preview: "Review-only thread"
      }
    ];
    const contextEventsById = {
      ctx_direct: [],
      ctx_review_only: []
    };
    const contextEventGets: string[] = [];
    const emitCalls: unknown[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_delivery", "Delivery Scope")],
      { scope_delivery: emptyScopeProjection("scope_delivery") },
      {
        endpoints,
        workspaceContexts: contexts,
        contextEventsById,
        contextEventGets,
        emitCalls,
        authProfiles: [{ id: "fake_profile", provider: "fake", model: "fake-model", label: "Fake runtime" }],
        runtimeBindings: [{
          binding_key: "binding_floe",
          scope: "agent",
          workspace_id: WORKSPACE_ID,
          endpoint_id: floeId,
          auth_profile: "fake_profile",
          model: "fake-model"
        }],
        runtimeAdapter: "fake"
      }
    );

    const home = page.getByTestId("v6-workspace-home");
    await home.getByTestId("v6-home-actors").getByRole("button", { name: /Floe/i }).click();

    const inspector = page.getByTestId("v6-inspector");
    const contextCard = inspector.locator(".inspector-context-card", { hasText: "Direct planning thread" });
    await expect(contextCard).toContainText("Workspace-level Context");
    await expect(page.getByTestId("v6-channel")).toHaveCount(0);

    await contextCard.getByRole("button", { name: "Open in Channel" }).click();

    const channel = page.getByTestId("v6-channel");
    await expect(channel).toBeVisible();
    await expect(channel.getByTestId("active-conversation-header")).toContainText("Direct planning thread");
    await expect(channel.getByPlaceholder("Message Floe")).toBeEnabled();
    await expect(inspector.getByRole("heading", { name: "Actor", exact: true })).toBeVisible();

    await channel.getByPlaceholder("Message Floe").fill("Keep this in Channel");
    await channel.getByRole("button", { name: "Send message" }).click();

    await expect(channel).toContainText("Keep this in Channel");
    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]).toMatchObject({
      type: "message",
      workspace_id: WORKSPACE_ID,
      source_endpoint_id: operatorId,
      destination: { kind: "endpoint", endpoint_id: floeId },
      context_id: "ctx_direct",
      content: { text: "Keep this in Channel" },
      metadata: { submitted_by: "floe-web", channel: "floe" }
    });
    expect(contextEventGets).toContain("ctx_direct");
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);

    const readOnlyCard = inspector.locator(".inspector-context-card", { hasText: "Review-only thread" });
    await expect(readOnlyCard).toContainText("Scoped Context · Delivery Scope");
    await readOnlyCard.getByRole("button", { name: "Open in Channel" }).click();

    await expect(channel.getByTestId("active-conversation-header")).toContainText("Review-only thread");
    await expect(channel).toContainText("Read-only Context");
    await expect(channel.getByPlaceholder("Read-only Context")).toBeDisabled();
  });

  test("opens Home Workspace-level Contexts in a distinct Channel without Scope defaults", async ({ page }) => {
    const contexts: WorkspaceContextRecord[] = [{
      context_id: "ctx_home",
      workspace_id: WORKSPACE_ID,
      scope_id: null,
      parent_context_id: null,
      created_by_endpoint_id: operatorId,
      created_at: "2026-05-24T00:00:00.000Z",
      last_event_at: "2026-05-24T00:01:00.000Z",
      participants: [operatorId, floeId],
      first_message_preview: "Home direct thread"
    }];
    const contextEventsById = {
      ctx_home: [{
        event_id: "evt_home",
        type: "message",
        workspace_id: WORKSPACE_ID,
        context_id: "ctx_home",
        source_endpoint_id: operatorId,
        content: { text: "Home Context event" },
        metadata: {},
        created_at: "2026-05-24T00:01:00.000Z"
      }]
    };
    const contextEventGets: string[] = [];
    const projectionGets: string[] = [];
    const legacyFieldRequests: string[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_delivery", "Delivery Scope")],
      { scope_delivery: emptyScopeProjection("scope_delivery") },
      {
        endpoints: [
          { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
          { endpoint_id: floeId, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" }
        ],
        workspaceContexts: contexts,
        contextEventsById,
        contextEventGets,
        projectionGets,
        legacyFieldRequests
      }
    );

    const homeContext = page.getByTestId("v6-home-contexts").locator(".workspace-context-block", { hasText: "Home direct thread" });
    await homeContext.getByRole("button", { name: "Open" }).click();

    const channel = page.getByTestId("v6-channel");
    const inspector = page.getByTestId("v6-inspector");
    await expect(channel).toBeVisible();
    await expect(inspector).toBeVisible();
    await expect(channel.getByTestId("active-conversation-header")).toContainText("Home direct thread");
    await expect(channel).toContainText("Home Context event");
    const channelBox = await channel.boundingBox();
    const inspectorBox = await inspector.boundingBox();
    expect(channelBox?.x).not.toBe(inspectorBox?.x);
    expect(channelBox?.width).not.toBe(inspectorBox?.width);
    expect(new Set(contextEventGets)).toEqual(new Set(["ctx_home"]));
    expect(projectionGets).toEqual([]);
    expect(legacyFieldRequests).toEqual([]);
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);
  });

  test("opens projected Context nodes through the same Channel path", async ({ page }) => {
    const projection: ScopeProjection = {
      ...emptyScopeProjection("scope_delivery"),
      refs: {
        ...emptyScopeProjection("scope_delivery").refs,
        contexts: [{
          context_id: "ctx_projected",
          workspace_id: WORKSPACE_ID,
          scope_id: "scope_delivery",
          parent_context_id: null,
          created_by_endpoint_id: operatorId,
          created_at: "2026-05-24T00:00:00.000Z",
          last_event_at: "2026-05-24T00:01:00.000Z",
          first_message_preview: "Projected delivery thread"
        }]
      },
      relationships: {
        ...emptyScopeProjection("scope_delivery").relationships,
        context_participants: [
          { context_id: "ctx_projected", endpoint_id: operatorId },
          { context_id: "ctx_projected", endpoint_id: floeId }
        ]
      }
    };
    const contextEventGets: string[] = [];
    const legacyFieldRequests: string[] = [];

    await seedAppWithScopes(
      page,
      [makeScope("scope_delivery", "Delivery Scope")],
      { scope_delivery: projection },
      {
        endpoints: [
          { endpoint_id: operatorId, workspace_id: WORKSPACE_ID, name: "Operator", status: "online", metadata_json: "{}" },
          { endpoint_id: floeId, workspace_id: WORKSPACE_ID, name: "Floe", status: "idle", agent_id: "floe", metadata_json: "{}" }
        ],
        workspaceContexts: [],
        contextEventsById: {
          ctx_projected: [{
            event_id: "evt_projected",
            type: "message",
            workspace_id: WORKSPACE_ID,
            context_id: "ctx_projected",
            source_endpoint_id: floeId,
            content: { text: "Projected Context event" },
            metadata: {},
            created_at: "2026-05-24T00:01:00.000Z"
          }]
        },
        contextEventGets,
        legacyFieldRequests
      }
    );

    await page.getByTestId("v6-home-scopes").getByRole("button", { name: /Delivery Scope/i }).click();
    const projectedNode = page.locator(".react-flow__node", { hasText: "Projected delivery thread" });
    await expect(projectedNode).toBeVisible();
    await projectedNode.getByRole("button", { name: "Open" }).click();

    const channel = page.getByTestId("v6-channel");
    await expect(channel).toBeVisible();
    await expect(channel.getByTestId("active-conversation-header")).toContainText("Projected delivery thread");
    await expect(channel).toContainText("Projected Context event");
    expect(new Set(contextEventGets)).toEqual(new Set(["ctx_projected"]));
    expect(legacyFieldRequests).toEqual([]);
    await expect(page.getByText(/Default (Scope|Field)/)).toHaveCount(0);
  });
});
