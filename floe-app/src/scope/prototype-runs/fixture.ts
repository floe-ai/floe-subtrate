/**
 * PROTOTYPE FIXTURE — throwaway. Not production data, not a bus call.
 *
 * Ticket: "One node, many runs" (#184) on map #166.
 *
 * REVISION 3, after the operator pushed back on revision 2. Two things:
 *
 *   1. A DETERMINISTIC STEP NEEDS A WAY BACK.
 *      "If it's a deterministic step, on failure it kind of needs to go back to
 *      a working space and reinject it into the context that it originally came
 *      from. So if there's five documents, it can't mistakenly go back to the
 *      context for another document."
 *
 *      Modelled here WITHOUT a new primitive: a command run is not a free-
 *      standing run, it is a CALL MADE BY the working-space run that invoked it
 *      (`called_by`). So its result has exactly one place to return to — its
 *      caller — and five documents cannot cross wires, because the return is
 *      per-RUN, not per-NODE. The return path is the SAME edge, travelled
 *      backwards; it is drawn dashed so you can see the shape, and it lights up
 *      when a run is actually coming back.
 *
 *   2. THE CANVAS HAS TO BRANCH AND CONVERGE.
 *      "There might be a split — one node writes the documentation, the other
 *      generates an image to support it — and they converge later, where an LLM
 *      puts the image in the documentation, then a deterministic validation,
 *      then it's saved."
 *
 *      That is graph 3 below, built to the operator's description. Branching and
 *      converging are just edges: a node with two out-edges, a node with two
 *      in-edges. No new node kind.
 *
 *      And the OTHER kind of many-ness — fifty assets each following the same
 *      path — is tracked with `subject`. Two runs at different nodes with the
 *      same subject are the same item at different steps, which is what makes
 *      "follow this one through the pipeline" possible without inventing a
 *      lane, a swimlane, or a branch primitive.
 */

export type RunState =
  | "running"
  | "idle"
  | "needs-you"
  | "failed"
  | "settled";

export type Run = {
  run_id: string;
  /** what this one run is about — never the node's name */
  label: string;
  /**
   * The ITEM this run concerns. Runs sharing a subject across different nodes
   * are the same thing at different steps — this is what makes a fan-out
   * followable, and it is just data on a run, not a new primitive.
   */
  subject?: string;
  state: RunState;
  age_min: number;
  actors: string[];
  last: string;
  /** how many times this run has been round its own review loop */
  passes?: number;
  /** a run that consumes many upstream artifacts — the fan-in case */
  gathers?: number;
  /**
   * Set on a COMMAND run: the working-space run that invoked it. A command has
   * no reasoning of its own, so its result returns here and nowhere else.
   */
  called_by?: string;
  /** this run's result is on its way back to its caller right now */
  returning?: boolean;
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

export type Edge = {
  from: string;
  to: string;
  /**
   * flow   — work moving forward
   * return — where a command's failure goes back to. NOT a second edge the
   *          operator draws: it is implied by `called_by`, and shown so the
   *          shape is visible.
   */
  kind: "flow" | "return";
  /** e.g. "×50" or "50 → 1" — makes fan-out and fan-in legible at a glance */
  multiplicity?: string;
};

export type Graph = {
  graph_id: string;
  label: string;
  nodes: Node[];
  edges: Edge[];
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

function seeded(i: number, mod: number): number {
  return (i * 2654435761) % mod;
}

// ---------------------------------------------------------------------------
// GRAPH 1 — volume. One step, fifty runs. Review lives inside each run.
// ---------------------------------------------------------------------------

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
    state === "needs-you" ? `Pass ${passes}: two readings of this component conflict — which do you want?`
    : state === "failed" ? "Render step exited 1: source asset missing."
    : state === "running"
      ? passes > 1
        ? `Critic sent it back — silhouette reads wrong. Pass ${passes} under way.`
        : "Blocking in the first pass now."
    : state === "settled" ? `Approved on pass ${passes}. Plate written to assets/concepts/.`
    : "Waiting on the critic to look again.";

  return {
    run_id: `run_draw_${i}`,
    label: c,
    subject: c,
    state,
    age_min: seeded(i + 7, 900),
    actors: passes > 1 ? ["concept-artist", "critic"] : ["concept-artist"],
    last,
    passes,
  };
});

