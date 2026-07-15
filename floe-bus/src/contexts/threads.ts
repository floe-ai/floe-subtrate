/**
 * First-class Thread records — a thread is a named sub-exchange INSIDE a context.
 *
 * Main vs side is DERIVED, never stored:
 *   parent_thread_id IS NULL  → main thread (root; thread_id === context_id by convention)
 *   parent_thread_id IS NOT NULL → side thread (sub-exchange)
 *
 * Every context gets one root thread row on creation (thread_id = context_id).
 * Side threads are created when an actor emits to a non-participant addressee
 * while operating inside an existing context (Rule 3 of the resolver).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Domain errors
// ---------------------------------------------------------------------------

export class ThreadNotFoundError extends Error {
  readonly code = "thread_not_found";
  constructor(readonly thread_id: string) {
    super(`Thread not found: ${thread_id}`);
    this.name = "ThreadNotFoundError";
  }
}

export class RootThreadCloseError extends Error {
  readonly code = "root_thread_cannot_be_closed";
  constructor(readonly thread_id: string) {
    super(`Root/main threads cannot be closed: ${thread_id}`);
    this.name = "RootThreadCloseError";
  }
}

export class ClosedThreadError extends Error {
  readonly code = "thread_closed";
  constructor(readonly thread_id: string) {
    super(`Thread is closed and does not accept new events: ${thread_id}`);
    this.name = "ClosedThreadError";
  }
}
export type ThreadRecord = {
  thread_id: string;
  context_id: string;
  /** NULL ⟹ main/root thread.  Non-null ⟹ side thread. */
  parent_thread_id: string | null;
  created_by_endpoint_id: string | null;
  status: "open" | "closed";
  created_at: string;
  title: string | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

export function applyThreadSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      thread_id              TEXT PRIMARY KEY,
      context_id             TEXT NOT NULL,
      parent_thread_id       TEXT,
      created_by_endpoint_id TEXT,
      status                 TEXT NOT NULL DEFAULT 'open',
      created_at             TEXT NOT NULL,
      title                  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_threads_context
      ON threads(context_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_threads_parent
      ON threads(parent_thread_id, created_at);
  `);

  // Backfill: every existing context that doesn't yet have a root thread row
  // gets one now (thread_id = context_id, parent_thread_id = NULL).
  db.exec(`
    INSERT OR IGNORE INTO threads (
      thread_id, context_id, parent_thread_id, created_by_endpoint_id, status, created_at
    )
    SELECT
      context_id,
      context_id,
      NULL,
      created_by_endpoint_id,
      'open',
      created_at
    FROM contexts
  `);
}

// ---------------------------------------------------------------------------
// ThreadStore
// ---------------------------------------------------------------------------

export class ThreadStore {
  constructor(readonly db: DatabaseSync) {}

  /**
   * Create a new thread.  Returns the generated thread_id.
   *
   * To create a ROOT thread: pass parent_thread_id = null and (optionally)
   * thread_id = context_id.
   * To create a SIDE thread: pass a non-null parent_thread_id.
   */
  createThread(input: {
    context_id: string;
    parent_thread_id: string | null;
    created_by_endpoint_id: string | null;
    title?: string | null;
    /** Caller may pin the id (e.g. root thread where id = context_id). */
    thread_id?: string;
  }): string {
    const id = input.thread_id ?? `thr_${randomUUID()}`;
    const ts = nowIso();
    this.db.prepare(`
      INSERT INTO threads (thread_id, context_id, parent_thread_id, created_by_endpoint_id, status, created_at, title)
      VALUES (?, ?, ?, ?, 'open', ?, ?)
    `).run(
      id,
      input.context_id,
      input.parent_thread_id ?? null,
      input.created_by_endpoint_id ?? null,
      ts,
      input.title ?? null
    );
    return id;
  }

  /**
   * Idempotent root-thread creation for a context.
   * Uses thread_id = context_id, parent_thread_id = NULL.
   * Safe to call multiple times; INSERT OR IGNORE skips duplicates.
   */
  ensureRootThread(
    contextId: string,
    createdByEndpointId: string | null,
    createdAt: string
  ): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO threads (thread_id, context_id, parent_thread_id, created_by_endpoint_id, status, created_at)
      VALUES (?, ?, NULL, ?, 'open', ?)
    `).run(contextId, contextId, createdByEndpointId ?? null, createdAt);
  }

  getThread(threadId: string): ThreadRecord | null {
    const row = this.db
      .prepare("SELECT * FROM threads WHERE thread_id = ?")
      .get(threadId) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Close a side thread — sets `status = 'closed'`.
   *
   * Guards:
   * - Thread must exist (returns null if not found).
   * - Thread must be a side thread (`parent_thread_id IS NOT NULL`).
   *   Root/main threads cannot be closed; they are owned by the context lifecycle.
   * - Closing an already-closed thread is a no-op (returns the thread).
   *
   * Returns the updated `ThreadRecord`, or `null` if the thread does not exist.
   * Throws `RootThreadCloseError` if the caller attempts to close a root thread.
   */
  closeThread(threadId: string): ThreadRecord {
    const existing = this.getThread(threadId);
    if (!existing) {
      throw new ThreadNotFoundError(threadId);
    }
    if (existing.parent_thread_id === null) {
      throw new RootThreadCloseError(threadId);
    }
    if (existing.status === "closed") {
      // Idempotent — already closed.
      return existing;
    }
    this.db
      .prepare("UPDATE threads SET status = 'closed' WHERE thread_id = ?")
      .run(threadId);
    return { ...existing, status: "closed" };
  }

  /** All threads for a context, root first then sides ordered by creation time. */
  listThreadsForContext(contextId: string): ThreadRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM threads WHERE context_id = ? ORDER BY created_at ASC, thread_id ASC"
      )
      .all(contextId) as any[];
    return rows.map((r) => this.mapRow(r));
  }

  private mapRow(row: any): ThreadRecord {
    return {
      thread_id: row.thread_id,
      context_id: row.context_id,
      parent_thread_id: (row.parent_thread_id as string | null) ?? null,
      created_by_endpoint_id: (row.created_by_endpoint_id as string | null) ?? null,
      status: row.status as "open" | "closed",
      created_at: row.created_at,
      title: (row.title as string | null) ?? null,
    };
  }
}
