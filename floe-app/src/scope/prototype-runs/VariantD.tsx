/**
 * PROTOTYPE VARIANT D — variant A at real scale.
 *
 * The operator picked A, then found the hole in it: "Follow one item can't be
 * in a subheader like that, there might be hundreds of items. What if one
 * pipeline is like what we are doing right now, building an application like
 * floe?"
 *
 * Correct, and it is not a layout problem — it is a modelling problem wearing a
 * layout costume. A pill bar is an ENUMERATION. Enumerations are a promise that
 * the list is short. Graph 4 has 140 tickets in flight and that promise breaks.
 *
 * D changes exactly one thing about A, and changes it on principle:
 *
 *   YOU DO NOT BROWSE ITEMS, YOU SEARCH THEM. The finder is a small control
 *   pinned to the canvas, not a bar across the top. It is empty by default and
 *   costs no vertical space. Type, and it finds the item anywhere in the scope.
 *
 *   THE ONE EXCEPTION IS ATTENTION. The only items the canvas volunteers
 *   unprompted are the ones asking for a human or stuck coming back — because
 *   those are the items you did not know to search for. Everything else waits
 *   to be asked for.
 *
 * That is the general rule this prototype is really testing: at scale, a
 * surface should show you what is WRONG and let you SEARCH for what is right.
 * Everything else in A is untouched.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_GRAPHS, CANVAS_W, CANVAS_H, NODE_W, NODE_KIND_LABEL, RETURN_COLOR,
  STATE_COLOR, STATE_LABEL, countBy, wantsAttention, searchItems, attentionItems,
  itemCount, runsForSubject,
  type Node, type Graph, type Edge, type ItemHit,
} from "./fixture.ts";
import { setProtoSelection, subscribeProtoSelection, getProtoSelection } from "./runSelection.ts";

export const VARIANT_D_NAME = "A at scale — search, don't list";

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

/**
 * The finder. Small, pinned, empty by default.
 *
 * Closed it is a single control. Open it shows attention items first — the ones
 * you did not know to look for — and then whatever you type. It never tries to
 * show you 140 things.
 */
function ItemFinder({
  following, onFollow,
}: {
  following: string | null;
  onFollow: (subject: string | null) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);

  const attention = useMemo(() => attentionItems(6), []);
  const total = useMemo(() => itemCount(), []);
  const results = useMemo(() => (q.trim() ? searchItems(q, 8) : []), [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as any)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  function pick(hit: ItemHit) {
    onFollow(hit.subject);
    const runs = runsForSubject(hit.subject);
    const first = runs[runs.length - 1];
    if (first) setProtoSelection({ nodeId: first.node.node_id, runId: first.run.run_id });
    setOpen(false);
    setQ("");
  }

  // Following: collapse to a chip. The canvas is already doing the explaining.
  if (following) {
    return (
      <div style={{
        position: "sticky", top: 12, left: 12, zIndex: 5, width: "fit-content",
        display: "inline-flex", alignItems: "center", gap: 8, marginLeft: 12,
        background: tk.surface, border: `1px solid ${tk.accent}`,
        boxShadow: `0 0 0 3px ${tk.accentRing}, 0 6px 20px rgba(0,0,0,0.35)`,
        borderRadius: 999, padding: "6px 8px 6px 12px",
      }}>
        <span style={{ fontSize: 11, color: tk.ink4 }}>following</span>
        <span style={{ fontSize: 12, color: tk.ink, fontWeight: 510, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {following}
        </span>
        <button
          onClick={() => onFollow(null)}
          style={{
            background: "transparent", border: "none", cursor: "pointer",
            color: tk.ink3, fontSize: 14, lineHeight: 1, padding: "0 4px",
          }}
        >
          ✕
        </button>
      </div>
    );
  }

  const rowBase: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 8, padding: "7px 11px",
    cursor: "pointer", fontSize: 11.5, borderTop: `1px solid ${tk.border}`,
  };

  return (
    <div
      ref={boxRef}
      style={{
        position: "sticky", top: 12, left: 12, zIndex: 5, width: 340,
        marginLeft: 12, marginBottom: -40,
      }}
    >
      <div style={{
        background: tk.surface, border: `1px solid ${tk.border}`,
        borderRadius: open ? tk.r3 : 999,
        boxShadow: "0 6px 20px rgba(0,0,0,0.35)", overflow: "hidden",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px" }}>
          <span style={{ color: tk.ink4, fontSize: 12 }}>⌕</span>
          <input
            value={q}
            onFocus={() => setOpen(true)}
            onChange={e => { setQ(e.target.value); setOpen(true); }}
            placeholder={`Find an item — ${total} in flight`}
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              color: tk.ink, fontSize: 12, fontFamily: tk.fontUi,
            }}
          />
        </div>

        {open && (
          <div style={{ maxHeight: 320, overflow: "auto" }}>
            {q.trim() === "" && (
              <>
                <div style={{
                  ...rowBase, cursor: "default", color: tk.ink4, fontSize: 10.5,
                  letterSpacing: "0.08em", textTransform: "uppercase", paddingBottom: 4,
                }}>
                  asking for you
                </div>
                {attention.map(hit => (
                  <div key={hit.subject} style={{ ...rowBase, borderTop: "none" }} onClick={() => pick(hit)}>
                    <span style={{
                      width: 7, height: 7, borderRadius: 7, flexShrink: 0,
                      background: STATE_COLOR[hit.state],
                    }} />
                    <span style={{ color: tk.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {hit.subject}
                    </span>
                    <span style={{ marginLeft: "auto", color: tk.ink4, fontSize: 10.5, flexShrink: 0 }}>
                      {hit.returning ? "going back" : hit.at}
                    </span>
                  </div>
                ))}
                <div style={{
                  ...rowBase, cursor: "default", color: tk.ink4, fontSize: 11,
                }}>
                  and {total - attention.length} more — type to find one
                </div>
              </>
            )}

            {q.trim() !== "" && results.length === 0 && (
              <div style={{ ...rowBase, cursor: "default", color: tk.ink4 }}>
                Nothing matches “{q}”.
              </div>
            )}

            {results.map(hit => (
              <div key={hit.subject} style={rowBase} onClick={() => pick(hit)}>
                <span style={{
                  width: 7, height: 7, borderRadius: 7, flexShrink: 0,
                  background: STATE_COLOR[hit.state],
                }} />
                <span style={{ color: tk.ink2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hit.subject}
                </span>
                <span style={{ marginLeft: "auto", color: tk.ink4, fontSize: 10.5, flexShrink: 0 }}>
                  {STATE_LABEL[hit.state]} · {hit.at}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function VariantD(): React.ReactElement {
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

  function isDim(nodeId: string): boolean {
    return following !== null && !litNodes.has(nodeId);
  }

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* ------------------------------------------------------------------ */}
      {/* The canvas. No subheader — the finder floats on top of it and costs  */}
      {/* no vertical space at all.                                            */}
      {/* ------------------------------------------------------------------ */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", background: tk.canvas }}>
        <ItemFinder following={following} onFollow={setFollowing} />
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
