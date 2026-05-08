/**
 * Environment sanitisation — strips Floe-managed secrets from spawned
 * process environments.
 *
 * Used by the bash tool to prevent leaking auth tokens, API keys, and
 * provider credentials into child processes.
 *
 * Policy:
 * - Strip known Floe-managed env vars (auth tokens, provider keys)
 * - Strip vars matching common credential patterns
 * - Do NOT log env variable values
 * - Do NOT claim full secret prevention for arbitrary workspace content
 */

/** Env var names/prefixes that Floe manages and must strip */
const FLOE_MANAGED_PATTERNS = [
  /^FLOE_/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^COPILOT_/i,
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^AZURE_OPENAI_/i,
  /^PI_/i,
];

/**
 * Create a sanitised copy of the environment, stripping Floe-managed secrets.
 * Returns a new object — does not mutate the input.
 */
export function sanitiseEnvironment(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const sanitised: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isFloeManaged(key)) continue;
    sanitised[key] = value;
  }

  return sanitised;
}

function isFloeManaged(key: string): boolean {
  return FLOE_MANAGED_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * List the env var names that would be stripped (for logging/debugging).
 * Returns names only — never values.
 */
export function listStrippedVarNames(
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return Object.keys(env).filter(isFloeManaged);
}
