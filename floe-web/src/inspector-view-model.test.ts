import { describe, expect, test } from "vitest";
import {
  buildActorInspectorSummary,
  buildContextInspectorSummary,
  buildScopeInspectorSummary,
  buildWorkspaceInspectorSummary
} from "./inspector-view-model";
import { type ActivityRow } from "./activity";
import { type ContextSummary } from "./contexts";
import { type ScopeProjection } from "./scope-projection";

const workspaceContext: ContextSummary = {
  context_id: "ctx_workspace",
  workspace_id: "ws",
  scope_id: null,
  parent_context_id: null,
  created_by_endpoint_id: "actor:operator",
  created_at: "2026-05-24T00:00:00.000Z",
  last_event_at: null,
  participants: ["actor:operator", "actor:floe"],
  first_message_preview: "Direct notes"
};

const scopedContext: ContextSummary = {
  ...workspaceContext,
  context_id: "ctx_scoped",
  scope_id: "scope_writing",
  first_message_preview: "Scoped notes"
};

const activityRow: ActivityRow = {
  id: "tel_1",
  category: "runtime",
  title: "Running",
  kind: "BeforeToolUse",
  detail: "checking references",
  sourceEndpointId: "actor:floe",
  sourceLabel: "Floe",
  contextId: "ctx_scoped",
  contextLabel: "Scoped notes",
  scopeId: "scope_writing",
  scopeLabel: "Writing Scope",
  scopeState: "scoped",
  createdAt: "2026-05-24T00:05:00.000Z"
};

describe("Inspector view models", () => {
  test("summarizes Workspace Home as an index rather than a Scope", () => {
    expect(buildWorkspaceInspectorSummary({
      namedScopeCount: 2,
      scopeBackedFieldCount: 2,
      contexts: [workspaceContext, scopedContext],
      eventCount: 3,
      telemetryCount: 4,
      endpointCount: 5
    })).toEqual({
      surface: "Workspace index (not a Scope)",
      namedScopeCount: 2,
      scopeBackedFieldCount: 2,
      workspaceLevelContextCount: 1,
      loadedContextCount: 2,
      eventCount: 3,
      telemetryCount: 4,
      endpointCount: 5
    });
  });

  test("summarizes actor participation and runtime binding without Field membership", () => {
    expect(buildActorInspectorSummary({
      actorId: "actor:floe",
      contexts: [workspaceContext, scopedContext],
      activityRows: [activityRow],
      runtimeBinding: { auth_profile: "local-dev", model: "gpt-5" },
      adapter: "pi"
    })).toEqual({
      runtimeBindingLabel: "local-dev / gpt-5",
      adapterLabel: "pi",
      workspaceLevelContextCount: 1,
      scopedContextCount: 1,
      activityCount: 1
    });
  });

  test("uses correlated Activity rows when projection event/activity refs are empty", () => {
    const projection: ScopeProjection = {
      workspace_id: "ws",
      scope_id: "scope_writing",
      generated_at: "2026-05-24T00:00:00.000Z",
      refs: {
        contexts: [],
        pulses: [],
        events: [],
        activity: []
      },
      relationships: {
        context_participants: [{ context_id: "ctx_scoped", endpoint_id: "actor:floe" }],
        pulse_subscribers: [],
        event_context_ownership: []
      },
      unsupported: []
    };

    expect(buildScopeInspectorSummary({
      scopeId: "scope_writing",
      projection,
      activityRows: [activityRow]
    })).toMatchObject({
      projectedEventCount: 0,
      projectedActivityRefCount: 0,
      actorCount: 1,
      activityRowCount: 1,
      hasProjectionActivityGap: true
    });
  });

  test("builds context metadata for the right inspector without duplicating stream semantics", () => {
    expect(buildContextInspectorSummary({
      context: scopedContext,
      events: [
        {
          event_id: "evt_created",
          type: "context.created",
          context_id: "ctx_scoped",
          source_endpoint_id: "actor:operator",
          destination_json: { kind: "broadcast" },
          content: {},
          created_at: "2026-05-24T00:00:00.000Z"
        },
        {
          event_id: "evt_message",
          type: "message",
          context_id: "ctx_scoped",
          source_endpoint_id: "actor:floe",
          destination_json: { kind: "endpoint", endpoint_id: "actor:operator" },
          content: { text: "Scoped notes" },
          created_at: "2026-05-24T00:05:00.000Z"
        }
      ],
      scopeTitlesById: { scope_writing: "Writing" }
    })).toEqual({
      label: "Scoped notes",
      scopeLabel: "Writing Scope",
      participantIds: ["actor:operator", "actor:floe"],
      participantCount: 2,
      totalEmitCount: 2,
      messageCount: 1,
      createdAt: "2026-05-24T00:00:00.000Z",
      lastActiveAt: "2026-05-24T00:05:00.000Z"
    });
  });
});
