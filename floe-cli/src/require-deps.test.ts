import { describe, expect, it } from "vitest";
import { assertRuntimeDepsResolvable, findUnresolvedDeps, staleDependencyMessage } from "./require-deps.js";

describe("runtime dependency preflight", () => {
  it("reports deps whose resolver throws as unresolved", () => {
    const resolve = (id: string): string => {
      if (id === "present-pkg") return "/node_modules/present-pkg/index.js";
      throw new Error(`Cannot find package '${id}'`);
    };
    expect(findUnresolvedDeps(["present-pkg", "missing-pkg"], resolve)).toEqual(["missing-pkg"]);
  });

  it("produces a clear, actionable stale-dependency message", () => {
    const message = staleDependencyMessage(["@earendil-works/pi-ai"]);
    expect(message).toContain("@earendil-works/pi-ai");
    expect(message).toContain("stale");
    expect(message).toContain("npm install");
  });

  it("does not throw when all required deps resolve in this workspace", () => {
    expect(() => assertRuntimeDepsResolvable()).not.toThrow();
  });
});
