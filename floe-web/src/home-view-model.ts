import { type ActivityRow } from "./activity";
import { type ContextSummary } from "./contexts";
import { type ScopeRecord } from "./scope-projection";

export type HomeEndpoint = {
  endpoint_id: string;
  name: string;
  status: string;
  agent_id?: string | null;
  metadata_json?: string;
};

export type HomeRuntimeBinding = {
  scope: "agent" | "workspace_default" | "global_default";
  workspace_id: string | null;
  endpoint_id: string | null;
  auth_profile: string;
  model: string | null;
};

export type HomeActivitySummary = {
  id: string;
  title: string;
  detail: string;
  sourceLabel: string;
  contextLabel: string | null;
  scopeLabel: string;
  createdAt: string;
};

export type HomeScopeCard = {
  scopeId: string;
  title: string;
  loadedContextCount: number;
  activityCount: number;
  latestActivityDetail: string | null;
  latestActivityAt: string | null;
};

export type HomeActorCard = {
  endpointId: string;
  name: string;
  status: string;
  runtimeBindingLabel: string;
  adapterLabel: string;
  workspaceLevelContextCount: number;
  scopedContextCount: number;
  activityCount: number;
  latestActivityDetail: string | null;
  latestActivityAt: string | null;
};

export type WorkspaceHomeModel = {
  recentActivity: HomeActivitySummary[];
  scopeCards: HomeScopeCard[];
  actorCards: HomeActorCard[];
  systemWarnings: string[];
};

export function buildWorkspaceHomeModel({
  scopes,
  contexts,
  activityRows,
  endpoints,
  operatorEndpointId,
  authProfileCount,
  bridgeRuntimeKnown,
  bridgeRuntimeAdapter,
  runtimeBindings,
  effectiveProfileId,
  effectiveModel
}: {
  scopes: ScopeRecord[];
  contexts: ContextSummary[];
  activityRows: ActivityRow[];
  endpoints: HomeEndpoint[];
  operatorEndpointId?: string;
  authProfileCount: number;
  bridgeRuntimeKnown: boolean;
  bridgeRuntimeAdapter: string | null;
  runtimeBindings: HomeRuntimeBinding[];
  effectiveProfileId: string | null;
  effectiveModel: string | null;
}): WorkspaceHomeModel {
  const sortedRows = [...activityRows].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const recentActivity = sortedRows.slice(0, 5).map((row) => ({
    id: row.id,
    title: row.title,
    detail: row.detail,
    sourceLabel: row.sourceLabel,
    contextLabel: row.contextLabel,
    scopeLabel: row.scopeLabel,
    createdAt: row.createdAt
  }));

  return {
    recentActivity,
    scopeCards: scopes.map((scope) => buildScopeCard(scope, contexts, sortedRows)),
    actorCards: endpoints.map((endpoint) => buildActorCard(endpoint, contexts, sortedRows, runtimeBindings, bridgeRuntimeAdapter)),
    systemWarnings: buildSystemWarnings({
      scopes,
      endpoints,
      activityRows,
      authProfileCount,
      bridgeRuntimeKnown,
      operatorEndpointId,
      effectiveProfileId,
      effectiveModel
    })
  };
}

function buildScopeCard(scope: ScopeRecord, contexts: ContextSummary[], activityRows: ActivityRow[]): HomeScopeCard {
  const scopeActivityRows = activityRows.filter((row) => row.scopeId === scope.scope_id);
  return {
    scopeId: scope.scope_id,
    title: scope.title || scope.scope_id,
    loadedContextCount: contexts.filter((context) => context.scope_id === scope.scope_id).length,
    activityCount: scopeActivityRows.length,
    latestActivityDetail: scopeActivityRows[0]?.detail ?? null,
    latestActivityAt: scopeActivityRows[0]?.createdAt ?? null
  };
}

function buildActorCard(
  endpoint: HomeEndpoint,
  contexts: ContextSummary[],
  activityRows: ActivityRow[],
  runtimeBindings: HomeRuntimeBinding[],
  bridgeRuntimeAdapter: string | null
): HomeActorCard {
  const actorContexts = contexts.filter((context) => context.participants.includes(endpoint.endpoint_id));
  const actorActivityRows = activityRows.filter((row) => row.sourceEndpointId === endpoint.endpoint_id);
  const binding = runtimeBindings.find((candidate) =>
    candidate.scope === "agent" && candidate.endpoint_id === endpoint.endpoint_id
  );
  return {
    endpointId: endpoint.endpoint_id,
    name: endpoint.name?.trim() || endpoint.agent_id || endpoint.endpoint_id,
    status: endpoint.status || "unknown",
    runtimeBindingLabel: binding
      ? `${binding.auth_profile}${binding.model ? ` / ${binding.model}` : ""}`
      : "Unconfigured",
    adapterLabel: endpointRuntimeAdapter(endpoint) ?? bridgeRuntimeAdapter ?? "unknown",
    workspaceLevelContextCount: actorContexts.filter((context) => !context.scope_id).length,
    scopedContextCount: actorContexts.filter((context) => context.scope_id).length,
    activityCount: actorActivityRows.length,
    latestActivityDetail: actorActivityRows[0]?.detail ?? null,
    latestActivityAt: actorActivityRows[0]?.createdAt ?? null
  };
}

function buildSystemWarnings({
  scopes,
  endpoints,
  operatorEndpointId,
  activityRows,
  authProfileCount,
  bridgeRuntimeKnown,
  effectiveProfileId,
  effectiveModel
}: {
  scopes: ScopeRecord[];
  endpoints: HomeEndpoint[];
  operatorEndpointId?: string;
  activityRows: ActivityRow[];
  authProfileCount: number;
  bridgeRuntimeKnown: boolean;
  effectiveProfileId: string | null;
  effectiveModel: string | null;
}): string[] {
  const warnings: string[] = [];
  if (authProfileCount === 0) warnings.push("No auth profiles are configured for runtime work.");
  if (!bridgeRuntimeKnown) warnings.push("Local runtime adapter status is unavailable.");
  if (!effectiveProfileId || !effectiveModel) warnings.push("Workspace runtime default is not fully configured.");
  if (endpoints.filter((endpoint) => endpoint.endpoint_id !== operatorEndpointId).length === 0) {
    warnings.push("No registered Workspace actors are loaded.");
  }
  if (scopes.length === 0) warnings.push("No named Scopes are loaded.");
  if (activityRows.length === 0) warnings.push("No recent Workspace Activity is loaded.");
  return warnings;
}

function endpointRuntimeAdapter(endpoint: HomeEndpoint): string | null {
  if (!endpoint.metadata_json) return null;
  try {
    const metadata = JSON.parse(endpoint.metadata_json) as Record<string, unknown>;
    return typeof metadata.runtime_adapter === "string"
      ? metadata.runtime_adapter.trim().toLowerCase()
      : null;
  } catch {
    return null;
  }
}
