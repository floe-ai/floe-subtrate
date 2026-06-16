/**
 * DecisionCard — renders a single pending-response decision item
 * with optional impact block and actor attribution.
 *
 * When impact is null the card shows a loud, visible "No impact summary
 * provided" notice attributing the omission to the asking actor.
 * Controls are keyboard-accessible; status is never communicated by colour alone.
 */
import type { DecisionCard as DecisionCardType } from "../bus-client/types.ts";

export type DecisionCardAction = "approve" | "redirect" | "comment";

export type DecisionCardProps = {
  card: DecisionCardType;
  onAct: (action: DecisionCardAction, text?: string) => void;
};

const STYLES = {
  card: {
    border: "1px solid #ccc",
    borderRadius: 6,
    padding: "1rem",
    marginBottom: "1rem",
    background: "#fff",
  } as React.CSSProperties,
  impactGrid: {
    display: "grid",
    gridTemplateColumns: "max-content 1fr",
    gap: "0.25rem 0.75rem",
    margin: "0.5rem 0",
  } as React.CSSProperties,
  label: {
    fontWeight: 600,
    color: "#555",
  } as React.CSSProperties,
  noImpact: {
    border: "2px solid #b00",
    borderRadius: 4,
    padding: "0.75rem",
    background: "#fff0f0",
    color: "#b00",
    fontWeight: 600,
    margin: "0.5rem 0",
  } as React.CSSProperties,
  actions: {
    display: "flex",
    gap: "0.5rem",
    flexWrap: "wrap" as const,
    marginTop: "0.75rem",
  } as React.CSSProperties,
  actorLine: {
    fontSize: "0.85rem",
    color: "#555",
    marginBottom: "0.25rem",
  } as React.CSSProperties,
};

export function DecisionCard({ card, onAct }: DecisionCardProps): React.ReactElement {
  const { source, impact, askingActor } = card;

  function handleComment() {
    const text = window.prompt("Enter comment:");
    if (text !== null) onAct("comment", text);
  }

  return (
    <article
      data-testid="decision-card"
      data-pending-id={source.pending_id}
      style={STYLES.card}
      aria-label={`Decision from ${askingActor.name}`}
    >
      {/* Actor attribution */}
      <p style={STYLES.actorLine} data-section="actor">
        <strong>Asking actor:</strong> {askingActor.name}
        {askingActor.agent_id ? ` (agent ${askingActor.agent_id})` : ""}
      </p>

      {/* Impact block */}
      {impact !== null ? (
        <section data-section="impact" aria-label="Impact summary">
          <h3 style={{ margin: "0 0 0.25rem" }}>Impact</h3>
          <dl style={STYLES.impactGrid}>
            {impact.architecture && (
              <>
                <dt style={STYLES.label}>Architecture</dt>
                <dd style={{ margin: 0 }}>{impact.architecture}</dd>
              </>
            )}
            {impact.product && (
              <>
                <dt style={STYLES.label}>Product</dt>
                <dd style={{ margin: 0 }}>{impact.product}</dd>
              </>
            )}
            {impact.risk && (
              <>
                <dt style={STYLES.label}>Risk</dt>
                <dd style={{ margin: 0 }}>{impact.risk}</dd>
              </>
            )}
            {impact.cost && (
              <>
                <dt style={STYLES.label}>Cost</dt>
                <dd style={{ margin: 0 }}>{impact.cost}</dd>
              </>
            )}
          </dl>
        </section>
      ) : (
        <div data-section="impact" data-missing-impact="true" role="alert" style={STYLES.noImpact}>
          <span aria-hidden="true">⚠ </span>
          No impact summary provided — <strong>{askingActor.name}</strong> did not include one.
          Review carefully before acting.
        </div>
      )}

      {/* Pending status */}
      <p style={{ fontSize: "0.8rem", color: "#666", margin: "0.25rem 0" }}>
        <span className="sr-only">Status: </span>
        <span data-section="status">[{source.status}]</span>
        {source.timeout_at && (
          <span> · Expires {new Date(source.timeout_at).toLocaleString()}</span>
        )}
      </p>

      {/* Actions */}
      <div style={STYLES.actions} data-section="actions">
        <button
          type="button"
          onClick={() => onAct("approve")}
          aria-label="Approve this decision"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onAct("redirect")}
          aria-label="Redirect this decision"
        >
          Redirect
        </button>
        <button
          type="button"
          onClick={handleComment}
          aria-label="Add a comment"
        >
          Comment
        </button>
      </div>
    </article>
  );
}
