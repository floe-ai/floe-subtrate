/**
 * Actor-neutral reference facade.
 *
 * The bus stores legacy `endpoint:<workspace>:<type>:<ref>` identifiers
 * where `<type>` is one of `user`, `human`, `agent`, `webhook`, `runtime`,
 * `system`, etc. Exposing those identifiers (or the `actor_type` field) to
 * agents lets them cite substrate metadata when distinguishing humans from
 * agents — which violates the actor-neutral substrate direction.
 *
 * This module is the bridge-side facade that strips category-revealing
 * segments before any endpoint information reaches an agent's prompt or
 * tool output, and resolves neutral refs back to legacy ids when the agent
 * targets one in `emit`.
 *
 * Storage and bus contracts are intentionally unchanged.
 */

const KNOWN_TYPE_SEGMENTS = new Set([
  "user",
  "human",
  "agent",
  "webhook",
  "runtime",
  "system",
  "cli",
  "web",
  "slack",
  "api",
]);

/**
 * Convert a legacy endpoint id to a neutral actor ref (just the actor's
 * local name, with no category prefix).
 *
 * Legacy ids have the shape `endpoint:<workspace_id>:<type>:<ref>` where
 * `<workspace_id>` itself may contain colons (e.g. `workspace:test`) and
 * `<ref>` may contain colons too. We locate the category by scanning for
 * the first known type segment after the `endpoint` prefix; everything
 * after it is the neutral ref.
 *
 * Examples:
 *   endpoint:workspace:abc:agent:floe              -> "floe"
 *   endpoint:workspace:abc:user:operator           -> "operator"
 *   endpoint:ws-a:user:operator                    -> "operator"
 *   endpoint:ws:agent:my:special:agent             -> "my:special:agent"
 *   "operator"                                     -> "operator"   (already neutral)
 *   "short:ref"                                    -> "short:ref"  (no recognised type segment)
 */
export function toNeutralRef(endpointId: string): string {
  if (!endpointId) return endpointId;
  const parts = endpointId.split(":");
  if (parts[0] !== "endpoint" || parts.length < 4) return endpointId;
  // Scan from index 2 (skip "endpoint" + at least one workspace segment) for
  // the first known type segment. The remainder is the neutral ref.
  for (let i = 2; i < parts.length - 1; i++) {
    if (KNOWN_TYPE_SEGMENTS.has(parts[i])) {
      return parts.slice(i + 1).join(":");
    }
  }
  return endpointId;
}

/**
 * Resolve a neutral ref against a workspace's endpoint list back to a
 * legacy endpoint id.
 *
 * Returns:
 *   - the matching legacy endpoint id when exactly one candidate matches
 *   - the input unchanged when it is already a legacy `endpoint:` id
 *     present in the list (pass-through for backward compat)
 *   - null when no candidate matches
 *   - null (with a console.warn) when multiple candidates collide
 */
export function fromNeutralRef(
  ref: string,
  endpoints: Array<{ endpoint_id: string }>,
): string | null {
  if (!ref) return null;
  // Pass-through: caller already holds a full legacy id.
  if (ref.startsWith("endpoint:")) {
    const direct = endpoints.find((ep) => ep.endpoint_id === ref);
    return direct ? direct.endpoint_id : null;
  }
  const matches = endpoints.filter((ep) => toNeutralRef(ep.endpoint_id) === ref);
  if (matches.length === 1) return matches[0].endpoint_id;
  if (matches.length === 0) return null;
  console.warn(
    "[bridge] fromNeutralRef: ambiguous neutral ref — multiple endpoints share the same local name",
    { ref, candidates: matches.map((m) => m.endpoint_id) },
  );
  return null;
}

export interface NeutralEndpoint {
  ref: string;
  name: string;
  status: string;
}

/**
 * Strip every category-revealing field from an endpoint object before
 * returning it to an agent. Output contains only `ref`, `name`, `status`.
 */
export function toNeutralEndpoint(ep: {
  endpoint_id: string;
  name: string;
  status: string;
  actor_type?: string;
}): NeutralEndpoint {
  return {
    ref: toNeutralRef(ep.endpoint_id),
    name: ep.name,
    status: ep.status,
  };
}
