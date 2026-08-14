/**
 * Scope Graphs — the authored graph primitive.
 *
 * `buildScopeProjection` (scopes/projection.ts) is DESCRIPTIVE: it derives refs
 * and relationships from contexts, pulses, events and activity that have
 * already happened. A Scope Graph is the opposite — PRESCRIPTIVE: nodes
 * authored before anything happens, that then cause the work.
 *
 * This slice supports exactly two node kinds: `trigger` and `actor`. There is
 * deliberately no stored "edge" record. A graph owns exactly one Context (an
 * EXISTING substrate primitive), and that shared context_id IS the wiring:
 * - An actor node's connection is realised, at authoring time, purely through
 *   existing Context primitives — ContextStore.applyContextSubscriptions adds
 *   it as a participant AND subscribes it to the node's event types.
 * - Firing a trigger node emits into the graph's context via
 *   BusStore.emitTriggerEvent (the same bus-originated wake primitive pulse
 *   firing already uses) once per endpoint whose EXISTING context subscription
 *   matches the trigger's event type — read via ContextStore.getContextSubscriptions.
 * No new routing table is introduced; "the edge" is inferred from shared
 * context membership, not stored as a separate concept.
 *
 * Node ownership, typed ports and nesting are deliberately out of scope for
 * this slice.
 *
 * A Scope Graph never claims to describe a Scope's derived history — it and
 * buildScopeProjection are separate records, never merged into one "the"
 * graph for a scope.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ScopeGraphTriggerNode = {
  node_id: string;
  kind: "trigger";
  label?: string;
  /** Event type stamped on the emission this node causes when fired. */
  event_type: string;
};

export type ScopeGraphActorNode = {
  node_id: string;
  kind: "actor";
  label?: string;
  endpoint_id: string;
  /** Event types this actor wakes for within the graph's Context. Defaults to ["*"]. */
  event_types?: string[];
};

export type ScopeGraphNode = ScopeGraphTriggerNode | ScopeGraphActorNode;

export type ScopeGraphRecord = {
  graph_id: string;
  workspace_id: string;
  scope_id: string;
  /** The Context that ties this graph's nodes together — the wiring, not a separate edge record. */
  context_id: string;
  nodes: ScopeGraphNode[];
  created_at: string;
  updated_at: string;
};

export class ScopeGraphNotFoundError extends Error {
  readonly code = "E_SCOPE_GRAPH_NOT_FOUND" as const;
  constructor(readonly workspace_id: string, readonly graph_id: string) {
    super(`Scope graph not found: ${graph_id}`);
    this.name = "ScopeGraphNotFoundError";
  }
}

export class ScopeGraphInvalidError extends Error {
  readonly code = "E_SCOPE_GRAPH_INVALID" as const;
  constructor(readonly reason: string) {
    super(`Invalid scope graph: ${reason}`);
    this.name = "ScopeGraphInvalidError";
  }
}

export class ScopeGraphNodeNotFoundError extends Error {
  readonly code = "E_SCOPE_GRAPH_NODE_NOT_FOUND" as const;
  constructor(readonly graph_id: string, readonly node_id: string) {
    super(`Scope graph '${graph_id}' has no node '${node_id}'`);
    this.name = "ScopeGraphNodeNotFoundError";
  }
}

export class ScopeGraphNodeNotATriggerError extends Error {
  readonly code = "E_SCOPE_GRAPH_NODE_NOT_A_TRIGGER" as const;
  constructor(readonly graph_id: string, readonly node_id: string) {
    super(`Scope graph '${graph_id}' node '${node_id}' is not a trigger node`);
    this.name = "ScopeGraphNodeNotATriggerError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function applyScopeGraphSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scope_graphs (
      graph_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      nodes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scope_graphs_scope
      ON scope_graphs(workspace_id, scope_id, created_at ASC);
  `);
}

export function validateScopeGraphNodes(nodes: ScopeGraphNode[]): void {
  const seenNodeIds = new Set<string>();
  for (const node of nodes) {
    if (seenNodeIds.has(node.node_id)) {
      throw new ScopeGraphInvalidError(`duplicate node id '${node.node_id}'`);
    }
    seenNodeIds.add(node.node_id);
    if (node.kind === "actor" && !node.endpoint_id) {
      throw new ScopeGraphInvalidError(`actor node '${node.node_id}' is missing endpoint_id`);
    }
    if (node.kind === "trigger" && !node.event_type) {
      throw new ScopeGraphInvalidError(`trigger node '${node.node_id}' is missing event_type`);
    }
  }
}

/**
 * Pure node-list + Context-id persistence. Realising the wiring (participants,
 * subscriptions) is the caller's job (BusStore.createScopeGraph), using
 * ContextStore — the existing primitive — not this store.
 */
export class ScopeGraphStore {
  constructor(readonly db: DatabaseSync) {}

  listScopeGraphs(workspaceId: string, scopeId: string): ScopeGraphRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scope_graphs WHERE workspace_id = ? AND scope_id = ? ORDER BY created_at ASC
    `).all(workspaceId, scopeId) as any[];
    return rows.map((row) => this.rowToGraph(row));
  }

  getScopeGraph(workspaceId: string, graphId: string): ScopeGraphRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM scope_graphs WHERE workspace_id = ? AND graph_id = ?
    `).get(workspaceId, graphId) as any;
    return row ? this.rowToGraph(row) : null;
  }

  insertScopeGraph(input: {
    workspace_id: string;
    scope_id: string;
    context_id: string;
    nodes: ScopeGraphNode[];
  }): ScopeGraphRecord {
    validateScopeGraphNodes(input.nodes);
    const graphId = `graph_${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scope_graphs (
        graph_id, workspace_id, scope_id, context_id, nodes_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      graphId,
      input.workspace_id,
      input.scope_id,
      input.context_id,
      JSON.stringify(input.nodes),
      timestamp,
      timestamp
    );
    return this.getScopeGraph(input.workspace_id, graphId) as ScopeGraphRecord;
  }

  private rowToGraph(row: any): ScopeGraphRecord {
    return {
      graph_id: String(row.graph_id),
      workspace_id: String(row.workspace_id),
      scope_id: String(row.scope_id),
      context_id: String(row.context_id),
      nodes: JSON.parse(row.nodes_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }
}
