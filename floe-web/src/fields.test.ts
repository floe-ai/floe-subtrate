import { describe, expect, it } from "vitest";
import {
  parseFieldRef,
  itemKindFromRef,
  fieldToReactFlow,
  reactFlowToLayout,
  applyNodeChangesToLayout,
  buildSemanticUpdate,
  defaultLayout,
  FieldSemanticOpError,
  type FieldSemantic,
  type FieldLayoutFloeweb
} from "./fields";
import type { NodeChange } from "@xyflow/react";

const T0 = "2024-06-01T10:00:00.000Z";
const T1 = "2024-06-01T11:00:00.000Z";

function makeSemantic(overrides: Partial<FieldSemantic> = {}): FieldSemantic {
  return {
    schema: "floe.field.v1",
    id: "field_1",
    title: "Test field",
    items: [],
    connections: [],
    created_at: T0,
    updated_at: T0,
    ...overrides
  };
}

describe("parseFieldRef", () => {
  it("parses each well-known kind", () => {
    const cases: Array<[string, string, string]> = [
      ["actor:floe", "actor", "floe"],
      ["context:ctx_1", "context", "ctx_1"],
      ["pulse:morning", "pulse", "morning"],
      ["webhook:hook_a", "webhook", "hook_a"],
      ["extension:ext_x", "extension", "ext_x"],
      ["file:/path/to/file.md", "file", "/path/to/file.md"],
      ["tool:bash", "tool", "bash"],
      ["work_log:wl_1", "work_log", "wl_1"],
      ["event:evt_1", "event", "evt_1"],
      ["field:field_2", "field", "field_2"]
    ];
    for (const [raw, kind, id] of cases) {
      expect(parseFieldRef(raw)).toEqual({ kind, id, raw });
    }
  });

  it("returns kind 'unknown' for unknown kind prefix", () => {
    const parsed = parseFieldRef("widget:thing");
    expect(parsed.kind).toBe("unknown");
    expect(parsed.raw).toBe("widget:thing");
  });

  it("returns kind 'unknown' for malformed refs without throwing", () => {
    expect(parseFieldRef("nocolon").kind).toBe("unknown");
    expect(parseFieldRef("nocolon").id).toBe("nocolon");
    expect(parseFieldRef(":noKind").kind).toBe("unknown");
    expect(parseFieldRef("noId:").kind).toBe("unknown");
    expect(parseFieldRef("").kind).toBe("unknown");
  });

  it("itemKindFromRef returns the kind only", () => {
    expect(itemKindFromRef("actor:floe")).toBe("actor");
    expect(itemKindFromRef("garbage")).toBe("unknown");
  });
});

