/**
 * PROTOTYPE VARIANT C — "The runs are the product. The graph is a legend."
 *
 * Revision 2: like A, this no longer opens conversations inside itself — a run
 * opens in the app's real right-hand inspector. What stays different is the
 * SURFACE: this one is the work, not the diagram. Every run in the scope, in
 * columns, one column per node, across BOTH graphs, with a lane along the top
 * holding only what is waiting on a person.
 *
 * Bet: with fifty live conversations you do not want a diagram — the diagram is
 * a handful of boxes you already know.
 */
import React, { useEffect, useState } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_GRAPHS, NODE_KIND_LABEL,
  STATE_COLOR, STATE_LABEL, wantsAttention, ago,
  type Run, type Node,
} from "./fixture.ts";
import { setProtoSelection, subscribeProtoSelection, getProtoSelection } from "./runSelection.ts";

export const VARIANT_C_NAME = "Runs first, graph as a legend";

type Located = { run: Run; node: Node; graphLabel: string };

const ALL: Located[] = PROTOTYPE_GRAPHS.flatMap(g =>
  g.nodes.flatMap(n => n.runs.map(r => ({ run: r, node: n, graphLabel: g.label })))
);

function useSelectedRun(): string | null {
  const [id, setId] = useState<string | null>(getProtoSelection().runId);
  useEffect(() => subscribeProtoSelection(s => setId(s.runId)), []);
  return id;
}

function Card({
  item, showWhere, selected, onClick,
}: {
  item: Located; showWhere?: boolean; selected: boolean; onClick: () => void;
}): React.ReactElement {
  const [hov, setHov] = useState(false);
  const { run } = item;
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        cursor: "pointer", borderRadius: tk.r2, padding: "9px 11px",
        background: hov ? tk.surfaceHov : tk.surface,
        border: `1px solid ${
          selected ? tk.accent : wantsAttention(run) ? STATE_COLOR[run.state] : tk.border
        }`,
        boxShadow: selected ? `0 0 0 2px ${tk.accentRing}` : "none",
        minWidth: showWhere ? 250 : 0, flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{
          width: 6, height: 6, borderRadius: 6, flexShrink: 0, background: STATE_COLOR[run.state],
        }} />
        <span style={{
          fontSize: 12.5, color: tk.ink, fontWeight: 510, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {run.label}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: tk.ink4, flexShrink: 0 }}>
          {ago(run.age_min)}
        </span>
      </div>
      {showWhere && (
        <div style={{ fontSize: 10.5, color: tk.ink4, marginTop: 3 }}>
          {item.graphLabel} · {item.node.label}
        </div>
      )}
      <div style={{
        fontSize: 11, color: tk.ink3, marginTop: 5, lineHeight: 1.4,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
      }}>
        {run.last}
      </div>
      {((run.passes ?? 1) > 1 || run.gathers) && (
        <div style={{ fontSize: 10, color: tk.ink4, marginTop: 6 }}>
          {run.gathers ? `gathers ${run.gathers} upstream` : `pass ${run.passes} · reworked in place`}
        </div>
      )}
    </div>
  );
}

