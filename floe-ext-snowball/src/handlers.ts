/**
 * HTTP handlers for the Snowball extension relay.
 *
 * These are registered with the extension's registerHttpHandler (Track S
 * extension relay feature) and become available at:
 *
 *   GET  /v1/extensions/snowball/board?scope_id=<id>    → board state JSON
 *   POST /v1/extensions/snowball/board/init             → initialize / persist sidecar
 *   POST /v1/extensions/snowball/columns                → add/update/delete/reorder columns
 *   POST /v1/extensions/snowball/card                  → create a card (new Context + sidecar)
 *   POST /v1/extensions/snowball/card/delete           → remove card from sidecar
 *   POST /v1/extensions/snowball/card/rename           → rename card title
 *   POST /v1/extensions/snowball/card/criteria         → toggle exit-criterion check
 *   POST /v1/extensions/snowball/move                  → move a card between columns
 *
 * The UI (BoardView.tsx) calls these endpoints.
 */

import type { ExtensionContext } from "./stub/extension-context.js";
import {
  loadSidecar,
  saveSidecar,
  sidecarExists,
  buildBoardSnapshot,
  getUncheckedCriteria,
} from "./sidecar.js";
import { asBusClient } from "./stub/bus-client.js";
import type { SidecarColumn } from "./types.js";

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

interface RelayRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

interface RelayResponse {
  status: number;
  body: unknown;
}

function jsonResponse(status: number, body: unknown): RelayResponse {
  return { status, body };
}

// ---------------------------------------------------------------------------
// GET /board?scope_id=<id>
// Returns board state + initialized flag (true = sidecar file exists on disk).
// ---------------------------------------------------------------------------

