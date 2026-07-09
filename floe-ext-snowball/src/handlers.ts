/**
 * HTTP handlers for the Snowball extension relay.
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Cards are now markdown files at tasks/<id>.md (not bus Contexts)
 *   - Columns are bus Contexts (created at board init)
 *   - Card-move writes frontmatter + appends carry-forward + emits to column context
 *
 * Available at:
 *   GET  /v1/extensions/snowball/board?scope_id=<id>    → board state JSON
 *   POST /v1/extensions/snowball/board/init             → initialize / persist sidecar + column contexts
 *   POST /v1/extensions/snowball/columns                → add/update/delete/reorder columns
 *   POST /v1/extensions/snowball/card                  → create a card (writes tasks/<id>.md)
 *   POST /v1/extensions/snowball/card/delete           → remove card file
 *   POST /v1/extensions/snowball/card/rename           → rename card title
 *   POST /v1/extensions/snowball/card/criteria         → toggle exit-criterion check
 *   POST /v1/extensions/snowball/move                  → move a card between columns
 */

import type { ExtensionContext } from "./stub/extension-context.js";
import {
  loadSidecar,
  saveSidecar,
  sidecarExists,
  buildBoardSnapshot,
  getUncheckedCriteria,
  initBoardContexts,
} from "./sidecar.js";
import { asBusClient } from "./stub/bus-client.js";
import { advanceCardIfReady } from "./overseer.js";
import {
  readCard,
  writeCard,
  listCards,
  generateCardId,
  updateCardFrontmatter,
  appendCarryForward,
  cardCountsByColumnFromFiles,
} from "./card-file.js";
import type { SidecarColumn } from "./types.js";
import { rmSync } from "node:fs";
import { cardPath } from "./card-file.js";

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
// Routing helpers
// ---------------------------------------------------------------------------

/**
 * Compute the snowball overseer endpoint id for a workspace.
 * The overseer is always a participant of column contexts so it can emit
 * card-move events into the column context.
 */
function overseerId(workspaceId: string): string {
  return `actor:${workspaceId}:snowball-overseer`;
}

/**
 * Compute the agent endpoint id for a workspace + agent.
 */
function agentEndpointId(workspaceId: string, agentId: string): string {
  return `actor:${workspaceId}:${agentId}`;
}

// ---------------------------------------------------------------------------
// GET /board?scope_id=<id>
// Returns board state + initialized flag.
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
      const snapshot = buildBoardSnapshot(workspacePath, sidecar);
      return jsonResponse(200, { ...snapshot, initialized });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /board/init  { scope_id }
// Persists sidecar to disk and creates column contexts in bus (idempotent).
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
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;

      // Create column contexts in bus (idempotent)
      const bus = asBusClient(ctx.busClient);
      const { changed } = await initBoardContexts(sidecar, ctx.workspaceId, bus);
      if (changed || !sidecarExists(ctx.workspacePath, scope_id)) {
        saveSidecar(ctx.workspacePath, scope_id, sidecar);
      }

      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /columns
// Manages board columns: add / update / delete / reorder.
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

        // Create a column context for the new column (best-effort)
        const bus = asBusClient(ctx.busClient);
        try {
          const participants: string[] = [overseerId(ctx.workspaceId)];
          if (newCol.owner.kind === "agent" && newCol.owner.agent_id) {
            const ep = agentEndpointId(ctx.workspaceId, newCol.owner.agent_id);
            if (!participants.includes(ep)) participants.push(ep);
          }
          const contextId = await bus.createContext({
            workspace_id: ctx.workspaceId,
            scope_id,
            participants,
            title: `Column: ${name}`,
          });
          sidecar.column_contexts[id] = contextId;
        } catch (err) {
          console.warn(`[snowball] Failed to create column context for "${name}": ${err}`);
        }

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
        // Move any cards in this column to the first remaining column (file update)
        const remaining = sidecar.columns.filter((_, i) => i !== idx);
        const fallbackCol = remaining[0];
        const allCards = listCards(ctx.workspacePath);
        const currentCount = allCards.filter((c) => c.column === fallbackCol.id).length;
        let moveOrder = currentCount;
        for (const card of allCards) {
          if (card.column === body.column_id) {
            updateCardFrontmatter(ctx.workspacePath, card.id, {
              column: fallbackCol.id,
              order: moveOrder++,
            });
          }
        }
        delete sidecar.column_contexts[body.column_id];
        sidecar.columns.splice(idx, 1);

      } else if (action === "reorder") {
        const ids = body.column_ids;
        if (!Array.isArray(ids)) return jsonResponse(400, { error: "column_ids required for action:reorder" });
        const reordered: SidecarColumn[] = [];
        for (const id of ids) {
          const col = sidecar.columns.find((c) => c.id === id);
          if (col) reordered.push(col);
        }
        for (const col of sidecar.columns) {
          if (!reordered.includes(col)) reordered.push(col);
        }
        sidecar.columns = reordered;

      } else {
        return jsonResponse(400, { error: `Unknown action: ${String(action)}` });
      }

      saveSidecar(ctx.workspacePath, scope_id, sidecar);
      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: true } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card  { scope_id, title, column_id?, description? }
