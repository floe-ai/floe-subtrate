import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExtensionView } from "./scope/ScopeDetail.tsx";

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

  it("falls back to the placeholder for an unknown extension view", () => {
    expect(resolveExtensionView("nope", "Nope").name).toBe("PlaceholderExtensionView");
  });

  // Extensions are optional: with none installed this asserts nothing, which is
  // correct. While one IS present it pins the floe-ext-{name}/src/ui/{component}
  // convention — otherwise a rename silently degrades the tab to the placeholder.
  it("resolves a present extension view via the naming convention", () => {
    const installed = Object.keys(import.meta.glob("../../floe-ext-*/src/ui/*.tsx"))
      .some(k => k.includes("floe-ext-snowball/src/ui/BoardView.tsx"));
    if (!installed) return;
    expect(resolveExtensionView("snowball", "BoardView").name).toBe("BoardView");
  });
});
