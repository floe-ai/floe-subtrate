/**
 * Board snapshot helpers — building and rendering BoardSnapshot from files.
 *
 * Slice 6 (fm/snowball-ctx-retire):
 *   Relocated from sidecar.ts after sidecar elimination.
 *   buildBoardSnapshot no longer requires a BoardSidecar; scope_id and
 *   workspace_id are passed explicitly.
 */

import {
  listCards,
  cardCountsByColumnFromFiles,
} from "./card-file.js";
import type {
  ColumnFile,
  BoardSnapshot,
  Card,
  CardCriterionCheck,
} from "./types.js";

// ---------------------------------------------------------------------------
// buildBoardSnapshot
// ---------------------------------------------------------------------------

/**
 * Build a full board snapshot suitable for API responses and BeforeTurn injection.
 * Reads card files from disk; receives column definitions as a parameter.
 */
export function buildBoardSnapshot(
  workspacePath: string,
  scopeId: string,
  workspaceId: string,
  columns: ColumnFile[]
): BoardSnapshot {
  const colIds = columns.map((c) => c.id);
  const counts = cardCountsByColumnFromFiles(workspacePath, colIds);

  const snapshotColumns = columns.map((col) => ({
    id: col.id,
    name: col.name,
    wip_limit: col.wip_limit,
    card_count: counts[col.id] ?? 0,
    wip_exceeded:
      col.wip_limit !== null && (counts[col.id] ?? 0) > col.wip_limit,
    assigned_actors: col.assigned_actors,
    exit_criteria: col.exit_criteria,
    instructions: col.instructions,
  }));

  const allCards = listCards(workspacePath);
  const cards: Card[] = allCards.map((cardFile): Card => {
    const colChecks = cardFile.checks[cardFile.column] ?? {};
    const criteria_checks: CardCriterionCheck[] = Object.entries(colChecks).map(
      ([criterionId, state]): CardCriterionCheck => ({
        columnId: cardFile.column,
        criterionId,
        checked: state.checked,
        checkedAt: state.checked_at ?? undefined,
        checkedBy: state.checked_by ?? undefined,
        note: state.note ?? undefined,
      })
    );
    return {
      card_id: cardFile.id,
      column_id: cardFile.column,
      order: cardFile.order,
      title: cardFile.title,
      created_at: cardFile.created_at,
      criteria_checks,
    };
  });

  // Sort cards by column order then card order
  const colOrderMap = new Map(columns.map((c, i) => [c.id, i]));
  cards.sort((a, b) => {
    const colA = colOrderMap.get(a.column_id) ?? 999;
    const colB = colOrderMap.get(b.column_id) ?? 999;
    if (colA !== colB) return colA - colB;
    return a.order - b.order;
  });

  return {
    scope_id: scopeId,
    workspace_id: workspaceId,
    columns: snapshotColumns,
    cards,
  };
}

// ---------------------------------------------------------------------------
// renderCompactBoardSnapshot
// ---------------------------------------------------------------------------

/**
 * Render a compact board snapshot as a string for BeforeTurn injection.
 * Stays well within the 4000-char limit for boards up to ~30 cards.
 */
export function renderCompactBoardSnapshot(snapshot: BoardSnapshot): string {
  const lines: string[] = [`Board: ${snapshot.scope_id}`, ""];

  for (const col of snapshot.columns) {
    const wipStr =
      col.wip_limit !== null
        ? ` (${col.card_count}/${col.wip_limit} WIP${col.wip_exceeded ? " \u26a0 EXCEEDED" : ""})`
        : ` (${col.card_count} cards)`;
    const actorsStr = col.assigned_actors.length > 0
      ? ` [${col.assigned_actors.map((a) => a.actor_ref).join(", ")}]`
      : " [unassigned]";
    lines.push(`## ${col.name}${wipStr}${actorsStr}`);

    const colCards = snapshot.cards.filter((c) => c.column_id === col.id);
    if (colCards.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const card of colCards) {
        const checkedCount = card.criteria_checks.filter((c) => c.checked).length;
        const totalCriteria = col.exit_criteria.length;
        const criteriaStr =
          totalCriteria > 0
            ? ` [${checkedCount}/${totalCriteria} criteria]`
            : "";
        lines.push(`  - ${card.title}${criteriaStr} (${card.card_id})`);
      }
    }
    lines.push("");
  }

  const result = lines.join("\n");
  if (result.length > 3800) {
    return result.slice(0, 3750) + "\n\n[...board snapshot truncated]";
  }
  return result;
}
