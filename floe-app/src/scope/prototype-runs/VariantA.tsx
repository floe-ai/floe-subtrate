/**
 * PROTOTYPE VARIANT A — "The canvas is the place. Runs open in the app's own
 * inspector."
 *
 * Revision 3 adds the two things the operator said were missing:
 *
 *   THE WAY BACK. Every command node has a dashed edge returning to the working
 *   space that calls it. It is drawn faint — that is the SHAPE, always true —
 *   and it lights up red with a count when runs are actually coming back right
 *   now. Crucially the label says which ITEM is returning, because the return
 *   is per-run: "peer-contexts.md" goes back to the run that owns
 *   peer-contexts.md, never to another document's run.
 *
 *   FAN-OUT AND FAN-IN, LEGIBLE. Flow edges carry a multiplicity label ("1 → 50",
 *   "50 → 1", "2 → 1") so a split or a convergence is readable without opening
 *   anything. And "follow this one" picks a single item and lights only its runs
 *   across every node, so you can watch one asset travel a branching pipeline.
 */
import React, { useEffect, useState } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_GRAPHS, CANVAS_W, CANVAS_H, NODE_W, NODE_KIND_LABEL, RETURN_COLOR,
  STATE_COLOR, countBy, wantsAttention, followableSubjects,
  type Node, type Graph, type Edge,
} from "./fixture.ts";
import { setProtoSelection, subscribeProtoSelection, getProtoSelection } from "./runSelection.ts";

export const VARIANT_A_NAME = "Canvas, runs in the inspector";

const NODE_H = 92;

function useSelectedNode(): string | null {
  const [id, setId] = useState<string | null>(getProtoSelection().nodeId);
  useEffect(() => subscribeProtoSelection(s => setId(s.nodeId)), []);
  return id;
}

/** Where an edge attaches, so branches leave and arrive at sensible points. */
function anchors(a: Node, b: Node) {
  return { x1: a.x + NODE_W, y1: a.y + 42, x2: b.x, y2: b.y + 42 };
}

function FlowEdge({ a, b, edge, dim }: { a: Node; b: Node; edge: Edge; dim: boolean }): React.ReactElement {
  const { x1, y1, x2, y2 } = anchors(a, b);
  const mid = (x1 + x2) / 2;
  return (
    <g style={{ opacity: dim ? 0.12 : 1, transition: "opacity 200ms ease" }}>
      <path
        d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
        stroke={tk.border} strokeWidth={1.5} fill="none" markerEnd="url(#proto-arrow)"
      />
      {edge.multiplicity && (
        <>
          <rect
            x={mid - 26} y={(y1 + y2) / 2 - 9} width={52} height={18} rx={9}
            fill={tk.canvas} stroke={tk.border}
          />
          <text
            x={mid} y={(y1 + y2) / 2 + 4} textAnchor="middle"
            fontSize={10} fill={tk.ink3} fontFamily={tk.fontUi}
          >
            {edge.multiplicity}
          </text>
        </>
      )}
    </g>
  );
}

/**
 * The way back. Not an edge the operator draws — it is implied by the fact that
 * a command run was called by a working-space run. Faint when nothing is
 * failing; alive when something is on its way home.
 */
function ReturnEdge({ a, b, dim }: { a: Node; b: Node; dim: boolean }): React.ReactElement {
  const live = a.runs.filter(r => r.returning);
  const alive = live.length > 0;
  // Loop underneath the row so it never sits on top of the forward path.
  const x1 = a.x + NODE_W / 2, x2 = b.x + NODE_W / 2;
  const y = a.y + NODE_H;
  const drop = y + 46;
  const color = alive ? RETURN_COLOR : tk.border;

  return (
    <g style={{ opacity: dim ? 0.1 : alive ? 1 : 0.55, transition: "opacity 200ms ease" }}>
      <path
        d={`M${x1},${y} C${x1},${drop} ${x2},${drop} ${x2},${y}`}
        stroke={color} strokeWidth={alive ? 1.8 : 1.2} fill="none"
        strokeDasharray="4 4" markerEnd={alive ? "url(#proto-arrow-live)" : "url(#proto-arrow-faint)"}
      />
      {alive && (
        <>
          <rect
            x={(x1 + x2) / 2 - 92} y={drop - 19} width={184} height={19} rx={9.5}
            fill={tk.canvas} stroke={RETURN_COLOR}
          />
          <text
            x={(x1 + x2) / 2} y={drop - 6} textAnchor="middle"
            fontSize={10} fill={RETURN_COLOR} fontFamily={tk.fontUi}
          >
            {live.length === 1
              ? `${live[0].subject ?? live[0].label} going back`
              : `${live.length} going back to their own run`}
          </text>
        </>
      )}
    </g>
  );
}

