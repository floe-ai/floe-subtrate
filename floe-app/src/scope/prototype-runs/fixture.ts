/**
 * PROTOTYPE FIXTURE — throwaway. Not production data, not a bus call.
 *
 * Ticket: "One node, many runs" (#184) on map #166.
 *
 * REVISION 2, after the operator looked at revision 1:
 *
 *   1. "Review and rework doesn't really make sense as its own node — that
 *      would be the same step as draw each component. The last node would be
 *      do something with the asset, that's separate. Because if there is a
 *      review step we would need to go backwards in some cases."
 *
 *      So: iteration lives INSIDE a run. A step you would have to draw a
 *      backwards arrow to is the tell that it was never a separate step. The
 *      image pipeline is now: image lands -> draw each component (which
 *      includes its own review and rework) -> pack the approved set.
 *
 *   2. "Add the earlier documentation pipeline as a parallel graph in the same
 *      scope so we can see them side by side."
 *
 *      So: a scope holds MANY graphs. The second one below is the real
 *      documentation pipeline read off the running bus (scope `docs`,
 *      graph_e147ddbc) from #157 / PR #165 — trigger, writer, reviewer,
 *      command, approver.
 *
 *      Note what it proves: the writer and reviewer DO pass work back and
 *      forth, and there is still no backwards arrow — they emit to each other
 *      inside one run. That is the same claim as (1), arrived at from the
 *      other direction.
 */

export type RunState =
  /** an actor is working in it right now */
  | "running"
  /** nothing is happening and nothing is waiting — the common resting state */
  | "idle"
  /** an actor has asked for a person and will not proceed without one */
  | "needs-you"
  /** something went wrong inside the run */
  | "failed"
  /** the work this run existed to do produced its artifact */
  | "settled";

export type Run = {
  run_id: string;
  /** what this one run is about — never the node's name */
  label: string;
  state: RunState;
  /** minutes since the last event landed in it */
  age_min: number;
  /** actors currently assigned into the working space */
  actors: string[];
  /** last thing said, for previews */
  last: string;
  /**
   * How many times this run has been round the review loop. Iteration is a
   * property of a run, not a shape on the canvas — this is the claim on trial.
   */
  passes?: number;
  /** set when a run consumes many upstream artifacts — the fan-in case */
  gathers?: number;
};

export type NodeKind = "event" | "working-space" | "command";

export type Node = {
  node_id: string;
  kind: NodeKind;
  label: string;
  /** only a command declares a shape; a conversation has none */
  declares?: string;
  x: number;
  y: number;
  runs: Run[];
};

export type Graph = {
  graph_id: string;
  label: string;
  nodes: Node[];
  edges: Array<[string, string]>;
};

const COMPONENTS = [
  "hull plating", "cockpit glass", "thruster cowl", "landing strut", "cargo hatch",
  "antenna array", "wing root", "heat shield", "docking collar", "sensor blister",
  "fuel line", "airbrake", "reactor vent", "crew ladder", "nav light",
  "hatch seal", "grab rail", "coolant tank", "aerial mast", "step plate",
  "tow eye", "access panel", "gimbal ring", "strut brace", "intake lip",
  "vane cluster", "shroud ring", "tail fin", "skid pad", "pylon",
  "canopy rail", "blast door", "winch drum", "cable run", "junction box",
  "spar cap", "rib flange", "gusset", "fairing", "chine",
  "keel beam", "bulkhead", "stringer", "longeron", "former",
  "boss mount", "shear web", "doubler", "cleat", "grommet",
];

/** Deterministic pseudo-random so the fixture is stable between reloads. */
function seeded(i: number, mod: number): number {
  return (i * 2654435761) % mod;
}

// ---------------------------------------------------------------------------
// GRAPH 1 — the image pipeline, reshaped after the operator's note
// ---------------------------------------------------------------------------

/**
 * Fifty runs of the one drawing step. Review and rework are NOT downstream —
 * they happen inside each of these, which is why some are on their third pass.
 */
