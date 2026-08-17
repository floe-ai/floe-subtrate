/**
 * PROTOTYPE VARIANT A — "The canvas is the place. Runs open in the app's own
 * inspector."
 *
 * Revision 2. In revision 1 this variant invented its own drawer; the operator
 * said that in a real environment it belongs in the second aside. So the
 * drawer is gone. The canvas now owns the whole main area, and clicking a node
 * fills the app's REAL right-hand inspector with that node's runs — click one
 * and the inspector goes a level deeper into the conversation.
 *
 * Two graphs share the scope, stacked, exactly as the substrate allows.
 *
 * Bet: the graph is the operator's home, and the app's existing inspector is
 * already the right place for detail — no new surface required.
 */
import React, { useEffect } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_GRAPHS, CANVAS_W, CANVAS_H, NODE_W, NODE_KIND_LABEL,
  STATE_COLOR, countBy, wantsAttention,
  type Node, type Graph,
} from "./fixture.ts";
import { setProtoSelection, subscribeProtoSelection, getProtoSelection } from "./runSelection.ts";

export const VARIANT_A_NAME = "Canvas, runs in the inspector";

function useSelectedNode(): string | null {
  const [id, setId] = React.useState<string | null>(getProtoSelection().nodeId);
  useEffect(() => subscribeProtoSelection(s => setId(s.nodeId)), []);
  return id;
}

function Stack({ n }: { n: number }): React.ReactElement | null {
  // A physical stack: up to 3 sheets behind the node, thickness implies volume.
  const sheets = Math.min(3, Math.max(0, n - 1));
  if (sheets === 0) return null;
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
  const iterating = node.runs.filter(r => (r.passes ?? 1) > 1).length;
  return (
    <div
      onClick={onClick}
      style={{ position: "absolute", left: node.x, top: node.y, width: NODE_W, cursor: "pointer", zIndex: 1 }}
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
          <div style={{ fontSize: 13, color: tk.ink, fontWeight: 510, lineHeight: 1.3 }}>
            {node.label}
          </div>
          {node.declares && (
            <div style={{ fontSize: 10, color: tk.ink4, marginTop: 5, lineHeight: 1.4 }}>
              {node.declares}
            </div>
          )}
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
                <span style={{ width: 7, height: 7, borderRadius: 7, background: STATE_COLOR["needs-you"] }} />
                {attention}
              </span>
            )}
          </div>
          {iterating > 0 && (
            <div style={{ fontSize: 10.5, color: tk.ink4, marginTop: 5 }}>
              {iterating} on a second pass or later
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GraphEdges({ graph }: { graph: Graph }): React.ReactElement {
  return (
    <>
      {graph.edges.map(([from, to]) => {
        const a = graph.nodes.find(n => n.node_id === from)!;
        const b = graph.nodes.find(n => n.node_id === to)!;
        const x1 = a.x + NODE_W, y1 = a.y + 46;
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
    </>
  );
}

export function VariantA(): React.ReactElement {
  const selectedNodeId = useSelectedNode();

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, overflow: "auto", background: tk.canvas }}>
      <div style={{ position: "relative", width: CANVAS_W, height: CANVAS_H }}>
        <svg width={CANVAS_W} height={CANVAS_H} style={{ position: "absolute", inset: 0 }}>
          {PROTOTYPE_GRAPHS.map(g => <GraphEdges key={g.graph_id} graph={g} />)}
        </svg>

        {PROTOTYPE_GRAPHS.map(g => (
          <React.Fragment key={g.graph_id}>
            {/* The graph is not a primitive — it is just a picture, so its name
                sits on the canvas as a caption, not as a container. */}
            <div style={{
              position: "absolute",
              left: g.nodes[0].x,
              top: g.nodes[0].y - 26,
              fontSize: 10.5, letterSpacing: "0.10em", textTransform: "uppercase",
              color: tk.ink4, fontWeight: 510,
            }}>
              {g.label}
            </div>
            {g.nodes.map(n => (
              <CanvasNode
                key={n.node_id}
                node={n}
                selected={n.node_id === selectedNodeId}
                onClick={() => setProtoSelection({ nodeId: n.node_id, runId: null })}
              />
            ))}
          </React.Fragment>
        ))}
      </div>

      {!selectedNodeId && (
        <div style={{
          position: "sticky", bottom: 14, left: 20, width: "fit-content",
          marginLeft: 20, fontSize: 11.5, color: tk.ink4,
        }}>
          Click a node — its runs open in the inspector on the right.
        </div>
      )}
    </div>
  );
}
