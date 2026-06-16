/**
 * TideLine — renders upcoming Pulse fires, giving the operator
 * a forward-looking view of scheduled activity.
 */
import type { PulseRef } from "../bus-client/types.ts";

export type TideLineProps = {
  pulses: PulseRef[];
};

const STYLES = {
  section: { marginBottom: "1.5rem" } as React.CSSProperties,
  list: {
    listStyle: "none",
    padding: 0,
    margin: 0,
  } as React.CSSProperties,
  item: {
    padding: "0.5rem 0",
    borderBottom: "1px solid #eee",
    display: "grid",
    gridTemplateColumns: "1fr max-content",
    gap: "0.25rem",
  } as React.CSSProperties,
  label: {
    fontWeight: 600,
    fontSize: "0.9rem",
  } as React.CSSProperties,
  meta: {
    fontSize: "0.8rem",
    color: "#666",
  } as React.CSSProperties,
  empty: {
    color: "#888",
    fontStyle: "italic",
  } as React.CSSProperties,
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function TideLine({ pulses }: TideLineProps): React.ReactElement {
  // Sort by next_fire_at ascending; pulses with no next_fire_at go last
  const sorted = [...pulses].sort((a, b) => {
    if (!a.next_fire_at && !b.next_fire_at) return 0;
    if (!a.next_fire_at) return 1;
    if (!b.next_fire_at) return -1;
    return a.next_fire_at < b.next_fire_at ? -1 : a.next_fire_at > b.next_fire_at ? 1 : 0;
  });

  return (
    <section data-testid="tide-line" style={STYLES.section} aria-label="Tide-line: upcoming pulses">
      <h2 style={{ marginBottom: "0.5rem" }}>Tide-line</h2>
      {sorted.length === 0 ? (
        <p style={STYLES.empty}>No pulses scheduled.</p>
      ) : (
        <ul style={STYLES.list} role="list">
          {sorted.map((pulse) => (
            <li key={pulse.pulse_id} style={STYLES.item} data-pulse-id={pulse.pulse_id}>
              <div>
                <span style={STYLES.label}>
                  Pulse <code>{pulse.pulse_id.slice(0, 8)}</code>
                </span>
                <div style={STYLES.meta}>
                  Next: <time dateTime={pulse.next_fire_at ?? undefined}>{fmtDate(pulse.next_fire_at)}</time>
                </div>
                {pulse.last_fired_at && (
                  <div style={STYLES.meta}>
                    Last: <time dateTime={pulse.last_fired_at}>{fmtDate(pulse.last_fired_at)}</time>
                  </div>
                )}
              </div>
              <div style={{ textAlign: "right" }}>
                <span
                  style={STYLES.meta}
                  aria-label={`Fired ${pulse.fire_count} time${pulse.fire_count !== 1 ? "s" : ""}`}
                >
                  ×{pulse.fire_count}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
