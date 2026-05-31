import { describe, expect, it } from "vitest";
import {
  buildActivityRows,
  filterActivityRows,
  parseTelemetryPayload,
  telemetryContextId,
  type ActivityEndpoint,
  type ActivityFilters
} from "./activity";
import { type ContextSummary } from "./contexts";
import { type ScopeRecord } from "./scope-projection";

const WS = "workspace:test";
const OP = "actor:workspace:test:operator";
const FLOE = "actor:workspace:test:floe";

const contexts: ContextSummary[] = [
  makeContext({ context_id: "ctx_workspace", scope_id: null, first_message_preview: "Workspace notes" }),
  makeContext({ context_id: "ctx_scope", scope_id: "scope_drafting", first_message_preview: "Drafting stream" })
];

const endpoints: ActivityEndpoint[] = [
  { endpoint_id: OP, name: "Operator" },
  { endpoint_id: FLOE, name: "Floe", agent_id: "floe" }
];

const scopes: ScopeRecord[] = [
  {
    scope_id: "scope_drafting",
    workspace_id: WS,
    title: "Drafting Scope",
    description: null,
    created_at: "2026-05-24T00:00:00.000Z",
    updated_at: "2026-05-24T00:00:00.000Z"
  }
];

const emptyFilters: ActivityFilters = { actorId: "all", kind: "all", scopeId: "all", contextId: "all" };

describe("buildActivityRows", () => {
  it("derives Scope labels from Context ownership, not Event-local Scope", () => {
    const rows = buildActivityRows({
      contexts,
      endpoints,
      scopes,
      events: [{
        event_id: "evt_scope",
        type: "pulse.fired",
        source_endpoint_id: null,
        context_id: "ctx_scope",
        content: { text: "Pulse fired" },
        created_at: "2026-05-24T00:02:00.000Z"
      }],
      telemetry: []
    });

    expect(rows).toMatchObject([{
      id: "evt_scope",
      sourceLabel: "Pulse",
      contextLabel: "Drafting stream",
      scopeId: "scope_drafting",
      scopeLabel: "Drafting Scope"
    }]);
  });

  it("keeps actor-anchored unscoped Context rows as Workspace-only", () => {
    const rows = buildActivityRows({
      contexts,
      endpoints,
      scopes,
      events: [{
        event_id: "evt_workspace",
        type: "message",
        source_endpoint_id: OP,
        context_id: "ctx_workspace",
        content: { text: "Workspace note" },
        created_at: "2026-05-24T00:01:00.000Z"
      }],
      telemetry: []
    });

    expect(rows[0]).toMatchObject({
      sourceLabel: "Operator",
      contextLabel: "Workspace notes",
      scopeId: null,
      scopeLabel: "Workspace-only",
      scopeState: "workspace"
    });
  });

  it("does not invent Workspace-only ownership when a referenced Context is not loaded", () => {
    const rows = buildActivityRows({
      contexts: [],
      endpoints,
      scopes,
      events: [{
        event_id: "evt_unresolved",
        type: "message",
        source_endpoint_id: OP,
        context_id: "ctx_missing",
        content: { text: "Missing Context row" },
        created_at: "2026-05-24T00:01:00.000Z"
      }],
      telemetry: []
    });

    expect(rows[0]).toMatchObject({
      contextId: "ctx_missing",
      contextLabel: null,
      scopeId: null,
      scopeLabel: "Context unresolved",
      scopeState: "unresolved"
    });
    expect(filterActivityRows(rows, { ...emptyFilters, scopeId: "workspace" })).toEqual([]);
  });

  it("parses Telemetry payloads for Context, source, and summary and sorts newest first", () => {
    const rows = buildActivityRows({
      contexts,
      endpoints,
      scopes,
      events: [{
        event_id: "evt_old",
        type: "message",
        source_endpoint_id: OP,
        context_id: "ctx_workspace",
        content: { text: "older" },
        created_at: "2026-05-24T00:01:00.000Z"
      }],
      telemetry: [{
        telemetry_id: "tel_new",
        endpoint_id: FLOE,
        kind: "BeforeToolUse",
        payload_json: JSON.stringify({ context_id: "ctx_scope", summary: "checking references", toolName: "web-search" }),
        created_at: "2026-05-24T00:03:00.000Z"
      }]
    });

    expect(rows.map((row) => row.id)).toEqual(["tel_new", "evt_old"]);
    expect(rows[0]).toMatchObject({
      category: "runtime",
      title: "Running",
      detail: "checking references",
      sourceLabel: "Floe",
      contextLabel: "Drafting stream",
      scopeLabel: "Drafting Scope"
    });
  });
});

describe("filterActivityRows", () => {
  it("combines actor, kind, Scope, and Context filters", () => {
    const rows = buildActivityRows({
      contexts,
      endpoints,
      scopes,
      events: [{
        event_id: "evt_workspace",
        type: "message",
        source_endpoint_id: OP,
        context_id: "ctx_workspace",
        content: { text: "Workspace note" },
        created_at: "2026-05-24T00:01:00.000Z"
      }],
      telemetry: [{
        telemetry_id: "tel_scope",
        endpoint_id: FLOE,
        kind: "BeforeToolUse",
        payload_json: JSON.stringify({ context_id: "ctx_scope", summary: "checking references" }),
        created_at: "2026-05-24T00:02:00.000Z"
      }]
    });

    expect(filterActivityRows(rows, { ...emptyFilters, scopeId: "workspace" }).map((row) => row.id)).toEqual(["evt_workspace"]);
    expect(filterActivityRows(rows, { ...emptyFilters, actorId: FLOE, kind: "runtime", scopeId: "scope_drafting", contextId: "ctx_scope" }).map((row) => row.id)).toEqual(["tel_scope"]);
    expect(filterActivityRows(rows, { ...emptyFilters, actorId: OP, kind: "runtime" })).toEqual([]);
  });
});

describe("Telemetry helpers", () => {
  it("returns null for invalid JSON payloads instead of inventing Context ownership", () => {
    const record = {
      telemetry_id: "tel_invalid",
      endpoint_id: FLOE,
      kind: "BeforeToolUse",
      payload_json: "{",
      created_at: "2026-05-24T00:00:00.000Z"
    };

    expect(parseTelemetryPayload(record)).toBeNull();
    expect(telemetryContextId(record)).toBeNull();
  });
});

function makeContext(overrides: Partial<ContextSummary>): ContextSummary {
  return {
    context_id: overrides.context_id ?? "ctx",
    workspace_id: WS,
    scope_id: null,
    parent_context_id: null,
    created_by_endpoint_id: OP,
    created_at: "2026-05-24T00:00:00.000Z",
    last_event_at: "2026-05-24T00:00:00.000Z",
    participants: [OP, FLOE],
    first_message_preview: null,
    ...overrides
  };
}
