import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import {
  deleteField,
  FieldAlreadyExistsError,
  FieldIdMismatchError,
  FieldRendererInvalidError,
  FieldValidationError,
  loadAllFields,
  loadField,
  upsertFieldLayout,
  upsertFieldSemantic,
  type FieldLayout,
  type FieldSemantic
} from "./fields-store.js";

function makeSemantic(overrides: Partial<FieldSemantic> = {}): FieldSemantic {
  return {
    schema: "floe.field.v1",
    id: "inbound-pr-review",
    title: "Inbound PR Review",
    description: "Working map for incoming GitHub PRs.",
    items: [
      { item_id: "pr_actor", ref: "actor:floe" },
      { item_id: "pr_context", ref: "context:ctx_123" }
    ],
    connections: [
      { id: "actor_to_ctx", from: "pr_actor", to: "pr_context", label: "handles" }
    ],
    created_at: "2026-05-19T15:00:00.000Z",
    updated_at: "2026-05-19T16:00:00.000Z",
    ...overrides
  };
}

function makeLayout(overrides: Partial<FieldLayout> = {}): FieldLayout {
  return {
    schema: "floe.field.layout.floeweb.v1",
    field_id: "inbound-pr-review",
    viewport: { x: 0, y: 0, zoom: 1 },
    items: {
      pr_actor: { x: 100, y: 200, width: 240, height: 120 },
      pr_context: { x: 400, y: 200, collapsed: false }
    },
    ...overrides
  };
}

