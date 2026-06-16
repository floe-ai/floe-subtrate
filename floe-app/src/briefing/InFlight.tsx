/**
 * InFlight — shows endpoints currently active/working.
 * An endpoint is considered "in flight" when its status indicates
 * it is actively processing (not idle/offline/error).
 */
import type { EndpointRef } from "../bus-client/types.ts";

export type InFlightProps = {
  endpoints: EndpointRef[];
};

const ACTIVE_STATUSES = new Set(["active", "working", "processing", "running", "busy"]);

function isActive(ep: EndpointRef): boolean {
  return ACTIVE_STATUSES.has(ep.status.toLowerCase());
}

const STYLES = {
  section: { marginBottom: "1.5rem" } as React.CSSProperties,
  list: {
    listStyle: "none",
    padding: 0,
    margin: 0,
  } as React.CSSProperties,
  item: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.4rem 0",
    borderBottom: "1px solid #eee",
  } as React.CSSProperties,
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    background: "#2a7",
    display: "inline-block",
    flexShrink: 0,
  } as React.CSSProperties,
  empty: {
    color: "#888",
    fontStyle: "italic",
  } as React.CSSProperties,
};

export function InFlight({ endpoints }: InFlightProps): React.ReactElement {
  const active = endpoints.filter(isActive);

  return (
    <section data-testid="in-flight" style={STYLES.section} aria-label="In-flight actors">
      <h2 style={{ marginBottom: "0.5rem" }}>What&apos;s in flight</h2>
      {active.length === 0 ? (
        <p style={STYLES.empty}>No actors are currently active.</p>
      ) : (
        <ul style={STYLES.list} role="list">
          {active.map((ep) => (
            <li
              key={ep.endpoint_id}
              style={STYLES.item}
              data-endpoint-id={ep.endpoint_id}
            >
              {/* Accessible indicator: shape + label, not colour alone */}
              <span
                style={STYLES.dot}
                aria-hidden="true"
                title="Active"
              />
              <span className="sr-only">Active — </span>
              <strong>{ep.name}</strong>
              {ep.agent_id && (
                <span style={{ color: "#666", fontSize: "0.85rem" }}>
                  &nbsp;(agent)
                </span>
              )}
              <span
                style={{ marginLeft: "auto", fontSize: "0.8rem", color: "#555" }}
              >
                {ep.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
