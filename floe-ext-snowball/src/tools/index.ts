/**
 * Snowball extension tools.
 *
 * Foundation Slice 1 (fm/snowball-found-s1):
 *   - Cards are markdown files at tasks/<id>.md (not bus Contexts)
 *   - Columns are bus Contexts (created at board init)
 *   - Card-move writes frontmatter + appends carry-forward + emits to column context
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
  getUncheckedCriteria,
  buildBoardSnapshot,
  cardCountsByColumn,
} from "../sidecar.js";
import {
  readCard,
  writeCard,
  listCards,
  generateCardId,
  updateCardFrontmatter,
  appendCarryForward,
  cardCountsByColumnFromFiles,
} from "../card-file.js";
import { advanceCardIfReady } from "../overseer.js";

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
        "List board columns with their config (WIP limit, owner, exit criteria) for a scope. Returns current card counts per column.",
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
        const sidecar = loadSidecar(workspacePath, scope_id);
        const card_counts = cardCountsByColumn(workspacePath, sidecar);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ columns: sidecar.columns, card_counts }),
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

        const sidecar = loadSidecar(workspacePath, scope_id);

        const targetColumn = column_id
          ? sidecar.columns.find((c) => c.id === column_id)
          : sidecar.columns[0];

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
          const counts = cardCountsByColumnFromFiles(workspacePath, [targetColumn.id]);
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

        const order = listCards(workspacePath).filter((c) => c.column === targetColumn.id).length;
        const cardId = generateCardId(title);
        writeCard(workspacePath, {
          id: cardId,
          title,
          type: "task",
          actor: null,
          column: targetColumn.id,
          order,
          created_at: new Date().toISOString(),
          checks: {},
          body: description ?? "",
        });

        // Emit creation event (best-effort)
        try {
          const bus = asBusClient(ctx.busClient);
          await bus.emit({
            type: "snowball.card.created",
            workspace_id: workspaceId,
            source_endpoint_id: overseerId(workspaceId),
            destination: {
              kind: "broadcast" as const,
              scope: "workspace",
              target: "active_with_delivery_processor",
            },
            content: {
              text: `Card "${title}" created in "${targetColumn.name}"`,
              data: {
                card_id: cardId,
                column_id: targetColumn.id,
                board_scope_id: scope_id,
              },
            },
            metadata: { source: "snowball-extension" },
          });
        } catch {
          // Non-fatal
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                card_id: cardId,
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

        const sidecar = loadSidecar(workspacePath, scope_id);

        const card = readCard(workspacePath, card_id);
        if (!card) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ ok: false, error: "card_not_found", card_id }),
              },
            ],
          };
        }

        const fromColumn = sidecar.columns.find((c) => c.id === card.column);
        const toColumn = sidecar.columns.find((c) => c.id === to_column_id);
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
          const counts = cardCountsByColumnFromFiles(workspacePath, [to_column_id]);
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
        const newOrder = listCards(workspacePath).filter((c) => c.column === to_column_id).length;

        // Rewrite card file frontmatter in-place (file stays at tasks/<id>.md)
        updateCardFrontmatter(workspacePath, card_id, {
          column: to_column_id,
          order: newOrder,
        });
        // Append carry-forward comment to card body
        appendCarryForward(workspacePath, card_id, previousColumnName);

        const bus = asBusClient(ctx.busClient);
        const overseer = overseerId(workspaceId);
        const columnContextId = sidecar.column_contexts[to_column_id];

        // Emit general move event (best-effort)
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
              text: `Card "${card.title}" moved from "${previousColumnName}" to "${toColumn.name}"`,
              data: {
                card_id,
                card_title: card.title,
                from_column_id: previousColumnId,
                to_column_id,
                forced: force,
                board_scope_id: scope_id,
              },
            },
            metadata: { source: "snowball-extension" },
          });
        } catch {
          // Non-fatal
        }

        // If destination is agent-owned, emit routing event to column context
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
            console.warn(`[snowball] Failed to emit routing event: ${err}`);
          }

          // Synchronous overseer evaluation
          try {
            await advanceCardIfReady(ctx, scope_id, card_id);
          } catch (err) {
            console.warn(`[snowball] Overseer advance failed: ${err}`);
          }
        }

        // Soft gate override warning (human + unchecked)
        if (force && unchecked.length > 0) {
          try {
            await bus.emit({
              type: "snowball.card.gate_overridden",
              workspace_id: workspaceId,
              source_endpoint_id: overseer,
              destination: {
                kind: "broadcast" as const,
                scope: "workspace",
                target: "active_with_delivery_processor",
              },
              content: {
                text: `Human override: card "${card.title}" moved from "${fromColumn?.name}" despite unchecked criteria`,
                data: {
                  card_id,
                  unchecked_criteria: unchecked,
                  board_scope_id: scope_id,
                },
              },
              metadata: { source: "snowball-extension" },
            });
          } catch {
            // Non-fatal
          }
        }

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
        updateCardFrontmatter(workspacePath, card_id, { checks: updatedChecks });

        // Emit criteria checked event (best-effort)
        try {
          const bus = asBusClient(ctx.busClient);
          await bus.emit({
            type: "snowball.card.criteria_checked",
            workspace_id: workspaceId,
            source_endpoint_id: overseerId(workspaceId),
            destination: {
              kind: "broadcast" as const,
              scope: "workspace",
              target: "active_with_delivery_processor",
            },
            content: {
              text: `Criterion "${criterion_id}" ${checked ? "checked" : "unchecked"} for card "${card.title}"`,
              data: {
                card_id,
                criterion_id,
                column_id,
                checked,
                board_scope_id: scope_id,
              },
            },
            metadata: { source: "snowball-extension" },
          });
        } catch {
          // Non-fatal
        }

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
        "Get a full board snapshot: columns with card counts, WIP status, cards per column. Use before any strategic decision.",
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
        const sidecar = loadSidecar(workspacePath, scope_id);
        const snapshot = buildBoardSnapshot(workspacePath, sidecar);
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot) }],
        };
      },
    },
  ];
}