describe("fields-store", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-fields-store-"));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("loadField returns null when the semantic file is missing", () => {
    expect(loadField(workspace, "does-not-exist")).toBeNull();
  });

  it("upsertFieldSemantic writes a valid Field and loadField round-trips it", () => {
    const written = upsertFieldSemantic(workspace, "inbound-pr-review", makeSemantic());

    expect(written.id).toBe("inbound-pr-review");
    expect(existsSync(join(workspace, ".floe", "fields", "inbound-pr-review.yaml"))).toBe(true);

    const loaded = loadField(workspace, "inbound-pr-review");
    expect(loaded).not.toBeNull();
    expect(loaded?.semantic.id).toBe("inbound-pr-review");
    expect(loaded?.semantic.items).toHaveLength(2);
    expect(loaded?.semantic.connections[0].label).toBe("handles");
    expect(loaded?.layout).toBeUndefined();
  });

  it("upsertFieldSemantic rejects a malformed body with FieldValidationError", () => {
    const bad = { schema: "floe.field.v1", id: "inbound-pr-review" } as unknown;
    expect(() => upsertFieldSemantic(workspace, "inbound-pr-review", bad)).toThrow(
      FieldValidationError
    );
  });

  it("upsertFieldSemantic rejects body id != path id with FieldIdMismatchError", () => {
    expect(() =>
      upsertFieldSemantic(workspace, "inbound-pr-review", makeSemantic({ id: "other-id" }))
    ).toThrow(FieldIdMismatchError);
  });

  it("upsertFieldSemantic with ifAbsent rejects existing files; default mode overwrites", () => {
    upsertFieldSemantic(workspace, "inbound-pr-review", makeSemantic());

    expect(() =>
      upsertFieldSemantic(workspace, "inbound-pr-review", makeSemantic(), { ifAbsent: true })
    ).toThrow(FieldAlreadyExistsError);

    const updated = upsertFieldSemantic(
      workspace,
      "inbound-pr-review",
      makeSemantic({ title: "Renamed" })
    );
    expect(updated.title).toBe("Renamed");
  });

  it("upsertFieldSemantic preserves created_at and bumps updated_at on overwrite", async () => {
    const first = upsertFieldSemantic(workspace, "f", makeSemantic({ id: "f" }));
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertFieldSemantic(
      workspace,
      "f",
      makeSemantic({ id: "f", created_at: "2099-01-01T00:00:00.000Z" })
    );
    expect(second.created_at).toBe(first.created_at);
    expect(Date.parse(second.updated_at)).toBeGreaterThanOrEqual(Date.parse(first.updated_at));
  });

  it("upsertFieldSemantic rejects connections whose from/to are not item_ids", () => {
    const body = makeSemantic({
      connections: [{ id: "c1", from: "pr_actor", to: "ghost" }]
    });
    expect(() => upsertFieldSemantic(workspace, "inbound-pr-review", body)).toThrow(
      FieldValidationError
    );
  });

  it("upsertFieldSemantic rejects duplicate item_id values", () => {
    const body = makeSemantic({
      items: [
        { item_id: "dup", ref: "actor:floe" },
        { item_id: "dup", ref: "context:ctx_123" }
      ],
      connections: []
    });
    expect(() => upsertFieldSemantic(workspace, "inbound-pr-review", body)).toThrow(
      FieldValidationError
    );
  });

  it("loadAllFields lists fields with counts and ignores layout sidecars", () => {
    upsertFieldSemantic(workspace, "alpha", makeSemantic({ id: "alpha", title: "Alpha" }));
    upsertFieldSemantic(
      workspace,
      "beta",
      makeSemantic({
        id: "beta",
        title: "Beta",
        items: [{ item_id: "only", ref: "actor:floe" }],
        connections: []
      })
    );
    upsertFieldLayout(workspace, "alpha", "floeweb", makeLayout({ field_id: "alpha", items: {} }));

    const summaries = loadAllFields(workspace);
    expect(summaries.map((s) => s.id)).toEqual(["alpha", "beta"]);
    const alpha = summaries.find((s) => s.id === "alpha")!;
    expect(alpha.title).toBe("Alpha");
    expect(alpha.item_count).toBe(2);
    expect(alpha.connection_count).toBe(1);
    const beta = summaries.find((s) => s.id === "beta")!;
    expect(beta.item_count).toBe(1);
    expect(beta.connection_count).toBe(0);
  });

  it("loadAllFields returns an empty array when .floe/fields/ is missing", () => {
    expect(loadAllFields(workspace)).toEqual([]);
  });

  it("upsertFieldLayout writes a sidecar and loadField returns it alongside the semantic without changing the semantic file", async () => {
    upsertFieldSemantic(workspace, "inbound-pr-review", makeSemantic());
    const semanticFile = join(workspace, ".floe", "fields", "inbound-pr-review.yaml");
    const mtimeBefore = statSync(semanticFile).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));

    upsertFieldLayout(workspace, "inbound-pr-review", "floeweb", makeLayout());

    const mtimeAfter = statSync(semanticFile).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    expect(
      existsSync(join(workspace, ".floe", "fields", "inbound-pr-review.layout.floeweb.yaml"))
    ).toBe(true);

    const loaded = loadField(workspace, "inbound-pr-review");
    expect(loaded?.layout?.field_id).toBe("inbound-pr-review");
    expect(loaded?.layout?.items.pr_actor.x).toBe(100);
  });

  it("upsertFieldLayout rejects bad renderer names and layout body mismatches", () => {
    upsertFieldSemantic(workspace, "inbound-pr-review", makeSemantic());

    expect(() =>
      upsertFieldLayout(workspace, "inbound-pr-review", "Bad Renderer", makeLayout())
    ).toThrow(FieldRendererInvalidError);

    expect(() =>
      upsertFieldLayout(workspace, "inbound-pr-review", "floeweb", { schema: "wrong" })
    ).toThrow(FieldValidationError);

    expect(() =>
      upsertFieldLayout(
        workspace,
        "inbound-pr-review",
        "floeweb",
        makeLayout({ field_id: "other-id" })
      )
    ).toThrow(FieldIdMismatchError);
  });

  it("deleteField removes the semantic file and every layout sidecar; idempotent on missing fields", () => {
    upsertFieldSemantic(workspace, "inbound-pr-review", makeSemantic());
    upsertFieldLayout(workspace, "inbound-pr-review", "floeweb", makeLayout());
    // hand-written second renderer sidecar
    const dir = join(workspace, ".floe", "fields");
    writeFileSync(
      join(dir, "inbound-pr-review.layout.cli.yaml"),
      YAML.stringify(makeLayout())
    );

    const result = deleteField(workspace, "inbound-pr-review");
    expect(result.semanticDeleted).toBe(true);
    expect(result.layoutsDeleted).toHaveLength(2);
    expect(readdirSync(dir)).toEqual([]);

    // idempotent
    const second = deleteField(workspace, "inbound-pr-review");
    expect(second.semanticDeleted).toBe(false);
    expect(second.layoutsDeleted).toEqual([]);
  });
});
