/**
 * PROTOTYPE FIXTURE — throwaway. Not production data, not a bus call.
 *
 * Ticket: "One node, many runs" (#184) on map #166.
 *
 * The worked example from the operator: a three-node pipeline —
 *   explode a concept image into components
 *     -> for each component, create a concept image
 *       -> review, provide feedback and rework
 *
 * Three nodes. Fifty conversations. The whole point of the prototype is to see
 * whether the canvas and the running system still describe the same thing.
 *
 * Candidate model under test (from #179):
 *   A node is the work to be done. A context is one run of it.
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
  /** set when this run was re-opened by a downstream review — the loop-back case */
  reworked_from?: string;
  /** set when a run consumes many upstream artifacts — the fan-in case */
  gathers?: number;
};

export type NodeKind = "event" | "working-space" | "command";

export type Node = {
  node_id: string;
  kind: NodeKind;
  label: string;
  x: number;
  y: number;
  runs: Run[];
};

const ACTORS = ["art-director", "concept-artist", "critic"];

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

function makeRun(i: number, label: string, prefix: string): Run {
  const roll = seeded(i, 100);
  let state: RunState;
  if (roll < 6) state = "needs-you";
  else if (roll < 10) state = "failed";
  else if (roll < 22) state = "running";
  else if (roll < 55) state = "idle";
  else state = "settled";

  const last =
    state === "needs-you" ? "Two readings of this component conflict — which do you want?"
    : state === "failed" ? "Render step exited 1: source asset missing."
    : state === "running" ? "Sketching the third pass now."
    : state === "settled" ? "Final plate written to assets/concepts/."
    : "Waiting on the reviewer.";

  return {
    run_id: `${prefix}_${i}`,
    label,
    state,
    age_min: seeded(i + 7, 900),
    actors: [ACTORS[seeded(i, 3)]],
    last,
  };
}

/** Node 1: the event that starts the whole thing. One run — it fired once. */
const explodeRuns: Run[] = [
  {
    run_id: "run_explode_1",
    label: "concept-ship-alpha.png",
    state: "settled",
    age_min: 902,
    actors: ["art-director"],
    last: "Split into 50 components. Handing each one downstream.",
  },
];

/** Node 2: fifty runs. This is the node the whole ticket is about. */
const renderRuns: Run[] = COMPONENTS.map((c, i) => makeRun(i, c, "run_render"));

/**
 * Node 3: only some components have reached review yet, so this node has fewer
 * runs than the one before it — the counts along a pipeline do not match, and
 * that is the honest picture.
 *
 * Three of them were sent back for rework: under the model on trial, that is
 * simply a context that has not finished, NOT an arrow pointing backwards.
 * One of them gathers fifty upstream artifacts — the fan-in case.
 */
const reviewRuns: Run[] = [
  ...COMPONENTS.slice(0, 18).map((c, i) => {
    const r = makeRun(i + 200, c, "run_review");
    if (i === 2 || i === 7 || i === 13) {
      return {
        ...r,
        state: "running" as RunState,
        last: "Silhouette reads as a fuel line, not a strut. Reworking against note 3.",
        reworked_from: `run_render_${i}`,
      };
    }
    return r;
  }),
  {
    run_id: "run_assemble_set",
    label: "Assemble the approved set",
    state: "idle",
    age_min: 41,
    actors: ["art-director"],
    last: "Holding until every component is approved. 34 of 50 in.",
    gathers: 50,
  },
];

export const PROTOTYPE_NODES: Node[] = [
  {
    node_id: "n_source",
    kind: "event",
    label: "A concept image lands",
    x: 60,
    y: 170,
    runs: explodeRuns,
  },
  {
    node_id: "n_render",
    kind: "working-space",
    label: "Draw each component",
    x: 380,
    y: 170,
    runs: renderRuns,
  },
  {
    node_id: "n_review",
    kind: "working-space",
    label: "Review and rework",
    x: 700,
    y: 170,
    runs: reviewRuns,
  },
];

export const PROTOTYPE_EDGES: Array<[string, string]> = [
  ["n_source", "n_render"],
  ["n_render", "n_review"],
];

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

export const NODE_KIND_LABEL: Record<NodeKind, string> = {
  event: "event",
  "working-space": "working space",
  command: "command",
};
