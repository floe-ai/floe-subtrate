import React from "react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { CheckCircle2Icon, CircleIcon } from "lucide-react";
import type { UiCard, UiColumn } from "./types.ts";

interface CardProps {
  card: UiCard;
  column: UiColumn;
  onSelect: (card: UiCard) => void;
}

export function Card({ card, column, onSelect }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: card.card_id });

  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  const exitCriteria = column.exitCriteria;
  const checks = card.criteria_checks.filter((c) => c.columnId === column.id);
  const satisfied =
    exitCriteria.length > 0 &&
    exitCriteria.every((ec) =>
      checks.find((c) => c.criterionId === ec.id)?.checked
    );
  const partial =
    !satisfied && exitCriteria.length > 0 && checks.some((c) => c.checked);

  return (
    <button
      ref={setNodeRef}
      type="button"
      style={{
        ...style,
        width: "100%",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.1)",
        background: "#131415",
        padding: "8px 10px",
        textAlign: "left",
        color: "#f7f8f8",
        cursor: isDragging ? "grabbing" : "grab",
        opacity: isDragging ? 0.5 : 1,
        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        transition: "opacity 0.15s",
      }}
      {...listeners}
      {...attributes}
      onClick={() => onSelect(card)}
    >
      <p
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 500,
          lineHeight: "1.4",
          color: "#f7f8f8",
        }}
      >
        {card.title}
      </p>
      {exitCriteria.length > 0 && (
        <div
          style={{
            marginTop: 6,
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
              borderRadius: 99,
              padding: "2px 6px",
              fontSize: 11,
              fontWeight: 500,
              background: satisfied
                ? "rgba(135,184,148,0.15)"
                : partial
                ? "rgba(210,160,80,0.15)"
                : "rgba(255,255,255,0.05)",
              color: satisfied
                ? "#87b894"
                : partial
                ? "#d2a050"
                : "#8a8f98",
            }}
          >
            {satisfied ? (
              <CheckCircle2Icon size={11} />
            ) : (
              <CircleIcon size={11} />
            )}
            {checks.filter((c) => c.checked).length}/{exitCriteria.length}
          </span>
        </div>
      )}
    </button>
  );
}
