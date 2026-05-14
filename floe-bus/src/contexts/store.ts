import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ContextRecord = {
  context_id: string;
  workspace_id: string;
  parent_context_id: string | null;
  created_by_endpoint_id: string;
  created_at: string;
};

export type ContextListRow = ContextRecord & {
  participants: string[];
  last_event_at: string | null;
  topic: string | null;
};

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

export function applyContextSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contexts (
      context_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      parent_context_id TEXT,
      created_by_endpoint_id TEXT NOT NULL,
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
}

export class ContextStore implements ContextStoreReader {
  constructor(readonly db: DatabaseSync) {}

  createContext(input: {
    workspace_id: string;
    created_by_endpoint_id: string;
    participants: readonly string[];
    parent_context_id?: string | null;
    context_id?: string;
  }): string {
    const id = input.context_id ?? `ctx_${randomUUID()}`;
    const ts = nowIso();
    const insertContext = this.db.prepare(`
      INSERT INTO contexts (context_id, workspace_id, parent_context_id, created_by_endpoint_id, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertParticipant = this.db.prepare(`
      INSERT OR IGNORE INTO context_participants (context_id, endpoint_id, joined_at)
      VALUES (?, ?, ?)
    `);
    insertContext.run(id, input.workspace_id, input.parent_context_id ?? null, input.created_by_endpoint_id, ts);
    const seen = new Set<string>();
    for (const ep of input.participants) {
      if (seen.has(ep)) continue;
      seen.add(ep);
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
      parent_context_id: row.parent_context_id ?? null,
      created_by_endpoint_id: row.created_by_endpoint_id,
      created_at: row.created_at
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
    return rows.map((row) => ({
      context_id: row.context_id,
      workspace_id: row.workspace_id,
      parent_context_id: row.parent_context_id ?? null,
      created_by_endpoint_id: row.created_by_endpoint_id,
      created_at: row.created_at,
      last_event_at: (row.last_event_at as string | null) ?? null,
      topic: null,
      participants: this.getContextParticipants(row.context_id)
    }));
  }
}
