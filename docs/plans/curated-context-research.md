# Curated Context Between Agent Steps — Research

**Resolves:** [What curated context actually travels between nodes](https://github.com/floe-ai/floe-subtrate/issues/183)
**Raised while resolving:** [A scope holds its nodes](https://github.com/floe-ai/floe-subtrate/issues/179)
**Status:** findings only — no code change proposed here.

## Summary

ThoughtDAG is a **local-first desktop/web app** (not a library or framework) for humans to visually wire LLM conversation nodes into a DAG where edges determine what the model sees. It is philosophically aligned with floe's "each node reasons in its own context" direction but operates at a completely different layer — interactive human note-taking, not programmatic multi-agent orchestration. It has ~219 stars, MIT license, is actively maintained (pushed Aug 16 2026), but offers nothing floe could import as a dependency. The right move is to **reject ThoughtDAG as a dependency, optionally borrow its "wires are the context" framing as validation**, and codify a convention on floe's existing primitives.

---

## 1. ThoughtDAG — What It Actually Is

**Repo:** [chenxiachan/thoughtdag](https://github.com/chenxiachan/thoughtdag)

| Dimension | Detail |
|-----------|--------|
| **Type** | Electron + web desktop app (TypeScript, React Flow) |
| **Stars** | 219 |
| **Forks** | 27 |
| **License** | MIT |
| **Created** | 2026-02-17 |
| **Last push** | 2026-08-16 |
| **Open issues** | 2 |
| **Dependencies** | Node.js runtime, React Flow, any OpenAI-compatible LLM endpoint or Ollama |

**What it does:** ThoughtDAG is an infinite-canvas note-taking/thinking tool where each node is an LLM conversation turn. The user manually wires nodes together. When asking a question at a node, the model receives **only the content of ancestor nodes reachable through wires** — not the full conversation history. The tagline is "Wires are the context." Deleting an edge changes what the model sees; pruning noise edges yields different answers.

**What it is NOT:** It is not a library, not an SDK, not a framework, not a published paper, and not an agent orchestration runtime. It has no programmatic API for embedding. Its "integration" with coding agents is literally "point your agent at the `.thoughtdag.json` file on disk and ask it to read it." There is no inter-process protocol, no event system, no typed port abstraction.

**Runtime assumptions:** Single-process Electron app or Cloudflare Worker (hosted demo). One user, one canvas. The DAG is a UI construct stored as JSON. There is no concept of multiple agents, sessions, scopes, or distributed execution.

---

## 2. Does ThoughtDAG Map Onto Floe's Model?

**Short answer: No, not structurally.** The alignment is purely philosophical.

| ThoughtDAG concept | Floe equivalent | Compatible? |
|--------------------|-----------------|-------------|
| Node (a prompt+response pair) | Node (Actor/Command on a scope canvas) | Superficial only — ThoughtDAG nodes are human-authored conversation turns, not autonomous agents |
| Wire (determines LLM context) | Edge inferred from shared Context membership + event subscriptions | ThoughtDAG wires are explicit UI edges; floe's "wiring" is subscription-based participation in a Context |
| Canvas (the whole DAG) | Scope Graph (`ScopeGraphRecord`) | ThoughtDAG's canvas is interactive; floe's graph is prescriptive and fires autonomously |
| No shared context pool — each node sees only wired ancestors | Each node reasons in its own Context (the new direction) | ✅ **This is the real alignment** |

ThoughtDAG **validates the design direction** floe is already moving toward: nodes should not see everything, only what is deliberately wired to them. But ThoughtDAG achieves this through a UI gesture (the human draws/deletes edges), while floe must achieve it through typed inputs/outputs on edges and event content payloads — which it already has (`ScopeGraphCommandInput`, `ScopeGraphCommandOutput` — `floe-bus/src/scope-graphs.ts:62-83`).

**Adopting ThoughtDAG would mean:** nothing useful. There is no importable module. Floe cannot depend on it.

**Borrowing its convention:** The convention is "wires are the context" — the model sees exactly what travels along the edge, nothing more. Floe already implements this: a command node's inputs are resolved from the triggering event's `content` by `content_key` (`floe-bridge/src/command-runner.ts:57-68`), and its outputs are mapped from execution facts to named content keys (`floe-bridge/src/command-runner.ts:107-120`). The convention is already built. What's missing is extending it to actor nodes (not just commands) and formalizing what *shape* travels on the wire.

---

## 3. State of the Art — Passing Curated Context Between Agent Steps

### 3a. Explicit Typed Input/Output Schemas

**How it works:** Each node declares named inputs (with types/schemas) and named outputs. The orchestrator routes outputs to downstream inputs by name or by edge binding. This is what floe's command nodes already do.

- **Token cost:** Minimal — only declared fields travel. No wasted context.
- **Fidelity loss:** None *if* the schema is well-designed. The failure mode is the schema being too narrow (see §5).
- **How it fails:** The upstream node didn't think to emit something the downstream node needs. Requires human foresight at authoring time.
- **Examples:** Prefect, Dagster, Airflow (XComs), Azure Logic Apps, floe itself.

**Verdict:** Best default for deterministic pipelines. Already built in floe for commands; needs extension to actors.

### 3b. Summarisation / Compaction Hand-off

**How it works:** An intermediate step (or the upstream node itself) summarises its reasoning into a compact payload before passing downstream.

- **Token cost:** Dramatically reduced — that's the point.
- **Fidelity loss:** **High and unpredictable.** The summariser doesn't know what the downstream node will need. Over-summarisation destroys the detail that mattered (see §5).
- **How it fails:** Lossy by design. Critical nuances, caveats, and edge cases are the first things lost. The downstream agent acts on a confident-sounding summary that omits the uncertainty.
- **Examples:** LangChain's `ConversationSummaryMemory`, AutoGPT's memory compaction.

**Verdict:** Useful only when the downstream node genuinely needs a gist, not specifics. Should be opt-in per edge, never default.

### 3c. Blackboard / Shared-Memory Architecture

**How it works:** All agents read/write to a shared mutable store. Each agent takes what it needs.

- **Token cost:** Depends on how much each agent reads from the blackboard. Can be enormous if agents read everything.
- **Fidelity loss:** Low (data is there), but **coherence risk** is high — agents may read stale or partially-updated state.
- **How it fails:** Contention, ordering bugs, agents reading data written for someone else (the exact problem floe is moving away from). The "one shared context" anti-pattern.
- **Examples:** Classic AI blackboard systems, CrewAI's shared memory, some BabyAGI variants.

**Verdict:** This is what floe is deliberately leaving behind. Reject.

### 3d. Artifact / File-Based Hand-off

**How it works:** The upstream node writes a file (code, data, report) to a workspace. The downstream node reads it.

- **Token cost:** Zero on the wire. The downstream node pays to read the file into its context, but only when needed.
- **Fidelity loss:** Zero — the full artifact is preserved.
- **How it fails:** Staleness (see §4, §5). The file may describe a world that has moved on. No notification mechanism unless coupled with an event.
- **Examples:** Any CI/CD pipeline with artifact stores, GitHub Actions artifacts, floe's workspace files.

**Verdict:** Best for large, durable, cross-scope outputs. See §4 for when it beats a parameter.

### 3e. RAG Over Prior Step Outputs

**How it works:** Prior outputs are indexed (embedded); downstream nodes retrieve relevant chunks via semantic search.

- **Token cost:** Moderate — retrieval is selective, but embedding + retrieval adds latency and infra.
- **Fidelity loss:** **Moderate to high.** Retrieval is probabilistic; relevant context can be missed entirely. Chunk boundaries split coherent arguments.
- **How it fails:** Missed retrieval (the relevant chunk wasn't in top-k), hallucination from partial context, embedding drift across model versions.
- **Examples:** LlamaIndex agent pipelines, Semantic Kernel memory, various "long-term memory" agent frameworks.

**Verdict:** Useful when there are many prior outputs and the downstream node can't predict which it needs. Overkill for a pipeline where the graph author knows the data flow.

### 3f. "Ask the Upstream Agent" / Agent-to-Agent Query

**How it works:** A downstream node, finding it lacks information, spins up a side conversation with the upstream node (or a specialist) to ask for it.

- **Token cost:** High — a full LLM round-trip per query, potentially multiple.
- **Fidelity loss:** **Lowest possible** — the upstream agent can provide exactly what's needed, with nuance.
- **How it fails:** Latency, cost, and the upstream agent may no longer have its original session context (ephemeral sessions). If the upstream agent must re-derive the answer, it may give a different one.
- **Examples:** AutoGen's agent chat, floe's existing "peer context" pattern (an actor spinning up an independent context with another actor).

**Verdict:** Excellent escape hatch for unanticipated information needs. Floe already supports this. Should remain available but not be the primary hand-off mechanism.

---

## 4. Where Does a File Beat a Parameter?

| Dimension | Parameter (event content) | File (workspace artifact) |
|-----------|--------------------------|---------------------------|
| **Size** | Best for small, structured data (<4KB). Large payloads bloat event storage and bus traffic. | No size limit. Code files, reports, datasets — file wins. |
| **Durability** | Ephemeral — lives in the event stream, queryable but not designed for long-term reference. | Durable — persists in workspace, versioned by git, survives scope/graph changes. |
| **Cross-scope reach** | Limited to the context the event was emitted into. Another scope's actor can't see it without explicit forwarding. | Any node in the workspace (or synced workspaces) can read the file path. Cross-scope and cross-workspace by default. |
| **Human reviewability** | Requires tooling to inspect event payloads. Not naturally browsable. | A file in a repo. Humans review it with standard tools. PR-reviewable. |
| **Staleness / drift** | Represents a point-in-time snapshot. Downstream node knows it's reading "what was emitted." | **Can drift.** The file may describe code that has since changed. No built-in invalidation unless coupled with a file-change event trigger. |

**Rule of thumb:**
- **Use a parameter** when the data is small, structured, needed immediately by the next node, and has no life beyond this execution.
- **Use a file** when the output is large, needs human review, must be reachable from other scopes/workspaces, or must persist beyond the current graph run.
- **Emit a parameter pointing to a file** when both apply — the event content carries `{artifact_path: "reports/analysis.md"}` and the downstream node reads the file.

---

## 5. What Goes Wrong in Practice

### 5a. Lossy Hand-off
The upstream node emits a summary; the downstream node acts on it as though it were complete. A test-runner node reports "3 tests failed" without the stack traces; the fix-suggesting node hallucinates a cause. **Mitigation:** Prefer structured, complete payloads. If summarising, include a `detail_path` pointing to the full output file.

### 5b. Unanticipated Information Needs
The graph author wired `stdout` from a lint step to a fix step but didn't wire `stderr`, where the actual error was. The fix step has no way to know `stderr` existed. **Mitigation:** Default to emitting all execution facts (floe already does this — `floe-bridge/src/command-runner.ts:112-117` emits all four facts when no outputs are declared). Make "declare outputs" an opt-in narrowing, not a mandatory gate.

### 5c. Artifact Staleness
A code-analysis node writes `analysis.md` describing the codebase as of commit `abc123`. A later node reads it after the code has changed. The analysis is confidently wrong. **Mitigation:** Stamp artifacts with the commit/timestamp they describe. File-change event triggers can invalidate downstream nodes (ThoughtDAG calls this "staleness & replay" — marking answers whose upstream inputs have changed).

### 5d. Over-Summarisation
A research node produces 2000 words of nuanced analysis. A compaction step reduces it to 3 bullet points. The downstream decision node picks the wrong option because the caveats were in the deleted paragraphs. **Mitigation:** Never auto-summarise without the graph author's explicit opt-in. When summarising, preserve uncertainty markers and caveats as first-class fields, not prose.

### 5e. Context Window Overflow from Accumulation
In a long chain (A→B→C→D→E), each node naively passes its full output plus all upstream outputs. By node E the context window is full. **Mitigation:** The "each node reasons in its own context" model prevents this by design — each node sees only what's on its incoming edges, not the transitive closure.

---

## 6. Recommendation

### ThoughtDAG: Reject as Dependency, Acknowledge as Validation

ThoughtDAG is a consumer note-taking app with 219 stars. It offers no importable library, no API, no protocol. Depending on it would mean depending on nothing — there is nothing to import. However, its core principle — **"wires are the context; the model sees exactly what wires into the node"** — is a clean articulation of the design direction floe is already pursuing. Cite it as prior art in the design doc if desired, but do not adopt it.

### What Floe Should Do: Codify a Convention on Existing Primitives

Floe already has the primitives:

1. **Events with typed content payloads** — the wire (`floe-bus/src/scope-graphs.ts:62-83`, `floe-bridge/src/command-runner.ts:19-30`)
2. **Destination contexts per node** — the isolation (`floe-bus/src/scope-graphs.ts:96-97`)
3. **Workspace files** — the durable artifact layer
4. **Peer contexts** — the escape hatch for unanticipated needs

The convention to codify:

| Principle | Implementation |
|-----------|---------------|
| **Each node reasons in its own context.** | Already the new direction. No shared context bloat. |
| **Knowledge travels on the wire as a typed payload.** | Extend the existing `inputs`/`outputs` pattern from command nodes to actor nodes. An actor node declares what content keys it reads from incoming events and what it emits. |
| **Default to emitting everything; narrow by declaration.** | When no outputs are declared, emit the full result. Declared outputs are an opt-in lens, not a gate. (Already true for commands.) |
| **Large or durable outputs go to files; the wire carries the path.** | Convention: if a content value exceeds ~4KB or needs cross-scope reach, write a file and emit `{artifact_path, artifact_type, source_commit?}`. |
| **Staleness is tracked by provenance.** | Every artifact carries a timestamp and optional source commit. File-change triggers can invalidate downstream nodes. |
| **The "ask" escape hatch remains available.** | When a node needs something not on its wires, it can spin up a peer context. This is already built. |

**This is a convention, not a new dependency.** No new package, no new abstraction, no new envelope type on the bus. The scope-graph schema gains `inputs`/`outputs` on actor nodes (mirroring what command nodes already have), and the team documents the file-vs-parameter heuristic above.