const imageGraph: Graph = {
  graph_id: "g_images",
  label: "Concept art — one step, fifty runs",
  nodes: [
    {
      node_id: "n_image_lands", kind: "event", label: "A concept image lands",
      x: 60, y: 90,
      runs: [{
        run_id: "run_explode_1", label: "concept-ship-alpha.png", subject: "concept-ship-alpha.png",
        state: "settled", age_min: 902, actors: ["art-director"],
        last: "Split into 50 components. Handing each one downstream.",
      }],
    },
    {
      node_id: "n_draw", kind: "working-space",
      label: "Draw each component, until it is approved",
      x: 360, y: 90, runs: drawRuns,
    },
    {
      node_id: "n_pack", kind: "command", label: "Pack the approved set",
      declares: "in: approved plates · out: sprite sheet, exit code",
      x: 660, y: 90,
      runs: [{
        run_id: "run_pack_1", label: "Assemble the approved set",
        state: "idle", age_min: 41, actors: ["art-director"],
        last: "Holding until every component is approved. 34 of 50 in.",
        gathers: 50,
      }],
    },
  ],
  edges: [
    { from: "n_image_lands", to: "n_draw", kind: "flow", multiplicity: "1 → 50" },
    { from: "n_draw", to: "n_pack", kind: "flow", multiplicity: "50 → 1" },
    { from: "n_pack", to: "n_draw", kind: "return" },
  ],
};

// ---------------------------------------------------------------------------
// GRAPH 2 — the real documentation pipeline, read off the running bus
// (workspace floe, scope `docs`, graph_e147ddbc — from #157 / PR #165)
// ---------------------------------------------------------------------------

const docsGraph: Graph = {
  graph_id: "g_docs",
  label: "Documentation pipeline (the real one, from #157)",
  nodes: [
    {
      node_id: "note_arrived", kind: "event", label: "A note lands in docs/",
      x: 60, y: 330,
      runs: [
        { run_id: "run_note_1", label: "session-context-thread-model.md", subject: "session-context-thread-model.md",
          state: "settled", age_min: 320, actors: ["folder watcher"],
          last: "docs.note.landed — docs/notes/session-context-thread-model.md" },
        { run_id: "run_note_2", label: "peer-contexts.md", subject: "peer-contexts.md",
          state: "settled", age_min: 88, actors: ["folder watcher"],
          last: "docs.note.landed — docs/notes/peer-contexts.md" },
      ],
    },
    {
      node_id: "writer_node", kind: "working-space", label: "Writer drafts it",
      x: 360, y: 330,
      runs: [
        { run_id: "run_write_1", label: "session-context-thread-model.md", subject: "session-context-thread-model.md",
          state: "settled", age_min: 300, actors: ["writer", "reviewer"], passes: 2,
          last: "Reviewer approved on the second pass. Handing to the check." },
        { run_id: "run_write_2", label: "peer-contexts.md", subject: "peer-contexts.md",
          state: "running", age_min: 6, actors: ["writer", "reviewer"], passes: 3,
          last: "Reviewer wants the invariant stated before the example. Revising." },
      ],
    },
    {
      node_id: "reviewer_node", kind: "working-space", label: "Reviewer critiques it",
      x: 660, y: 330,
      runs: [
        { run_id: "run_review_1", label: "session-context-thread-model.md", subject: "session-context-thread-model.md",
          state: "settled", age_min: 298, actors: ["reviewer", "writer"], passes: 2,
          last: "Approved. Emitted review.approved to docs_check." },
        { run_id: "run_review_2", label: "peer-contexts.md", subject: "peer-contexts.md",
          state: "needs-you", age_min: 4, actors: ["reviewer", "writer"], passes: 3,
          last: "This contradicts CONTEXT.md on thread_id. Change the doc or the invariant?" },
      ],
    },
    {
      node_id: "check_node", kind: "command", label: "Run the docs check",
      declares: "out: passed, exit_code, stdout, stderr",
      x: 960, y: 330,
      runs: [
        { run_id: "run_check_1", label: "vitest docs-structure.test.ts", subject: "session-context-thread-model.md",
          state: "settled", age_min: 296, actors: ["docs_check"], called_by: "run_review_1",
          last: "passed=true · exit_code 0 · 3 tests" },
      ],
    },
    {
      node_id: "approver_node", kind: "working-space", label: "Approver writes the file",
      x: 1260, y: 330,
      runs: [
        { run_id: "run_approve_1", label: "session-context-thread-model.md", subject: "session-context-thread-model.md",
          state: "settled", age_min: 294, actors: ["approver"],
          last: "Wrote docs/plans/session-context-thread-model.md." },
      ],
    },
  ],
  edges: [
    { from: "note_arrived", to: "writer_node", kind: "flow" },
    { from: "writer_node", to: "reviewer_node", kind: "flow" },
    { from: "reviewer_node", to: "check_node", kind: "flow" },
    { from: "check_node", to: "approver_node", kind: "flow" },
    { from: "check_node", to: "reviewer_node", kind: "return" },
  ],
};

