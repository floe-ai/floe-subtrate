/**
 * Endpoint Watermark — a persisted, per-Endpoint Event Cursor marking how far
 * an Endpoint has been carried forward (brought up to date).
 *
 * It is generic across Actors: the operator is just one Endpoint. The watermark
 * advances only when something explicitly sets it — it never moves on read — so
 * "what changed since I was last here" persists until the operator deliberately
 * marks themselves caught up.
 *
 * This is unrelated to bridges.last_seen_at, which tracks bridge liveness.
 */

import type { DatabaseSync } from "node:sqlite";
import { decodeEventCursor, encodeEventCursor } from "./event-cursor.js";

export type EndpointWatermark = {
  workspace_id: string;
  endpoint_id: string;
  cursor: string;
  updated_at: string;
};

export function applyEndpointWatermarkSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS endpoint_watermarks (
      workspace_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      cursor_created_at TEXT NOT NULL,
      cursor_event_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, endpoint_id)
    );
  `);
}

export class EndpointWatermarkStore {
  constructor(private readonly db: DatabaseSync) {}

  get(workspaceId: string, endpointId: string): EndpointWatermark | null {
    const row = this.db
      .prepare("SELECT * FROM endpoint_watermarks WHERE workspace_id = ? AND endpoint_id = ?")
      .get(workspaceId, endpointId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToWatermark(row);
  }

  /** Sets (or advances) the watermark. Throws InvalidEventCursorError on a malformed cursor. */
  set(workspaceId: string, endpointId: string, cursor: string): EndpointWatermark {
    const decoded = decodeEventCursor(cursor);
    this.db
      .prepare(
        `INSERT INTO endpoint_watermarks
           (workspace_id, endpoint_id, cursor_created_at, cursor_event_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, endpoint_id) DO UPDATE SET
           cursor_created_at = excluded.cursor_created_at,
           cursor_event_id = excluded.cursor_event_id,
           updated_at = excluded.updated_at`
      )
      .run(workspaceId, endpointId, decoded.created_at, decoded.event_id, new Date().toISOString());
    return this.get(workspaceId, endpointId)!;
  }

  private rowToWatermark(row: Record<string, unknown>): EndpointWatermark {
    return {
      workspace_id: String(row.workspace_id),
      endpoint_id: String(row.endpoint_id),
      cursor: encodeEventCursor({
        created_at: String(row.cursor_created_at),
        event_id: String(row.cursor_event_id)
      }),
      updated_at: String(row.updated_at)
    };
  }
}
