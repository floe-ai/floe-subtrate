/**
 * HTTP handlers for the Snowball extension relay.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   - Column definitions now live in committed markdown files
 *     (boards/<scopeSlug>/columns/<id>.md) instead of the gitignored sidecar.
 *   - POST /board/init now creates column files (if absent) + column contexts.
 *   - POST /columns mutations write to/from column files.
 *   - GET  /column/instructions — read a column's instructions body
 *   - POST /column/instructions — write a column's instructions body
 *
 * Available at:
 *   GET  /v1/extensions/snowball/board?scope_id=<id>              → board state JSON
 *   POST /v1/extensions/snowball/board/init                        → init column files + contexts
 *   POST /v1/extensions/snowball/columns                           → add/update/delete/reorder
 *   GET  /v1/extensions/snowball/column/instructions?scope_id=<id>&column_id=<id>
 *   POST /v1/extensions/snowball/column/instructions               → save instructions body
 *   POST /v1/extensions/snowball/card                              → create card file
 *   POST /v1/extensions/snowball/card/delete                       → remove card file
 *   POST /v1/extensions/snowball/card/rename                       → rename card title
 *   POST /v1/extensions/snowball/card/criteria                     → toggle exit-criterion check
 *   POST /v1/extensions/snowball/move                              → move a card between columns
 */

import type { ExtensionContext } from "./stub/extension-context.js";
import {
  loadSidecar,
  saveSidecar,
  sidecarExists,
  slugify,
  buildBoardSnapshot,
  getUncheckedCriteria,
  initBoardContexts,
} from "./sidecar.js";
import {
  listColumnFiles,
  writeColumnFile,
  readColumnFile,
  deleteColumnFile,
  updateColumnFileFrontmatter,
  updateColumnFileInstructions,
  generateColumnId,
  defaultColumnFiles,
  type ColumnFile,
} from "./column-file.js";
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
  cardPath,
} from "./card-file.js";
import { rmSync } from "node:fs";

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

