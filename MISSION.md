# Mission

Why this substrate exists. Read this when the work feels redundant — especially the week a new model ships.

## The goal

A company that runs autonomously: agents and humans as peer actors, executing projects end-to-end, with the operator steering by exception instead of driving by hand.

## The bet

**Models are labor. The substrate is the company.**

Every lab release makes the labor smarter and cheaper. No lab release provides the company: identity, memory, communication, accountability, scheduling, and boundaries that persist across models, sessions, and vendors. Floe is that layer — the durable record of work and the coordination fabric that turns interchangeable model capability into a compounding organisation.

## Why this survives new model releases

1. **A better model is an upgrade event, not an extinction event.** Actors bind to models through runtime bindings; a new release is a configuration change that upgrades every actor in the workspace at once. The substrate rides capability waves; it does not compete with them.
2. **The substrate stores what no model can regenerate.** What happened, who decided, what was said, why — events, contexts, work logs. A 10x better model cannot remember what it was never present for.
3. **Harnesses are leases; the substrate is ownership.** Anything assembled inside a vendor harness — its memory, its scheduling, its agent definitions — lives at the vendor's pleasure: pricing, deprecation, product pivots. The organisation's record of work must outlive any vendor relationship.
4. **Actor-neutrality is the endgame assumption.** Mainstream harnesses are built around one human driving one tool. Floe is built around actors, where human-or-agent is an implementation detail. A substrate that assumes that now fits the world we are building toward; harnesses that assume a driver will need rewriting to get there.

## The redundancy test

Before building anything, ask: **would a 10x better model make this unnecessary?**

- If yes — do not build it. It is scaffolding compensating for model weakness, and the next release deletes it.
- If it becomes *more* valuable as models improve — more work flowing through identity, audit, scheduling, and communication — it belongs in the substrate.

## The actor-generality test

Substrate features must serve actors generally, not one client. Before building anything framed as "for the UI," ask: **is this useful to an actor that never opens the UI** — an agent, a webhook processor, a headless script?

- If yes, build it in the substrate.
- If it is only meaningful to the human UI, it is UI code, not substrate — it does not belong in floe-bus. Build it in the client, or reconsider whether to build it at all.

The operator is an ordinary actor; the UI is one client among many. (Example: the Endpoint Watermark serves any actor processing "events since I last ran," not just the Briefing.)

## What Floe is not

- **Not a harness.** We do not compete with coding agents on driving a model well; we bind to them through the bridge.
- **Not a workflow tool.** Workflows encode procedure; Floe encodes organisation. Procedure is exactly what better models replace.
- **Not a platform play, yet.** It must first run one real company — this one. Dogfooding is not a development technique here; it is the business.

## How this gets proven

The only loop that validates Floe: **give the workspace a goal → actors decompose, execute, coordinate, and report through the substrate → the operator steers by exception.**

Every slice must shorten that loop. A slice that makes the substrate more complete but the loop no shorter is deferred by default.

---

This document is canonical (tier 1, alongside `CONTEXT.md` and accepted ADRs). If the ROADMAP, a plan, or a slice conflicts with this document's intent, raise it to the operator — never silently follow either side.