// ---------------------------------------------------------------------------
// GRAPH 3 — the operator's branching example, built to their description.
//
//   a doc lands
//     -> write the documentation      -> validate the document  \
//     -> generate a supporting image  -> validate the image     /  converge
//        -> put the image in the doc -> final format check -> save it
//
// Three documents are in flight at once. Two command runs have FAILED and are
// on their way back to the exact run that called them — watch that they go to
// their own document and not another one.
// ---------------------------------------------------------------------------

const DOCS = ["peer-contexts.md", "adr-0008.md", "zero-poll.md"];

const branchGraph: Graph = {
  graph_id: "g_branch",
  label: "Doc + image — a split that converges",
  nodes: [
    {
      node_id: "b_lands", kind: "event", label: "A doc lands",
      x: 60, y: 640,
      runs: DOCS.map((d, i) => ({
        run_id: `b_land_${i}`, label: d, subject: d,
        state: "settled" as RunState, age_min: 200 - i * 40, actors: ["folder watcher"],
        last: `docs.note.landed — docs/notes/${d}`,
      })),
    },
    {
      node_id: "b_write", kind: "working-space", label: "Write the documentation",
      x: 360, y: 560,
      runs: [
        { run_id: "b_write_0", label: DOCS[0], subject: DOCS[0], state: "running", age_min: 3,
          actors: ["writer", "reviewer"], passes: 2,
          last: "Format check came back failed — fixing the heading levels it flagged." },
        { run_id: "b_write_1", label: DOCS[1], subject: DOCS[1], state: "settled", age_min: 62,
          actors: ["writer"], passes: 1, last: "Draft approved. Handed to the format check." },
        { run_id: "b_write_2", label: DOCS[2], subject: DOCS[2], state: "idle", age_min: 30,
          actors: ["writer"], passes: 1, last: "Waiting on the reviewer to look." },
      ],
    },
    {
      node_id: "b_image", kind: "working-space", label: "Generate a supporting image",
      x: 360, y: 760,
      runs: [
        { run_id: "b_image_0", label: DOCS[0], subject: DOCS[0], state: "settled", age_min: 40,
          actors: ["illustrator"], passes: 1, last: "Diagram exported at 2400px. Handed to the image check." },
        { run_id: "b_image_1", label: DOCS[1], subject: DOCS[1], state: "running", age_min: 2,
          actors: ["illustrator"], passes: 3,
          last: "Image check rejected the colour profile — re-exporting as sRGB." },
        { run_id: "b_image_2", label: DOCS[2], subject: DOCS[2], state: "needs-you", age_min: 12,
          actors: ["illustrator"], passes: 1,
          last: "No obvious subject for a diagram here. Do you want one at all?" },
      ],
    },
    {
      node_id: "b_valdoc", kind: "command", label: "Validate the document",
      declares: "out: passed, exit_code, stdout, stderr",
      x: 660, y: 560,
      runs: [
        { run_id: "b_valdoc_0", label: DOCS[0], subject: DOCS[0], state: "failed", age_min: 4,
          actors: ["docs_check"], called_by: "b_write_0", returning: true,
          last: "passed=false · heading levels skip from h2 to h4 (line 31)." },
        { run_id: "b_valdoc_1", label: DOCS[1], subject: DOCS[1], state: "settled", age_min: 60,
          actors: ["docs_check"], called_by: "b_write_1", last: "passed=true · exit_code 0" },
      ],
    },
    {
      node_id: "b_valimg", kind: "command", label: "Validate the image",
      declares: "out: passed, exit_code, stdout, stderr",
      x: 660, y: 760,
      runs: [
        { run_id: "b_valimg_0", label: DOCS[0], subject: DOCS[0], state: "settled", age_min: 38,
          actors: ["image_check"], called_by: "b_image_0", last: "passed=true · sRGB, 2400px" },
        { run_id: "b_valimg_1", label: DOCS[1], subject: DOCS[1], state: "failed", age_min: 3,
          actors: ["image_check"], called_by: "b_image_1", returning: true,
          last: "passed=false · colour profile is Display P3, expected sRGB." },
      ],
    },
    {
      node_id: "b_place", kind: "working-space", label: "Put the image in the doc",
      x: 960, y: 640,
      runs: [
        { run_id: "b_place_1", label: DOCS[1], subject: DOCS[1], state: "idle", age_min: 55,
          actors: ["writer"], gathers: 2,
          last: "Document is clean. Holding for the image to pass its check." },
      ],
    },
    {
      node_id: "b_final", kind: "command", label: "Final format check",
      declares: "out: passed, exit_code, stdout, stderr",
      x: 1260, y: 640,
      runs: [
        { run_id: "b_final_1", label: DOCS[1], subject: DOCS[1], state: "failed", age_min: 9,
          actors: ["docs_check"], called_by: "b_place_1", returning: true,
          last: "passed=false · image reference resolves outside docs/." },
      ],
    },
    {
      node_id: "b_save", kind: "command", label: "Save it where it belongs",
      declares: "in: approved doc · out: exit code",
      x: 1560, y: 640,
      runs: [],
    },
  ],
  edges: [
    { from: "b_lands", to: "b_write", kind: "flow" },
    { from: "b_lands", to: "b_image", kind: "flow" },
    { from: "b_write", to: "b_valdoc", kind: "flow" },
    { from: "b_image", to: "b_valimg", kind: "flow" },
    { from: "b_valdoc", to: "b_place", kind: "flow" },
    { from: "b_valimg", to: "b_place", kind: "flow", multiplicity: "2 → 1" },
    { from: "b_place", to: "b_final", kind: "flow" },
    { from: "b_final", to: "b_save", kind: "flow" },
    // The three ways back. Each returns to the RUN that called it.
    { from: "b_valdoc", to: "b_write", kind: "return" },
    { from: "b_valimg", to: "b_image", kind: "return" },
    { from: "b_final", to: "b_place", kind: "return" },
  ],
};

