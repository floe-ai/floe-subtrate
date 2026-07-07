import React, { useState, useRef, useEffect } from "react";
import { useDroppable } from "@dnd-kit/core";
import { BotIcon, Settings2Icon, PlusIcon } from "lucide-react";
import type { UiCard, UiColumn } from "./types.ts";
import { Card } from "./Card.tsx";

interface ColumnProps {
  column: UiColumn;
  cards: UiCard[];
  onSelectCard: (card: UiCard) => void;
  onConfigColumn: (column: UiColumn) => void;
  onAddCard: (columnId: string, title: string) => Promise<void>;
  addingCard?: boolean;
}

export function Column({
  column,
  cards,
  onSelectCard,
  onConfigColumn,
  onAddCard,
  addingCard = false,
}: ColumnProps) {
  const atLimit =
    column.wipLimit !== null && cards.length >= column.wipLimit;

  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  const [addMode, setAddMode] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when entering add mode
  useEffect(() => {
    if (addMode && inputRef.current) {
      inputRef.current.focus();
    }
  }, [addMode]);

  async function handleSubmitCard(e?: React.FormEvent) {
    e?.preventDefault();
    const title = draftTitle.trim();
    if (!title) {
      setAddMode(false);
      setDraftTitle("");
      return;
    }
    setSubmitting(true);
    try {
      await onAddCard(column.id, title);
      setDraftTitle("");
      setAddMode(false);
    } finally {
      setSubmitting(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setAddMode(false);
      setDraftTitle("");
    }
  }

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

  const wipBlocked = atLimit;

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
        {cards.length === 0 && !addMode && (
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

      {/* Add Card inline form */}
      {addMode ? (
        <form
          onSubmit={handleSubmitCard}
          style={{ marginTop: 8 }}
        >
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Card title…"
            disabled={submitting}
            style={{
              width: "100%",
              background: "#1a1c1e",
              border: "1px solid rgba(138,168,156,0.4)",
              borderRadius: 6,
              color: "#f7f8f8",
              fontSize: 12,
              padding: "6px 8px",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: 6,
            }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="submit"
              disabled={submitting || !draftTitle.trim()}
              style={{
                flex: 1,
                padding: "5px 0",
                fontSize: 12,
                fontWeight: 500,
                borderRadius: 5,
                border: "1px solid rgba(138,168,156,0.4)",
                background: "rgba(138,168,156,0.15)",
                color: "#8aa89c",
                cursor: submitting || !draftTitle.trim() ? "not-allowed" : "pointer",
                opacity: submitting || !draftTitle.trim() ? 0.5 : 1,
              }}
            >
              {submitting ? "Adding…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => { setAddMode(false); setDraftTitle(""); }}
              style={{
                padding: "5px 10px",
                fontSize: 12,
                borderRadius: 5,
                border: "1px solid rgba(255,255,255,0.1)",
                background: "transparent",
                color: "#8a8f98",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (!wipBlocked) setAddMode(true);
          }}
          disabled={wipBlocked || addingCard}
          style={{
            marginTop: 8,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 4,
            padding: "5px 0",
            fontSize: 11,
            borderRadius: 5,
            border: "1px dashed rgba(255,255,255,0.1)",
            background: "transparent",
            color: wipBlocked ? "#3a3d42" : "#62666d",
            cursor: wipBlocked ? "not-allowed" : "pointer",
            width: "100%",
            transition: "color 0.12s, border-color 0.12s",
          }}
          aria-label={`Add card to ${column.name}`}
          title={wipBlocked ? `WIP limit reached (${column.wipLimit})` : "Add card"}
        >
          <PlusIcon size={11} />
          Add card
        </button>
      )}
    </section>
  );
}
