/**
 * PROTOTYPE VARIANT A — "The canvas is the place. Runs arrive in a drawer."
 *
 * Structure: the graph owns the whole surface and never changes. A node shows
 * how many runs are behind it as a physical stack, plus a single pip if any of
 * them want a person. Clicking a node slides a drawer in from the right; the
 * canvas stays visible and in place behind it, so you never lose where you are.
 *
 * Bet: the graph is the operator's home, and runs are a side-panel detail.
 */
import React, { useState } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_NODES, PROTOTYPE_EDGES, NODE_KIND_LABEL,
  STATE_COLOR, STATE_LABEL, countBy, wantsAttention, ago,
  type Node, type Run, type RunState,
} from "./fixture.ts";
import { RunConversation } from "./RunConversation.tsx";

export const VARIANT_A_NAME = "Canvas with a drawer";

function Stack({ n }: { n: number }): React.ReactElement {
  // A physical stack: up to 3 sheets behind the node, thickness implies volume.
  const sheets = Math.min(3, Math.max(0, n - 1));
  return (
    <>
      {Array.from({ length: sheets }).map((_, i) => (
        <div key={i} style={{
          position: "absolute", inset: 0,
          transform: `translate(${(i + 1) * 4}px, ${(i + 1) * 4}px)`,
          border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
          borderRadius: tk.r3, zIndex: -1,
        }} />
      ))}
    </>
  );
}

