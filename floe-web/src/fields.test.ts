import type { NodeChange } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import {
  applyNodeChangesToLayout,
  itemKindFromRef,
  parseFieldRef,
  reactFlowToLayout,
  type FieldLayoutFloeweb
} from "./fields";

describe("parseFieldRef", () => {
  it("parses substrate refs that Scope Projection can render", () => {
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

  it("returns unknown for malformed or unsupported refs without creating membership semantics", () => {
    expect(parseFieldRef("widget:thing")).toEqual({ kind: "unknown", id: "widget:thing", raw: "widget:thing" });
    expect(parseFieldRef("nocolon")).toEqual({ kind: "unknown", id: "nocolon", raw: "nocolon" });
    expect(parseFieldRef(":noKind").kind).toBe("unknown");
    expect(parseFieldRef("noId:").kind).toBe("unknown");
    expect(itemKindFromRef("pulse:daily")).toBe("pulse");
  });
});

describe("renderer layout helpers", () => {
  it("serializes React Flow node positions into renderer-only layout", () => {
    const layout = reactFlowToLayout(
      "default",
      [
        {
          id: "context:ctx_1",
          position: { x: 100, y: 200 },
          data: {},
          width: 180,
          height: 90
        },
        {
          id: "pulse:pulse_1",
          position: { x: 320, y: 200 },
          data: {}
        }
      ],
      { x: -25, y: 10, zoom: 0.75 }
    );

    expect(layout).toEqual({
      schema: "floe.field.layout.floeweb.v1",
      field_id: "default",
      viewport: { x: -25, y: 10, zoom: 0.75 },
      items: {
        "context:ctx_1": { x: 100, y: 200, width: 180, height: 90 },
        "pulse:pulse_1": { x: 320, y: 200 }
      }
    });
  });

  it("applies only position and dimension changes to layout", () => {
    const prev: FieldLayoutFloeweb = {
      schema: "floe.field.layout.floeweb.v1",
      field_id: "default",
      viewport: { x: 0, y: 0, zoom: 1 },
      items: {
        "context:ctx_1": { x: 1, y: 2 },
        "pulse:pulse_1": { x: 3, y: 4 }
      }
    };
    const changes: NodeChange[] = [
      { type: "select", id: "context:ctx_1", selected: true },
      { type: "position", id: "context:ctx_1", position: { x: 10, y: 20 }, dragging: false },
      { type: "dimensions", id: "pulse:pulse_1", dimensions: { width: 240, height: 120 }, resizing: false }
    ];

    expect(applyNodeChangesToLayout(prev, changes)).toEqual({
      ...prev,
      items: {
        "context:ctx_1": { x: 10, y: 20 },
        "pulse:pulse_1": { x: 3, y: 4, width: 240, height: 120 }
      }
    });
  });

  it("returns the original layout object when no renderer layout change occurred", () => {
    const prev: FieldLayoutFloeweb = {
      schema: "floe.field.layout.floeweb.v1",
      field_id: "default",
      viewport: { x: 0, y: 0, zoom: 1 },
      items: {}
    };

    expect(applyNodeChangesToLayout(prev, [{ type: "select", id: "context:ctx_1", selected: true }])).toBe(prev);
  });
});
