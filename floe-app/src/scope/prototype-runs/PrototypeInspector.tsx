/**
 * PROTOTYPE — throwaway. What the app's real right-hand aside shows when a
 * prototype node or run is selected.
 *
 * Revision 2, from the operator: "in a real environment I would expect it to
 * render in the second aside." So the drawer the prototype invented in
 * revision 1 is gone — the node's runs, and then one run's conversation, both
 * land here, in the inspector the app already has.
 *
 * Two levels, one panel:
 *   node selected -> the list of that node's runs
 *   run selected  -> that run's conversation, with a way back to the list
 */
import React, { useEffect, useState } from "react";
import { tk } from "../../theme.ts";
import { useExplain } from "./explain.tsx";
import {
  nodeOf, findRun, graphOf, runsForSubject,
  STATE_COLOR, STATE_LABEL, NODE_KIND_LABEL, wantsAttention, ago,
  type Run, type RunState,
} from "./fixture.ts";
import {
  getProtoSelection, setProtoSelection, subscribeProtoSelection,
  type ProtoSelection,
} from "./runSelection.ts";

export function useProtoSelection(): ProtoSelection {
  const [sel, setSel] = useState<ProtoSelection>(getProtoSelection);
  useEffect(() => subscribeProtoSelection(setSel), []);
  return sel;
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
        width: 7, height: 7, borderRadius: 7, flexShrink: 0, background: STATE_COLOR[run.state],
      }} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 12.5, color: tk.ink2, whiteSpace: "nowrap",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {run.label}
          {run.passes && run.passes > 1 && (
            <span style={{ color: tk.ink4, fontSize: 11 }}> · pass {run.passes}</span>
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

/** Level 1 — every run of the selected node. */
function NodeRuns({ nodeId }: { nodeId: string }): React.ReactElement | null {
  const node = nodeOf(nodeId);
  const [filter, setFilter] = useState<RunState | "all" | "attention">("all");
  if (!node) return null;

  const shown =
    filter === "all" ? node.runs
    : filter === "attention" ? node.runs.filter(wantsAttention)
    : node.runs.filter(r => r.state === filter);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ padding: "14px 16px 10px", borderBottom: `1px solid ${tk.border}`, flexShrink: 0 }}>
        <div style={{
          fontSize: 9.5, letterSpacing: "0.10em", textTransform: "uppercase",
          color: tk.ink4, marginBottom: 4,
        }}>
          {NODE_KIND_LABEL[node.kind]} · {graphOf(node.node_id).label}
        </div>
        <div style={{ fontSize: 13.5, color: tk.ink, fontWeight: 510 }}>{node.label}</div>
        {node.declares && (
          <div style={{ fontSize: 11, color: tk.ink4, marginTop: 3 }}>{node.declares}</div>
        )}
        <div style={{ fontSize: 11, color: tk.ink3, marginTop: 4 }}>
          {node.runs.length} {node.runs.length === 1 ? "run" : "runs"} of this node
        </div>
        <div style={{ display: "flex", gap: 4, marginTop: 10, flexWrap: "wrap" }}>
          {(["all", "attention", "running", "idle", "settled"] as const).map(f => {
            const n = f === "all" ? node.runs.length
              : f === "attention" ? node.runs.filter(wantsAttention).length
              : node.runs.filter(r => r.state === f).length;
            if (n === 0 && f !== "all") return null;
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
          <RunRow
            key={r.run_id}
            run={r}
            onClick={() => setProtoSelection({ nodeId, runId: r.run_id })}
          />
        ))}
        {shown.length === 0 && (
          <div style={{ padding: 20, fontSize: 12, color: tk.ink4 }}>Nothing here.</div>
        )}
      </div>
    </div>
  );
}

