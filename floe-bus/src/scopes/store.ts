import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export const DEFAULT_SCOPE_ID = "default";

export type ScopeRecord = {
  scope_id: string;
  workspace_id: string;
  title: string;
  description: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

export class ScopeAlreadyExistsError extends Error {
  constructor(readonly workspace_id: string, readonly scope_id: string) {
    super(`Scope '${scope_id}' already exists in workspace '${workspace_id}'.`);
    this.name = "ScopeAlreadyExistsError";
  }
}

export class ScopeNotFoundError extends Error {
  constructor(readonly workspace_id: string, readonly scope_id: string) {
    super(`Scope '${scope_id}' was not found in workspace '${workspace_id}'.`);
    this.name = "ScopeNotFoundError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function applyScopeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scopes (
      workspace_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, scope_id)
    );

    CREATE INDEX IF NOT EXISTS idx_scopes_workspace
      ON scopes(workspace_id, is_default DESC, created_at ASC);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_scopes_one_default_per_workspace
      ON scopes(workspace_id)
      WHERE is_default = 1;
  `);
}

export class ScopeStore {
  constructor(readonly db: DatabaseSync) {}

  ensureDefaultScope(workspaceId: string): ScopeRecord {
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scopes (
        workspace_id, scope_id, title, description, is_default, created_at, updated_at
      )
      VALUES (?, ?, 'Default', 'Default workspace scope', 1, ?, ?)
      ON CONFLICT(workspace_id, scope_id) DO UPDATE SET
        is_default = 1
    `).run(workspaceId, DEFAULT_SCOPE_ID, timestamp, timestamp);
    return this.getScope(workspaceId, DEFAULT_SCOPE_ID) as ScopeRecord;
  }

  ensureDefaultScopesForWorkspaces(): void {
    const rows = this.db.prepare("SELECT workspace_id FROM workspaces").all() as Array<{ workspace_id: string }>;
    for (const row of rows) this.ensureDefaultScope(row.workspace_id);
  }

  listScopes(workspaceId: string): ScopeRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM scopes
      WHERE workspace_id = ?
      ORDER BY is_default DESC, created_at ASC, title ASC
    `).all(workspaceId) as any[];
    return rows.map((row) => this.rowToScope(row));
  }

  getScope(workspaceId: string, scopeId: string): ScopeRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM scopes WHERE workspace_id = ? AND scope_id = ?
    `).get(workspaceId, scopeId) as any;
    return row ? this.rowToScope(row) : null;
  }

  createScope(input: {
    workspace_id: string;
    scope_id?: string;
    title: string;
    description?: string | null;
  }): ScopeRecord {
    const scopeId = input.scope_id ?? `scope_${randomUUID()}`;
    if (this.getScope(input.workspace_id, scopeId)) {
      throw new ScopeAlreadyExistsError(input.workspace_id, scopeId);
    }
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO scopes (
        workspace_id, scope_id, title, description, is_default, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 0, ?, ?)
    `).run(
      input.workspace_id,
      scopeId,
      input.title,
      input.description ?? null,
      timestamp,
      timestamp
    );
    return this.getScope(input.workspace_id, scopeId) as ScopeRecord;
  }

  updateScope(input: {
    workspace_id: string;
    scope_id: string;
    title?: string;
    description?: string | null;
  }): ScopeRecord | null {
    const existing = this.getScope(input.workspace_id, input.scope_id);
    if (!existing) return null;
    const timestamp = nowIso();
    this.db.prepare(`
      UPDATE scopes
      SET title = ?, description = ?, updated_at = ?
      WHERE workspace_id = ? AND scope_id = ?
    `).run(
      input.title ?? existing.title,
      input.description === undefined ? existing.description : input.description,
      timestamp,
      input.workspace_id,
      input.scope_id
    );
    return this.getScope(input.workspace_id, input.scope_id);
  }

  private rowToScope(row: any): ScopeRecord {
    return {
      scope_id: String(row.scope_id),
      workspace_id: String(row.workspace_id),
      title: String(row.title),
      description: row.description ?? null,
      is_default: Number(row.is_default) === 1,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }
}