export const PROTOTYPE_GRAPHS: Graph[] = [imageGraph, docsGraph, branchGraph];

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

/** Every run of the same item, across every node — the lineage of one thing. */
export function runsForSubject(subject: string): Array<{ run: Run; node: Node }> {
  const out: Array<{ run: Run; node: Node }> = [];
  for (const n of ALL_NODES) {
    for (const r of n.runs) if (r.subject === subject) out.push({ run: r, node: n });
  }
  return out;
}

/** Subjects worth offering as a "follow this one" — those spanning >1 node. */
export function followableSubjects(graph: Graph): string[] {
  const counts = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    for (const r of n.runs) {
      if (!r.subject) continue;
      if (!counts.has(r.subject)) counts.set(r.subject, new Set());
      counts.get(r.subject)!.add(n.node_id);
    }
  }
  return [...counts.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
}

/** Runs currently on their way back to whoever called them. */
export function returningRuns(): Array<{ run: Run; node: Node }> {
  const out: Array<{ run: Run; node: Node }> = [];
  for (const n of ALL_NODES) {
    for (const r of n.runs) if (r.returning) out.push({ run: r, node: n });
  }
  return out;
}

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

export const CANVAS_W = 1820;
export const CANVAS_H = 900;
export const NODE_W = 210;
export const RETURN_COLOR = "#b85a5a";
