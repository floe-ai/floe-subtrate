/**
 * HTTP handlers for the Snowball extension relay.
 *
 * These are registered with the extension's registerHttpHandler (Track S
 * extension relay feature) and become available at:
 *
 *   GET  /v1/extensions/snowball/board?scope_id=<id>   → board state JSON
 *   POST /v1/extensions/snowball/move                  → move a card (UI-initiated)
 *
 * The UI (BoardView.tsx) calls these endpoints.
 *
 * If registerHttpHandler is not yet available (pre-Track-S), registration is
 * skipped gracefully — the tools remain usable by agents.
 */

import type { ExtensionContext } from "./stub/extension-context.js";
import {
  loadSidecar,
  saveSidecar,
  buildBoardSnapshot,
  getUncheckedCriteria,
} from "./sidecar.js";
import { asBusClient } from "./stub/bus-client.js";

// ---------------------------------------------------------------------------
// Request / response types — matches the real ExtensionContext.registerHttpHandler
// interface from floe-bridge/src/extension-loader.ts
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
      const sidecar = loadSidecar(workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(sidecar);
      return jsonResponse(200, snapshot);
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /move  { card_id, to_column_id, scope_id, force? }
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
        message: "Exit criteria not satisfied. Pass force=true to override (human only).",
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
    card.order = Object.values(sidecar.cards).filter(
      (c) => c.column_id === to_column_id
    ).length - 1; // already counted including this card
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
// Register both handlers with the extension relay
// ---------------------------------------------------------------------------

export function registerHttpHandlers(ctx: ExtensionContext): void {
  ctx.registerHttpHandler("GET", "/board", handleGetBoard(ctx.workspacePath));
  ctx.registerHttpHandler("POST", "/move", handlePostMove(ctx));
  console.info("[snowball] HTTP handlers registered: GET /board, POST /move");
}