describe("fieldToReactFlow", () => {
  it("produces a node per item with id = item_id and parsed ref in data", () => {
    const semantic = makeSemantic({
      items: [
        { item_id: "n1", ref: "actor:floe" },
        { item_id: "n2", ref: "context:ctx_a" }
      ]
    });
    const { nodes } = fieldToReactFlow(semantic);
    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe("n1");
    expect(nodes[0].type).toBe("fieldItem");
    const data0 = nodes[0].data as { ref: { kind: string; id: string }; kind: string; label: string };
    expect(data0.ref).toEqual({ kind: "actor", id: "floe", raw: "actor:floe" });
    expect(data0.kind).toBe("actor");
    expect(data0.label).toBe("floe");
  });

  it("uses layout positions when present; falls back to deterministic grid", () => {
    const semantic = makeSemantic({
      items: [
        { item_id: "n1", ref: "actor:a" },
        { item_id: "n2", ref: "actor:b" }
      ]
    });
    const layout: FieldLayoutFloeweb = {
      schema: "floe.field.layout.floeweb.v1",
      field_id: "field_1",
      viewport: { x: 0, y: 0, zoom: 1 },
      items: { n1: { x: 500, y: 300, width: 200, height: 100 } }
    };
    const { nodes } = fieldToReactFlow(semantic, layout);
    expect(nodes[0].position).toEqual({ x: 500, y: 300 });
    expect(nodes[0].width).toBe(200);
    expect(nodes[0].height).toBe(100);
    expect(nodes[1].position).toEqual(defaultLayout(1));
    expect(nodes[1].width).toBeUndefined();
  });

  it("produces an edge per connection referencing item_ids", () => {
    const semantic = makeSemantic({
      items: [
        { item_id: "n1", ref: "actor:a" },
        { item_id: "n2", ref: "actor:b" }
      ],
      connections: [
        { id: "e1", from: "n1", to: "n2", label: "talks to", metadata: { weight: 1 } }
      ]
    });
    const { edges } = fieldToReactFlow(semantic);
    expect(edges).toHaveLength(1);
    expect(edges[0].id).toBe("e1");
    expect(edges[0].source).toBe("n1");
    expect(edges[0].target).toBe("n2");
    expect(edges[0].label).toBe("talks to");
    const data = edges[0].data as { metadata: { weight: number } };
    expect(data.metadata).toEqual({ weight: 1 });
  });

  it("handles a field with zero items", () => {
    const { nodes, edges } = fieldToReactFlow(makeSemantic());
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("handles unknown ref kinds without crashing", () => {
    const semantic = makeSemantic({
      items: [{ item_id: "n1", ref: "wat:nope" }]
    });
    const { nodes } = fieldToReactFlow(semantic);
    const data = nodes[0].data as { kind: string; label: string };
    expect(data.kind).toBe("unknown");
    expect(data.label).toBe("wat:nope");
  });
});

describe("reactFlowToLayout", () => {
  it("produces a layout with positions and viewport, omitting missing width/height", () => {
    const layout = reactFlowToLayout(
      "field_1",
      [
        { id: "n1", position: { x: 10, y: 20 }, data: {}, width: 100, height: 60 },
        { id: "n2", position: { x: 30, y: 40 }, data: {} }
      ],
      { x: 5, y: 6, zoom: 1.5 }
    );
    expect(layout.schema).toBe("floe.field.layout.floeweb.v1");
    expect(layout.field_id).toBe("field_1");
    expect(layout.viewport).toEqual({ x: 5, y: 6, zoom: 1.5 });
    expect(layout.items.n1).toEqual({ x: 10, y: 20, width: 100, height: 60 });
    expect(layout.items.n2).toEqual({ x: 30, y: 40 });
    expect("width" in layout.items.n2).toBe(false);
    expect("height" in layout.items.n2).toBe(false);
  });
});

describe("applyNodeChangesToLayout", () => {
  const base: FieldLayoutFloeweb = {
    schema: "floe.field.layout.floeweb.v1",
    field_id: "field_1",
    viewport: { x: 0, y: 0, zoom: 1 },
    items: { n1: { x: 10, y: 20 } }
  };

  it("updates positions on position-change events", () => {
    const changes: NodeChange[] = [
      { id: "n1", type: "position", position: { x: 100, y: 200 } }
    ];
    const next = applyNodeChangesToLayout(base, changes);
    expect(next.items.n1).toEqual({ x: 100, y: 200 });
  });

  it("updates dimensions on dimension-change events", () => {
    const changes: NodeChange[] = [
      { id: "n1", type: "dimensions", dimensions: { width: 250, height: 80 } }
    ];
    const next = applyNodeChangesToLayout(base, changes);
    expect(next.items.n1).toEqual({ x: 10, y: 20, width: 250, height: 80 });
  });

  it("leaves layout untouched on select/remove events", () => {
    const changes: NodeChange[] = [
      { id: "n1", type: "select", selected: true },
      { id: "n1", type: "remove" }
    ];
    const next = applyNodeChangesToLayout(base, changes);
    expect(next).toBe(base);
  });
});

describe("buildSemanticUpdate", () => {
  it("rename updates title and bumps updated_at, preserves created_at", () => {
    const prev = makeSemantic({ title: "Old" });
    const next = buildSemanticUpdate(prev, { type: "rename", title: "New" }, T1);
    expect(next.title).toBe("New");
    expect(next.updated_at).toBe(T1);
    expect(next.created_at).toBe(T0);
  });

  it("add_item appends; rejects duplicate item_id", () => {
    const prev = makeSemantic({ items: [{ item_id: "n1", ref: "actor:a" }] });
    const next = buildSemanticUpdate(
      prev,
      { type: "add_item", item: { item_id: "n2", ref: "actor:b" } },
      T1
    );
    expect(next.items.map((i) => i.item_id)).toEqual(["n1", "n2"]);
    expect(next.updated_at).toBe(T1);
    expect(() =>
      buildSemanticUpdate(
        prev,
        { type: "add_item", item: { item_id: "n1", ref: "actor:dup" } },
        T1
      )
    ).toThrow(FieldSemanticOpError);
  });

  it("remove_item cascades: removes item AND all connections touching it", () => {
    const prev = makeSemantic({
      items: [
        { item_id: "n1", ref: "actor:a" },
        { item_id: "n2", ref: "actor:b" },
        { item_id: "n3", ref: "actor:c" }
      ],
      connections: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
        { id: "e3", from: "n1", to: "n3" }
      ]
    });
    const next = buildSemanticUpdate(prev, { type: "remove_item", item_id: "n2" }, T1);
    expect(next.items.map((i) => i.item_id)).toEqual(["n1", "n3"]);
    expect(next.connections.map((c) => c.id)).toEqual(["e3"]);
    expect(next.updated_at).toBe(T1);
  });

  it("add_connection appends; rejects unknown from/to; rejects duplicate id", () => {
    const prev = makeSemantic({
      items: [
        { item_id: "n1", ref: "actor:a" },
        { item_id: "n2", ref: "actor:b" }
      ],
      connections: [{ id: "e1", from: "n1", to: "n2" }]
    });
    const next = buildSemanticUpdate(
      prev,
      { type: "add_connection", connection: { id: "e2", from: "n2", to: "n1" } },
      T1
    );
    expect(next.connections.map((c) => c.id)).toEqual(["e1", "e2"]);
    expect(() =>
      buildSemanticUpdate(
        prev,
        { type: "add_connection", connection: { id: "e3", from: "nX", to: "n1" } },
        T1
      )
    ).toThrow(FieldSemanticOpError);
    expect(() =>
      buildSemanticUpdate(
        prev,
        { type: "add_connection", connection: { id: "e4", from: "n1", to: "nY" } },
        T1
      )
    ).toThrow(FieldSemanticOpError);
    expect(() =>
      buildSemanticUpdate(
        prev,
        { type: "add_connection", connection: { id: "e1", from: "n1", to: "n2" } },
        T1
      )
    ).toThrow(FieldSemanticOpError);
  });

  it("remove_connection removes by id and is idempotent on missing", () => {
    const prev = makeSemantic({
      items: [
        { item_id: "n1", ref: "actor:a" },
        { item_id: "n2", ref: "actor:b" }
      ],
      connections: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n1" }
      ]
    });
    const next = buildSemanticUpdate(prev, { type: "remove_connection", id: "e1" }, T1);
    expect(next.connections.map((c) => c.id)).toEqual(["e2"]);
    expect(next.updated_at).toBe(T1);

    const noop = buildSemanticUpdate(prev, { type: "remove_connection", id: "missing" }, T1);
    expect(noop).toBe(prev);
  });
});