const drawRuns: Run[] = COMPONENTS.map((c, i) => {
  const roll = seeded(i, 100);
  let state: RunState;
  if (roll < 6) state = "needs-you";
  else if (roll < 10) state = "failed";
  else if (roll < 26) state = "running";
  else if (roll < 52) state = "idle";
  else state = "settled";

  const passes = 1 + seeded(i + 3, 3);

  const last =
    state === "needs-you"
      ? `Pass ${passes}: two readings of this component conflict — which do you want?`
      : state === "failed"
      ? "Render step exited 1: source asset missing."
      : state === "running"
      ? passes > 1
        ? `Critic sent it back — silhouette reads wrong. Pass ${passes} under way.`
        : "Blocking in the first pass now."
      : state === "settled"
      ? `Approved on pass ${passes}. Plate written to assets/concepts/.`
      : "Waiting on the critic to look again.";

  return {
    run_id: `run_draw_${i}`,
    label: c,
    state,
    age_min: seeded(i + 7, 900),
    actors: passes > 1 ? ["concept-artist", "critic"] : ["concept-artist"],
    last,
    passes,
  };
});

const imageGraph: Graph = {
  graph_id: "g_images",
  label: "Concept art pipeline",
  nodes: [
    {
      node_id: "n_image_lands",
      kind: "event",
      label: "A concept image lands",
      x: 60,
      y: 90,
      runs: [
        {
          run_id: "run_explode_1",
          label: "concept-ship-alpha.png",
          state: "settled",
          age_min: 902,
          actors: ["art-director"],
          last: "Split into 50 components. Handing each one downstream.",
        },
      ],
    },
    {
      node_id: "n_draw",
      kind: "working-space",
      // The name now says what the whole step is, iteration included.
      label: "Draw each component, until it is approved",
      x: 330,
      y: 90,
      runs: drawRuns,
    },
    {
      node_id: "n_pack",
      kind: "command",
      label: "Pack the approved set",
      declares: "in: approved plates · out: sprite sheet, exit code",
      x: 600,
      y: 90,
      runs: [
        {
          run_id: "run_pack_1",
          label: "Assemble the approved set",
          state: "idle",
          age_min: 41,
          actors: ["art-director"],
          last: "Holding until every component is approved. 34 of 50 in.",
          gathers: 50,
        },
      ],
    },
  ],
  edges: [
    ["n_image_lands", "n_draw"],
    ["n_draw", "n_pack"],
  ],
};

// ---------------------------------------------------------------------------
// GRAPH 2 — the real documentation pipeline, read off the running bus
// (workspace floe, scope `docs`, graph_e147ddbc — from #157 / PR #165)
// ---------------------------------------------------------------------------