function CanvasNode({
  node, selected, dim, litRunCount, onClick,
}: {
  node: Node; selected: boolean; dim: boolean; litRunCount: number | null; onClick: () => void;
}): React.ReactElement {
  const counts = countBy(node.runs);
  const attention = node.runs.filter(wantsAttention).length;
  const returning = node.runs.filter(r => r.returning).length;
  const sheets = Math.min(3, Math.max(0, node.runs.length - 1));

  return (
    <div
      onClick={onClick}
      style={{
        position: "absolute", left: node.x, top: node.y, width: NODE_W, cursor: "pointer",
        zIndex: 1, opacity: dim ? 0.16 : 1, transition: "opacity 200ms ease",
      }}
    >
      <div style={{ position: "relative" }}>
        {Array.from({ length: sheets }).map((_, i) => (
          <div key={i} style={{
            position: "absolute", inset: 0,
            transform: `translate(${(i + 1) * 4}px, ${(i + 1) * 4}px)`,
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r3, zIndex: -1,
          }} />
        ))}
        <div style={{
          position: "relative",
          border: `1px solid ${selected ? tk.accent : returning > 0 ? RETURN_COLOR : tk.border}`,
          boxShadow: selected ? `0 0 0 3px ${tk.accentRing}` : "none",
          background: tk.surface, borderRadius: tk.r3, padding: "11px 13px",
        }}>
          <div style={{
            fontSize: 9.5, letterSpacing: "0.10em", textTransform: "uppercase",
            color: node.kind === "command" ? tk.ink3 : tk.ink4, marginBottom: 5,
          }}>
            {NODE_KIND_LABEL[node.kind]}
          </div>
          <div style={{ fontSize: 12.5, color: tk.ink, fontWeight: 510, lineHeight: 1.3 }}>
            {node.label}
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 8, marginTop: 9,
            fontSize: 11, color: tk.ink3,
          }}>
            {litRunCount !== null ? (
              <span style={{ color: tk.accent }}>
                {litRunCount} {litRunCount === 1 ? "run" : "runs"} of this item
              </span>
            ) : (
              <>
                <span>{node.runs.length} {node.runs.length === 1 ? "run" : "runs"}</span>
                {counts.running > 0 && (
                  <span style={{ color: STATE_COLOR.running }}>{counts.running} running</span>
                )}
                {attention > 0 && (
                  <span style={{
                    marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 5,
                    color: STATE_COLOR["needs-you"], fontWeight: 510,
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: 7, background: STATE_COLOR["needs-you"] }} />
                    {attention}
                  </span>
                )}
              </>
            )}
          </div>
          {returning > 0 && litRunCount === null && (
            <div style={{ fontSize: 10.5, color: RETURN_COLOR, marginTop: 5 }}>
              {returning} failed — going back to its caller
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function VariantA(): React.ReactElement {
  const selectedNodeId = useSelectedNode();
  const [following, setFollowing] = useState<string | null>(null);

  const litNodes = new Set<string>();
  if (following) {
    for (const g of PROTOTYPE_GRAPHS) {
      for (const n of g.nodes) {
        if (n.runs.some(r => r.subject === following)) litNodes.add(n.node_id);
      }
    }
  }

  const allSubjects = PROTOTYPE_GRAPHS.flatMap(g =>
    followableSubjects(g).map(s => ({ subject: s, graph: g.label }))
  );

  function isDim(nodeId: string): boolean {
    return following !== null && !litNodes.has(nodeId);
  }

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* ------------------------------------------------------------------ */}
      {/* Follow one item across the whole pipeline                            */}
      {/* ------------------------------------------------------------------ */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
        padding: "9px 20px", borderBottom: `1px solid ${tk.border}`,
        background: tk.surface, flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: tk.ink4 }}>Follow one item:</span>
        <button
          onClick={() => setFollowing(null)}
          style={{
            background: following === null ? tk.accentSoft2 : "transparent",
            border: `1px solid ${following === null ? tk.accent : tk.border}`,
            color: following === null ? tk.ink : tk.ink3,
            borderRadius: 999, padding: "3px 10px", fontSize: 11,
            cursor: "pointer", fontFamily: tk.fontUi,
          }}
        >
          everything
        </button>
        {allSubjects.slice(0, 8).map(({ subject }) => (
          <button
            key={subject}
            onClick={() => setFollowing(following === subject ? null : subject)}
            style={{
              background: following === subject ? tk.accentSoft2 : "transparent",
              border: `1px solid ${following === subject ? tk.accent : tk.border}`,
              color: following === subject ? tk.ink : tk.ink3,
              borderRadius: 999, padding: "3px 10px", fontSize: 11,
              cursor: "pointer", fontFamily: tk.fontUi,
            }}
          >
            {subject}
          </button>
        ))}
        <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, color: tk.ink4 }}>
          <svg width={26} height={8}><path d="M0,4 L26,4" stroke={RETURN_COLOR} strokeWidth={1.5} strokeDasharray="4 4" /></svg>
          the way back from a command
        </span>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The canvas                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", background: tk.canvas }}>
        <div style={{ position: "relative", width: CANVAS_W, height: CANVAS_H }}>
          <svg width={CANVAS_W} height={CANVAS_H} style={{ position: "absolute", inset: 0 }}>
            <defs>
              <marker id="proto-arrow" markerWidth={7} markerHeight={7} refX={6} refY={3}
                orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L6,3 L0,6 z" fill={tk.border} />
              </marker>
              <marker id="proto-arrow-live" markerWidth={7} markerHeight={7} refX={6} refY={3}
                orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L6,3 L0,6 z" fill={RETURN_COLOR} />
              </marker>
              <marker id="proto-arrow-faint" markerWidth={7} markerHeight={7} refX={6} refY={3}
                orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L6,3 L0,6 z" fill={tk.border} />
              </marker>
            </defs>

            {PROTOTYPE_GRAPHS.map((g: Graph) =>
              g.edges.map(e => {
                const a = g.nodes.find(n => n.node_id === e.from)!;
                const b = g.nodes.find(n => n.node_id === e.to)!;
                const dim = isDim(e.from) || isDim(e.to);
                return e.kind === "return"
                  ? <ReturnEdge key={`${g.graph_id}-${e.from}-${e.to}-r`} a={a} b={b} dim={dim} />
                  : <FlowEdge key={`${g.graph_id}-${e.from}-${e.to}`} a={a} b={b} edge={e} dim={dim} />;
              })
            )}
          </svg>

          {PROTOTYPE_GRAPHS.map(g => (
            <React.Fragment key={g.graph_id}>
              {/* A graph is not a primitive — it is a picture, so its name is a
                  caption on the canvas, not a container around it. */}
              <div style={{
                position: "absolute",
                left: g.nodes[0].x,
                top: Math.min(...g.nodes.map(n => n.y)) - 28,
                fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
                color: tk.ink4, fontWeight: 510, whiteSpace: "nowrap",
              }}>
                {g.label}
              </div>
              {g.nodes.map(n => (
                <CanvasNode
                  key={n.node_id}
                  node={n}
                  selected={n.node_id === selectedNodeId}
                  dim={isDim(n.node_id)}
                  litRunCount={
                    following && litNodes.has(n.node_id)
                      ? n.runs.filter(r => r.subject === following).length
                      : null
                  }
                  onClick={() => setProtoSelection({ nodeId: n.node_id, runId: null })}
                />
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
