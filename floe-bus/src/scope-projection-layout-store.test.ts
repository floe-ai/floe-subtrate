import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
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
    schema: "floe.field.layout.floeweb.v1",
    field_id: scopeId,
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

  it("round-trips renderer layout for a Scope id without Field-owned semantic files", () => {
    const layout = makeLayout("scope/with space");

    const written = upsertScopeProjectionLayout(workspace, "scope/with space", "floeweb", layout);
    const loaded = loadScopeProjectionLayout(workspace, "scope/with space", "floeweb");

    expect(written).toEqual(layout);
    expect(loaded).toEqual(layout);
    expect(existsSync(join(workspace, ".floe", "scope-projection-layouts", "scope%2Fwith%20space.layout.floeweb.yaml"))).toBe(true);
    expect(existsSync(join(workspace, ".floe", "fields", "scope/with space.yaml"))).toBe(false);
    expect(existsSync(join(workspace, ".floe", "blocks"))).toBe(false);
  });

  it("returns null when a Scope Projection layout sidecar is missing", () => {
    expect(loadScopeProjectionLayout(workspace, "missing", "floeweb")).toBeNull();
  });

  it("reads a legacy Field layout sidecar when the new Scope Projection layout path is missing", () => {
    const layout = makeLayout("default", {
      items: { "context:ctx_legacy": { x: 24, y: 48 } }
    });
    const legacyDir = join(workspace, ".floe", "fields");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "default.layout.floeweb.yaml"), YAML.stringify(layout), "utf8");

    expect(loadScopeProjectionLayout(workspace, "default", "floeweb")).toEqual(layout);
    expect(existsSync(join(workspace, ".floe", "scope-projection-layouts"))).toBe(false);
  });

  it("rejects invalid layout bodies, renderers, and path/body id mismatches", () => {
    expect(() =>
      upsertScopeProjectionLayout(workspace, "default", "Bad Renderer", makeLayout("default"))
    ).toThrow(ScopeProjectionLayoutRendererInvalidError);

    expect(() =>
      upsertScopeProjectionLayout(workspace, "default", "floeweb", { schema: "wrong" })
    ).toThrow(ScopeProjectionLayoutValidationError);

    expect(() =>
      upsertScopeProjectionLayout(workspace, "default", "floeweb", makeLayout("other"))
    ).toThrow(ScopeProjectionLayoutIdMismatchError);
  });
});
