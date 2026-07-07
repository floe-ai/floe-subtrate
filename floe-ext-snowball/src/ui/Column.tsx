import React, { useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { BotIcon, Settings2Icon } from "lucide-react";
import type { UiCard, UiColumn } from "./types.ts";
import { Card } from "./Card.tsx";

interface ColumnProps {
  column: UiColumn;
  cards: UiCard[];
  onSelectCard: (card: UiCard) => void;
  onConfigColumn: (column: UiColumn) => void;
}

export function Column({
  column,
  cards,
  onSelectCard,
  onConfigColumn,
}: ColumnProps) {
  const atLimit =
    column.wipLimit !== null && cards.length >= column.wipLimit;

  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const borderColor = atLimit
    ? "#b85a5a"
    : isOver
    ? "#8aa89c"
    : "rgba(255,255,255,0.08)";
  const bg = atLimit
    ? "rgba(184,90,90,0.06)"
    : isOver
    ? "rgba(138,168,156,0.05)"
    : "#0f1011";

  return (
    <section
      ref={setNodeRef}
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 220,
        flex: "1 1 220px",
        borderRadius: 8,
        border: `1px solid ${borderColor}`,
        padding: "10px 10px 12px",
        background: bg,
        transition: "border-color 0.15s, background 0.15s",
      }}
    >
      {/* Header */}
      <header style={{ marginBottom: 8 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.02em",
              textTransform: "uppercase",
              color: atLimit ? "#b85a5a" : "#8a8f98",
            }}
          >
            {column.name}
          </h2>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            {column.owner.kind === "agent" && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 3,
                  borderRadius: 99,
                  padding: "2px 6px",
                  fontSize: 10,
                  fontWeight: 500,
                  background: "rgba(100,140,200,0.15)",
                  color: "#7ba4d4",
                }}
              >
                <BotIcon size={10} />
                {column.owner.agent_id ?? "agent"}
              </span>
            )}
            <button
              type="button"
              onClick={() => onConfigColumn(column)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "#8a8f98",
                padding: 2,
                display: "flex",
                alignItems: "center",
              }}
              aria-label={`Configure ${column.name}`}
            >
              <Settings2Icon size={13} />
            </button>
          </div>
        </div>
        {column.wipLimit !== null && (
          <p
            style={{
              margin: "3px 0 0",
              fontSize: 11,
              color: atLimit ? "#b85a5a" : "#62666d",
              fontWeight: atLimit ? 600 : 400,
            }}
          >
            {cards.length}/{column.wipLimit} WIP
          </p>
        )}
        {column.exitCriteria.length > 0 && (
          <p style={{ margin: "2px 0 0", fontSize: 10, color: "#62666d" }}>
            {column.exitCriteria.length} exit{" "}
            {column.exitCriteria.length === 1 ? "criterion" : "criteria"}
          </p>
        )}
      </header>

      {/* Cards */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 6,
          flex: 1,
          minHeight: 40,
        }}
      >
        {cards.map((card) => (
          <Card
            key={card.card_id}
            card={card}
            column={column}
            onSelect={onSelectCard}
          />
        ))}
        {cards.length === 0 && (
          <p
            style={{
              margin: "8px 0",
              fontSize: 11,
              color: "#3a3d42",
              textAlign: "center",
              fontStyle: "italic",
            }}
          >
            empty
          </p>
        )}
      </div>
    </section>
  );
}
