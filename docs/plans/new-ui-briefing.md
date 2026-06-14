# New UI — Product Briefing

**Status:** Proposal / design briefing. Point-in-time per `docs/plans/README.md`. Where this
conflicts with `MISSION.md`, `CONTEXT.md`, or accepted ADRs, those govern.

**Scope of this document:** the *what and why* of a ground-up human interface for Floe. The
*how, platform, cutover, and substrate prerequisites* live in `new-ui-replacement-plan.md`.

**Relationship to existing work:** this reframes and supersedes the operator-facing direction in
`PRODUCT.md` and the in-flight `slice-2-scope-field-remainder.md`. The substrate semantics in
`CONTEXT.md` and `substrate-semantics.md` are unchanged and remain authoritative — this is a
rendering/projection redesign, not a substrate redesign.

---

## 1. The reframe: driver → executive

Every mainstream AI interface is built for a **driver** — one human leaning forward, operating one
tool turn by turn. Floe's mission (`MISSION.md`) is the opposite: the operator **steers by
exception** while the company runs whether or not they are present. The keystone economic property
(`floe_thought_log.md`) is that 30 seconds of human reaction must be worth hours of agent work, and
feedback must feel like conversation, not review.

So the interface is not a cockpit. It is what an **executive returns to**. Its default question is
*"what happened while I was gone, and what needs me?"* — not *"what do you want to type?"*

This single shift reorganises the product. The current `PRODUCT.md` layout (left rail / centre
canvas / inspector / right Channel) is a competent *driver* layout — an empty Field waiting to be
operated. We invert it: **the canvas is a place you enter, not where you land.**

## 2. The governing law: substrate honesty

Brand words: calm, spatial, durable, precise. The product model already insists the Field renders
only what exists in the substrate — no fake agents, no invented Blocks, no Field-owned membership.

We make that a hard design law: **every element maps to a real substrate primitive, and from any
rendering you can descend to the event/delivery/work-log truth underneath.** The UI is a faithful
*projection*, never a flattering mock. That honesty is the source of operator trust, and trust is
the product. It is also the redundancy-test filter: a surface earns its place only if it gets *more*
valuable as the labour gets cheaper (more work flowing through identity, audit, scheduling,
coordination), not less.

## 3. Shape: three lenses over one substrate, plus two things that are everywhere

Not panes — **lenses** onto the same event-sourced substrate.

### Lens 1 — The Briefing (lean back; the home)
Not a metrics dashboard and not a chat sidebar (both are explicit anti-references). A
*state-of-the-company* surface answering three things:
- **What changed since you were last here** — a diff of the company, derived from events since your
  read watermark.
- **What's in flight** — which Actors are processing what right now (endpoint status).
- **What's waiting on you** — the centrepiece, rendered as **decision cards** (§5).

Momentum (is spend converting to progress?) is woven in as a single legible read with drill-down —
not charts. Per `floe_thought_log.md`, spend-to-outcome telemetry is a deliberately later layer; the
Briefing reserves the slot but does not block on it.

### Lens 2 — The Field (lean in; spatial work)
Opening a Scope enters its Field: a calm spatial composition of the *actual* scoped primitives from
the Scope Projection (`floe-bus/src/scopes/projection.ts`) — Contexts as the top-level work tiles,
their participant Actors, attached Pulses, and the derived relationships that already exist on the
substrate. The floe metaphor done right: tiles carry stable identity and can be rearranged without
that rearrangement *meaning* anything (Field Layout is renderer-only, never membership). Where you go
to understand or reshape connected work — not the default screen, and not a node-canvas spectacle.

