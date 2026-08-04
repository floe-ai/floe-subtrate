import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Resolve from this file, never process.cwd() — a cwd-relative lookup can fall
// through to the repo-root package.json and pass vacuously.
const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("core UI extension dependencies", () => {
  it("does not depend on any extension package", () => {
    const deps = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    expect(deps.filter(name => name.startsWith("floe-ext-"))).toEqual([]);
  });

  it("reads its own package.json, not the repo root", () => {
    expect(pkg.name).toBe("floe-app");
  });

});
