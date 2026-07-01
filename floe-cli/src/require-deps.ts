/**
 * Runtime packages every Floe service imports at startup. A stale `node_modules`
 * (e.g. after a dependency rename bump) leaves these unresolved, and every service
 * then dies deep in an import with a raw `ERR_MODULE_NOT_FOUND`. We fail fast with a
 * clear "run npm install" message instead.
 *
 * These are ESM-only packages, so resolution goes through `import.meta.resolve`
 * (CommonJS `require.resolve` cannot resolve their `exports` map).
 */
export const REQUIRED_RUNTIME_DEPS = ["@earendil-works/pi-ai", "@earendil-works/pi-agent-core"];

function defaultResolve(id: string): string {
  return import.meta.resolve(id);
}

export function findUnresolvedDeps(
  deps: string[],
  resolve: (id: string) => string = defaultResolve
): string[] {
  const missing: string[] = [];
  for (const dep of deps) {
    try {
      resolve(dep);
    } catch {
      missing.push(dep);
    }
  }
  return missing;
}

export function staleDependencyMessage(missing: string[]): string {
  return (
    `Floe dependencies are stale: ${missing.join(", ")} could not be resolved.\n` +
    `This usually means node_modules is out of date after a version bump.\n` +
    `Reinstall dependencies before starting Floe:\n` +
    `  npm install`
  );
}

/** Throws a clear, actionable error if any required runtime dependency is unresolved. */
export function assertRuntimeDepsResolvable(deps: string[] = REQUIRED_RUNTIME_DEPS): void {
  const missing = findUnresolvedDeps(deps);
  if (missing.length > 0) throw new Error(staleDependencyMessage(missing));
}
