/**
 * Snowball overseer — mechanical card advance driver.
 *
 * Slice 4 (fm/snowball-card-context):
 *   Uses applyColumnAssignment (card context) instead of column contexts.
 *   entered_column emitted into card context, not column context.
 *
 * Slice 2 (fm/snowball-col-instr-s2):
 *   Now reads column definitions from committed column files instead of sidecar.
 *   Minimal change to keep overseer working with the new file-first model.
 *
 * Provides a deterministic in-process evaluator that advances a card through
 * consecutive actor-assigned columns when its exit criteria are all satisfied.
 *
 * All emits are best-effort; a failed emit does not roll back the card file.
 */

import {
  slugify,
  getUncheckedCriteria,
} from "./sidecar.js";
import { listColumnsFromBoard } from "./board-file.js";
import {
  readCard,
  updateCardFrontmatter,
  appendCarryForward,
  listCards,
} from "./card-file.js";
import { asBusClient } from "./stub/bus-client.js";
import {
  applyColumnAssignment,
  createCardContext,
  actorEndpointId,
} from "./handoff.js";

/** Maximum cascade depth guard against infinite column loops. */
const MAX_CASCADE = 20;

/**
 * Run the overseer's advance evaluation for a single card.
 *
 * The card must currently be in an actor-assigned column.  If its exit criteria
 * are all satisfied and the next column has room (WIP), the card is advanced.
 * If the next column is also actor-assigned, evaluation cascades synchronously
 * until a column with no assigned actors is reached, a WIP limit blocks the
 * advance, an exit criterion is unmet, or the card is in the last column.
 */
export async function advanceCardIfReady(
  ctx: { workspacePath: string; workspaceId: string; busClient: unknown },
  scopeId: string,
  cardId: string
): Promise<void> {
  const bus = asBusClient(ctx.busClient);
  const slug = slugify(scopeId);

  for (let depth = 0; depth < MAX_CASCADE; depth++) {
    // Reload column files and card each iteration for freshest state.
    const columns = listColumnsFromBoard(ctx.workspacePath, slug);
    const card = readCard(ctx.workspacePath, cardId);
    if (!card) break;

    const col = columns.find((c) => c.id === card.column);
    // Stop if card is in a column with no assigned actors (or column is missing).
    if (!col || col.assigned_actors.length === 0) break;

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
    const colIdx = columns.indexOf(col);
    const nextCol = columns[colIdx + 1];
    if (!nextCol) {
      console.info("[snowball:overseer] card is in the last column — no advance", {
        card_id: cardId,
        card_title: card.title,
      });
      break;
    }

    // WIP limit on destination — hard block for agent-driven moves.
    if (nextCol.wip_limit !== null) {
      const currentCount = listCards(ctx.workspacePath).filter(
        (c) => c.column === nextCol.id
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

    // Advance the card: update frontmatter in-place, append carry-forward comment.
    const fromColumnId = col.id;
    const fromColumnName = col.name;
    const newOrder = listCards(ctx.workspacePath).filter(
      (c) => c.column === nextCol.id
    ).length;

    updateCardFrontmatter(ctx.workspacePath, cardId, {
      column: nextCol.id,
      order: newOrder,
    });
    appendCarryForward(ctx.workspacePath, cardId, fromColumnName);

    console.info("[snowball:overseer] card advanced", {
      card_id: cardId,
      card_title: card.title,
      from_column: col.name,
      to_column: nextCol.name,
      scope_id: scopeId,
    });

    // If destination is an actor-assigned column, apply column assignment and continue cascade.
    if (nextCol.assigned_actors.length > 0) {
      const primaryActor = nextCol.assigned_actors[0];
      const actingEp = actorEndpointId(ctx.workspaceId, primaryActor.actor_ref);

      // Lazy card context creation for legacy cards.
      const freshCard = readCard(ctx.workspacePath, cardId);
      let cardContextId = freshCard?.context_id ?? null;
      if (!cardContextId) {
        cardContextId = await createCardContext({
          workspaceId: ctx.workspaceId,
          scope_id: scopeId,
          cardTitle: card.title,
          creatorEp: actingEp,
          bus,
        });
        if (cardContextId) {
          updateCardFrontmatter(ctx.workspacePath, cardId, { context_id: cardContextId });
        }
      }

      await applyColumnAssignment({
        cardContextId,
        destAssignedActors: nextCol.assigned_actors,
        priorAssignedActors: col.assigned_actors,
        actingActorEp: actingEp,
        workspaceId: ctx.workspaceId,
        scope_id: scopeId,
        cardId,
        cardTitle: card.title,
        toColumnId: nextCol.id,
        toColumnName: nextCol.name,
        fromColumnId,
        bus,
      });

      // Loop continues: re-evaluate the card in the new actor-assigned column.
    } else {
      // Destination has no assigned actors; mechanical advance is complete.
      break;
    }
  }
}
