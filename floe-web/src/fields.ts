// Pure helpers for the Field substrate primitive.
//
// Translates between the substrate Field model (semantic + layout sidecar) and
// ReactFlow nodes/edges. Mirrors the contexts.ts style: no React, no DOM,
// no fetch, no localStorage. Vitest-exercisable transforms only.

import type { Node, Edge, NodeChange } from "@xyflow/react";

export type FieldItemKind =
  | "actor"
  | "context"
  | "pulse"
  | "webhook"
  | "extension"
  | "file"
  | "tool"
  | "work_log"
  | "event"
  | "field"
  | "unknown";

const KNOWN_KINDS: ReadonlySet<FieldItemKind> = new Set<FieldItemKind>([
  "actor",
  "context",
  "pulse",
  "webhook",
  "extension",
  "file",
  "tool",
  "work_log",
  "event",
  "field"
]);

export type ParsedFieldRef = {
  kind: FieldItemKind;
  id: string;
  raw: string;
};

export type FieldItem = {
  item_id: string;
  ref: string;
};

export type FieldConnection = {
  id: string;
  from: string;
  to: string;
  label?: string;
  metadata?: Record<string, unknown>;
};

export type FieldSemantic = {
  schema: "floe.field.v1";
  id: string;
  title: string;
  description?: string;
  items: FieldItem[];
  connections: FieldConnection[];
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ItemLayout = {
  x: number;
  y: number;
  width?: number;
  height?: number;
  collapsed?: boolean;
};

export type FieldLayoutFloeweb = {
  schema: "floe.field.layout.floeweb.v1";
  field_id: string;
  viewport: { x: number; y: number; zoom: number };
  items: Record<string, ItemLayout>;
};

export type FieldSummary = {
  id: string;
  title: string;
  item_count: number;
  connection_count: number;
  parent_count: number;
  updated_at: string;
};

export type FieldItemNodeData = {
  ref: ParsedFieldRef;
  kind: FieldItemKind;
  label: string;
};

export type FieldEdgeData = {
  metadata?: Record<string, unknown>;
};

export type FieldSemanticOp =
  | { type: "rename"; title: string }
  | { type: "add_item"; item: FieldItem }
  | { type: "remove_item"; item_id: string }
  | { type: "add_connection"; connection: FieldConnection }
  | { type: "update_connection"; connection: FieldConnection }
  | { type: "remove_connection"; id: string };

export class FieldSemanticOpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldSemanticOpError";
  }
}

export function parseFieldRef(ref: string): ParsedFieldRef {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1) {
    return { kind: "unknown", id: ref, raw: ref };
  }
  const kindStr = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (KNOWN_KINDS.has(kindStr as FieldItemKind)) {
    return { kind: kindStr as FieldItemKind, id, raw: ref };
  }
  return { kind: "unknown", id: ref, raw: ref };
}

export function itemKindFromRef(ref: string): FieldItemKind {
  return parseFieldRef(ref).kind;
}

export function deriveLabel(parsed: ParsedFieldRef): string {
  if (parsed.kind === "unknown") return parsed.raw;
  if (parsed.kind === "actor") {
    const parts = parsed.id.split(":").filter(Boolean);
    return parts.at(-1) ?? parsed.id;
  }
  return parsed.id;
}

export function defaultLayout(index: number): { x: number; y: number } {
  return {
    x: 80 + (index % 4) * 260,
    y: 80 + Math.floor(index / 4) * 160
  };
}