### Lens 3 — The Timeline (look back; legibility)
The substrate is event-sourced, so causality is free. A scrubber over a Workspace or Scope
reconstructs state at time *T* and walks the causal chain: request → Actor actions → decisions →
artifacts → evaluation changes → final state (`floe_thought_log.md`, "Agent work must be legible
across time"). Every artifact, anywhere, has a **trace-back** affordance.

### Cross-cutting A — Floe as a persistent conversational command surface
Floe is the always-available system interface. You talk to the company from anywhere and it
navigates and acts *through* the substrate (`emit`, never a private path). In the executive loop you
mostly *tell Floe* and *respond to cards*; entering a Field to look closely is the exception.

### Cross-cutting B — Feedback attachable to any element
Select any Event, Block, result, or artifact and attach an evaluation ("this is wrong — find the
root cause and prevent recurrence"; thumb; pick-between-alternatives). It becomes a structured
substrate signal, not chat that evaporates (`floe_thought_log.md`, "Continuous improvement through
embedded evaluation"). This is what makes feedback feel like conversation, not review.

## 4. How each primitive renders

| Primitive | Visual treatment |
|---|---|
| **Workspace** | The shell/frame — the company. |
| **Scope** | Not rendered as an object; entered *as* a Field. A tinted territory. |
| **Context** | The thing you open. In a Field: a rounded "floe" tile — scope-tinted header, stable participant-Actor glyphs, one-line `first_message_preview`, relative `last_event_at`, and a status edge (soft glow active / **amber waiting-on-you** / calm idle). Open it → it becomes a stream (§6). |
| **Event** | The atom and the substance of the Timeline. Inside a Context it is split by the substrate's own communication/work-log distinction (§6). |
| **Actor / Endpoint** | A *presence* — identity, role/remit, status, current Context. Never a draggable mascot, never a contact list. Surfaced as an **org lens** (§7). |
| **Pulse** | How the system acts on its own accord — made visible with a **tide** motif (fits floe, avoids ice kitsch): a Workspace tide-line of upcoming fires ("what the company will do next while you sleep") plus small attached markers on Contexts/Scopes (next-fire, last-fired, fire count). Doubles as the unattended-cost/trust surface. |
| **Delivery** | Mostly inspector/trust depth — the inbox of an endpoint. Not a default surface. |
| **Work Log** | The Actor diary — browsable as "what this Actor did," and the body of the descend view (§6) and Timeline. |
| **Block / Surface** | The rendering layer where extension outputs (charts, structured results, render specs) appear — only for primitives that exist, and always reachable through the substrate alone (no web-only capability). |
| **Decision card** | The atomic unit of human attention (§5). |

## 5. The Briefing surface in detail

The home is built from **decision cards**, the unit that makes "30 seconds = hours" real. Each
pre-packages one thing needing the operator:
- a pending response (`response.expected`) addressed to the operator endpoint, or a high-impact
  proposal, or an **orphaned responsibility** ("needs an owner" — `floe_thought_log.md`, "Actors
  must respect responsibilities and route work explicitly");
- a **high-level impact summary** first (architecture / product / risk / cost), before any
  implementation detail (`floe_thought_log.md`, "Show high-level impact before implementation
  detail");
- the asking Actor and one-gesture responses: **approve / redirect / comment**.

The operator appears here as an ordinary Actor endpoint with a role, not as the privileged centre
(`floe_thought_log.md`, "Humans are ordinary actor endpoints").

## 6. The surface-vs-descend Context view (the cleanest substrate mapping)

The substrate distinguishes **communication (`emit`) from work log (visible output)**
(`substrate-semantics.md` §6). We make that structural, not stylistic:

- **Surface** — an open Context's readable spine is *only the emitted Events*: the decisions,
  reports, questions, approvals an Actor *chose* to surface. Sparse, legible. The executive lives
  here. `response.expected` Events are marked as awaiting.
- **Descend** — behind each emitted Event, a collapsible drawer holds the work that produced it:
  work log, tool activity, diffs, runtime trace, cost. On demand only.

This *is* "show high-level impact before implementation detail" and "calm surface, inspectable
depth," realised as the substrate's own communication/work-log split rather than a UI convention.

## 7. Actors as an org

Because the endgame is a company that runs itself, there is a view of the Actor system: who exists,
their responsibilities/remit, what each is working on, and what is orphaned. The operator is *in*
this org as one endpoint, not above it. Humans differ only in interface, never in authority model.

## 8. What this is not / what we will not build

All `PRODUCT.md` anti-references hold: no chat-with-a-sidebar, no project board, no fixed metrics
dashboard, no debug console with a skin, no draggable-agent canvas, no workflow builder, no file
explorer, no demo UI inventing unsupported Blocks.

Redundancy test for every surface: would a 10× better model make it unnecessary? A prettier prompt
box — yes, cut it. An exception briefing, a causal Timeline, a momentum read, feedback-as-signal —
these get *more* valuable as labour improves. Only those belong.
