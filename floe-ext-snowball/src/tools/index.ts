/**
 * Snowball extension tools.
 *
 * Slice 4 (fm/snowball-card-context):
 *   - create_card now creates a bus context for the card (card = context).
 *   - move_card uses applyColumnAssignment (card context) instead of column contexts.
 *   - Columns use assigned_actors[] — no owner.kind branching.
 *   - Tool path acting actor: first assigned actor of destination column.
 *     (The calling agent's endpoint is not available in ExtensionContext; using
 *     destination actor as source is pragmatic — they just became a participant.)
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   - Column definitions now read from committed column files instead of sidecar.
 *   - list_columns returns column definitions from column files.
 *   - move_card and create_card read column config from column files.
 *
 * Gate enforcement (§5.2):
 *  - move_card: hard block for AI (no force), soft warning for human (force=true)
 *  - WIP limit: hard block for both
 *  - All others: no gate
 */

import type { ExtensionContext } from "../stub/extension-context.js";
import { asBusClient } from "../stub/bus-client.js";
import {
  loadSidecar,
  slugify,
  getUncheckedCriteria,
  buildBoardSnapshot,
} from "../sidecar.js";
import {
  listColumnFiles,
  defaultColumnFiles,
} from "../column-file.js";
import {
  readCard,
  writeCard,
  listCards,
  generateCardId,
  updateCardFrontmatter,
  appendCarryForward,
  cardCountsByColumnFromFiles,
} from "../card-file.js";
import {
  applyColumnAssignment,
  createCardContext,
  actorEndpointId,
  operatorEndpointId,
} from "../handoff.js";

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
        "List board columns with their config (WIP limit, assigned_actors, exit criteria, agent instructions) for a scope. Returns current card counts per column.",
      parameters: {
        type: "object",
        properties: {
          scope_id: {
            type: "string",
            description: "Board scope ID. Use current delivery scope_id.",
          },
        },
        required: ["scope_id"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const scope_id = params.scope_id as string;
        const slug = slugify(scope_id);
        const columns = listColumnFiles(workspacePath, slug);
        const effectiveColumns =
          columns.length > 0 ? columns : defaultColumnFiles(scope_id);
        const card_counts = cardCountsByColumnFromFiles(
          workspacePath,
          effectiveColumns.map((c) => c.id)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ columns: effectiveColumns, card_counts }),
            },
          ],
        };
      },
    },

    // ── list_cards ────────────────────────────────────────────────────────
    {
      name: "list_cards",
      label: "List Board Cards",
      description:
        "List cards on the board (or filtered to a column). Each card is identified by its id. Include column_id to filter.",
      parameters: {
        type: "object",
        properties: {
          scope_id: { type: "string" },
          column_id: {
            type: "string",
            description: "Filter to this column. Omit for all columns.",
          },
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
          .map((c) => ({
            card_id: c.id,
            title: c.title,
            column_id: c.column,
            order: c.order,
            created_at: c.created_at,
            actor: c.actor,
          }))
          .sort((a, b) => a.order - b.order);
        return {
          content: [{ type: "text", text: JSON.stringify({ cards }) }],
        };
      },
    },

    // ── create_card ───────────────────────────────────────────────────────
    {
      name: "create_card",
      label: "Create Card",
      description:
        "Create a new card as a markdown file in tasks/. Returns the card's id, which is its permanent identity.",
      parameters: {
        type: "object",
        properties: {
          scope_id: { type: "string", description: "Board scope ID" },
          title: { type: "string", description: "Card title" },
          column_id: {
            type: "string",
            description: "Initial column. Defaults to first column.",
          },
          description: {
            type: "string",
            description: "Card description / body text",
          },
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
        const columns = listColumnFiles(workspacePath, slug);
        const effectiveColumns =
          columns.length > 0 ? columns : defaultColumnFiles(scope_id);

        const targetColumn = column_id
          ? effectiveColumns.find((c) => c.id === column_id)
          : effectiveColumns[0];

        if (!targetColumn) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "column_not_found",
                  column_id,
                }),
              },
            ],
          };
        }

        // WIP check
        if (targetColumn.wip_limit !== null) {
          const counts = cardCountsByColumnFromFiles(workspacePath, [
            targetColumn.id,
          ]);
          const current = counts[targetColumn.id] ?? 0;
          if (current >= targetColumn.wip_limit) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    error: "wip_limit_exceeded",
                    column_id: targetColumn.id,
                    current,
                    limit: targetColumn.wip_limit,
                  }),
                },
              ],
            };
          }
        }

        const order = listCards(workspacePath).filter(
          (c) => c.column === targetColumn.id
        ).length;
        const cardId = generateCardId(title);
        const bus = asBusClient(ctx.busClient);

        // The calling agent is the creator. We use the destination column's first
        // assigned actor as the acting endpoint if available; else the operator.
        // TODO: replace with actual calling-agent endpoint when ExtensionContext
        // exposes the current endpoint_id.
        const firstAssignedEp =
          targetColumn.assigned_actors.length > 0
            ? actorEndpointId(workspaceId, targetColumn.assigned_actors[0].actor_ref)
            : operatorEndpointId(workspaceId);

        // Create card bus context — the creating actor becomes first participant.
        const context_id = await createCardContext({
          workspaceId,
          scope_id,
          cardTitle: title,
          creatorEp: firstAssignedEp,
          bus,
        });

        writeCard(workspacePath, {
          id: cardId,
          title,
          type: "task",
          actor: null,
          column: targetColumn.id,
          order,
          created_at: new Date().toISOString(),
          context_id,
          checks: {},
          body: description ?? "",
        });

        // Apply column assignment for the destination column.
        await applyColumnAssignment({
          cardContextId: context_id,
          destAssignedActors: targetColumn.assigned_actors,
          priorAssignedActors: [],
          actingActorEp: firstAssignedEp,
          workspaceId,
          scope_id,
          cardId,
          cardTitle: title,
          toColumnId: targetColumn.id,
          toColumnName: targetColumn.name,
          fromColumnId: "",
          bus,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                card_id: cardId,
                context_id,
                column_id: targetColumn.id,
                title,
              }),
            },
          ],
        };
      },
    },

    // ── move_card ──────────────────────────────────────────────────────────
    {
      name: "move_card",
      label: "Move Card",
      description:
        "Move a card to a destination column. AI movers are HARD-BLOCKED by unchecked exit criteria. Human-initiated moves receive a soft warning. Check snowball_list_columns for column IDs.",
      parameters: {
        type: "object",
        properties: {
          card_id: {
            type: "string",
            description: "The id of the card (e.g. fix-login-bug-lz0vb8)",
          },
          to_column_id: {
            type: "string",
            description: "Destination column ID",
          },
          scope_id: { type: "string" },
          force: {
            type: "boolean",
            description:
              "For human-initiated moves only: pass true to override soft gate. Default false.",
          },
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
        const columns = listColumnFiles(workspacePath, slug);
        const effectiveColumns =
          columns.length > 0 ? columns : defaultColumnFiles(scope_id);

        const card = readCard(workspacePath, card_id);
        if (!card) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "card_not_found",
                  card_id,
                }),
              },
            ],
          };
        }

        const fromColumn = effectiveColumns.find((c) => c.id === card.column);
        const toColumn = effectiveColumns.find((c) => c.id === to_column_id);
        if (!toColumn) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "column_not_found",
                  to_column_id,
                }),
              },
            ],
          };
        }

        if (card.column === to_column_id) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "already_in_column",
                  card_id,
                  column_id: to_column_id,
                }),
              },
            ],
          };
        }

        // ── Gate: exit criteria from the SOURCE column ──────────────────
        const exitCriteria = fromColumn?.exit_criteria ?? [];
        const unchecked = getUncheckedCriteria(card, card.column, exitCriteria);
        if (unchecked.length > 0 && !force) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "gate_blocked",
                  message:
                    "Exit criteria not satisfied. Check all criteria before moving.",
                  unchecked_criteria: unchecked,
                  from_column_id: card.column,
                  to_column_id,
                }),
              },
            ],
          };
        }

        // ── Gate: WIP limit on destination column ──────────────────────
        if (toColumn.wip_limit !== null) {
          const counts = cardCountsByColumnFromFiles(workspacePath, [
            to_column_id,
          ]);
          const current = counts[to_column_id] ?? 0;
          if (current >= toColumn.wip_limit) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    ok: false,
                    error: "wip_limit_exceeded",
                    to_column_id,
                    current,
                    limit: toColumn.wip_limit,
                    message: `Column "${toColumn.name}" is at WIP limit (${current}/${toColumn.wip_limit})`,
                  }),
                },
              ],
            };
          }
        }

        // ── Perform move ───────────────────────────────────────────────
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

        const bus = asBusClient(ctx.busClient);

        // Lazy card context creation for legacy cards (created before Slice 4).
        let cardContextId = card.context_id;
        if (!cardContextId) {
          // Destination actor becomes the creator for legacy cards.
          const creatorEp =
            toColumn.assigned_actors.length > 0
              ? actorEndpointId(workspaceId, toColumn.assigned_actors[0].actor_ref)
              : operatorEndpointId(workspaceId);
          cardContextId = await createCardContext({
            workspaceId,
            scope_id,
            cardTitle: card.title,
            creatorEp,
            bus,
          });
          if (cardContextId) {
            updateCardFrontmatter(workspacePath, card_id, { context_id: cardContextId });
          }
        }

        // The acting actor for tool-initiated moves is the destination column's first
        // assigned actor (they are about to become a participant and take ownership).
        // TODO: replace with actual calling-agent endpoint when available in ExtensionContext.
        const actingActorEp =
          toColumn.assigned_actors.length > 0
            ? actorEndpointId(workspaceId, toColumn.assigned_actors[0].actor_ref)
            : operatorEndpointId(workspaceId);

        // Apply column assignment: add new actors, demote prior actors, emit entered_column.
        await applyColumnAssignment({
          cardContextId,
          destAssignedActors: toColumn.assigned_actors,
          priorAssignedActors: fromColumn?.assigned_actors ?? [],
          actingActorEp,
          workspaceId,
          scope_id,
          cardId: card_id,
          cardTitle: card.title,
          toColumnId: to_column_id,
          toColumnName: toColumn.name,
          fromColumnId: previousColumnId,
          bus,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                card_id,
                from_column_id: previousColumnId,
                to_column_id,
                forced: force,
              }),
            },
          ],
        };
      },
    },

    // ── check_criteria ────────────────────────────────────────────────────
    {
      name: "check_criteria",
      label: "Check Exit Criterion",
      description:
        "Record an exit criterion as checked or unchecked for a card in its current column. Call this before snowball_move_card to satisfy the gate.",
      parameters: {
        type: "object",
        properties: {
          card_id: {
            type: "string",
            description: "id of the card",
          },
          scope_id: { type: "string" },
          criterion_id: {
            type: "string",
            description:
              "Criterion ID as defined in the column's exit_criteria list",
          },
          checked: { type: "boolean" },
          note: {
            type: "string",
            description:
              "Evidence note (e.g. 'Tests passed with 100% coverage')",
          },
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
        if (!card) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "card_not_found",
                  card_id,
                }),
              },
            ],
          };
        }

        const column_id = card.column;
        const updatedChecks = {
          ...card.checks,
          [column_id]: {
            ...(card.checks[column_id] ?? {}),
            [criterion_id]: {
              checked,
              checked_at: checked ? new Date().toISOString() : null,
              checked_by: null,
              note: note ?? null,
            },
          },
        };
        updateCardFrontmatter(workspacePath, card_id, {
          checks: updatedChecks,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                card_id,
                criterion_id,
                checked,
                column_id,
              }),
            },
          ],
        };
      },
    },

    // ── get_board_state ───────────────────────────────────────────────────
    {
      name: "get_board_state",
      label: "Get Board State",
      description:
        "Get a full board snapshot: columns with card counts, WIP status, cards per column, column instructions. Use before any strategic decision.",
      parameters: {
        type: "object",
        properties: {
          scope_id: { type: "string" },
        },
        required: ["scope_id"],
      },
      async execute(
        _callId: string,
        params: Record<string, unknown>
      ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
        const scope_id = params.scope_id as string;
        const slug = slugify(scope_id);
        const columns = listColumnFiles(workspacePath, slug);
        const effectiveColumns =
          columns.length > 0 ? columns : defaultColumnFiles(scope_id);
        const sidecar = loadSidecar(workspacePath, scope_id);
        const snapshot = buildBoardSnapshot(
          workspacePath,
          sidecar,
          effectiveColumns
        );
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot) }],
        };
      },
    },
  ];
}
