/**
 * PROTOTYPE VARIANT B — "One surface. You fly into the node."
 *
 * Structure: there is no second panel anywhere. The scope, a node's fifty runs,
 * and a single conversation are all the SAME canvas at three depths. Clicking a
 * node flies the camera into it and the node's interior becomes the grid of its
 * runs; clicking a run flies in once more. Escape (or the breadcrumb) flies out.
 *
 * Bet: nesting is spatial, so you always feel where you are and one gesture —
 * in and out — is the whole navigation model. No list/canvas split to maintain.
 */
import React, { useEffect, useState } from "react";
import { tk } from "../../theme.ts";
import {
  PROTOTYPE_NODES, PROTOTYPE_EDGES, NODE_KIND_LABEL,
  STATE_COLOR, STATE_LABEL, countBy, wantsAttention, ago,
  type Node, type Run,
} from "./fixture.ts";
import { RunConversation } from "./RunConversation.tsx";

export const VARIANT_B_NAME = "Fly into the node";

const STAGE_W = 1000;
const STAGE_H = 460;
const NODE_W = 210;
const NODE_H = 96;

/** A single run, as a tile inside the opened node. */
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
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{
          width: 6, height: 6, borderRadius: 6, flexShrink: 0,
          background: STATE_COLOR[run.state],
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
        {run.reworked_from ? " · reworking" : ""}
        {run.gathers ? ` · gathers ${run.gathers}` : ""}
      </div>
    </button>
  );
}

export function VariantB(): React.ReactElement {
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const node = PROTOTYPE_NODES.find(n => n.node_id === nodeId) ?? null;
  const run = node?.runs.find(r => r.run_id === runId) ?? null;
  const depth = run ? 2 : node ? 1 : 0;

  // Escape flies out one level.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (runId) setRunId(null);
      else if (nodeId) setNodeId(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nodeId, runId]);

  // Camera: at depth 0 the whole scope; deeper, centre on the opened node.
  const scale = depth === 0 ? 1 : 1.06;
  const focusX = node ? node.x + NODE_W / 2 : STAGE_W / 2;
  const focusY = node ? node.y + NODE_H / 2 : STAGE_H / 2;
  const tx = depth === 0 ? 0 : (STAGE_W / 2 - focusX) * 0.9;
  const ty = depth === 0 ? 0 : (STAGE_H / 2 - focusY) * 0.9;

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
            color: depth === 0 ? tk.ink : tk.ink3, fontSize: 11.5, padding: 0,
            fontFamily: tk.fontUi,
          }}
        >
          the scope
        </button>
        {node && <>
          <span>›</span>
          <button
            onClick={() => setRunId(null)}
            style={{
              background: "transparent", border: "none", cursor: "pointer",
              color: depth === 1 ? tk.ink : tk.ink3, fontSize: 11.5, padding: 0,
              fontFamily: tk.fontUi,
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

      {/* The one stage */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
        <div style={{
          position: "relative", width: STAGE_W, height: STAGE_H,
          margin: "40px auto 0",
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transformOrigin: "center center",
          transition: "transform 320ms cubic-bezier(0.22,0.61,0.36,1)",
        }}>
          <svg width={STAGE_W} height={STAGE_H} style={{
            position: "absolute", inset: 0,
            opacity: depth === 0 ? 1 : 0.25,
            transition: "opacity 260ms ease",
          }}>
            {PROTOTYPE_EDGES.map(([from, to]) => {
              const a = PROTOTYPE_NODES.find(n => n.node_id === from)!;
              const b = PROTOTYPE_NODES.find(n => n.node_id === to)!;
              const x1 = a.x + NODE_W, y1 = a.y + 46;
              const x2 = b.x, y2 = b.y + 46;
              const mid = (x1 + x2) / 2;
              return (
                <path key={`${from}-${to}`}
                  d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                  stroke={tk.border} strokeWidth={1.5} fill="none" />
              );
            })}
          </svg>

          {PROTOTYPE_NODES.map(n => {
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
                  width: open ? STAGE_W - 80 : NODE_W,
                  height: open ? STAGE_H - 40 : "auto",
                  zIndex: open ? 3 : 1,
                  opacity: nodeId && !open ? 0.18 : 1,
                  pointerEvents: nodeId && !open ? "none" : "auto",
                  cursor: open ? "default" : "pointer",
                  background: tk.surface,
                  border: `1px solid ${open ? tk.accent : tk.border}`,
                  borderRadius: tk.r3,
                  overflow: "hidden",
                  display: "flex", flexDirection: "column",
                  transition: "left 320ms cubic-bezier(0.22,0.61,0.36,1), top 320ms cubic-bezier(0.22,0.61,0.36,1), width 320ms cubic-bezier(0.22,0.61,0.36,1), height 320ms cubic-bezier(0.22,0.61,0.36,1), opacity 220ms ease",
                }}
              >
                {/* The node's own face — same in both states, it just gets bigger */}
                <div style={{
                  padding: open ? "12px 16px" : "12px 14px",
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
                    <div style={{ fontSize: 13.5, color: tk.ink, fontWeight: 510 }}>{n.label}</div>
                    <div style={{ marginLeft: "auto", fontSize: 11.5, color: tk.ink3 }}>
                      {n.runs.length} {n.runs.length === 1 ? "run" : "runs"}
                      {counts.running > 0 && (
                        <span style={{ color: STATE_COLOR.running }}> · {counts.running} running</span>
                      )}
                      {attention > 0 && (
                        <span style={{ color: STATE_COLOR["needs-you"] }}> · {attention} need you</span>
                      )}
                    </div>
                  </div>
                </div>

                {/* The interior. Only exists once you have flown in. */}
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
        </div>
      </div>
    </div>
  );
}