const docsGraph: Graph = {
  graph_id: "g_docs",
  label: "Documentation pipeline",
  nodes: [
    {
      node_id: "note_arrived",
      kind: "event",
      label: "A note lands in docs/",
      x: 60,
      y: 330,
      runs: [
        {
          run_id: "run_note_1",
          label: "session-context-thread-model.md",
          state: "settled",
          age_min: 320,
          actors: ["folder watcher"],
          last: "docs.note.landed — docs/notes/session-context-thread-model.md",
        },
        {
          run_id: "run_note_2",
          label: "peer-contexts.md",
          state: "settled",
          age_min: 88,
          actors: ["folder watcher"],
          last: "docs.note.landed — docs/notes/peer-contexts.md",
        },
      ],
    },
    {
      node_id: "writer_node",
      kind: "working-space",
      label: "Writer drafts it",
      x: 330,
      y: 330,
      runs: [
        {
          run_id: "run_write_1",
          label: "session-context-thread-model.md",
          state: "settled",
          age_min: 300,
          actors: ["writer", "reviewer"],
          last: "Reviewer approved on the second pass. Handing to the check.",
          passes: 2,
        },
        {
          run_id: "run_write_2",
          label: "peer-contexts.md",
          state: "running",
          age_min: 6,
          actors: ["writer", "reviewer"],
          last: "Reviewer wants the invariant stated before the example. Revising.",
          passes: 3,
        },
      ],
    },
    {
      node_id: "reviewer_node",
      kind: "working-space",
      label: "Reviewer critiques it",
      x: 600,
      y: 330,
      runs: [
        {
          run_id: "run_review_1",
          label: "session-context-thread-model.md",
          state: "settled",
          age_min: 298,
          actors: ["reviewer", "writer"],
          last: "Approved. Emitted review.approved to docs_check.",
          passes: 2,
        },
        {
          run_id: "run_review_2",
          label: "peer-contexts.md",
          state: "needs-you",
          age_min: 4,
          actors: ["reviewer", "writer"],
          last: "This contradicts CONTEXT.md on thread_id. Change the doc or the invariant?",
          passes: 3,
        },
      ],
    },
    {
      node_id: "check_node",
      kind: "command",
      label: "Run the docs check",
      declares: "out: passed, exit_code, stdout, stderr",
      x: 870,
      y: 330,
      runs: [
        {
          run_id: "run_check_1",
          label: "vitest docs-structure.test.ts",
          state: "settled",
          age_min: 296,
          actors: ["docs_check"],
          last: "passed=true · exit_code 0 · 3 tests",
        },
      ],
    },
    {
      node_id: "approver_node",
      kind: "working-space",
      label: "Approver writes the file",
      x: 1140,
      y: 330,
      runs: [
        {
          run_id: "run_approve_1",
          label: "session-context-thread-model.md",
          state: "settled",
          age_min: 294,
          actors: ["approver"],
          last: "Wrote docs/plans/session-context-thread-model.md.",
        },
      ],
    },
  ],
  edges: [
    ["note_arrived", "writer_node"],
    ["writer_node", "reviewer_node"],
    ["reviewer_node", "check_node"],
    ["check_node", "approver_node"],
  ],
};

export const PROTOTYPE_GRAPHS: Graph[] = [imageGraph, docsGraph];

/** Flat view, for the variants that do not care which graph a node is in. */
export const ALL_NODES: Node[] = PROTOTYPE_GRAPHS.flatMap(g => g.nodes);

export function graphOf(nodeId: string): Graph {
  return PROTOTYPE_GRAPHS.find(g => g.nodes.some(n => n.node_id === nodeId))!;
}

export function nodeOf(nodeId: string): Node | null {
  return ALL_NODES.find(n => n.node_id === nodeId) ?? null;
}

export function findRun(runId: string): { run: Run; node: Node } | null {
  for (const n of ALL_NODES) {
    const run = n.runs.find(r => r.run_id === runId);
    if (run) return { run, node: n };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers — the only thing variants are allowed to agree on.
// ---------------------------------------------------------------------------

export const STATE_COLOR: Record<RunState, string> = {
  running: "#8aa89c",
  idle: "#62666d",
  "needs-you": "#d9a441",
  failed: "#b85a5a",
  settled: "#3f4a45",
};

export const STATE_LABEL: Record<RunState, string> = {
  running: "running",
  idle: "quiet",
  "needs-you": "needs you",
  failed: "failed",
  settled: "settled",
};

export const NODE_KIND_LABEL: Record<NodeKind, string> = {
  event: "event",
  "working-space": "working space",
  command: "command",
};

/** Runs that would make a person want to look. Everything else can stay folded. */
export function wantsAttention(r: Run): boolean {
  return r.state === "needs-you" || r.state === "failed";
}

export function countBy(runs: Run[]): Record<RunState, number> {
  const out: Record<RunState, number> = {
    running: 0, idle: 0, "needs-you": 0, failed: 0, settled: 0,
  };
  for (const r of runs) out[r.state] += 1;
  return out;
}

export function ago(min: number): string {
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.floor(min / 60)}h`;
  return `${Math.floor(min / 1440)}d`;
}

export const CANVAS_W = 1420;
export const CANVAS_H = 520;
export const NODE_W = 210;