/** Level 2 — one run's conversation. */
function RunDetail({ runId, nodeId }: { runId: string; nodeId: string | null }): React.ReactElement | null {
  const explain = useExplain();
  const hit = findRun(runId);
  if (!hit) return null;
  const { run, node } = hit;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "12px 16px", borderBottom: `1px solid ${tk.border}`, flexShrink: 0,
      }}>
        <button
          onClick={() => setProtoSelection({ nodeId: nodeId ?? node.node_id, runId: null })}
          style={{
            background: "transparent", border: `1px solid ${tk.border}`, color: tk.ink2,
            borderRadius: tk.r2, padding: "4px 10px", fontSize: 11.5, cursor: "pointer",
            fontFamily: tk.fontUi, flexShrink: 0,
          }}
        >
          ← {node.runs.length} runs
        </button>
        <div style={{ minWidth: 0 }}>
          <div style={{
            fontSize: 13, color: tk.ink, fontWeight: 510,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {run.label}
          </div>
          <div style={{ fontSize: 10.5, color: tk.ink4 }}>
            one run of “{node.label}”
          </div>
        </div>
        <span style={{
          marginLeft: "auto", width: 8, height: 8, borderRadius: 8,
          background: STATE_COLOR[run.state], flexShrink: 0,
        }} />
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "14px 16px", minHeight: 0 }}>
        <div style={{ fontSize: 11, color: tk.ink4, marginBottom: 12 }}>
          {STATE_LABEL[run.state]} · {ago(run.age_min)} ago · {run.actors.join(", ")}
        </div>

        {run.called_by && (() => {
          const caller = findRun(run.called_by!);
          return (
            <div style={{
              border: `1px solid ${run.returning ? "#b85a5a" : tk.border}`,
              background: tk.surfaceSunk, borderRadius: tk.r2,
              padding: "8px 10px", marginBottom: 14, fontSize: 11.5,
              color: tk.ink3, lineHeight: 1.5,
            }}>
              {run.returning ? (
                <>
                  <strong style={{ color: "#b85a5a", fontWeight: 510 }}>
                    Failed · returning to caller
                  </strong>
                  {explain && (
                    <>
                      {" "}— a command has no reasoning of its own, so its result
                      returns to the run that called it and nowhere else:
                    </>
                  )}
                </>
              ) : (
                <span style={{ color: tk.ink4 }}>Called by</span>
              )}
              <div style={{ marginTop: 6 }}>
                <button
                  onClick={() => caller && setProtoSelection({
                    nodeId: caller.node.node_id, runId: caller.run.run_id,
                  })}
                  style={{
                    background: "transparent", border: `1px solid ${tk.border}`,
                    borderRadius: tk.r2, padding: "4px 9px", cursor: "pointer",
                    color: tk.ink2, fontSize: 11.5, fontFamily: tk.fontUi, textAlign: "left",
                  }}
                >
                  ↩ {caller ? `${caller.run.label} — in “${caller.node.label}”` : run.called_by}
                </button>
              </div>
              <div style={{ marginTop: 6, color: tk.ink4, display: explain ? "block" : "none" }}>
                Other documents are in flight at the same time. It returns to this
                one, because the caller is a <em>run</em>, not a node.
              </div>
            </div>
          );
        })()}

        {run.subject && runsForSubject(run.subject).length > 1 && (
          <div style={{
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r2, padding: "8px 10px", marginBottom: 14,
          }}>
            <div style={{ fontSize: 10.5, color: tk.ink4, marginBottom: 6 }}>
              This item across the pipeline
            </div>
            {runsForSubject(run.subject).map(({ run: r, node: n }) => (
              <div
                key={r.run_id}
                onClick={() => setProtoSelection({ nodeId: n.node_id, runId: r.run_id })}
                style={{
                  display: "flex", alignItems: "center", gap: 7, cursor: "pointer",
                  padding: "3px 0", fontSize: 11.5,
                  color: r.run_id === run.run_id ? tk.ink : tk.ink3,
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: 6, flexShrink: 0,
                  background: STATE_COLOR[r.state],
                }} />
                <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {n.label}
                </span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: tk.ink4, flexShrink: 0 }}>
                  {STATE_LABEL[r.state]}
                </span>
              </div>
            ))}
          </div>
        )}

        {run.passes && run.passes > 1 && (
          <div style={{
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r2, padding: "8px 10px", marginBottom: 14,
            fontSize: 11.5, color: tk.ink3, lineHeight: 1.5,
          }}>
            <strong style={{ color: tk.ink2, fontWeight: 510 }}>Pass {run.passes}</strong>
            {explain && (
              <>
                {" "}— review and rework happened <em>here</em>, inside this run; there
                is no second node and no arrow pointing backwards.
              </>
            )}
          </div>
        )}
        {run.gathers && (
          <div style={{
            border: `1px solid ${tk.border}`, background: tk.surfaceSunk,
            borderRadius: tk.r2, padding: "8px 10px", marginBottom: 14,
            fontSize: 11.5, color: tk.ink3, lineHeight: 1.5,
          }}>
            Reads {run.gathers} upstream artifacts
            {explain && (
              <>
                . Fan-in is a run that takes in many things — not a shape on the canvas.
              </>
            )}
          </div>
        )}

        {[
          { who: run.actors[0], text: run.last },
          { who: "you", text: "Looks close. Push the silhouette 10% wider and go again." },
          { who: run.actors[run.actors.length - 1], text: "Re-rendering — will write to assets/concepts/." },
        ].map((m, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, color: tk.ink4, marginBottom: 3 }}>{m.who}</div>
            <div style={{ fontSize: 12.5, color: tk.ink2, lineHeight: 1.5 }}>{m.text}</div>
          </div>
        ))}
      </div>

      <div style={{ padding: "10px 16px 14px", borderTop: `1px solid ${tk.border}`, flexShrink: 0 }}>
        <div style={{
          border: `1px solid ${tk.border}`, borderRadius: tk.r2, background: tk.surfaceSunk,
          padding: "9px 12px", fontSize: 12.5, color: tk.ink4,
        }}>
          Say something in this run…
        </div>
      </div>
    </div>
  );
}

export function PrototypeInspector(): React.ReactElement | null {
  const sel = useProtoSelection();
  if (sel.runId) return <RunDetail runId={sel.runId} nodeId={sel.nodeId} />;
  if (sel.nodeId) return <NodeRuns nodeId={sel.nodeId} />;
  return null;
}
