/**
 * modelsForProfile — profile → provider → models constraint.
 *
 * Profile/provider model-binding behavior is implemented here as a reusable helper.
 * Both
 * the actor inspector (scope=agent) and Workspace Settings (scope=workspace_default)
 * can share one constrained-list rule instead of reimplementing it twice.
 *
 * Rule: a profile is bound to exactly one provider (AuthProfileRecord.provider).
 * The model list for that profile is `getAuthModels(provider)` — i.e. every
 * model the provider's auth profile family knows about. There is no
 * profile-specific (as opposed to provider-specific) restriction in the
 * substrate today, so "constrained to the profile" == "constrained to the
 * profile's provider".
 */
import type { AuthModelRecord, AuthProfileRecord } from "../bus-client/types.ts";
import { getAuthModels } from "../bus-client/client.ts";

/** Find the provider for a given profile id. Returns null if the profile is unknown. */
export function providerForProfile(
  profiles: AuthProfileRecord[],
  profileId: string | null
): string | null {
  if (!profileId) return null;
  return profiles.find((p) => p.id === profileId)?.provider ?? null;
}

/**
 * Fetch the models available for a given profile, constrained to that
 * profile's provider. Returns an empty list if no profile/provider is set.
 */
export async function modelsForProfile(
  profiles: AuthProfileRecord[],
  profileId: string | null
): Promise<AuthModelRecord[]> {
  const provider = providerForProfile(profiles, profileId);
  if (!provider) return [];
  return getAuthModels(provider);
}

/**
 * Ensure the currently-selected model still shows up in the dropdown even if
 * the live provider model list doesn't include it (e.g. a model that was
 * valid when bound but has since rotated out of the catalog). Keeps a currently
 * selected model visible when the provider catalog changes.
 */
export function withSelectedModelOption(
  models: AuthModelRecord[],
  selectedModelId: string | null | undefined,
  provider: string | null
): AuthModelRecord[] {
  if (!selectedModelId || models.some((m) => m.id === selectedModelId)) return models;
  return [
    ...models,
    {
      id: selectedModelId,
      name: selectedModelId,
      provider: provider ?? "",
      api: "",
      reasoning: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Endpoint-id convention
// ---------------------------------------------------------------------------

/**
 * Actor endpoint ids use `actor:<workspace_id>:<slug>`, with the reserved
 * "operator" slug generalized for arbitrary actor names.
 */
export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "actor";
}

export function actorEndpointId(workspaceId: string, name: string): string {
  return `actor:${workspaceId}:${slugify(name)}`;
}