function handleGetBoard(
  workspacePath: string
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const scope_id = req.query["scope_id"];

    if (!scope_id) {
      return jsonResponse(400, { error: "scope_id query parameter required" });
    }

    try {
      const initialized = sidecarExists(workspacePath, scope_id);
      const sidecar = loadSidecar(workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(200, { ...snapshot, initialized });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /board/init  { scope_id }
// Persists the default sidecar to disk (idempotent — safe to call twice).
// ---------------------------------------------------------------------------

function handlePostBoardInit(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as { scope_id?: string };
    const { scope_id } = body;
    if (!scope_id) return jsonResponse(400, { error: "scope_id required" });

    try {
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      // Fill workspace_id if missing (new sidecar)
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;
      saveSidecar(ctx.workspacePath, scope_id, sidecar);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /columns
// Manages board columns: add / update / delete / reorder.
//
// Body shapes by action:
//   add:     { scope_id, action:"add", name, wip_limit?, owner?, exit_criteria? }
//   update:  { scope_id, action:"update", column_id, name?, wip_limit?, owner?, exit_criteria? }
//   delete:  { scope_id, action:"delete", column_id }
//   reorder: { scope_id, action:"reorder", column_ids: string[] }
//
// Returns: { ok: true, board: BoardSnapshot & { initialized: true } }
// ---------------------------------------------------------------------------

function handlePostColumns(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    type Body = {
      scope_id?: string;
      action?: "add" | "update" | "delete" | "reorder";
      column_id?: string;
      name?: string;
      wip_limit?: number | null;
      owner?: { kind: "human" | "agent"; agent_id?: string };
      exit_criteria?: Array<{
        id: string;
        description: string;
        kind: "machine" | "human";
      }>;
      column_ids?: string[];
    };
    const body = (req.body ?? {}) as Body;
    const { scope_id, action } = body;

    if (!scope_id) return jsonResponse(400, { error: "scope_id required" });
    if (!action) return jsonResponse(400, { error: "action required" });

    try {
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;

      if (action === "add") {
        const name = body.name?.trim();
        if (!name) return jsonResponse(400, { error: "name required for action:add" });
        const id = `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const newCol: SidecarColumn = {
          id,
          name,
          wip_limit: body.wip_limit ?? null,
          order: sidecar.columns.length,
          owner: body.owner ?? { kind: "human" },
          exit_criteria: body.exit_criteria ?? [],
        };
        sidecar.columns.push(newCol);

      } else if (action === "update") {
        if (!body.column_id) return jsonResponse(400, { error: "column_id required for action:update" });
        const col = sidecar.columns.find((c) => c.id === body.column_id);
        if (!col) return jsonResponse(404, { error: "column_not_found", column_id: body.column_id });
        if (body.name !== undefined) col.name = body.name.trim();
        if (body.wip_limit !== undefined) col.wip_limit = body.wip_limit;
        if (body.owner !== undefined) col.owner = body.owner;
        if (body.exit_criteria !== undefined) col.exit_criteria = body.exit_criteria;

      } else if (action === "delete") {
        if (!body.column_id) return jsonResponse(400, { error: "column_id required for action:delete" });
        const idx = sidecar.columns.findIndex((c) => c.id === body.column_id);
        if (idx === -1) return jsonResponse(404, { error: "column_not_found", column_id: body.column_id });
        if (sidecar.columns.length <= 1) {
          return jsonResponse(422, { error: "Cannot delete the last column" });
        }
        // Move any cards in this column to the first remaining column
        const remaining = sidecar.columns.filter((_, i) => i !== idx);
        const fallback = remaining[0];
        for (const card of Object.values(sidecar.cards)) {
          if (card.column_id === body.column_id) {
            card.column_id = fallback.id;
            card.order = Object.values(sidecar.cards).filter(
              (c) => c.column_id === fallback.id
            ).length;
          }
        }
        sidecar.columns.splice(idx, 1);

      } else if (action === "reorder") {
        const ids = body.column_ids;
        if (!Array.isArray(ids)) return jsonResponse(400, { error: "column_ids required for action:reorder" });
        const reordered: SidecarColumn[] = [];
        for (const id of ids) {
          const col = sidecar.columns.find((c) => c.id === id);
          if (col) reordered.push(col);
        }
        // Append any columns not mentioned (shouldn't happen, but be safe)
        for (const col of sidecar.columns) {
          if (!reordered.includes(col)) reordered.push(col);
        }
        sidecar.columns = reordered;

      } else {
        return jsonResponse(400, { error: `Unknown action: ${String(action)}` });
      }

      saveSidecar(ctx.workspacePath, scope_id, sidecar);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card  { scope_id, title, column_id? }
// Creates a floe Context (card) scoped to scope_id + adds sidecar entry.
// ---------------------------------------------------------------------------

function handlePostCard(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as {
      scope_id?: string;
      title?: string;
      column_id?: string;
    };

    const { scope_id, title, column_id } = body;
    if (!scope_id) return jsonResponse(400, { error: "scope_id required" });
    if (!title?.trim()) return jsonResponse(400, { error: "title required" });

    try {
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;

      // Target column: explicit or first column
      const targetColId = column_id ?? sidecar.columns[0]?.id;
      if (!targetColId) return jsonResponse(400, { error: "Board has no columns" });
      const targetCol = sidecar.columns.find((c) => c.id === targetColId);
      if (!targetCol) return jsonResponse(404, { error: "column_not_found", column_id: targetColId });

      // WIP limit check
      if (targetCol.wip_limit !== null) {
        const currentCount = Object.values(sidecar.cards).filter(
          (c) => c.column_id === targetColId
        ).length;
        if (currentCount >= targetCol.wip_limit) {
          return jsonResponse(422, {
            ok: false,
            error: "wip_limit_exceeded",
            current: currentCount,
            limit: targetCol.wip_limit,
          });
        }
      }

      // Create a floe Context for this card
      const bus = asBusClient(ctx.busClient);
      let cardId: string;
      try {
        cardId = await bus.createContext({
          workspace_id: ctx.workspaceId,
          scope_id,
          participants: [],
          title: title.trim(),
        });
      } catch (err) {
        return jsonResponse(500, { error: `Failed to create context: ${err}` });
      }

      // Add to sidecar
      const order = Object.values(sidecar.cards).filter(
        (c) => c.column_id === targetColId
      ).length;
      sidecar.cards[cardId] = {
        column_id: targetColId,
        order,
        title: title.trim(),
        created_at: new Date().toISOString(),
        checks: {},
      };

      saveSidecar(ctx.workspacePath, scope_id, sidecar);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(201, { ok: true, card_id: cardId, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card/delete  { scope_id, card_id }
// Removes card from sidecar. The floe Context is NOT deleted (immutable).
// ---------------------------------------------------------------------------

function handlePostCardDelete(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as { scope_id?: string; card_id?: string };
    const { scope_id, card_id } = body;
    if (!scope_id || !card_id) {
      return jsonResponse(400, { error: "scope_id and card_id required" });
    }

    try {
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      if (!sidecar.cards[card_id]) {
        return jsonResponse(404, { error: "card_not_found", card_id });
      }
      delete sidecar.cards[card_id];
      saveSidecar(ctx.workspacePath, scope_id, sidecar);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card/rename  { scope_id, card_id, title }
// ---------------------------------------------------------------------------

function handlePostCardRename(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as {
      scope_id?: string;
      card_id?: string;
      title?: string;
    };
    const { scope_id, card_id, title } = body;
    if (!scope_id || !card_id || !title?.trim()) {
      return jsonResponse(400, { error: "scope_id, card_id, title required" });
    }

    try {
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const card = sidecar.cards[card_id];
      if (!card) return jsonResponse(404, { error: "card_not_found", card_id });
      card.title = title.trim();
      saveSidecar(ctx.workspacePath, scope_id, sidecar);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card/criteria  { scope_id, card_id, column_id, criterion_id, checked }
// Toggle an exit-criterion check on a card.
// ---------------------------------------------------------------------------

function handlePostCardCriteria(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as {
      scope_id?: string;
      card_id?: string;
      column_id?: string;
      criterion_id?: string;
      checked?: boolean;
    };
    const { scope_id, card_id, column_id, criterion_id, checked } = body;
    if (
      !scope_id ||
      !card_id ||
      !column_id ||
      !criterion_id ||
      checked === undefined
    ) {
      return jsonResponse(400, {
        error: "scope_id, card_id, column_id, criterion_id, checked required",
      });
    }

    try {
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const card = sidecar.cards[card_id];
      if (!card) return jsonResponse(404, { error: "card_not_found", card_id });

      if (!card.checks[column_id]) card.checks[column_id] = {};
      card.checks[column_id][criterion_id] = {
        checked,
        checked_at: checked ? new Date().toISOString() : null,
        checked_by: "human",
        note: null,
      };

      saveSidecar(ctx.workspacePath, scope_id, sidecar);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /move  { card_id, to_column_id, scope_id, force? }
// (existing handler — kept exactly as before)
// ---------------------------------------------------------------------------

function handlePostMove(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    let body: Record<string, unknown>;
    try {
      body = (req.body ?? {}) as Record<string, unknown>;
    } catch {
      return jsonResponse(400, { error: "Invalid JSON body" });
    }

    const { card_id, to_column_id, scope_id, force } = body as {
      card_id?: string;
      to_column_id?: string;
      scope_id?: string;
      force?: boolean;
    };

    if (!card_id || !to_column_id || !scope_id) {
      return jsonResponse(400, {
        error: "card_id, to_column_id, and scope_id are required",
      });
    }

    const { workspacePath, workspaceId } = ctx;
    const sidecar = loadSidecar(workspacePath, scope_id);

    const card = sidecar.cards[card_id];
    if (!card) {
      return jsonResponse(404, { error: "card_not_found", card_id });
    }

    const fromColumn = sidecar.columns.find((c) => c.id === card.column_id);
    const toColumn = sidecar.columns.find((c) => c.id === to_column_id);
    if (!toColumn) {
      return jsonResponse(404, { error: "column_not_found", to_column_id });
    }

    // Exit criteria gate (soft for human-initiated force=true)
    const exitCriteria = fromColumn?.exit_criteria ?? [];
    const unchecked = getUncheckedCriteria(card, card.column_id, exitCriteria);
    if (unchecked.length > 0 && !force) {
      return jsonResponse(422, {
        ok: false,
        error: "gate_blocked",
        message:
          "Exit criteria not satisfied. Pass force=true to override (human only).",
        unchecked_criteria: unchecked,
      });
    }

    // WIP limit
    if (toColumn.wip_limit !== null) {
      const current = Object.values(sidecar.cards).filter(
        (c) => c.column_id === to_column_id
      ).length;
      if (current >= toColumn.wip_limit) {
        return jsonResponse(422, {
          ok: false,
          error: "wip_limit_exceeded",
          current,
          limit: toColumn.wip_limit,
        });
      }
    }

    // Perform move
    const previousColumnId = card.column_id;
    card.column_id = to_column_id;
    card.order =
      Object.values(sidecar.cards).filter(
        (c) => c.column_id === to_column_id
      ).length - 1;
    saveSidecar(workspacePath, scope_id, sidecar);

    // Emit events (best-effort)
    const bus = asBusClient(ctx.busClient);
    try {
      await bus.emit({
        type: "snowball.card.moved",
        workspace_id: workspaceId,
        content: {
          text: `Card "${card.title}" moved from "${fromColumn?.name ?? previousColumnId}" to "${toColumn.name}" (UI)`,
          data: {
            card_context_id: card_id,
            card_title: card.title,
            from_column_id: previousColumnId,
            to_column_id,
            forced: Boolean(force),
            board_scope_id: scope_id,
            source: "ui",
          },
        },
        metadata: { source: "snowball-extension" },
      });
    } catch {
      // Non-fatal
    }

    // If destination is agent-owned, emit routing event
    if (toColumn.owner.kind === "agent" && toColumn.owner.agent_id) {
      try {
        const endpoints = await bus.listEndpoints(workspaceId);
        const agentEndpoint = endpoints.find(
          (ep) =>
            ep.endpoint_id.endsWith(`:${toColumn.owner.agent_id}`) ||
            ep.agent_id === toColumn.owner.agent_id
        );
        if (agentEndpoint) {
          await bus.emit({
            type: "snowball.card.entered_column",
            workspace_id: workspaceId,
            destination: {
              kind: "endpoint",
              endpoint_id: agentEndpoint.endpoint_id,
            },
            content: {
              text: `Card "${card.title}" has entered column "${toColumn.name}"`,
              data: {
                card_context_id: card_id,
                card_title: card.title,
                column_id: to_column_id,
                column_name: toColumn.name,
                from_column_id: previousColumnId,
                board_scope_id: scope_id,
              },
            },
            response: { expected: true },
            metadata: { source: "snowball-extension" },
          });
        }
      } catch (err) {
        console.warn(`[snowball] Routing event failed: ${err}`);
      }
    }

    return jsonResponse(200, {
      ok: true,
      card_id,
      from_column_id: previousColumnId,
      to_column_id,
      forced: Boolean(force),
    });
  };
}

// ---------------------------------------------------------------------------
// Register all handlers with the extension relay
// ---------------------------------------------------------------------------

export function registerHttpHandlers(ctx: ExtensionContext): void {
  ctx.registerHttpHandler("GET", "/board", handleGetBoard(ctx.workspacePath));
  ctx.registerHttpHandler("POST", "/board/init", handlePostBoardInit(ctx));
  ctx.registerHttpHandler("POST", "/columns", handlePostColumns(ctx));
  ctx.registerHttpHandler("POST", "/card", handlePostCard(ctx));
  ctx.registerHttpHandler("POST", "/card/delete", handlePostCardDelete(ctx));
  ctx.registerHttpHandler("POST", "/card/rename", handlePostCardRename(ctx));
  ctx.registerHttpHandler("POST", "/card/criteria", handlePostCardCriteria(ctx));
  ctx.registerHttpHandler("POST", "/move", handlePostMove(ctx));
  console.info(
    "[snowball] HTTP handlers registered: GET /board, POST /board/init, POST /columns, POST /card, POST /card/delete, POST /card/rename, POST /card/criteria, POST /move"
  );
}
