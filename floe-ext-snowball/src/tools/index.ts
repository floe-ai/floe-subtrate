/**
 * Snowball extension tools.
 *
 * Slice 5 (fm/snowball-col-board-s5):
 *   Column definitions read from board.md (via board-file.ts).
 *   column-file.ts is deleted.
 *
 * Slice 4 (fm/snowball-card-context):
 *   create_card + move_card use card contexts (applyColumnAssignment).
 *
 * Gate enforcement:
 *  - move_card: hard block for AI (unchecked exit criteria)
 *  - WIP limit: hard block for both
 */

import type { ExtensionContext } from "../stub/extension-context.js";
import { asBusClient } from "../stub/bus-client.js";
import {
  slugify,
} from "../board-file.js";
import { buildBoardSnapshot } from "../board-snapshot.js";
import {
  listColumnsFromBoard,
  defaultColumnFiles,
} from "../board-file.js";
import {
  readCard,
  writeCard,
  listCards,
  generateCardId,
  updateCardFrontmatter,
  appendCarryForward,
  cardCountsByColumnFromFiles,
  getUncheckedCriteriaForCard,
} from "../card-file.js";
import {
  applyColumnAssignment,
  createCardContext,
  actorEndpointId,
  operatorEndpointId,
} from "../handoff.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEffectiveColumns(workspacePath: string, scopeSlug: string, scopeId: string) {
  const cols = listColumnsFromBoard(workspacePath, scopeSlug);
  return cols.length > 0 ? cols : defaultColumnFiles(scopeId);
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createTools(ctx: ExtensionContext) {
  const { workspacePath, workspaceId } = ctx;

  return [
    // ── list_columns ──────────────────────────────────────────────────────
    {
      name: "list_columns",
      label: "List Board Columns",
      description:
        "List board columns with their config (WIP limit, assigned_actors, exit criteria, agent instructions) for a scope.",
      parameters: {
        type: "object",
        properties: {
          scope_id: { type: "string", description: "Board scope ID." },
        },
        required: ["scope_id"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const scope_id = params.scope_id as string;
        const slug = slugify(scope_id);
        const columns = getEffectiveColumns(workspacePath, slug, scope_id);
        const card_counts = cardCountsByColumnFromFiles(workspacePath, columns.map((c) => c.id));
        return { content: [{ type: "text", text: JSON.stringify({ columns, card_counts }) }] };
      },
    },

    // ── list_cards ────────────────────────────────────────────────────────
    {
      name: "list_cards",
      label: "List Board Cards",
      description: "List cards on the board (or filtered to a column).",
      parameters: {
        type: "object",
        properties: {
          scope_id: { type: "string" },
          column_id: { type: "string", description: "Filter to this column. Omit for all columns." },
        },
        required: ["scope_id"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const column_id = params.column_id as string | undefined;
        const cards = listCards(workspacePath)
          .filter((c) => !column_id || c.column === column_id)
          .map((c) => ({ card_id: c.id, title: c.title, column_id: c.column, order: c.order, created_at: c.created_at, actor: c.actor }))
          .sort((a, b) => a.order - b.order);
        return { content: [{ type: "text", text: JSON.stringify({ cards }) }] };
      },
    },

    // ── create_card ───────────────────────────────────────────────────────
    {
      name: "create_card",
      label: "Create Card",
      description: "Create a new card. Returns the card's id (permanent identity) and context_id.",
      parameters: {
        type: "object",
        properties: {
          scope_id: { type: "string" },
          title: { type: "string" },
          column_id: { type: "string", description: "Initial column. Defaults to first column." },
          description: { type: "string" },
        },
        required: ["scope_id", "title"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const scope_id = params.scope_id as string;
        const title = params.title as string;
        const column_id = params.column_id as string | undefined;
        const description = params.description as string | undefined;

        const slug = slugify(scope_id);
        const columns = getEffectiveColumns(workspacePath, slug, scope_id);
        const targetColumn = column_id ? columns.find((c) => c.id === column_id) : columns[0];
        if (!targetColumn)
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "column_not_found", column_id }) }] };

        if (targetColumn.wip_limit !== null) {
          const counts = cardCountsByColumnFromFiles(workspacePath, [targetColumn.id]);
          const current = counts[targetColumn.id] ?? 0;
          if (current >= targetColumn.wip_limit)
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "wip_limit_exceeded", column_id: targetColumn.id, current, limit: targetColumn.wip_limit }) }] };
        }

        const order = listCards(workspacePath).filter((c) => c.column === targetColumn.id).length;
        const cardId = generateCardId(title);
        const bus = asBusClient(ctx.busClient);

        // Tool path: first assigned actor is creator; fallback to operator
        const firstAssignedEp = targetColumn.assigned_actors.length > 0
          ? actorEndpointId(workspaceId, targetColumn.assigned_actors[0].actor_ref)
          : operatorEndpointId(workspaceId);

        const context_id = await createCardContext({ workspaceId, scope_id, cardTitle: title, creatorEp: firstAssignedEp, bus });

        writeCard(workspacePath, {
          id: cardId, title, type: "task", actor: null,
          column: targetColumn.id, order, created_at: new Date().toISOString(),
          context_id, checks: {}, body: description ?? "",
        });

        await applyColumnAssignment({
          cardContextId: context_id, destAssignedActors: targetColumn.assigned_actors,
          priorAssignedActors: [], actingActorEp: firstAssignedEp,
          workspaceId, scope_id, cardId, cardTitle: title,
          toColumnId: targetColumn.id, toColumnName: targetColumn.name, fromColumnId: "", bus,
        });

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, card_id: cardId, context_id, column_id: targetColumn.id, title }) }] };
      },
    },

    // ── move_card ──────────────────────────────────────────────────────────
    {
      name: "move_card",
      label: "Move Card",
      description: "Move a card to a destination column. AI movers are HARD-BLOCKED by unchecked exit criteria.",
      parameters: {
        type: "object",
        properties: {
          card_id: { type: "string" },
          to_column_id: { type: "string" },
          scope_id: { type: "string" },
          force: { type: "boolean", description: "Human-initiated override of soft gate." },
        },
        required: ["card_id", "to_column_id", "scope_id"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const card_id = params.card_id as string;
        const to_column_id = params.to_column_id as string;
        const scope_id = params.scope_id as string;
        const force = Boolean(params.force);

        const slug = slugify(scope_id);
        const columns = getEffectiveColumns(workspacePath, slug, scope_id);
        const card = readCard(workspacePath, card_id);
        if (!card) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "card_not_found", card_id }) }] };

        const fromColumn = columns.find((c) => c.id === card.column);
        const toColumn = columns.find((c) => c.id === to_column_id);
        if (!toColumn) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "column_not_found", to_column_id }) }] };
        if (card.column === to_column_id) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "already_in_column", card_id, column_id: to_column_id }) }] };

        // Exit criteria gate
        const unchecked = getUncheckedCriteriaForCard(card, fromColumn?.exit_criteria ?? []);
        if (unchecked.length > 0 && !force)
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "gate_blocked", message: "Exit criteria not satisfied. Check all criteria before moving.", unchecked_criteria: unchecked, from_column_id: card.column, to_column_id }) }] };

        // WIP limit gate
        if (toColumn.wip_limit !== null) {
          const counts = cardCountsByColumnFromFiles(workspacePath, [to_column_id]);
          const current = counts[to_column_id] ?? 0;
          if (current >= toColumn.wip_limit)
            return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "wip_limit_exceeded", to_column_id, current, limit: toColumn.wip_limit, message: `Column "${toColumn.name}" is at WIP limit (${current}/${toColumn.wip_limit})` }) }] };
        }

        const previousColumnId = card.column;
        const previousColumnName = fromColumn?.name ?? previousColumnId;
        const newOrder = listCards(workspacePath).filter((c) => c.column === to_column_id).length;
        updateCardFrontmatter(workspacePath, card_id, { column: to_column_id, order: newOrder });
        appendCarryForward(workspacePath, card_id, previousColumnName);

        const bus = asBusClient(ctx.busClient);

        // Lazy card context creation for legacy cards
        let cardContextId = card.context_id;
        if (!cardContextId) {
          const creatorEp = toColumn.assigned_actors.length > 0
            ? actorEndpointId(workspaceId, toColumn.assigned_actors[0].actor_ref)
            : operatorEndpointId(workspaceId);
          cardContextId = await createCardContext({ workspaceId, scope_id, cardTitle: card.title, creatorEp, bus });
          if (cardContextId) updateCardFrontmatter(workspacePath, card_id, { context_id: cardContextId });
        }

        const actingActorEp = toColumn.assigned_actors.length > 0
          ? actorEndpointId(workspaceId, toColumn.assigned_actors[0].actor_ref)
          : operatorEndpointId(workspaceId);

        await applyColumnAssignment({
          cardContextId, destAssignedActors: toColumn.assigned_actors,
          priorAssignedActors: fromColumn?.assigned_actors ?? [],
          actingActorEp, workspaceId, scope_id,
          cardId: card_id, cardTitle: card.title,
          toColumnId: to_column_id, toColumnName: toColumn.name, fromColumnId: previousColumnId,
          bus,
        });

        return { content: [{ type: "text", text: JSON.stringify({ ok: true, card_id, from_column_id: previousColumnId, to_column_id, forced: force }) }] };
      },
    },

    // ── check_criteria ────────────────────────────────────────────────────
    {
      name: "check_criteria",
      label: "Check Exit Criterion",
      description: "Record an exit criterion as checked or unchecked. Call before snowball_move_card.",
      parameters: {
        type: "object",
        properties: {
          card_id: { type: "string" },
          scope_id: { type: "string" },
          criterion_id: { type: "string" },
          checked: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["card_id", "scope_id", "criterion_id", "checked"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const card_id = params.card_id as string;
        const scope_id = params.scope_id as string;
        const criterion_id = params.criterion_id as string;
        const checked = Boolean(params.checked);
        const note = params.note as string | undefined;
        const card = readCard(workspacePath, card_id);
        if (!card) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "card_not_found", card_id }) }] };
        const column_id = card.column;
        updateCardFrontmatter(workspacePath, card_id, {
          checks: {
            ...card.checks,
            [column_id]: {
              ...(card.checks[column_id] ?? {}),
              [criterion_id]: { checked, checked_at: checked ? new Date().toISOString() : null, checked_by: null, note: note ?? null },
            },
          },
        });
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, card_id, criterion_id, checked, column_id }) }] };
      },
    },

    // ── get_board_state ───────────────────────────────────────────────────
    {
      name: "get_board_state",
      label: "Get Board State",
      description: "Get a full board snapshot with columns, card counts, WIP status, and column instructions.",
      parameters: {
        type: "object",
        properties: { scope_id: { type: "string" } },
        required: ["scope_id"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const scope_id = params.scope_id as string;
        const slug = slugify(scope_id);
        const columns = getEffectiveColumns(workspacePath, slug, scope_id);
        const snapshot = buildBoardSnapshot(workspacePath, scope_id, workspaceId, columns);
        return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
      },
    },
  ];
}
