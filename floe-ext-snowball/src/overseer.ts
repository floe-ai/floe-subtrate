/**
 * Snowball overseer — mechanical card advance driver.
 *
 * Provides a deterministic in-process evaluator that advances a card through
 * consecutive agent-owned columns when its exit criteria are all satisfied.
 *
 * This replaces the former heartbeat / Pulse approach.  Evaluation is
 * triggered synchronously from the move path (handlePostMove, move_card tool)
 * whenever a card enters an agent-owned column, and cascades through further
 * agent columns in the same call with no timer involved.
 *
 * Accepted limitation (Captain-approved): if exit criteria become satisfied
 * while a card is already sitting in an agent column with no card-move event,
 * the overseer will NOT wake and the card stays put.
 */

import { loadSidecar, saveSidecar, getUncheckedCriteria } from "./sidecar.js";
import { asBusClient } from "./stub/bus-client.js";

/** Maximum cascade depth guard against infinite column loops. */
const MAX_CASCADE = 20;

/**
 * Run the overseer's advance evaluation for a single card.
 *
 * The card must currently be in an agent-owned column.  If its exit criteria
 * are all satisfied and the next column has room (WIP), the card is advanced.
 * If the next column is also agent-owned, evaluation cascades synchronously
 * until a human-owned column is reached, a WIP limit blocks the advance, an
 * exit criterion is unmet, or the card is in the last column.
 *
 * Emits `snowball.card.moved` for every mechanical advance and
 * `snowball.card.entered_column` when an advance lands in a further
 * agent-owned column (for routing / telemetry).
 *
 * All emits are best-effort; a failed emit does not roll back the sidecar.
 */
export async function advanceCardIfReady(
  ctx: { workspacePath: string; workspaceId: string; busClient: unknown },
  scopeId: string,
  cardId: string
): Promise<void> {
  const bus = asBusClient(ctx.busClient);

  for (let depth = 0; depth < MAX_CASCADE; depth++) {
    // Reload sidecar each iteration so we see the freshest committed state.
    const sidecar = loadSidecar(ctx.workspacePath, scopeId);
    const card = sidecar.cards[cardId];
    if (!card) break;

    const col = sidecar.columns.find((c) => c.id === card.column_id);
    // Stop if card is in a human-owned column (or column is missing).
    if (!col || col.owner.kind !== "agent") break;

    // Hard gate: all exit criteria in the current column must be satisfied.
    const unchecked = getUncheckedCriteria(card, col.id, col.exit_criteria);
    if (unchecked.length > 0) {
      console.info("[snowball:overseer] card held — unmet exit criteria", {
        card_id: cardId,
        card_title: card.title,
        column: col.name,
        unmet_criteria: unchecked.map((c) => c.id),
      });
      break;
    }

    // Find the next column in array order.
    const colIdx = sidecar.columns.indexOf(col);
    const nextCol = sidecar.columns[colIdx + 1];
    if (!nextCol) {
      console.info("[snowball:overseer] card is in the last column — no advance", {
        card_id: cardId,
        card_title: card.title,
      });
      break;
    }

    // WIP limit on destination — hard block for agent-driven moves.
    if (nextCol.wip_limit !== null) {
      const currentCount = Object.values(sidecar.cards).filter(
        (c) => c.column_id === nextCol.id
      ).length;
      if (currentCount >= nextCol.wip_limit) {
        console.info("[snowball:overseer] card held — destination WIP limit", {
          card_id: cardId,
          card_title: card.title,
          to_column: nextCol.name,
          current: currentCount,
          limit: nextCol.wip_limit,
        });
        break;
      }
    }

    // Advance the card.
    const fromColumnId = card.column_id;
    const newOrder = Object.values(sidecar.cards).filter(
      (c) => c.column_id === nextCol.id
    ).length;
    card.column_id = nextCol.id;
    card.order = newOrder;
    saveSidecar(ctx.workspacePath, scopeId, sidecar);

    console.info("[snowball:overseer] card advanced", {
      card_id: cardId,
      card_title: card.title,
      from_column: col.name,
      to_column: nextCol.name,
      scope_id: scopeId,
    });

    // Emit move event (best-effort).
    try {
      await bus.emit({
        type: "snowball.card.moved",
        workspace_id: ctx.workspaceId,
        content: {
          text: `[overseer] Card "${card.title}" advanced from "${col.name}" to "${nextCol.name}" (all exit criteria satisfied)`,
          data: {
            card_context_id: cardId,
            card_title: card.title,
            from_column_id: fromColumnId,
            to_column_id: nextCol.id,
            board_scope_id: scopeId,
            source: "overseer",
            forced: false,
          },
        },
        metadata: { source: "snowball-overseer" },
      });
    } catch (err) {
      console.warn("[snowball:overseer] failed to emit card moved event", { error: String(err) });
    }

    // If the destination is agent-owned, emit the routing event and continue
    // the loop to evaluate the card in its new column.
    if (nextCol.owner.kind === "agent" && nextCol.owner.agent_id) {
      try {
        const endpoints = await bus.listEndpoints(ctx.workspaceId);
        const agentEndpoint = endpoints.find(
          (ep) =>
            ep.endpoint_id.endsWith(`:${nextCol.owner.agent_id}`) ||
            ep.agent_id === nextCol.owner.agent_id
        );
        if (agentEndpoint) {
          await bus.emit({
            type: "snowball.card.entered_column",
            workspace_id: ctx.workspaceId,
            destination: {
              kind: "endpoint",
              endpoint_id: agentEndpoint.endpoint_id,
            },
            content: {
              text: `Card "${card.title}" has entered column "${nextCol.name}" (overseer advance)`,
              data: {
                card_context_id: cardId,
                card_title: card.title,
                column_id: nextCol.id,
                column_name: nextCol.name,
                from_column_id: fromColumnId,
                board_scope_id: scopeId,
              },
            },
            response: { expected: true },
            metadata: { source: "snowball-overseer" },
          });
        }
      } catch (err) {
        console.warn("[snowball:overseer] failed to emit routing event", { error: String(err) });
      }
      // Loop continues: re-evaluate the card in the new agent-owned column.
    } else {
      // Destination is human-owned; mechanical advance is complete.
      break;
    }
  }
}
