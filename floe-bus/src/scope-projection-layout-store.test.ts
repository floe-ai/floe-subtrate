import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadScopeProjectionLayout,
  ScopeProjectionLayoutIdMismatchError,
  ScopeProjectionLayoutRendererInvalidError,
  ScopeProjectionLayoutValidationError,
  upsertScopeProjectionLayout,
  type ScopeProjectionLayout
} from "./scope-projection-layout-store.js";

function makeLayout(scopeId: string, overrides: Partial<ScopeProjectionLayout> = {}): ScopeProjectionLayout {
  return {
    schema: "floe.scope-projection.layout.floe-app.v1",
    scope_id: scopeId,
    viewport: { x: 0, y: 0, zoom: 1 },
    items: {
      "context:ctx_research": { x: 100, y: 200, width: 240, height: 120 },
      "pulse:pulse_daily": { x: 400, y: 200, collapsed: false }
    },
    ...overrides
  };
}

describe("scope-projection-layout-store", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-scope-projection-layout-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("round-trips renderer layout for a Scope id without separate semantic files", () => {
    const layout = makeLayout("scope/with space");

    const written = upsertScopeProjectionLayout(workspace, "scope/with space", "floe-app", layout);
    const loaded = loadScopeProjectionLayout(workspace, "scope/with space", "floe-app");

    expect(written).toEqual(layout);
    expect(loaded).toEqual(layout);
    expect(existsSync(join(workspace, ".floe", "scope-projection-layouts", "scope%2Fwith%20space.layout.floe-app.yaml"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "fields", "scope/with space.yaml"))).toBe(false);
    expect(existsSync(join(workspace, ".floe", "blocks"))).toBe(false);
  });

  it("returns null when a Scope Projection layout sidecar is missing", () => {
    expect(loadScopeProjectionLayout(workspace, "missing", "floe-app")).toBeNull();
  });



  it("rejects invalid layout bodies, renderers, and path/body id mismatches", () => {
    expect(() =>
      upsertScopeProjectionLayout(workspace, "default", "Bad Renderer", makeLayout("default"))
    ).toThrow(ScopeProjectionLayoutRendererInvalidError);

    expect(() =>
      upsertScopeProjectionLayout(workspace, "default", "floe-app", { schema: "wrong" })
    ).toThrow(ScopeProjectionLayoutValidationError);

    expect(() =>
      upsertScopeProjectionLayout(workspace, "default", "floe-app", makeLayout("other"))
    ).toThrow(ScopeProjectionLayoutIdMismatchError);
  });
});