function slugifyConnectionPart(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

export function nextFieldConnectionId(semantic: FieldSemantic, from: string, to: string): string {
  const existing = new Set(semantic.connections.map((connection) => connection.id));
  const base = `connection-${slugifyConnectionPart(from)}-to-${slugifyConnectionPart(to)}`;
  if (!existing.has(base)) return base;
  let index = 2;
  while (existing.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

export function fieldToReactFlow(
  semantic: FieldSemantic,
  layout?: FieldLayoutFloeweb
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = semantic.items.map((item, index) => {
    const parsed = parseFieldRef(item.ref);
    const positioned = layout?.items[item.item_id];
    const position = positioned
      ? { x: positioned.x, y: positioned.y }
      : defaultLayout(index);
    const data: FieldItemNodeData = {
      ref: parsed,
      kind: parsed.kind,
      label: deriveLabel(parsed)
    };
    const node: Node = {
      id: item.item_id,
      type: "fieldItem",
      position,
      deletable: false,
      data: data as unknown as Record<string, unknown>
    };
    if (positioned?.width !== undefined) node.width = positioned.width;
    if (positioned?.height !== undefined) node.height = positioned.height;
    return node;
  });

  const edges: Edge[] = semantic.connections.map((conn) => {
    const data: FieldEdgeData = { metadata: conn.metadata };
    const edge: Edge = {
      id: conn.id,
      source: conn.from,
      target: conn.to,
      data: data as unknown as Record<string, unknown>
    };
    if (conn.label !== undefined) edge.label = conn.label;
    return edge;
  });

  return { nodes, edges };
}

export function reactFlowToLayout(
  fieldId: string,
  nodes: Node[],
  viewport: { x: number; y: number; zoom: number }
): FieldLayoutFloeweb {
  const items: Record<string, ItemLayout> = {};
  for (const node of nodes) {
    const entry: ItemLayout = {
      x: node.position.x,
      y: node.position.y
    };
    if (typeof node.width === "number") entry.width = node.width;
    if (typeof node.height === "number") entry.height = node.height;
    items[node.id] = entry;
  }
  return {
    schema: "floe.field.layout.floeweb.v1",
    field_id: fieldId,
    viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
    items
  };
}

export function applyNodeChangesToLayout(
  prev: FieldLayoutFloeweb,
  changes: NodeChange[]
): FieldLayoutFloeweb {
  const items: Record<string, ItemLayout> = { ...prev.items };
  let mutated = false;

  for (const change of changes) {
    if (change.type === "position") {
      if (!change.position) continue;
      const existing = items[change.id] ?? { x: 0, y: 0 };
      items[change.id] = {
        ...existing,
        x: change.position.x,
        y: change.position.y
      };
      mutated = true;
    } else if (change.type === "dimensions") {
      if (!change.dimensions) continue;
      const existing = items[change.id] ?? { x: 0, y: 0 };
      items[change.id] = {
        ...existing,
        width: change.dimensions.width,
        height: change.dimensions.height
      };
      mutated = true;
    }
  }

  if (!mutated) return prev;
  return { ...prev, items };
}

export function buildSemanticUpdate(
  prev: FieldSemantic,
  op: FieldSemanticOp,
  now: string
): FieldSemantic {
  switch (op.type) {
    case "rename":
      return { ...prev, title: op.title, updated_at: now };

    case "add_item": {
      if (prev.items.some((i) => i.item_id === op.item.item_id)) {
        throw new FieldSemanticOpError(
          `item_id already exists: ${op.item.item_id}`
        );
      }
      return {
        ...prev,
        items: [...prev.items, op.item],
        updated_at: now
      };
    }

    case "remove_item": {
      const items = prev.items.filter((i) => i.item_id !== op.item_id);
      const connections = prev.connections.filter(
        (c) => c.from !== op.item_id && c.to !== op.item_id
      );
      return { ...prev, items, connections, updated_at: now };
    }

    case "add_connection": {
      const ids = new Set(prev.items.map((i) => i.item_id));
      if (!ids.has(op.connection.from)) {
        throw new FieldSemanticOpError(
          `connection.from references unknown item_id: ${op.connection.from}`
        );
      }
      if (!ids.has(op.connection.to)) {
        throw new FieldSemanticOpError(
          `connection.to references unknown item_id: ${op.connection.to}`
        );
      }
      if (prev.connections.some((c) => c.id === op.connection.id)) {
        throw new FieldSemanticOpError(
          `connection id already exists: ${op.connection.id}`
        );
      }
      return {
        ...prev,
        connections: [...prev.connections, op.connection],
        updated_at: now
      };
    }

    case "update_connection": {
      const ids = new Set(prev.items.map((i) => i.item_id));
      if (!ids.has(op.connection.from)) {
        throw new FieldSemanticOpError(
          `connection.from references unknown item_id: ${op.connection.from}`
        );
      }
      if (!ids.has(op.connection.to)) {
        throw new FieldSemanticOpError(
          `connection.to references unknown item_id: ${op.connection.to}`
        );
      }
      let found = false;
      const connections = prev.connections.map((conn) => {
        if (conn.id !== op.connection.id) return conn;
        found = true;
        return op.connection;
      });
      if (!found) {
        throw new FieldSemanticOpError(
          `connection id does not exist: ${op.connection.id}`
        );
      }
      return { ...prev, connections, updated_at: now };
    }

    case "remove_connection": {
      const connections = prev.connections.filter((c) => c.id !== op.id);
      if (connections.length === prev.connections.length) return prev;
      return { ...prev, connections, updated_at: now };
    }
  }
}
