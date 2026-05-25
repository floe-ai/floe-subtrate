// Pure helpers for FloeWeb's Field renderer projection.
//
// Field is now a renderer view of substrate Scope. This module intentionally
// keeps ref parsing and layout-sidecar helpers only; it does not own semantic
// Field membership or connection updates.

import type { Node, NodeChange } from "@xyflow/react";

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
  parent_count?: number;
  updated_at: string;
};

export type FieldItemNodeData = {
  ref: ParsedFieldRef;
  kind: FieldItemKind;
  label: string;
};

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
