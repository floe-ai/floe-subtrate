import { describe, expect, test } from "vitest";
import { buildWorkspaceHomeModel } from "./home-view-model";
import { type ActivityRow } from "./activity";
import { type ContextSummary } from "./contexts";
import { type ScopeRecord } from "./scope-projection";

const operatorId = "actor:ws:operator";
const floeId = "actor:ws:floe";
const reviewerId = "actor:ws:reviewer";

const scopes: ScopeRecord[] = [
  {
    workspace_id: "ws",
    scope_id: "scope_writing",
    title: "Writing Scope",
    description: null,
    is_default: false,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z"
  }
];

const contexts: ContextSummary[] = [
  {
    context_id: "ctx_workspace",
    workspace_id: "ws",
    scope_id: null,
    parent_context_id: null,
    created_by_endpoint_id: operatorId,
    created_at: "2026-05-24T00:00:00.000Z",
    last_event_at: "2026-05-24T00:03:00.000Z",
    participants: [operatorId, floeId],
    first_message_preview: "Direct planning notes"
  },
  {
    context_id: "ctx_scoped",
    workspace_id: "ws",
    scope_id: "scope_writing",
    parent_context_id: null,
    created_by_endpoint_id: floeId,
    created_at: "2026-05-24T00:01:00.000Z",
    last_event_at: "2026-05-24T00:05:00.000Z",
    participants: [floeId, reviewerId],
    first_message_preview: "Drafting evidence stream"
  }
];

const activityRows: ActivityRow[] = [
  {
    id: "tel_1",
    category: "runtime",
    title: "Running",
    kind: "BeforeToolUse",
    detail: "checking references",
    sourceEndpointId: floeId,
    sourceLabel: "Floe",
    contextId: "ctx_scoped",
    contextLabel: "Drafting evidence stream",
    scopeId: "scope_writing",
    scopeLabel: "Writing Scope",
    scopeState: "scoped",
    createdAt: "2026-05-24T00:06:00.000Z"
  },
  {
    id: "evt_workspace",
    category: "event",
    title: "message",
    kind: "message",
    detail: "Workspace conversation note",
    sourceEndpointId: operatorId,
    sourceLabel: "Operator",
    contextId: "ctx_workspace",
    contextLabel: "Direct planning notes",
    scopeId: null,
    scopeLabel: "Workspace-only",
    scopeState: "workspace",
    createdAt: "2026-05-24T00:04:00.000Z"
  }
];

describe("Workspace Home view model", () => {
  test("summarizes named Scopes, actors, Activity, and setup state without creating a Home Scope", () => {
    const model = buildWorkspaceHomeModel({
      scopes,
      contexts,
      activityRows,
      endpoints: [
        { endpoint_id: operatorId, name: "Operator", status: "online" },
        {
          endpoint_id: floeId,
          name: "Floe",
          status: "idle",
          agent_id: "floe",
          metadata_json: JSON.stringify({ runtime_adapter: "pi" })
        },
        { endpoint_id: reviewerId, name: "Reviewer", status: "idle", agent_id: "reviewer" }
      ],
      operatorEndpointId: operatorId,
      authProfileCount: 1,
      bridgeRuntimeKnown: true,
      bridgeRuntimeAdapter: "pi",
      runtimeBindings: [
        {
          scope: "workspace_default",
          workspace_id: "ws",
          endpoint_id: null,
          auth_profile: "local-dev",
          model: "gpt-5"
        },
        {
          scope: "agent",
          workspace_id: "ws",
          endpoint_id: floeId,
          auth_profile: "local-dev",
          model: "gpt-5"
        }
      ],
      effectiveProfileId: "local-dev",
      effectiveModel: "gpt-5"
    });

    expect(model.recentActivity).toEqual([
      expect.objectContaining({
        id: "tel_1",
        title: "Running",
        detail: "checking references",
        sourceLabel: "Floe",
        contextLabel: "Drafting evidence stream",
        scopeLabel: "Writing Scope"
      }),
      expect.objectContaining({
        id: "evt_workspace",
        title: "message",
        detail: "Workspace conversation note",
        sourceLabel: "Operator",
        contextLabel: "Direct planning notes",
        scopeLabel: "Workspace-only"
      })
    ]);
    expect(model.scopeCards).toEqual([
      expect.objectContaining({
        scopeId: "scope_writing",
        title: "Writing Scope",
        loadedContextCount: 1,
        activityCount: 1,
        latestActivityDetail: "checking references"
      })
    ]);
    expect(model.actorCards.find((actor) => actor.endpointId === floeId)).toMatchObject({
      name: "Floe",
      status: "idle",
      runtimeBindingLabel: "local-dev / gpt-5",
      adapterLabel: "pi",
      workspaceLevelContextCount: 1,
      scopedContextCount: 1,
      activityCount: 1,
      latestActivityDetail: "checking references"
    });
    expect(model.systemWarnings).toEqual([]);
  });

  test("derives warnings only from missing loaded substrate state", () => {
    expect(buildWorkspaceHomeModel({
      scopes: [],
      contexts: [],
      activityRows: [],
      endpoints: [],
      operatorEndpointId: operatorId,
      authProfileCount: 0,
      bridgeRuntimeKnown: false,
      bridgeRuntimeAdapter: null,
      runtimeBindings: [],
      effectiveProfileId: null,
      effectiveModel: null
    }).systemWarnings).toEqual([
      "No auth profiles are configured for runtime work.",
      "Local runtime adapter status is unavailable.",
      "Workspace runtime default is not fully configured.",
      "No registered Workspace actors are loaded.",
      "No named Scopes are loaded.",
      "No recent Workspace Activity is loaded."
    ]);
  });

  test("treats an operator-only Workspace as having no loaded actors", () => {
    expect(buildWorkspaceHomeModel({
      scopes,
      contexts: [],
      activityRows: [],
      endpoints: [{ endpoint_id: operatorId, name: "Operator", status: "online" }],
      operatorEndpointId: operatorId,
      authProfileCount: 1,
      bridgeRuntimeKnown: true,
      bridgeRuntimeAdapter: "pi",
      runtimeBindings: [],
      effectiveProfileId: "local-dev",
      effectiveModel: "gpt-5"
    }).systemWarnings).toContain("No registered Workspace actors are loaded.");
  });
});
