/**
 * App-level tests — Slice 1.
 *
 * The THINKING_LEVELS / WorkspaceConfigPanel mocked-call-spy tests from the
 * previous round tested removed code. They are replaced here.
 *
 * Slice 1 acceptance is verified by running the app and clicking through;
 * meaningful behavior tests will be added in later slices when there is
 * real behavior to assert at the seams.
 */
import { describe, it, expect } from "vitest";

describe("App smoke", () => {
  it("module loads without error", async () => {
    // Dynamic import so we don't need a DOM env here
    const mod = await import("./App.tsx");
    expect(typeof mod.App).toBe("function");
  });
});
