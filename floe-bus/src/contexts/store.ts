import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ContextRecord = {
  context_id: string;
  workspace_id: string;
  scope_id: string | null;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  title: string | null;
};

export type ContextListRow = ContextRecord & {
  participants: string[];
  last_event_at: string | null;
  topic: string | null;
};

export type ContextScopeFilter = "all" | "scoped" | "unscoped";

/**
 * Read-only surface used by the context resolver. Keeps the resolver decoupled
 * from the BusStore so it can be unit-tested in isolation.
 */
export interface ContextStoreReader {
  getContext(context_id: string): ContextRecord | null;
  getContextParticipants(context_id: string): string[];
  isParticipant(context_id: string, endpoint_id: string): boolean;
  listContextsForParticipant(endpoint_id: string): ContextListRow[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function relaxContextAnchorColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(contexts)").all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
  const scope = columns.find((item) => item.name === "scope_id");
  const createdBy = columns.find((item) => item.name === "created_by_endpoint_id");
  const needsRebuild =
    scope?.notnull === 1 ||
    scope?.dflt_value != null ||
    createdBy?.notnull === 1;
  if (!needsRebuild) return;

  db.exec(`
    CREATE TABLE contexts_next (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT,
      created_at TEXT NOT NULL
    );

    INSERT INTO contexts_next (
      context_id, workspace_id, scope_id, parent_context_id, created_by_endpoint_id, created_at
    )
    SELECT
      context_id,
      workspace_id,
      NULLIF(scope_id, 'default'),
      parent_context_id,
      created_by_endpoint_id,
      created_at
    FROM contexts;

    DROP TABLE contexts;
    ALTER TABLE contexts_next RENAME TO contexts;
  `);
}

export function applyContextSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      scope_id TEXT,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contexts_workspace
      ON contexts(workspace_id, created_at);

    CREATE TABLE IF NOT EXISTS context_participants (
      context_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (context_id, endpoint_id)
    );

    CREATE INDEX IF NOT EXISTS idx_context_participants_endpoint
      ON context_participants(endpoint_id, context_id);
  `);
  addColumnIfMissing(db, "contexts", "scope_id", "TEXT");
  relaxContextAnchorColumns(db);
  addColumnIfMissing(db, "contexts", "title", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contexts_workspace_scope
      ON contexts(workspace_id, scope_id, created_at);
  `);
}

export class ContextStore implements ContextStoreReader {
  constructor(readonly db: DatabaseSync) {}