// Creates a card as a markdown file at tasks/<id>.md.
// ---------------------------------------------------------------------------

function handlePostCard(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as {
      scope_id?: string;
      title?: string;
      column_id?: string;
      description?: string;
    };

    const { scope_id, title, column_id, description } = body;
    if (!scope_id) return jsonResponse(400, { error: "scope_id required" });
    if (!title?.trim()) return jsonResponse(400, { error: "title required" });

    try {
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;

      const targetColId = column_id ?? sidecar.columns[0]?.id;
      if (!targetColId) return jsonResponse(400, { error: "Board has no columns" });
      const targetCol = sidecar.columns.find((c) => c.id === targetColId);
      if (!targetCol) return jsonResponse(404, { error: "column_not_found", column_id: targetColId });

      // WIP limit check
      if (targetCol.wip_limit !== null) {
        const counts = cardCountsByColumnFromFiles(ctx.workspacePath, [targetColId]);
        const currentCount = counts[targetColId] ?? 0;
        if (currentCount >= targetCol.wip_limit) {
          return jsonResponse(422, {
            ok: false,
            error: "wip_limit_exceeded",
            current: currentCount,
            limit: targetCol.wip_limit,
          });
        }
      }

      // Compute order (count of existing cards in target column)
      const allCards = listCards(ctx.workspacePath);
      const order = allCards.filter((c) => c.column === targetColId).length;

      // Write card file
      const cardId = generateCardId(title.trim());
      writeCard(ctx.workspacePath, {
        id: cardId,
        title: title.trim(),
        type: "task",
        actor: null,
        column: targetColId,
        order,
        created_at: new Date().toISOString(),
        checks: {},
        body: description?.trim() ?? "",
      });

      // Emit creation event (best-effort)
      const bus = asBusClient(ctx.busClient);
      try {
        await bus.emit({
          type: "snowball.card.created",
          workspace_id: ctx.workspaceId,
          source_endpoint_id: overseerId(ctx.workspaceId),
          destination: {
            kind: "broadcast" as const,
            scope: "workspace",
            target: "active_with_delivery_processor",
          },
          content: {
            text: `Card "${title.trim()}" created in "${targetCol.name}"`,
            data: {
              card_id: cardId,
              column_id: targetColId,
              board_scope_id: scope_id,
            },
          },
          metadata: { source: "snowball-extension" },
        });
      } catch {
        // Non-fatal
      }

      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar);
      return jsonResponse(201, { ok: true, card_id: cardId, board: { ...snapshot, initialized: sidecarExists(ctx.workspacePath, scope_id) } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card/delete  { scope_id, card_id }
// Removes card file from tasks/.
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
      const card = readCard(ctx.workspacePath, card_id);
      if (!card) {
        return jsonResponse(404, { error: "card_not_found", card_id });
      }
      // Delete the card file
      try {
        rmSync(cardPath(ctx.workspacePath, card_id));
      } catch (err) {
        return jsonResponse(500, { error: `Failed to delete card file: ${err}` });
      }

      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: sidecarExists(ctx.workspacePath, scope_id) } });
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
      const card = readCard(ctx.workspacePath, card_id);
      if (!card) return jsonResponse(404, { error: "card_not_found", card_id });
      updateCardFrontmatter(ctx.workspacePath, card_id, { title: title.trim() });
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: sidecarExists(ctx.workspacePath, scope_id) } });
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
    if (!scope_id || !card_id || !column_id || !criterion_id || checked === undefined) {
      return jsonResponse(400, {
        error: "scope_id, card_id, column_id, criterion_id, checked required",
      });
    }

    try {
      const card = readCard(ctx.workspacePath, card_id);
      if (!card) return jsonResponse(404, { error: "card_not_found", card_id });

      const updatedChecks = {
        ...card.checks,
        [column_id]: {
          ...(card.checks[column_id] ?? {}),
          [criterion_id]: {
            checked,
            checked_at: checked ? new Date().toISOString() : null,
            checked_by: "human",
            note: null,
          },
        },
      };
      updateCardFrontmatter(ctx.workspacePath, card_id, { checks: updatedChecks });

      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar);
      return jsonResponse(200, { ok: true, board: { ...snapshot, initialized: sidecarExists(ctx.workspacePath, scope_id) } });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /move  { card_id, to_column_id, scope_id, force? }
