# Floe thought log

Purpose: concise, context-dense capture of project-specific brain-dump notes. Entries should preserve enough context to reconstruct the idea even if chat history is lost, while avoiding filler and duplicate phrasing.

## Agent self-evolution and substrate-first capability design

- When a Floe agent or actor is asked to build something, it should reason from first principles before creating a capability or extension. The agent should identify the underlying reusable substrate primitive(s), rather than immediately building a narrow product-specific extension.
- Example: if a user asks for stock-market analysis charts, the agent should not default to building a “stock market extension”. It should ask what generic capabilities are actually needed: rendering charts, representing structured data/results, connecting data sources, refreshing outputs, and exposing those outputs through surfaces.
- New capabilities should remain substrate-centred and usable without FloeWeb. FloeWeb can provide visual rendering/configuration, but the underlying extension or primitive should still work through the substrate alone, producing artefacts, events, render specs, files, or other non-web outputs.
- Floe’s self-evolution should add generic substrate primitives or composable extensions, not progressively prescribe more product semantics. Expansion should keep Floe flexible by deriving reusable capabilities from concrete requests.
- A lightweight capability design review may be useful before agents scaffold/install extensions: capture the user request, the stripped-back underlying need, proposed substrate primitive(s), surface/UI implications, non-web execution path, and a rejection check for whether the proposal is becoming too narrow or product-specific.

## Agent codebase stewardship and architecture coherence

- Floe agents that maintain or modify a codebase must act as professional codebase stewards, not opportunistic patchers. They should preserve architecture, organisation, maintainability, and long-term coherence while working toward the shared system goal.
- Agents should avoid “hacking code wherever it fits”. Before making changes, they should understand the surrounding architecture, existing patterns, ownership boundaries, and how the change keeps the system aligned rather than creating isolated fixes.
- Agent-led development should include best-practice engineering discipline: seeing the forest as well as the trees, keeping implementation details consistent with the broader architecture, and ensuring multiple agents can collaborate without fragmenting the project.
- The standard should be a high-quality, organised, professional project/codebase regardless of whether agents are building Floe itself, an extension, or another user project.

## Thought-log operating rule

- After each user note, capture the durable project-relevant insight, not just the meta-instruction.
- Shorten filler into compact meaning without losing nuance.
- Merge with nearby/adjacent ideas when the note reframes an existing point.
- Add a new line item only when the idea is genuinely distinct.
- Keep the log grouped and maintainable rather than chronological by default.

## ADLC reference for agent-safe development

- Reference to revisit: YouTube video https://youtu.be/aMBQB_IJ0dQ about ADLC as an agent-focused replacement or evolution of SDLC. The video should be treated as a source of ideas for how Floe agents are built, measured, evaluated, governed, and safely evolved.
- High-level takeaway to preserve: Floe should learn from ADLC-style pipelines where agentic systems are not shipped like fixed software alone; they need lifecycle support for design, evaluation, measurement, observability, governance, and continuous improvement.
- Relevance to Floe: ADLC maps strongly to Floe’s need for safe self-evolution. If agents can build/modify capabilities and codebases, the substrate should eventually support repeatable review, evaluation, audit, and release patterns for agent-created work.
- Adjacent to existing principles: ADLC should complement first-principles capability design and agent codebase stewardship. It can provide the development/evaluation pipeline around those principles, helping prevent agents from making unmeasured, ungoverned, or architecture-breaking changes.

## Continuous improvement through embedded evaluation

- Floe should bake evaluation into normal work so agents, humans, and other actors can continuously improve the system, its outputs, products, projects, and knowledge base.
- Because Floe treats agents and humans as actors, evaluation should support actor-to-actor feedback: humans can evaluate agent outputs, agents can evaluate their own and each other’s work, and feedback can become structured learning rather than disappearing into chat history.
- Feedback should be available wherever work happens, not only in chat. FloeWeb could allow a user to select any element/result/block and attach feedback such as “this looks incorrect; investigate the cause and prevent recurrence”.
- Evaluation patterns can include free-text feedback, thumbs up/down, choosing between generated alternatives, review notes on prototypes, quality checks on knowledge-base entries, and retrospective assessments after agent work.
- Short principle: Continuous improvement in Floe requires evaluation to be embedded at every work surface and artefact, so actor feedback becomes structured signal for agent learning, correction, and safer self-improvement.

## Scoped agent execution through working directories