export function VariantC(): React.ReactElement {
  const selectedRunId = useSelectedRun();
  const [onlyNode, setOnlyNode] = useState<string | null>(null);
  const [hideSettled, setHideSettled] = useState(true);

  const attention = ALL.filter(i => wantsAttention(i.run));

  return (
    <div style={{
      flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
      background: tk.canvas, overflow: "hidden",
    }}>
      {/* ------------------------------------------------------------------ */}
      {/* Both graphs, demoted to strips. Click a box to filter the board.     */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        padding: "8px 20px 10px", borderBottom: `1px solid ${tk.border}`,
        background: tk.surface, flexShrink: 0, overflowX: "auto",
      }}>
        {PROTOTYPE_GRAPHS.map(g => (
          <div key={g.graph_id} style={{ display: "flex", alignItems: "center", marginTop: 6 }}>
            <div style={{
              fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase",
              color: tk.ink4, width: 150, flexShrink: 0,
            }}>
              {g.label}
            </div>
            {g.nodes.map((n, i) => (
              <React.Fragment key={n.node_id}>
                {i > 0 && <span style={{ color: tk.ink4, padding: "0 8px", fontSize: 12 }}>→</span>}
                <button
                  onClick={() => setOnlyNode(onlyNode === n.node_id ? null : n.node_id)}
                  style={{
                    background: onlyNode === n.node_id ? tk.accentSoft2 : "transparent",
                    border: `1px solid ${onlyNode === n.node_id ? tk.accent : tk.border}`,
                    borderRadius: tk.r2, padding: "4px 9px", cursor: "pointer",
                    textAlign: "left", fontFamily: tk.fontUi, flexShrink: 0,
                  }}
                >
                  <div style={{ fontSize: 8.5, letterSpacing: "0.08em", textTransform: "uppercase", color: tk.ink4 }}>
                    {NODE_KIND_LABEL[n.kind]}
                  </div>
                  <div style={{ fontSize: 11.5, color: tk.ink, fontWeight: 510 }}>{n.label}</div>
                  <div style={{ fontSize: 10, color: tk.ink3 }}>{n.runs.length} runs</div>
                </button>
              </React.Fragment>
            ))}
          </div>
        ))}
        <label style={{
          display: "flex", alignItems: "center", gap: 6, marginTop: 10,
          fontSize: 11.5, color: tk.ink3, cursor: "pointer", width: "fit-content",
        }}>
          <input type="checkbox" checked={hideSettled} onChange={e => setHideSettled(e.target.checked)} />
          hide settled
        </label>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The lane that matters: runs asking for a person                      */}
      {/* ------------------------------------------------------------------ */}
      {attention.length > 0 && (
        <div style={{
          padding: "10px 20px 12px", borderBottom: `1px solid ${tk.border}`,
          background: tk.surfaceSunk, flexShrink: 0,
        }}>
          <div style={{
            fontSize: 10, letterSpacing: "0.10em", textTransform: "uppercase",
            color: STATE_COLOR["needs-you"], fontWeight: 510, marginBottom: 8,
          }}>
            {attention.length} runs are waiting on you
          </div>
          <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
            {attention.map(i => (
              <Card
                key={i.run.run_id}
                item={i}
                showWhere
                selected={i.run.run_id === selectedRunId}
                onClick={() => setProtoSelection({ nodeId: i.node.node_id, runId: i.run.run_id })}
              />
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* The board: one column per node, across both graphs                   */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        flex: 1, minHeight: 0, overflow: "auto", display: "flex", gap: 14,
        padding: "14px 20px", alignItems: "stretch",
      }}>
        {PROTOTYPE_GRAPHS.flatMap(g => g.nodes)
          .filter(n => !onlyNode || n.node_id === onlyNode)
          .map(n => {
            const runs = n.runs.filter(r => !(hideSettled && r.state === "settled"));
            return (
              <div key={n.node_id} style={{
                flex: 1, minWidth: 240, display: "flex", flexDirection: "column", minHeight: 0,
              }}>
                <div style={{
                  display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexShrink: 0,
                }}>
                  <span style={{ fontSize: 12, color: tk.ink2, fontWeight: 510 }}>{n.label}</span>
                  <span style={{ fontSize: 11, color: tk.ink4 }}>
                    {runs.length}{hideSettled && runs.length !== n.runs.length ? ` of ${n.runs.length}` : ""}
                  </span>
                </div>
                <div style={{
                  flex: 1, minHeight: 0, overflow: "auto",
                  display: "flex", flexDirection: "column", gap: 7, paddingRight: 4,
                }}>
                  {runs.map(r => (
                    <Card
                      key={r.run_id}
                      item={{ run: r, node: n, graphLabel: "" }}
                      selected={r.run_id === selectedRunId}
                      onClick={() => setProtoSelection({ nodeId: n.node_id, runId: r.run_id })}
                    />
                  ))}
                  {runs.length === 0 && (
                    <div style={{ fontSize: 11.5, color: tk.ink4, padding: "8px 2px" }}>
                      Nothing open here.
                    </div>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      <div style={{
        padding: "8px 20px", borderTop: `1px solid ${tk.border}`, flexShrink: 0,
        fontSize: 11, color: tk.ink4, display: "flex", gap: 14,
      }}>
        {(Object.keys(STATE_LABEL) as Array<keyof typeof STATE_LABEL>).map(s => (
          <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: 6, background: STATE_COLOR[s] }} />
            {STATE_LABEL[s]}
          </span>
        ))}
      </div>
    </div>
  );
}