  createContext(input: {
    workspace_id: string;
    scope_id?: string | null;
    created_by_endpoint_id: string | null;
    participants: readonly string[];
    parent_context_id?: string | null;
    context_id?: string;
    title?: string | null;
  }): string {
    const id = input.context_id ?? `ctx_${randomUUID()}`;
    const ts = nowIso();
    const participants = Array.from(new Set(input.participants));
    if (!input.scope_id && participants.length === 0) {
      throw new Error("Context requires at least one actor participant or Scope");
    }
    const insertContext = this.db.prepare(`
      INSERT INTO contexts (context_id, workspace_id, scope_id, parent_context_id, created_by_endpoint_id, created_at, title)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertParticipant = this.db.prepare(`
      INSERT OR IGNORE INTO context_participants (context_id, endpoint_id, joined_at)
      VALUES (?, ?, ?)
    `);
    insertContext.run(id, input.workspace_id, input.scope_id ?? null, input.parent_context_id ?? null, input.created_by_endpoint_id, ts, input.title ?? null);
    for (const ep of participants) {
      insertParticipant.run(id, ep, ts);
    }
    return id;
  }

  getContext(context_id: string): ContextRecord | null {
    const row = this.db.prepare("SELECT * FROM contexts WHERE context_id = ?").get(context_id) as any;
    if (!row) return null;
    return {
      context_id: row.context_id,
      workspace_id: row.workspace_id,
      scope_id: row.scope_id ?? null,
      parent_context_id: row.parent_context_id ?? null,
      created_by_endpoint_id: row.created_by_endpoint_id ?? null,
      created_at: row.created_at,
      title: (row.title as string | null) ?? null
    };
  }

  getContextParticipants(context_id: string): string[] {
    const rows = this.db
      .prepare("SELECT endpoint_id FROM context_participants WHERE context_id = ? ORDER BY joined_at ASC")
      .all(context_id) as Array<{ endpoint_id: string }>;
    return rows.map((r) => r.endpoint_id);
  }

  isParticipant(context_id: string, endpoint_id: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM context_participants WHERE context_id = ? AND endpoint_id = ?")
      .get(context_id, endpoint_id);
    return !!row;
  }

  setContextScope(context_id: string, scope_id: string): ContextRecord | null {
    this.db.prepare("UPDATE contexts SET scope_id = ? WHERE context_id = ?").run(scope_id, context_id);
    return this.getContext(context_id);
  }

  getLastEventAt(context_id: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(created_at) AS last FROM events WHERE context_id = ?")
      .get(context_id) as any;
    return (row?.last as string | null) ?? null;
  }

  getFirstMessagePreview(context_id: string, maxChars = 80): string | null {
    const row = this.db
      .prepare(
        "SELECT content_json FROM events WHERE context_id = ? AND type = 'message' ORDER BY created_at ASC LIMIT 1"
      )
      .get(context_id) as { content_json: string | null } | undefined;
    if (!row || !row.content_json) return null;
    let parsed: any;
    try {
      parsed = JSON.parse(row.content_json);
    } catch {
      return null;
    }
    const text = parsed && typeof parsed.text === "string" ? parsed.text : null;
    if (!text) return null;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "…";
  }

  private mapContextListRow(row: any): ContextListRow {
    return {
      context_id: row.context_id,
      workspace_id: row.workspace_id,
      scope_id: row.scope_id ?? null,
      parent_context_id: row.parent_context_id ?? null,
      created_by_endpoint_id: row.created_by_endpoint_id ?? null,
      created_at: row.created_at,
      title: (row.title as string | null) ?? null,
      last_event_at: (row.last_event_at as string | null) ?? null,
      topic: null,
      participants: this.getContextParticipants(row.context_id)
    };
  }

  listContextsForParticipant(endpoint_id: string): ContextListRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM context_participants cp
        JOIN contexts c ON c.context_id = cp.context_id
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE cp.endpoint_id = ?
        GROUP BY c.context_id
        ORDER BY (last_event_at IS NULL) ASC, last_event_at DESC, c.created_at DESC
      `
      )
      .all(endpoint_id) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  listContextsForWorkspace(
    workspace_id: string,
    options: { scope?: ContextScopeFilter; limit?: number } = {}
  ): ContextListRow[] {
    const params: Array<string | number> = [workspace_id];
    let scopeClause = "";
    if (options.scope === "scoped") {
      scopeClause = "AND c.scope_id IS NOT NULL";
    } else if (options.scope === "unscoped") {
      scopeClause = "AND c.scope_id IS NULL";
    }
    const limit = options.limit ?? 50;
    params.push(limit);
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM contexts c
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE c.workspace_id = ? ${scopeClause}
        GROUP BY c.context_id
        ORDER BY (last_event_at IS NULL) ASC, last_event_at DESC, c.created_at DESC
        LIMIT ?
      `
      )
      .all(...params) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }

  listContextsForScope(workspace_id: string, scope_id: string): ContextListRow[] {
    const rows = this.db
      .prepare(
        `
        SELECT c.*, MAX(e.created_at) AS last_event_at
        FROM contexts c
        LEFT JOIN events e ON e.context_id = c.context_id
        WHERE c.workspace_id = ? AND c.scope_id = ?
        GROUP BY c.context_id
        ORDER BY (last_event_at IS NULL) ASC, last_event_at DESC, c.created_at DESC
      `
      )
      .all(workspace_id, scope_id) as any[];
    return rows.map((row) => this.mapContextListRow(row));
  }
}
