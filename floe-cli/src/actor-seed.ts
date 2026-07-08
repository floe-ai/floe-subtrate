/**
 * actor-seed — seed a default human actor after workspace registration.
 *
 * Stores the actor exclusively in the bus DB via POST /v1/endpoints/register
 * (an upsert). No file is written to the workspace tree, so git status stays
 * clean in any workspace. The actor persists across bridge restarts; a factory
 * reset wipes the bus DB, but the next `floe setup` call re-seeds it.
 *
 * Idempotency: lists current endpoints first; only registers if the default
 * operator endpoint does not already exist.
 */

export const DEFAULT_ACTOR_SLUG = "operator";
export const DEFAULT_ACTOR_NAME = "Operator";

/** Mirror of the endpoint-id convention used across the substrate. */
export function actorEndpointId(workspaceId: string, slug: string): string {
  return `actor:${workspaceId}:${slug}`;
}

export type SeedResult =
  | { seeded: true; endpoint_id: string }
  | { seeded: false; reason: "already_exists" | "list_failed" | "register_failed" };

/**
 * Seed the default human operator actor for a workspace, if not already present.
 *
 * @param busHttpBase  HTTP base URL for the bus (e.g. "http://127.0.0.1:5174")
 * @param workspaceId  The workspace_id returned by /v1/workspaces/register
 * @param fetchFn      Optional fetch implementation (defaults to globalThis.fetch; injectable for tests)
 * @returns            A SeedResult indicating whether the actor was created
 */
export async function seedDefaultActor(
  busHttpBase: string,
  workspaceId: string,
  fetchFn: typeof fetch = globalThis.fetch
): Promise<SeedResult> {
  const endpointId = actorEndpointId(workspaceId, DEFAULT_ACTOR_SLUG);
  const base = busHttpBase.replace(/\/$/, "");

  // Check if the default actor already exists
  let listRes: Response;
  try {
    listRes = await fetchFn(`${base}/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
  } catch {
    return { seeded: false, reason: "list_failed" };
  }
  if (!listRes.ok) return { seeded: false, reason: "list_failed" };

  const { endpoints } = (await listRes.json()) as { endpoints: Array<{ endpoint_id: string }> };
  if (endpoints.some((ep) => ep.endpoint_id === endpointId)) {
    return { seeded: false, reason: "already_exists" };
  }

  // Register the default operator actor (bus-only; no workspace file written)
  let regRes: Response;
  try {
    regRes = await fetchFn(`${base}/v1/endpoints/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint_id: endpointId,
        workspace_id: workspaceId,
        name: DEFAULT_ACTOR_NAME,
        agent_id: DEFAULT_ACTOR_SLUG,
        bridge_id: null,
        status: "idle",
      }),
    });
  } catch {
    return { seeded: false, reason: "register_failed" };
  }
  if (!regRes.ok) return { seeded: false, reason: "register_failed" };

  return { seeded: true, endpoint_id: endpointId };
}
