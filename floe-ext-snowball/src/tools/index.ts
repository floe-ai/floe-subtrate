/**
 * Snowball extension tools.
 *
 * All 6 tools per contract §5.  Tool names here are WITHOUT the `snowball_`
 * prefix — the extension loader adds that automatically.
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
  saveSidecar,
  getUncheckedCriteria,
  buildBoardSnapshot,
  cardCountsByColumn,
} from "../sidecar.js";
import { advanceCardIfReady } from "../overseer.js";

// ---------------------------------------------------------------------------
// Routing event helper
// ---------------------------------------------------------------------------

async function emitCardEnteredColumn(
  ctx: ExtensionContext,
  params: {
    card_id: string;
    card_title: string;
    column_id: string;
    column_name: string;
    from_column_id: string;
    scope_id: string;
    agent_id: string;
  }
): Promise<void> {
  const bus = asBusClient(ctx.busClient);
  // Resolve agent_id → endpoint_id
  const endpoints = await bus.listEndpoints(ctx.workspaceId);
  const agentEndpoint = endpoints.find(
    (ep) =>
      ep.endpoint_id.endsWith(`:${params.agent_id}`) ||
      ep.agent_id === params.agent_id
  );

  if (!agentEndpoint) {
    console.warn(
      `[snowball] Could not resolve endpoint for agent '${params.agent_id}' — routing event skipped`
    );
    return;
  }

  await bus.emit({
    type: "snowball.card.entered_column",
    workspace_id: ctx.workspaceId,
    destination: {
      kind: "endpoint",
      endpoint_id: agentEndpoint.endpoint_id,
    },
    content: {
      text: `Card "${params.card_title}" has entered column "${params.column_name}"`,
      data: {
        card_context_id: params.card_id,
        card_title: params.card_title,
        column_id: params.column_id,
        column_name: params.column_name,
        from_column_id: params.from_column_id,
        board_scope_id: params.scope_id,
      },
    },
    response: { expected: true },
    metadata: { source: "snowball-extension" },
  });
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
        const card_counts = cardCountsByColumn(sidecar);
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
        "List cards in a column (or all columns). Each card is identified by context_id. Include column_id to filter.",
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
        const scope_id = params.scope_id as string;
        const column_id = params.column_id as string | undefined;
        const sidecar = loadSidecar(workspacePath, scope_id);
        const cards = Object.entries(sidecar.cards)
          .filter(([, c]) => !column_id || c.column_id === column_id)
          .map(([ctxId, c]) => ({ card_id: ctxId, ...c }))
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
        "Create a new card (= a new floe Context scoped to the board). Returns the card's context_id, which is its permanent identity.",
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
            description: "Card description / initial context message",
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

        const sidecar = loadSidecar(workspacePath, scope_id);
        sidecar.workspace_id = workspaceId;

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

        // Create the Context in the bus — card_id = context_id
        const bus = asBusClient(ctx.busClient);
        let context_id: string;
        try {
          context_id = await bus.createContext({
            workspace_id: workspaceId,
            scope_id,
            participants: [],
          });
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  error: "create_context_failed",
                  message: String(err),
                }),
              },
            ],
          };
        }

        const order = Object.values(sidecar.cards).filter(
          (c) => c.column_id === targetColumn.id
        ).length;

        sidecar.cards[context_id] = {
          column_id: targetColumn.id,
          order,
          title,
          created_at: new Date().toISOString(),
          checks: {},
        };
        saveSidecar(workspacePath, scope_id, sidecar);

        // Emit creation event
        try {
          await bus.emit({
            type: "snowball.card.created",
            workspace_id: workspaceId,
            content: {
              text: `Card "${title}" created in "${targetColumn.name}"`,
              data: {
                card_context_id: context_id,
                column_id: targetColumn.id,
                board_scope_id: scope_id,
              },
            },
            metadata: { source: "snowball-extension" },
          });
        } catch {
          // Non-fatal: emit failure does not roll back the card creation
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                card_id: context_id,
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
            description: "The context_id of the card (e.g. ctx_abc123)",
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

        const card = sidecar.cards[card_id];
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

        const fromColumn = sidecar.columns.find(
          (c) => c.id === card.column_id
        );
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

        if (card.column_id === to_column_id) {
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
        const unchecked = getUncheckedCriteria(card, card.column_id, exitCriteria);
        if (unchecked.length > 0 && !force) {
          // Hard block: AI callers (and humans who haven't passed force=true)
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
                  from_column_id: card.column_id,
                  to_column_id,
                }),
              },
            ],
          };
        }

        // ── Gate: WIP limit on destination column ──────────────────────
        if (toColumn.wip_limit !== null) {
          const current = Object.values(sidecar.cards).filter(
            (c) => c.column_id === to_column_id
          ).length;
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
        const previousColumnId = card.column_id;
        const newOrder = Object.values(sidecar.cards).filter(
          (c) => c.column_id === to_column_id
        ).length;
        card.column_id = to_column_id;
        card.order = newOrder;
        saveSidecar(workspacePath, scope_id, sidecar);

        const bus = asBusClient(ctx.busClient);

        // Emit general move event to overseer (best-effort)
        try {
          await bus.emit({
            type: "snowball.card.moved",
            workspace_id: workspaceId,
            content: {
              text: `Card "${card.title}" moved from "${fromColumn?.name ?? previousColumnId}" to "${toColumn.name}"`,
              data: {
                card_context_id: card_id,
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

        // If destination is agent-owned, emit routing event and run mechanical evaluation.
        if (toColumn.owner.kind === "agent" && toColumn.owner.agent_id) {
          try {
            await emitCardEnteredColumn(ctx, {
              card_id,
              card_title: card.title,
              column_id: to_column_id,
              column_name: toColumn.name,
              from_column_id: previousColumnId,
              scope_id,
              agent_id: toColumn.owner.agent_id,
            });
          } catch (err) {
            console.warn(
              `[snowball] Failed to emit routing event: ${err}`
            );
          }

          // Synchronous overseer evaluation: advance the card immediately if
          // exit criteria are all satisfied, cascading through further agent columns.
          try {
            await advanceCardIfReady(ctx, scope_id, card_id);
          } catch (err) {
            console.warn(`[snowball] Overseer advance failed: ${err}`);
          }
        }

        // If WIP exceeded softly (force path only, warn overseer)
        if (
          force &&
          unchecked.length > 0 &&
          toColumn.wip_limit === null
        ) {
          try {
            await bus.emit({
              type: "snowball.card.gate_overridden",
              workspace_id: workspaceId,
              content: {
                text: `Human override: card "${card.title}" moved from "${fromColumn?.name}" despite unchecked criteria`,
                data: {
                  card_context_id: card_id,
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
            description: "context_id of the card",
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

        const sidecar = loadSidecar(workspacePath, scope_id);
        const card = sidecar.cards[card_id];
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

        const column_id = card.column_id;
        if (!card.checks[column_id]) {
          card.checks[column_id] = {};
        }
        card.checks[column_id][criterion_id] = {
          checked,
          checked_at: checked ? new Date().toISOString() : null,
          checked_by: null,
          note: note ?? null,
        };
        saveSidecar(workspacePath, scope_id, sidecar);

        // Emit criteria checked event (best-effort)
        try {
          const bus = asBusClient(ctx.busClient);
          await bus.emit({
            type: "snowball.card.criteria_checked",
            workspace_id: workspaceId,
            content: {
              text: `Criterion "${criterion_id}" ${checked ? "checked" : "unchecked"} for card "${card.title}"`,
              data: {
                card_context_id: card_id,
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
        "Get a full board snapshot: columns with card counts, WIP status, cards per column, stalled detection. Use before any strategic decision.",
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
        const snapshot = buildBoardSnapshot(sidecar);
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot) }],
        };
      },
    },
  ];
}
