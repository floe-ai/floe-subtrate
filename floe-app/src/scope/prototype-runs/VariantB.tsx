/**
 * PROTOTYPE VARIANT B — "One surface. You fly into the node."
 *
 * Revision 2. The operator's word for this one was "premium", so it is kept
 * intact rather than folded into A: its bet is precisely that there is NO
 * second panel, so unlike A and C it does not borrow the app's inspector. The
 * scope, a node's fifty runs, and one conversation are the same canvas at
 * three depths. Click a node and the camera flies into it; Esc flies out.
 *
 * Both graphs share the surface, so flying into one dims the other — which is
 * itself worth judging when a scope holds more than one pipeline.
 */
import React, { useEffect, useState } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_GRAPHS, CANVAS_W, CANVAS_H, NODE_W, NODE_KIND_LABEL, RETURN_COLOR,
  STATE_COLOR, STATE_LABEL, countBy, wantsAttention, ago, nodeOf, graphOf,
  type Run, type Graph,
} from "./fixture.ts";
import { RunConversation } from "./RunConversation.tsx";
import { setProtoSelection } from "./runSelection.ts";

export const VARIANT_B_NAME = "Fly into the node";

const NODE_H = 96;

function RunTile({ run, onClick }: { run: Run; onClick: () => void }): React.ReactElement {
  const [hov, setHov] = useState(false);
  const attention = wantsAttention(run);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      title={`${run.label} — ${STATE_LABEL[run.state]}`}
      style={{
        textAlign: "left", cursor: "pointer", fontFamily: tk.fontUi,
        background: hov ? tk.surfaceHov : tk.surfaceSunk,
        border: `1px solid ${attention ? STATE_COLOR[run.state] : tk.border}`,
        borderRadius: tk.r2, padding: "7px 8px", minWidth: 0, overflow: "hidden",
        transition: "background 120ms ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: 6, flexShrink: 0, background: STATE_COLOR[run.state],
        }} />
        <span style={{
          fontSize: 11, color: tk.ink2, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {run.label}
        </span>
      </div>
      <div style={{ fontSize: 9.5, color: tk.ink4, marginTop: 3 }}>
        {STATE_LABEL[run.state]} · {ago(run.age_min)}
        {(run.passes ?? 1) > 1 ? ` · pass ${run.passes}` : ""}
        {run.gathers ? ` · gathers ${run.gathers}` : ""}
      </div>
    </button>
  );
}

function GraphEdges({ graph, dim }: { graph: Graph; dim: boolean }): React.ReactElement {
  return (
    <g style={{ opacity: dim ? 0.25 : 1, transition: "opacity 260ms ease" }}>
      {graph.edges.map(e => {
        const a = graph.nodes.find(n => n.node_id === e.from)!;
        const b = graph.nodes.find(n => n.node_id === e.to)!;
        if (e.kind === "return") {
          const live = a.runs.some(r => r.returning);
          const x1 = a.x + NODE_W / 2, x2 = b.x + NODE_W / 2;
          const y = a.y + NODE_H, drop = y + 46;
          return (
            <path key={`${e.from}-${e.to}-r`}
              d={`M${x1},${y} C${x1},${drop} ${x2},${drop} ${x2},${y}`}
              stroke={live ? RETURN_COLOR : tk.border} strokeWidth={live ? 1.8 : 1.2}
              strokeDasharray="4 4" fill="none" opacity={live ? 1 : 0.5} />
          );
        }
        const x1 = a.x + NODE_W, y1 = a.y + 42;
        const x2 = b.x, y2 = b.y + 42;
        const mid = (x1 + x2) / 2;
        return (
          <path key={`${e.from}-${e.to}`}
            d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
            stroke={tk.border} strokeWidth={1.5} fill="none" />
        );
      })}
    </g>
  );
}

export function VariantB(): React.ReactElement {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const node = nodeId ? nodeOf(nodeId) : null;
  const run = node?.runs.find(r => r.run_id === runId) ?? null;
  const depth = run ? 2 : node ? 1 : 0;

  // This variant keeps everything on its own surface, so make sure the app's
  // inspector is not left showing a stale run from another variant.
  useEffect(() => { setProtoSelection({ nodeId: null, runId: null }); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (runId) setRunId(null);
      else if (nodeId) setNodeId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodeId, runId]);

  const focusX = node ? node.x + NODE_W / 2 : CANVAS_W / 2;
  const focusY = node ? node.y + NODE_H / 2 : CANVAS_H / 2;
  const tx = depth === 0 ? 0 : (CANVAS_W / 2 - focusX) * 0.9;
  const ty = depth === 0 ? 0 : (CANVAS_H / 2 - focusY) * 0.9;
  const ease = "cubic-bezier(0.22,0.61,0.36,1)";

  return (
    <div style={{
      position: "relative", flex: 1, minHeight: 0, overflow: "hidden", background: tk.canvas,
    }}>
      {/* Breadcrumb — the only chrome; it is also the way out */}
      <div style={{
        position: "absolute", top: 12, left: 20, zIndex: 5,
        display: "flex", alignItems: "center", gap: 6,
        fontSize: 11.5, color: tk.ink4, fontFamily: tk.fontUi,
      }}>
        <button
          onClick={() => { setNodeId(null); setRunId(null); }}
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            color: depth === 0 ? tk.ink : tk.ink3, fontSize: 11.5, padding: 0, fontFamily: tk.fontUi,
          }}
        >
          the scope
        </button>
        {node && <>
          <span>›</span>
          <span style={{ color: tk.ink4 }}>{graphOf(node.node_id).label}</span>
          <span>›</span>
          <button
            onClick={() => setRunId(null)}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: depth === 1 ? tk.ink : tk.ink3, fontSize: 11.5, padding: 0, fontFamily: tk.fontUi,
            }}
          >
            {node.label}
          </button>
        </>}
        {run && <><span>›</span><span style={{ color: tk.ink }}>{run.label}</span></>}
        {depth > 0 && (
          <span style={{ marginLeft: 8, color: tk.ink4, fontSize: 10.5 }}>esc to fly out</span>
        )}
      </div>

      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <div style={{
          position: "relative", width: CANVAS_W, height: CANVAS_H, margin: "40px auto 0",
          transform: `translate(${tx}px, ${ty}px)`,
          transformOrigin: "center center",
          transition: `transform 320ms ${ease}`,
        }}>
          <svg width={CANVAS_W} height={CANVAS_H} style={{ position: "absolute", inset: 0 }}>
            {PROTOTYPE_GRAPHS.map(g => (
              <GraphEdges key={g.graph_id} graph={g} dim={depth > 0} />
            ))}
          </svg>

          {PROTOTYPE_GRAPHS.map(g => (
            <React.Fragment key={g.graph_id}>
              <div style={{
                position: "absolute", left: g.nodes[0].x, top: g.nodes[0].y - 26,
                fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
                color: tk.ink4, fontWeight: 510,
                opacity: depth > 0 ? 0.15 : 1, transition: "opacity 220ms ease",
              }}>
                {g.label}
              </div>

              {g.nodes.map(n => {
                const open = n.node_id === nodeId;
                const counts = countBy(n.runs);
                const attention = n.runs.filter(wantsAttention).length;
                return (
                  <div
                    key={n.node_id}
                    onClick={() => { if (!open) { setNodeId(n.node_id); setRunId(null); } }}
                    style={{
                      position: "absolute",
                      left: open ? 40 : n.x,
                      top: open ? 20 : n.y,
                      width: open ? CANVAS_W - 80 : NODE_W,
                      height: open ? CANVAS_H - 40 : "auto",
                      zIndex: open ? 3 : 1,
                      opacity: nodeId && !open ? 0.15 : 1,
                      pointerEvents: nodeId && !open ? "none" : "auto",
                      cursor: open ? "default" : "pointer",
                      background: tk.surface,
                      border: `1px solid ${open ? tk.accent : tk.border}`,
                      borderRadius: tk.r3,
                      overflow: "hidden",
                      display: "flex", flexDirection: "column",
                      transition: `left 320ms ${ease}, top 320ms ${ease}, width 320ms ${ease}, height 320ms ${ease}, opacity 220ms ease`,
                    }}
                  >
                    <div style={{
                      padding: "12px 16px",
                      borderBottom: open ? `1px solid ${tk.border}` : "none",
                      flexShrink: 0,
                    }}>
                      <div style={{
                        fontSize: 9.5, letterSpacing: "0.10em", textTransform: "uppercase",
                        color: tk.ink4, marginBottom: 5,
                      }}>
                        {NODE_KIND_LABEL[n.kind]}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ fontSize: 13, color: tk.ink, fontWeight: 510 }}>{n.label}</div>
                        <div style={{ marginLeft: "auto", fontSize: 11.5, color: tk.ink3, whiteSpace: "nowrap" }}>
                          {n.runs.length} {n.runs.length === 1 ? "run" : "runs"}
                          {counts.running > 0 && (
                            <span style={{ color: STATE_COLOR.running }}> · {counts.running} running</span>
                          )}
                          {attention > 0 && (
                            <span style={{ color: STATE_COLOR["needs-you"] }}> · {attention} need you</span>
                          )}
                        </div>
                      </div>
                      {n.declares && !open && (
                        <div style={{ fontSize: 10, color: tk.ink4, marginTop: 5 }}>{n.declares}</div>
                      )}
                    </div>

                    {open && (
                      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                        {run ? (
                          <RunConversation
                            run={run}
                            nodeLabel={n.label}
                            onBack={() => setRunId(null)}
                            backLabel="out to the node"
                          />
                        ) : (
                          <div style={{
                            flex: 1, overflow: "auto", minHeight: 0, padding: 14,
                            display: "grid", gap: 8,
                            gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
                            alignContent: "start",
                          }}>
                            {n.runs.map(r => (
                              <RunTile key={r.run_id} run={r} onClick={() => setRunId(r.run_id)} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
