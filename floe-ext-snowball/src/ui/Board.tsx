import React, { useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { UiBoardState, UiCard, UiColumn, UiCriterionCheck } from "./types.ts";
import { Column } from "./Column.tsx";
import { ExitCriteriaGate } from "./ExitCriteriaGate.tsx";

interface BoardProps {
  board: UiBoardState;
  onMove: (cardId: string, toColumnId: string, force: boolean) => Promise<boolean>;
  onSelectCard: (card: UiCard) => void;
  onConfigColumn: (column: UiColumn) => void;
  onAddCard: (columnId: string, title: string) => Promise<void>;
}

interface PendingMove {
  cardId: string;
  fromColumnId: string;
  toColumnId: string;
}

export function Board({ board, onMove, onSelectCard, onConfigColumn, onAddCard }: BoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);

  function cardsForColumn(colId: string): UiCard[] {
    return board.cards
      .filter((c) => c.column_id === colId)
      .sort((a, b) => a.order - b.order);
  }

  // Convert flat board columns (with exit_criteria) to UiColumn shape
  function toUiColumn(col: UiBoardState["columns"][number]): UiColumn {
    return {
      id: col.id,
      name: col.name,
      wipLimit: col.wip_limit,
      order: 0,
      owner: col.owner,
      exitCriteria: col.exit_criteria,
      instructions: col.instructions,
    };
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const cardId = active.id as string;
    const toColumnId = over.id as string;

    const card = board.cards.find((c) => c.card_id === cardId);
    if (!card || card.column_id === toColumnId) return;

    const toColData = board.columns.find((c) => c.id === toColumnId);
    if (!toColData) return;

    // WIP limit enforcement (client-side fast-fail before server call)
    if (toColData.wip_limit !== null) {
      const currentCount = board.cards.filter(
        (c) => c.column_id === toColumnId
      ).length;
      if (currentCount >= toColData.wip_limit) {
        // Silently reject — the server would also reject
        return;
      }
    }

    const fromColData = board.columns.find((c) => c.id === card.column_id);
    const fromCol = fromColData ? toUiColumn(fromColData) : null;

    // If source column has exit criteria, show the gate dialog
    if (fromCol && fromCol.exitCriteria.length > 0) {
      setPendingMove({ cardId, fromColumnId: card.column_id, toColumnId });
      return;
    }

    // No exit criteria — move directly (force=false)
    onMove(cardId, toColumnId, false).catch(console.error);
  }

  async function handleGateConfirm(
    _checks: UiCriterionCheck[],
    force: boolean
  ) {
    if (!pendingMove) return;
    const { cardId, toColumnId } = pendingMove;
    await onMove(cardId, toColumnId, force);
    setPendingMove(null);
  }

  function handleGateCancel() {
    setPendingMove(null);
  }

  const pendingCard = pendingMove
    ? board.cards.find((c) => c.card_id === pendingMove.cardId) ?? null
    : null;
  const pendingFromColData = pendingMove
    ? board.columns.find((c) => c.id === pendingMove.fromColumnId) ?? null
    : null;
  const pendingFromCol = pendingFromColData
    ? toUiColumn(pendingFromColData)
    : null;

  return (
    <>
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <div
          style={{
            display: "flex",
            gap: 12,
            overflowX: "auto",
            padding: "16px",
            height: "100%",
            boxSizing: "border-box",
          }}
        >
          {board.columns.map((colData) => {
            const uiCol = toUiColumn(colData);
            return (
              <Column
                key={colData.id}
                column={uiCol}
                cards={cardsForColumn(colData.id)}
                onSelectCard={onSelectCard}
                onConfigColumn={onConfigColumn}
                onAddCard={onAddCard}
              />
            );
          })}
        </div>
      </DndContext>

      {pendingCard && pendingFromCol && (
        <ExitCriteriaGate
          open
          sourceColumn={pendingFromCol}
          card={pendingCard}
          onConfirm={handleGateConfirm}
          onCancel={handleGateCancel}
        />
      )}
    </>
  );
}