- Floe agents and sub-agents should be launched with the smallest useful working context, often by setting their current working directory to the relevant repository/workspace subdirectory for the task.
- Directory-scoped execution helps agents stay focused on the module or area they are modifying, reduces noisy context retrieval, and prevents large codebases/workspaces from overwhelming the agent with irrelevant files.
- The scope should be treated as a focus boundary, not a blindness boundary: agents should know the wider architecture exists and escalate/search outward when the local change depends on external contracts, shared abstractions, or system-level consistency.
- Floe workflows may need a way to specify or infer the correct starting directory for an agent task, so complex projects can route agents to the right local context while preserving awareness of the broader substrate/project.

## Deterministic work should become reusable tools

- When an agent handles a process that is deterministic, repeatable, or likely to recur, Floe should prefer turning that process into an executable script/tool rather than repeatedly relying on agent reasoning.
- Agents should identify when a task contains deterministic calculations, transformations, checks, or workflows; build or call a tool for that portion; then package the tool so it is reusable and discoverable later.
- Skills may become the packaging/discovery layer for these reusable tools: “agent does X” should evolve into “agent finds/runs the saved tool for X” wherever the process can be made deterministic.

## Agent work must be legible across time

- Floe needs a substrate-level record of meaningful agent and human activity so long-running work can be understood after the fact: what changed, why it changed, who/what changed it, what evidence supported it, what risks were considered, and what outcomes followed.
- The first principle is not a “timeline UI”; it is temporal legibility. Agent work should produce inspectable state transitions, decision records, evaluations, retrospectives, tool-creation events, architectural changes, risk/security impacts, and correction loops.
- FloeWeb may express this as a scrubber, replay, or time-lapse interface, but the underlying substrate must preserve enough structured history for any surface or actor to audit, filter, replay, challenge, and learn from the work.
- Trust comes from explainable continuity: a user returning to a workspace should be able to see the causal chain from prompt/request → agent actions → decisions → artefacts/tools/code → evaluation changes → final state.
- The same history should support different review lenses: security, architecture, code, generated tools, evaluation-matrix changes, resolved inefficiencies, product impact, or agent self-improvement decisions.
- This applies to both human and agent actors. Agents should also be able to inspect prior decisions and state changes so they can avoid repeating mistakes, justify changes, and improve system behaviour without silently rewriting history.

## Show high-level impact before implementation detail

- Floe should help users retain visibility over AI-led development by presenting plans, progress, and decisions in terms of high-level impact: architecture changes, module boundaries, product implications, risks, and whether the work is on track.
- Most users do not need continuous low-level implementation detail such as line-by-line code changes, raw Jira movement, or internal task chatter. They need to understand the bigger-picture consequences so they can make good decisions.
- Before agents implement a meaningful feature or system change, they should be able to propose the architectural/product-level shape of the change: what new module or capability is needed, where it attaches to the existing system, what the revised architecture would look like, and what trade-offs or risks are introduced.
- Once the high-level direction is accepted, agents can decompose into lower-level specs and implementation tasks. This creates a manager-friendly and architecturally aware workflow: approve the shape of the change first, then let agents work through the details.

## Actors must respect responsibilities and route work explicitly

- Floe's substrate is built around multiple actors, including humans and agents. Actors can be created and should have clear responsibilities, scopes, and domains of ownership.
- If an actor is asked to do something outside its responsibilities, it should not silently execute anyway. It should push the work back into the system, identify the responsibility mismatch, and make the task available for an actor with the correct remit.
- If no suitable actor exists, the work should become an explicit orphaned responsibility rather than disappearing or being handled poorly. A system-maintenance actor or coordination process should detect these orphaned responsibilities and decide how to incorporate them.
- The system may resolve responsibility gaps by assigning new responsibility to an existing actor, creating a new actor, or restructuring actor boundaries so the work can be handled with the most useful context density for the token/work budget.
- This keeps the actor system coherent: agents specialise, avoid overreach, route work through visible responsibility boundaries, and evolve coverage only when the substrate identifies a real gap.

## Humans are ordinary actor endpoints

- The human never appears as a special-cased "human" inside the substrate. A human is just another actor endpoint whose role and responsibilities are defined in actor files, exactly like an agent's.
- If a person sits behind an endpoint, it is their responsibility to fulfil the role that endpoint declares. Escalation duties (e.g. "approves high-level impact") are properties of a role, not of humanness, so they can later be delegated to any actor — human or agent — without changing the system.
- Early on, more escalations will route to the owner's endpoint; over time those roles migrate to other actors. The philosophy must hold through that transition: only the role assignment changes, never the substrate's model of actors.
- Equality means: given the same permissions, a human actor and an agent actor can behave identically from the system's perspective. Humans differ only in interface, never in authority model.
- Permission/scope design is still open. Interim rule: an actor has full permissions within its own workspace, regardless of actor type.