// Moves a card: rewrites frontmatter + appends carry-forward + emits event.
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

    const card = readCard(workspacePath, card_id);
    if (!card) {
      return jsonResponse(404, { error: "card_not_found", card_id });
    }

    const fromColumn = sidecar.columns.find((c) => c.id === card.column);
    const toColumn = sidecar.columns.find((c) => c.id === to_column_id);
    if (!toColumn) {
      return jsonResponse(404, { error: "column_not_found", to_column_id });
    }

    if (card.column === to_column_id) {
      return jsonResponse(422, { ok: false, error: "already_in_column", card_id, column_id: to_column_id });
    }

    // Exit criteria gate (soft for human-initiated force=true)
    const exitCriteria = fromColumn?.exit_criteria ?? [];
    const unchecked = getUncheckedCriteria(card, card.column, exitCriteria);
    if (unchecked.length > 0 && !force) {
      return jsonResponse(422, {
        ok: false,
        error: "gate_blocked",
        message: "Exit criteria not satisfied. Pass force=true to override (human only).",
        unchecked_criteria: unchecked,
      });
    }

    // WIP limit check
    if (toColumn.wip_limit !== null) {
      const counts = cardCountsByColumnFromFiles(workspacePath, [to_column_id]);
      const current = counts[to_column_id] ?? 0;
      if (current >= toColumn.wip_limit) {
        return jsonResponse(422, {
          ok: false,
          error: "wip_limit_exceeded",
          current,
          limit: toColumn.wip_limit,
        });
      }
    }

    // Perform move: update frontmatter + append carry-forward comment
    const previousColumnId = card.column;
    const previousColumnName = fromColumn?.name ?? previousColumnId;
    const newOrder = listCards(workspacePath).filter((c) => c.column === to_column_id).length;

    updateCardFrontmatter(workspacePath, card_id, {
      column: to_column_id,
      order: newOrder,
    });
    appendCarryForward(workspacePath, card_id, previousColumnName);

    // Emit events (best-effort)
    const bus = asBusClient(ctx.busClient);
    const overseer = overseerId(workspaceId);
    const columnContextId = sidecar.column_contexts[to_column_id];

    try {
      await bus.emit({
        type: "snowball.card.moved",
        workspace_id: workspaceId,
        source_endpoint_id: overseer,
        destination: {
          kind: "broadcast" as const,
          scope: "workspace",
          target: "active_with_delivery_processor",
        },
        content: {
          text: `Card "${card.title}" moved from "${previousColumnName}" to "${toColumn.name}" (UI)`,
          data: {
            card_id,
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

    // If destination is agent-owned, emit routing event into column context
    if (toColumn.owner.kind === "agent" && toColumn.owner.agent_id) {
      const agentEp = agentEndpointId(workspaceId, toColumn.owner.agent_id);
      try {
        await bus.emit({
          type: "snowball.card.entered_column",
          workspace_id: workspaceId,
          source_endpoint_id: overseer,
          ...(columnContextId ? { context_id: columnContextId } : {}),
          destination: {
            kind: "endpoint" as const,
            endpoint_id: agentEp,
          },
          content: {
            text: `Card "${card.title}" has entered column "${toColumn.name}"`,
            data: {
              card_id,
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
      } catch (err) {
        console.warn(`[snowball] Routing event failed: ${err}`);
      }

      // Synchronous overseer evaluation
      try {
        await advanceCardIfReady(ctx, scope_id, card_id);
      } catch (err) {
        console.warn(`[snowball] Overseer advance failed: ${err}`);
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
