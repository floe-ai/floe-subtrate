/**
 * Scope Graphs — the authored graph primitive.
 *
 * `buildScopeProjection` (scopes/projection.ts) is DESCRIPTIVE: it derives refs
 * and relationships from contexts, pulses, events and activity that have
 * already happened. A Scope Graph is the opposite — PRESCRIPTIVE: nodes and
 * edges authored before anything happens, that then cause the work.
 *
 * This slice supports exactly two node kinds: `trigger` and `actor`. Firing a
 * trigger node walks the graph's edges and wakes every actor node it points
 * to (via BusStore.emitTriggerEvent — the substrate's existing bus-originated
 * wake primitive, also used by pulse firing). Node ownership, typed ports and
 * nesting are deliberately out of scope for this slice.
 *
 * A Scope Graph never claims to describe a Scope's derived history — the two
 * are separate records, never merged into one "the" graph for a scope.
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
};

export type ScopeGraphNode = ScopeGraphTriggerNode | ScopeGraphActorNode;

export type ScopeGraphEdge = {
  from_node_id: string;
  to_node_id: string;
};

export type ScopeGraphRecord = {
  graph_id: string;
  workspace_id: string;
  scope_id: string;
  nodes: ScopeGraphNode[];
  edges: ScopeGraphEdge[];
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
      nodes_json TEXT NOT NULL,
      edges_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scope_graphs_scope
      ON scope_graphs(workspace_id, scope_id, created_at ASC);
  `);
}

function validateGraphShape(nodes: ScopeGraphNode[], edges: ScopeGraphEdge[]): void {
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
  for (const edge of edges) {
    if (!seenNodeIds.has(edge.from_node_id)) {
      throw new ScopeGraphInvalidError(`edge references unknown node '${edge.from_node_id}'`);
    }
    if (!seenNodeIds.has(edge.to_node_id)) {
      throw new ScopeGraphInvalidError(`edge references unknown node '${edge.to_node_id}'`);
    }
  }
}

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

  createScopeGraph(input: {
    workspace_id: string;
    scope_id: string;
    nodes: ScopeGraphNode[];
    edges: ScopeGraphEdge[];
  }): ScopeGraphRecord {
    validateGraphShape(input.nodes, input.edges);
    const graphId = `graph_${randomUUID()}`;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scope_graphs (
        graph_id, workspace_id, scope_id, nodes_json, edges_json, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      graphId,
      input.workspace_id,
      input.scope_id,
      JSON.stringify(input.nodes),
      JSON.stringify(input.edges),
      timestamp,
      timestamp
    );
    return this.getScopeGraph(input.workspace_id, graphId) as ScopeGraphRecord;
  }

  /**
   * Resolves which actor nodes a trigger node's edges point to. Throws if the
   * graph, node, or node kind is invalid. Callers wake each returned actor
   * node via BusStore.emitTriggerEvent — this store holds no runtime state.
   */
  resolveTriggerTargets(workspaceId: string, graphId: string, nodeId: string): ScopeGraphActorNode[] {
    const graph = this.getScopeGraph(workspaceId, graphId);
    if (!graph) throw new ScopeGraphNotFoundError(workspaceId, graphId);

    const node = graph.nodes.find((candidate) => candidate.node_id === nodeId);
    if (!node) throw new ScopeGraphNodeNotFoundError(graphId, nodeId);
    if (node.kind !== "trigger") throw new ScopeGraphNodeNotATriggerError(graphId, nodeId);

    const targetNodeIds = graph.edges
      .filter((edge) => edge.from_node_id === nodeId)
      .map((edge) => edge.to_node_id);

    return graph.nodes.filter(
      (candidate): candidate is ScopeGraphActorNode => candidate.kind === "actor" && targetNodeIds.includes(candidate.node_id)
    );
  }

  private rowToGraph(row: any): ScopeGraphRecord {
    return {
      graph_id: String(row.graph_id),
      workspace_id: String(row.workspace_id),
      scope_id: String(row.scope_id),
      nodes: JSON.parse(row.nodes_json),
      edges: JSON.parse(row.edges_json),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }
}