function overseerId(workspaceId: string): string {
  return `actor:${workspaceId}:snowball-overseer`;
}

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
      const slug = slugify(scope_id);
      let columns = listColumnFiles(workspacePath, slug);
      // Fall back to defaults if no column files exist yet (pre-init)
      if (columns.length === 0) {
        columns = defaultColumnFiles(scope_id);
      }
      const initialized = sidecarExists(workspacePath, scope_id);
      const sidecar = loadSidecar(workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(workspacePath, sidecar, columns);
      return jsonResponse(200, { ...snapshot, initialized });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /board/init  { scope_id }
// Creates committed column files (if absent) + column contexts (idempotent).
// ---------------------------------------------------------------------------

function handlePostBoardInit(
  ctx: ExtensionContext
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as { scope_id?: string };
    const { scope_id } = body;
    if (!scope_id) return jsonResponse(400, { error: "scope_id required" });

    try {
      const slug = slugify(scope_id);

      // 1. Load existing column files or create defaults.
      let columns = listColumnFiles(ctx.workspacePath, slug);
      if (columns.length === 0) {
        columns = defaultColumnFiles(scope_id);
        for (const col of columns) {
          writeColumnFile(ctx.workspacePath, slug, col);
        }
      }

      // 2. Load sidecar (context map only) and set workspace_id.
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;

      // 3. Create column contexts in bus (idempotent).
      const bus = asBusClient(ctx.busClient);
      const { changed } = await initBoardContexts(
        sidecar,
        ctx.workspaceId,
        bus,
        columns
      );
      if (changed || !sidecarExists(ctx.workspacePath, scope_id)) {
        saveSidecar(ctx.workspacePath, scope_id, sidecar);
      }

      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar, columns);
      return jsonResponse(200, {
        ok: true,
        board: { ...snapshot, initialized: true },
      });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /columns
// Manages board columns: add / update / delete / reorder.
// All mutations write to/from committed column files.
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
      const slug = slugify(scope_id);
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;

      let columns = listColumnFiles(ctx.workspacePath, slug);
      // If no column files exist, start from defaults (pre-init board)
      if (columns.length === 0) {
        columns = defaultColumnFiles(scope_id);
        for (const col of columns) writeColumnFile(ctx.workspacePath, slug, col);
      }

      if (action === "add") {
        const name = body.name?.trim();
        if (!name) return jsonResponse(400, { error: "name required for action:add" });

        const id = generateColumnId();
        const newCol: ColumnFile = {
          id,
          name,
          scope_id,
          wip_limit: body.wip_limit ?? null,
          order: columns.length,
          owner: body.owner ?? { kind: "human" },
          exit_criteria: body.exit_criteria ?? [],
          instructions: "",
        };
        writeColumnFile(ctx.workspacePath, slug, newCol);

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
          saveSidecar(ctx.workspacePath, scope_id, sidecar);
        } catch (err) {
          console.warn(
            `[snowball] Failed to create column context for "${name}": ${err}`
          );
        }
      } else if (action === "update") {
        if (!body.column_id)
          return jsonResponse(400, {
            error: "column_id required for action:update",
          });
        const col = columns.find((c) => c.id === body.column_id);
        if (!col)
          return jsonResponse(404, {
            error: "column_not_found",
            column_id: body.column_id,
          });

        const updates: Partial<Omit<ColumnFile, "instructions">> = {};
        if (body.name !== undefined) updates.name = body.name.trim();
        if (body.wip_limit !== undefined) updates.wip_limit = body.wip_limit;
        if (body.owner !== undefined) updates.owner = body.owner;
        if (body.exit_criteria !== undefined)
          updates.exit_criteria = body.exit_criteria;
        updateColumnFileFrontmatter(
          ctx.workspacePath,
          slug,
          body.column_id,
          updates
        );

        // When the column owner changes to an agent, evict the existing context
        // from the sidecar so the next card move triggers a lazy re-init with
        // the new agent as a participant.  The old context remains in the bus
        // DB (historical events are preserved) but is no longer the routing
        // target.  Only evict when the owner was NOT already the same agent to
        // avoid unnecessary churn.
        if (body.owner?.kind === "agent" && body.owner.agent_id) {
          const previousOwner = col.owner;
          const ownerChanged =
            previousOwner.kind !== "agent" ||
            previousOwner.agent_id !== body.owner.agent_id;
          if (ownerChanged && sidecar.column_contexts[body.column_id]) {
            delete sidecar.column_contexts[body.column_id];
            saveSidecar(ctx.workspacePath, scope_id, sidecar);
          }
        }
      } else if (action === "delete") {
        if (!body.column_id)
          return jsonResponse(400, {
            error: "column_id required for action:delete",
          });
        const colIdx = columns.findIndex((c) => c.id === body.column_id);
        if (colIdx === -1)
          return jsonResponse(404, {
            error: "column_not_found",
            column_id: body.column_id,
          });
        if (columns.length <= 1) {
          return jsonResponse(422, { error: "Cannot delete the last column" });
        }
        // Move any cards in this column to the first remaining column (file update)
        const remaining = columns.filter((_, i) => i !== colIdx);
        const fallbackCol = remaining[0];
        const allCards = listCards(ctx.workspacePath);
        const currentCount = allCards.filter(
          (c) => c.column === fallbackCol.id
        ).length;
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
        saveSidecar(ctx.workspacePath, scope_id, sidecar);
        deleteColumnFile(ctx.workspacePath, slug, body.column_id);
      } else if (action === "reorder") {
        const ids = body.column_ids;
        if (!Array.isArray(ids))
          return jsonResponse(400, {
            error: "column_ids required for action:reorder",
          });
        // Update the order field in each column file
        const idOrder = new Map(ids.map((id, i) => [id, i]));
        for (const col of columns) {
          const newOrder = idOrder.get(col.id);
          if (newOrder !== undefined && newOrder !== col.order) {
            updateColumnFileFrontmatter(ctx.workspacePath, slug, col.id, {
              order: newOrder,
            });
          }
        }
        // Handle columns not in the ids list (append at end)
        let extra = ids.length;
        for (const col of columns) {
          if (!idOrder.has(col.id)) {
            updateColumnFileFrontmatter(ctx.workspacePath, slug, col.id, {
              order: extra++,
            });
          }
        }
      } else {
        return jsonResponse(400, { error: `Unknown action: ${String(action)}` });
      }

      // Reload columns after mutation to get fresh state
      const updatedColumns = listColumnFiles(ctx.workspacePath, slug);
      const snapshot = buildBoardSnapshot(
        ctx.workspacePath,
        sidecar,
        updatedColumns.length > 0 ? updatedColumns : defaultColumnFiles(scope_id)
      );
      return jsonResponse(200, {
        ok: true,
        board: {
          ...snapshot,
          initialized: sidecarExists(ctx.workspacePath, scope_id),
        },
      });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// GET /column/instructions?scope_id=<id>&column_id=<id>
// Returns the instructions body of a column definition file.
// ---------------------------------------------------------------------------

function handleGetColumnInstructions(
  workspacePath: string
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const { scope_id, column_id } = req.query;
    if (!scope_id || !column_id) {
      return jsonResponse(400, {
        error: "scope_id and column_id query parameters required",
      });
    }
    try {
      const slug = slugify(scope_id);
      const col = readColumnFile(workspacePath, slug, column_id);
      if (!col) {
        return jsonResponse(404, {
          error: "column_not_found",
          column_id,
          note: "Column file does not exist. Initialize the board first.",
        });
      }
      return jsonResponse(200, {
        column_id: col.id,
        column_name: col.name,
        instructions: col.instructions,
      });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /column/instructions  { scope_id, column_id, instructions }
// Saves the instructions body of a column definition file.
// The file body IS the instructions — this is the committed source of truth.
// ---------------------------------------------------------------------------

function handlePostColumnInstructions(
  workspacePath: string
): (req: RelayRequest) => Promise<RelayResponse> {
  return async (req) => {
    const body = (req.body ?? {}) as {
      scope_id?: string;
      column_id?: string;
      instructions?: string;
    };
    const { scope_id, column_id, instructions } = body;
    if (!scope_id || !column_id || instructions === undefined) {
      return jsonResponse(400, {
        error: "scope_id, column_id, and instructions required",
      });
    }
    try {
      const slug = slugify(scope_id);
      const updated = updateColumnFileInstructions(
        workspacePath,
        slug,
        column_id,
        instructions
      );
      if (!updated) {
        return jsonResponse(404, {
          error: "column_not_found",
          column_id,
          note: "Column file does not exist. Initialize the board first.",
        });
      }
      return jsonResponse(200, {
        ok: true,
        column_id: updated.id,
        column_name: updated.name,
        instructions: updated.instructions,
      });
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
      const slug = slugify(scope_id);
      let columns = listColumnFiles(ctx.workspacePath, slug);
      if (columns.length === 0) {
        columns = defaultColumnFiles(scope_id);
        for (const col of columns) writeColumnFile(ctx.workspacePath, slug, col);
      }

      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      if (!sidecar.workspace_id) sidecar.workspace_id = ctx.workspaceId;

      const targetColId = column_id ?? columns[0]?.id;
      if (!targetColId) return jsonResponse(400, { error: "Board has no columns" });
      const targetCol = columns.find((c) => c.id === targetColId);
      if (!targetCol)
        return jsonResponse(404, {
          error: "column_not_found",
          column_id: targetColId,
        });

      // WIP limit check
      if (targetCol.wip_limit !== null) {
        const counts = cardCountsByColumnFromFiles(ctx.workspacePath, [
          targetColId,
        ]);
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
          scope_id,
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

      const snapshot = buildBoardSnapshot(ctx.workspacePath, sidecar, columns);
      return jsonResponse(201, {
        ok: true,
        card_id: cardId,
        board: {
          ...snapshot,
          initialized: sidecarExists(ctx.workspacePath, scope_id),
        },
      });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card/delete  { scope_id, card_id }
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
      try {
        rmSync(cardPath(ctx.workspacePath, card_id));
      } catch (err) {
        return jsonResponse(500, { error: `Failed to delete card file: ${err}` });
      }

      const slug = slugify(scope_id);
      const columns = listColumnFiles(ctx.workspacePath, slug);
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(
        ctx.workspacePath,
        sidecar,
        columns.length > 0 ? columns : defaultColumnFiles(scope_id)
      );
      return jsonResponse(200, {
        ok: true,
        board: {
          ...snapshot,
          initialized: sidecarExists(ctx.workspacePath, scope_id),
        },
      });
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
      return jsonResponse(400, {
        error: "scope_id, card_id, title required",
      });
    }

    try {
      const card = readCard(ctx.workspacePath, card_id);
      if (!card) return jsonResponse(404, { error: "card_not_found", card_id });
      updateCardFrontmatter(ctx.workspacePath, card_id, {
        title: title.trim(),
      });
      const slug = slugify(scope_id);
      const columns = listColumnFiles(ctx.workspacePath, slug);
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(
        ctx.workspacePath,
        sidecar,
        columns.length > 0 ? columns : defaultColumnFiles(scope_id)
      );
      return jsonResponse(200, {
        ok: true,
        board: {
          ...snapshot,
          initialized: sidecarExists(ctx.workspacePath, scope_id),
        },
      });
    } catch (err) {
      return jsonResponse(500, { error: String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// POST /card/criteria  { scope_id, card_id, column_id, criterion_id, checked }
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
      updateCardFrontmatter(ctx.workspacePath, card_id, {
        checks: updatedChecks,
      });

      const slug = slugify(scope_id);
      const columns = listColumnFiles(ctx.workspacePath, slug);
      const sidecar = loadSidecar(ctx.workspacePath, scope_id);
      const snapshot = buildBoardSnapshot(
        ctx.workspacePath,
        sidecar,
        columns.length > 0 ? columns : defaultColumnFiles(scope_id)
      );
      return jsonResponse(200, {
        ok: true,
        board: {
          ...snapshot,
          initialized: sidecarExists(ctx.workspacePath, scope_id),
        },
      });
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
    const slug = slugify(scope_id);
    const columns = listColumnFiles(workspacePath, slug);
    const effectiveColumns =
      columns.length > 0 ? columns : defaultColumnFiles(scope_id);
    const sidecar = loadSidecar(workspacePath, scope_id);

    const card = readCard(workspacePath, card_id);
    if (!card) {
      return jsonResponse(404, { error: "card_not_found", card_id });
    }

    const fromColumn = effectiveColumns.find((c) => c.id === card.column);
    const toColumn = effectiveColumns.find((c) => c.id === to_column_id);
    if (!toColumn) {
      return jsonResponse(404, { error: "column_not_found", to_column_id });
    }

    if (card.column === to_column_id) {
      return jsonResponse(422, {
        ok: false,
        error: "already_in_column",
        card_id,
        column_id: to_column_id,
      });
    }

    // Exit criteria gate (soft for human-initiated force=true)
    const exitCriteria = fromColumn?.exit_criteria ?? [];
    const unchecked = getUncheckedCriteria(card, card.column, exitCriteria);
    if (unchecked.length > 0 && !force) {
      return jsonResponse(422, {
        ok: false,
        error: "gate_blocked",
        message:
          "Exit criteria not satisfied. Pass force=true to override (human only).",
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

    // Perform move
    const previousColumnId = card.column;
    const previousColumnName = fromColumn?.name ?? previousColumnId;
    const newOrder = listCards(workspacePath).filter(
      (c) => c.column === to_column_id
    ).length;

    updateCardFrontmatter(workspacePath, card_id, {
      column: to_column_id,
      order: newOrder,
    });
    appendCarryForward(workspacePath, card_id, previousColumnName);

    // Emit events (best-effort)
    const bus = asBusClient(ctx.busClient);
    const overseer = overseerId(workspaceId);

    // Lazy board init: if the destination column is agent-owned but has no column
    // context yet (board never initialised, or context was evicted after an owner
    // change), create it now so the routing event lands in the right context.
    if (toColumn.owner.kind === "agent" && !sidecar.column_contexts[to_column_id]) {
      try {
        const { changed } = await initBoardContexts(
          sidecar,
          workspaceId,
          bus,
          effectiveColumns
        );
        if (changed) saveSidecar(workspacePath, scope_id, sidecar);
      } catch (err) {
        console.warn(`[snowball] Lazy board init failed: ${err}`);
      }
    }

    const columnContextId = sidecar.column_contexts[to_column_id];

    try {
      await bus.emit({
        type: "snowball.card.moved",
        workspace_id: workspaceId,
        source_endpoint_id: overseer,
        scope_id,
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
          scope_id,
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
  ctx.registerHttpHandler(
    "GET",
    "/column/instructions",
    handleGetColumnInstructions(ctx.workspacePath)
  );
  ctx.registerHttpHandler(
    "POST",
    "/column/instructions",
    handlePostColumnInstructions(ctx.workspacePath)
  );
  ctx.registerHttpHandler("POST", "/card", handlePostCard(ctx));
  ctx.registerHttpHandler("POST", "/card/delete", handlePostCardDelete(ctx));
  ctx.registerHttpHandler("POST", "/card/rename", handlePostCardRename(ctx));
  ctx.registerHttpHandler("POST", "/card/criteria", handlePostCardCriteria(ctx));
  ctx.registerHttpHandler("POST", "/move", handlePostMove(ctx));
  console.info(
    "[snowball] HTTP handlers registered: GET /board, POST /board/init, POST /columns, GET /column/instructions, POST /column/instructions, POST /card, POST /card/delete, POST /card/rename, POST /card/criteria, POST /move"
  );
}