function CanvasNode({
  node, selected, onClick,
}: { node: Node; selected: boolean; onClick: () => void }): React.ReactElement {
  const counts = countBy(node.runs);
  const attention = node.runs.filter(wantsAttention).length;
  return (
    <div
      onClick={onClick}
      style={{
        position: "absolute", left: node.x, top: node.y, width: 210,
        cursor: "pointer", zIndex: 1,
      }}
    >
      <div style={{ position: "relative" }}>
        <Stack n={node.runs.length} />
        <div style={{
          position: "relative",
          border: `1px solid ${selected ? tk.accent : tk.border}`,
          boxShadow: selected ? `0 0 0 3px ${tk.accentRing}` : "none",
          background: tk.surface, borderRadius: tk.r3, padding: "12px 14px",
        }}>
          <div style={{
            fontSize: 9.5, letterSpacing: "0.10em", textTransform: "uppercase",
            color: tk.ink4, marginBottom: 5,
          }}>
            {NODE_KIND_LABEL[node.kind]}
          </div>
          <div style={{ fontSize: 13.5, color: tk.ink, fontWeight: 510, lineHeight: 1.3 }}>
            {node.label}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginTop: 10,
            fontSize: 11.5, color: tk.ink3,
          }}>
            <span>{node.runs.length} {node.runs.length === 1 ? "run" : "runs"}</span>
            {counts.running > 0 && (
              <span style={{ color: STATE_COLOR.running }}>{counts.running} running</span>
            )}
            {attention > 0 && (
              <span style={{
                marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5,
                color: STATE_COLOR["needs-you"], fontWeight: 510,
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: 7, background: STATE_COLOR["needs-you"],
                }} />
                {attention}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RunRow({ run, onClick }: { run: Run; onClick: () => void }): React.ReactElement {
  const [hov, setHov] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "9px 16px", cursor: "pointer",
        background: hov ? tk.surfaceHov : "transparent",
        borderBottom: `1px solid ${tk.border2}`,
      }}
    >
      <span style={{
        width: 7, height: 7, borderRadius: 7, flexShrink: 0,
        background: STATE_COLOR[run.state],
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 12.5, color: tk.ink2, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {run.label}
          {run.reworked_from && (
            <span style={{ color: tk.ink4, fontSize: 11 }}> · reworking</span>
          )}
          {run.gathers && (
            <span style={{ color: tk.ink4, fontSize: 11 }}> · gathers {run.gathers}</span>
          )}
        </div>
        <div style={{
          fontSize: 11, color: tk.ink4, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {run.last}
        </div>
      </div>
      <span style={{ fontSize: 10.5, color: tk.ink4, flexShrink: 0 }}>{ago(run.age_min)}</span>
    </div>
  );
}

export function VariantA(): React.ReactElement {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RunState | "all" | "attention">("all");

  const node = PROTOTYPE_NODES.find(n => n.node_id === nodeId) ?? null;
  const run = node?.runs.find(r => r.run_id === runId) ?? null;

  const shown = !node ? [] :
    filter === "all" ? node.runs :
    filter === "attention" ? node.runs.filter(wantsAttention) :
    node.runs.filter(r => r.state === filter);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", background: tk.canvas }}>
      {/* ---------------------------------------------------------------- */}
      {/* The canvas — never changes, never scrolls away                     */}
      {/* ---------------------------------------------------------------- */}
      <div style={{ position: "absolute", inset: 0, overflow: "auto" }}>
        <div style={{ position: "relative", width: 980, height: 460 }}>
          <svg width={980} height={460} style={{ position: "absolute", inset: 0 }}>
            {PROTOTYPE_EDGES.map(([from, to]) => {
              const a = PROTOTYPE_NODES.find(n => n.node_id === from)!;
              const b = PROTOTYPE_NODES.find(n => n.node_id === to)!;
              const x1 = a.x + 210, y1 = a.y + 46;
              const x2 = b.x, y2 = b.y + 46;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={`${from}-${to}`}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  stroke={tk.border} strokeWidth={1.5} fill="none"
                />
              );
            })}
          </svg>
          {PROTOTYPE_NODES.map(n => (
            <CanvasNode
              key={n.node_id}
              node={n}
              selected={n.node_id === nodeId}
              onClick={() => { setNodeId(n.node_id); setRunId(null); setFilter("all"); }}
            />
          ))}
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The drawer                                                        */}
      {/* ---------------------------------------------------------------- */}
      {node && (
        <div style={{
          position: "absolute", top: 0, right: 0, bottom: 0, width: 400,
          background: tk.surface, borderLeft: `1px solid ${tk.border}`,
          display: "flex", flexDirection: "column", minHeight: 0,
          boxShadow: "-16px 0 40px rgba(0,0,0,0.45)",
        }}>
          {run ? (
            <RunConversation
              run={run}
              nodeLabel={node.label}
              onBack={() => setRunId(null)}
              backLabel={`${node.runs.length} runs`}
            />
          ) : (
            <>
              <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${tk.border}` }}>
                <div style={{ display: "flex", alignItems: "start", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, color: tk.ink, fontWeight: 510 }}>{node.label}</div>
                    <div style={{ fontSize: 11, color: tk.ink4, marginTop: 2 }}>
                      {node.runs.length} runs of this node
                    </div>
                  </div>
                  <button
                    onClick={() => setNodeId(null)}
                    style={{
                      marginLeft: "auto", background: "transparent", border: "none",
                      color: tk.ink3, cursor: "pointer", fontSize: 16, lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 10, flexWrap: "wrap" }}>
                  {(["all", "attention", "running", "idle", "settled"] as const).map(f => {
                    const n = f === "all" ? node.runs.length
                      : f === "attention" ? node.runs.filter(wantsAttention).length
                      : node.runs.filter(r => r.state === f).length;
                    return (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        style={{
                          background: filter === f ? tk.accentSoft2 : "transparent",
                          border: `1px solid ${filter === f ? tk.accent : tk.border}`,
                          color: filter === f ? tk.ink : tk.ink3,
                          borderRadius: 999, padding: "3px 9px", fontSize: 11,
                          cursor: "pointer", fontFamily: tk.fontUi,
                        }}
                      >
                        {f === "attention" ? "needs you" : f === "all" ? "all" : STATE_LABEL[f as RunState]} {n}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
                {shown.map(r => (
                  <RunRow key={r.run_id} run={r} onClick={() => setRunId(r.run_id)} />
                ))}
                {shown.length === 0 && (
                  <div style={{ padding: 20, fontSize: 12, color: tk.ink4 }}>Nothing here.</div>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {!node && (
        <div style={{
          position: "absolute", right: 20, bottom: 20, fontSize: 11.5, color: tk.ink4,
        }}>
          Click a node to see its runs.
        </div>
      )}
    </div>
  );
}