## North-star use cases and six-month proof

- Personal north star: an AI-first game design company. The owner discusses a multi-year vision with a co-founding agent, then steps back. The human steps in only for testing and unavoidable real-world actions (payments, authentication). The AI counterpart runs the company.
- Six-month proof: a colleague of any discipline installs Floe, describes a desired outcome in plain language (e.g. an idea-to-published-video pipeline using named tools like GPT image models and Runway/Leonardo), and the agent designs the entire workflow system itself: storyboard/shot-board/narrative decomposition, spawning actors per stage, webhooks for remote-API callbacks, pulses that watch a folder for human-dropped ideas, and self-written extensions (e.g. a video playback / shot-board browser surface) — without the human explaining any system design.
- The human can step into a running system at any time to observe progress, drop thoughts/encouragement/feedback, or redirect — but the system keeps moving whether or not the human is present. The human is the ultimate executive; the world does not pause for them.
- Hosting model: self-hosted on the owner's machine/server first, with cloud deployability as a later option. Durability across host restarts matters; "the world keeps moving" implies an always-on host, not a laptop-session lifetime.
- Keystone economic property: a human's 30 seconds of reaction must be worth an agent's hours of work. Feedback must feel like conversation, not review, or the "human spends no time working in the system" dream fails.

## Trust gate for full autonomy, and the real fear

- The fear is not large token consumption; it is high cost with little momentum. Spend is acceptable when it visibly converts into value/progress.
- Spend-to-outcome telemetry (cost per workspace/actor/mission tied to legibility records) is acknowledged as needed, but deliberately a later layer once the substrate spine works — not an early build target.
- Full-autonomy trust gate: an agent can set a one-to-three-year mission, decompose it into small pieces, keep the company profitable along the way (e.g. shipping smaller sellable tools), schedule and run its own pulses/events on its own accord, and hold the long-term mission in sight — effectively and efficiently. AI must be able to *run* a company, not just instruct within one.
- Current trust deficits to close: memory and retrieval quality, and agents' ability to plan and operate workflows autonomously over long horizons.

## v58 is superseded; current architectural posture

- The v58 north-star doc is outdated in the owner's mind. Direction has evolved through subsequent PRDs/decisions: field → scope movement, and strict layering where the substrate owns all state.
- The web is purely a visual layer over the substrate. It may persist web-only metadata (e.g. React Flow node positions) but owns no substrate state. Bridge and CLI are independent projects.
- Pi is not load-bearing philosophically, but it is currently load-bearing practically: it provides multi-provider auth (Anthropic, OpenAI/GPT, GitHub Copilot, Gemini — both subscription OAuth and API keys) and runtime/hook plumbing that Floe would otherwise have to rebuild. Decision: keep Pi for now and spend tokens elsewhere; a replacement (e.g. Claude Agent SDK adapter beside or instead of Pi) needs a written proposal before any build.
- Any runtime replacement must preserve multi-provider support: Anthropic, OpenAI/GPT, GitHub Copilot, and Gemini subscriptions as well as API keys across these.
- The single biggest blocker to dogfooding (Floe building Floe) is that frontier models such as Claude are not yet available as agents inside the system, due to the pi-ai dependency. Self-hosting is otherwise considered close.
- Resolved 2026-06-10: frontier Claude models run through the existing Pi path via custom entries in `~/.floe/auth/models.json` (`claude-fable-5`, `claude-opus-4-8`) with `reasoning: false`. pi-ai 0.73.1 doesn't recognize these ids for adaptive thinking and would otherwise send a `thinking` param they reject (400); with `reasoning: false` the param is omitted and the model defaults to adaptive server-side. Trade-off: binding-level `thinking_level` is a no-op for these entries until Pi deps catch up. First end-to-end Fable turn verified (bus → bridge → pi runtime → emit → reply, ~$0.01).
- ADRs and PRDs in the repo are inspiration anchored to their creation date, not contracts; perspective is expected to shift toward supporting frontier models.

## Memory as a harness-agnostic parallel system

- Memory should be built as a standalone system usable in any harness, not welded to the Floe substrate. It can be developed in parallel with the substrate.
- Packaging target: an official Floe extension, enabled by default expectation but disableable by users who do not want it.
- This keeps the substrate core memory-free (consistent with earlier "memory remains external" decisions) while still treating memory quality as a first-class trust problem to solve.

