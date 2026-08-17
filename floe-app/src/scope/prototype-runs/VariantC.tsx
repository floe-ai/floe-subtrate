/**
 * PROTOTYPE VARIANT C — "The runs are the product. The graph is a legend."
 *
 * Structure: the surface is the WORK — every run in the scope, in columns, one
 * column per node, in pipeline order. The three-node graph is demoted to a thin
 * strip along the top that you read to orient yourself and click to filter.
 * A lane at the very top collects only the runs asking for a person.
 *
 * Bet: an operator with fifty live conversations does not want a diagram — the
 * diagram is three boxes they already know. They want the fifty, sorted.
 */
import React, { useState } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_NODES, NODE_KIND_LABEL,
  STATE_COLOR, STATE_LABEL, wantsAttention, ago,
  type Run,
} from "./fixture.ts";
import { RunConversation } from "./RunConversation.tsx";

export const VARIANT_C_NAME = "Runs first, graph as a legend";

type Located = { run: Run; nodeId: string; nodeLabel: string };

const ALL: Located[] = PROTOTYPE_NODES.flatMap(n =>
  n.runs.map(r => ({ run: r, nodeId: n.node_id, nodeLabel: n.label }))
);

function Card({
  item, compact, onClick,
}: { item: Located; compact?: boolean; onClick: () => void }): React.ReactElement {
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
        border: `1px solid ${wantsAttention(run) ? STATE_COLOR[run.state] : tk.border}`,
        minWidth: compact ? 230 : 0, flexShrink: 0,
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
      {compact && (
        <div style={{ fontSize: 10.5, color: tk.ink4, marginTop: 3 }}>
          in “{item.nodeLabel}”
        </div>
      )}
      <div style={{
        fontSize: 11, color: tk.ink3, marginTop: 5, lineHeight: 1.4,
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
      }}>
        {run.last}
      </div>
      {(run.reworked_from || run.gathers) && (
        <div style={{ fontSize: 10, color: tk.ink4, marginTop: 6 }}>
          {run.reworked_from ? "re-opened by review · still going" : `gathers ${run.gathers} upstream`}
        </div>
      )}
    </div>
  );
}

export function VariantC(): React.ReactElement {
  const [openId, setOpenId] = useState<string | null>(null);
  const [onlyNode, setOnlyNode] = useState<string | null>(null);
  const [hideSettled, setHideSettled] = useState(true);

  const open = ALL.find(i => i.run.run_id === openId) ?? null;

  if (open) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: tk.canvas }}>
        <RunConversation
          run={open.run}
          nodeLabel={open.nodeLabel}
          onBack={() => setOpenId(null)}
          backLabel="all runs"
        />
      </div>
    );
  }

  const attention = ALL.filter(i => wantsAttention(i.run));

  return (
    <div style={{
      flex: 1, minHeight: 0, display: "flex", flexDirection: "column",
      background: tk.canvas, overflow: "hidden",
    }}>
      {/* ------------------------------------------------------------------ */}
      {/* The graph, demoted to a strip. Click a box to filter the board.      */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        display: "flex", alignItems: "center", gap: 0, padding: "10px 20px",
        borderBottom: `1px solid ${tk.border}`, background: tk.surface, flexShrink: 0,
      }}>
        {PROTOTYPE_NODES.map((n, i) => (
          <React.Fragment key={n.node_id}>
            {i > 0 && <span style={{ color: tk.ink4, padding: "0 10px", fontSize: 13 }}>→</span>}
            <button
              onClick={() => setOnlyNode(onlyNode === n.node_id ? null : n.node_id)}
              style={{
                background: onlyNode === n.node_id ? tk.accentSoft2 : "transparent",
                border: `1px solid ${onlyNode === n.node_id ? tk.accent : tk.border}`,
                borderRadius: tk.r2, padding: "5px 10px", cursor: "pointer",
                textAlign: "left", fontFamily: tk.fontUi,
              }}
            >
              <div style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: tk.ink4 }}>
                {NODE_KIND_LABEL[n.kind]}
              </div>
              <div style={{ fontSize: 12, color: tk.ink, fontWeight: 510 }}>{n.label}</div>
              <div style={{ fontSize: 10.5, color: tk.ink3 }}>{n.runs.length} runs</div>
            </button>
          </React.Fragment>
        ))}
        <label style={{
          marginLeft: "auto", display: "flex", alignItems: "center", gap: 6,
          fontSize: 11.5, color: tk.ink3, cursor: "pointer",
        }}>
          <input
            type="checkbox"
            checked={hideSettled}
            onChange={e => setHideSettled(e.target.checked)}
          />
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
              <Card key={i.run.run_id} item={i} compact onClick={() => setOpenId(i.run.run_id)} />
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* The board: one column per node                                       */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        flex: 1, minHeight: 0, overflow: "auto", display: "flex", gap: 14,
        padding: "14px 20px", alignItems: "stretch",
      }}>
        {PROTOTYPE_NODES.filter(n => !onlyNode || n.node_id === onlyNode).map(n => {
          const runs = n.runs.filter(r => !(hideSettled && r.state === "settled"));
          return (
            <div key={n.node_id} style={{
              flex: 1, minWidth: 260, display: "flex", flexDirection: "column", minHeight: 0,
            }}>
              <div style={{
                display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexShrink: 0,
              }}>
                <span style={{ fontSize: 12.5, color: tk.ink2, fontWeight: 510 }}>{n.label}</span>
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
                    item={{ run: r, nodeId: n.node_id, nodeLabel: n.label }}
                    onClick={() => setOpenId(r.run_id)}
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
