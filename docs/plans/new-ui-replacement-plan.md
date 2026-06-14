# New UI — Replacement Plan

**Status:** Proposal. Point-in-time per `docs/plans/README.md`. Pairs with `new-ui-briefing.md`
(the *what/why*); this is the *how, platform, cutover, prerequisites, and build sequence*.

**Premise:** the new UI **replaces `floe-web` outright**. Per `ROADMAP.md`: "Floe has not shipped.
Do not preserve legacy behaviour unless explicitly requested. Prefer clean breaking changes over
compatibility shims." We treat the new UI as a clean break, not a refactor.

---

## 1. Platform

### Recommendation: a desktop shell (Tauri) over a browser-runnable web frontend

The frontend stays a web stack (so `floe_thought_log.md` holds — "the web is purely a visual layer
over the substrate," owning no substrate state, persisting only renderer metadata like layout). We
wrap it in a **Tauri** desktop shell for the operator build.

**Why a desktop shell at all** — the executive model needs things a browser tab cannot do well:
- **OS-level notifications** for decision cards. "Steer by exception" fails if the operator must
  keep a tab open to learn something needs them. This is the single strongest platform driver.
- **Persistent presence** (tray, always-running) matching the "always-on host; the world keeps
  moving" hosting model.
- A **serious local build tool** feel (a `PRODUCT.md` design goal), not a SaaS tab — which is itself
  an anti-reference.

**Why Tauri over Electron** — far smaller footprint, native notifications/tray, no bundled Node
runtime, and it fits a local-first tool. Electron's only edge (Node in the shell) is unnecessary:
all privileged work already lives in `floe-bus` / `floe-bridge`, which the UI talks to over the
existing HTTP + WebSocket API.

**Why keep it browser-runnable** — dev iteration stays fast (Vite in a browser), the rendering layer
stays portable, and cloud-deployability (a later `floe_thought_log.md` option) remains open without a
rewrite. The Tauri shell is packaging, not a fork of the app.

### Alternatives considered
- **PWA** — installable + Push API, no native shell. Lighter, but desktop push is browser-dependent
  and the always-on/tray story is weak. Viable fallback if we want to defer native packaging.
- **Plain browser (today's model)** — zero install, but no presence and weak notifications; risks
  the "ChatGPT-with-a-sidebar / SaaS dashboard" anti-references.
- **Electron** — rejected: heavier, no benefit here.

> **Decided (2026-06-13): Tauri desktop shell up front**, with OS notifications in the first slice.
> The operator wants exceptions to reach them with nothing open, so presence + native alerts are not
> deferred. The frontend stays browser-runnable for dev iteration and future cloud deploy.

## 2. Clean replacement strategy (no creep of old systems)

`floe-web` today is effectively a monolith: `src/main.tsx` is ~2,800 lines plus ~1,700 lines of CSS,
built on `@xyflow/react` (React Flow), React 18, Vite. A refactor would drag its assumptions
(driver-first layout, Field-as-landing) into the new model. We do a **greenfield app and delete the
old one.**

**New package:** `floe-app/` (name TBD — avoids "web" since it is platform-flexible). The new app
owns the rendering layer; the substrate is untouched.

**Salvage list (port deliberately, do not import wholesale):**
- The **bus client contracts** — the HTTP/WS surface in `server.ts` is the real interface and is
  reused as-is. The thin client wrappers (`scope-projection-api.ts`, `pulse-api.ts`, `contexts.ts`)
  are reference for endpoint shapes, re-authored clean in the new app.
- The **WebSocket event stream** (`/v1/events/stream`) — the live spine of the Briefing and Fields.
- React Flow may still be the Field renderer, but adopted fresh against the Scope Projection, not
  inherited through `main.tsx`.

**Delete, do not migrate:** `main.tsx`, `styles.css`, the existing dialog/field/channel components,
and the Playwright/e2e suites tied to the old layout.

**No-creep rules:**
1. The new app reads/writes substrate state *only* through the `floe-bus` HTTP/WS API. No direct
   `.floe/` reads, no runtime path around bus/bridge (`PRODUCT.md` source-of-truth constraints).
2. No code import from `floe-web/`. Salvage by re-authoring against documented endpoints.
3. `floe-web/` is removed in the **same change** that lands the first end-to-end vertical slice of
   the new app (Briefing reading live bus state), so `main` never carries two operator UIs.
4. References to `floe-web` in `package.json`, `README.md`, `PRODUCT.md`, `docs/contracts.md` are
   updated as part of cutover — not left dangling.

## 3. Substrate gaps — do these first, in separate sessions

The Briefing and the surface-vs-descend view need substrate inputs that **partly do not exist yet**.
Per the operator's direction, these land *before* the UI build, in their own sessions, so the UI is
built against a real API and not mocked. Findings are from the current `floe-bus/src/server.ts` and
`store.ts`.

**Already present (no gap) — build directly on these:**
- Pending responses — `GET /v1/pending-responses` → "what's waiting on you."
- Endpoint status / turn lifecycle — `getEndpoint`, `POST /v1/endpoints/:id/turn-end` → "what's in
  flight."
- Events query — `GET /v1/events` (by workspace/scope/context).
- Pulses — `GET /v1/pulses` → the tide-line.
- Scope Projection — `GET /v1/workspaces/:w/scopes/:s/projection` → the Field.
- Contexts — `GET /v1/contexts` with `last_event_at`, `participants`, `first_message_preview`.
- Generic runtime telemetry — `POST/GET /v1/runtime/telemetry` (raw substrate for momentum later).
- Live stream — `GET /v1/events/stream` (WebSocket).

**Gaps (prerequisite work, ordered by how much they block the UI):**

1. **Operator read watermark** *(blocks "what changed since I left")* — there is no per-endpoint
   read/seen position over events; `last_seen_at` exists only for bridge liveness. Need a per-actor
   watermark and an events query that accepts a `since`/cursor (today `GET /v1/events` only takes
   `limit`). This is the backbone of the Briefing's diff.
2. **Work-log / trace retrieval per Event** *(blocks the descend view + Timeline detail)* — there is
   no bus API to read an Actor's committed work logs (`.floe/agents/<id>/worklogs/…`) or to join
   telemetry to the emitted Event that produced it. Need a read API that, given an emitted Event,
   returns its work log / tool trace / cost.
3. **Required impact summary on decisions** *(decided 2026-06-13: always required)* — every
   approval-seeking Event/proposal must carry a high-level impact summary (architecture / product /
   risk / cost) as a guaranteed, validated payload, so the Briefing always leads with consequences.
   This hardens from a typing convention into a **substrate requirement**: the prerequisite session
   enforces it (schema + validation on the emit path for approval-seeking events), not optional.
4. **Agent model config in agent YAML** *(operator-named; later)* — model selection is currently via
   runtime bindings (`/v1/runtime/bindings`) + `~/.floe/auth/models.json`, not agent-file
   frontmatter. The operator flagged this explicitly as later substrate work; not a UI blocker, but
   the Inspector/Actor surfaces assume it eventually.
5. **Momentum / spend-to-outcome** *(deferred by owner)* — `floe_thought_log.md` defers this as a
   later layer. The Briefing reserves the slot; we do **not** build aggregation now.
6. **Actor org / responsibilities read model** *(secondary; can follow the first UI slices)* — actor
   files carry responsibilities, but no API exposes remit/org/orphaned-responsibilities. Needed for
   the org lens (§7 of the briefing), which is not in the first slice.

> Suggested gap sequencing: **(1) read watermark → (2) work-log retrieval → (3) decision typing**
> unblock the first two UI slices. (4), (5), (6) follow the initial cutover.

## 4. Build sequence with the outside-in skill (later)

When the gated substrate work lands, build the app with the **outside-in skill**: route to the owning
module, write the skeleton (files, signatures, types, test names), hard-stop for human review, then
delegate implementation per module to subagents. Per memory `[[orchestrator-delegation-pattern]]`
and `[[token-conscious-orchestration]]`, the primary agent orchestrates and delegates implementation
to control cost; user-visible evidence is the verification.

**Proposed module boundaries for the new app** (the outside-in routing targets):
- `bus-client` — typed wrappers over the `floe-bus` HTTP/WS API. The only substrate seam.
- `briefing` — the home: decision cards, "since I left" diff, in-flight, tide-line, momentum slot.
- `field` — Scope → Field rendering (React Flow against Scope Projection), Context tiles, derived
  relationships, renderer-only layout.
- `context-view` — open-Context stream with the surface-vs-descend (emit vs work-log) split.
- `timeline` — scrubber/replay + trace-back.
- `floe-command` — the persistent conversational command surface.
- `feedback` — attach-evaluation-to-any-element, compiling to substrate signal.
- `shell` — platform packaging (Tauri), notifications, presence.

**Slice 1 is one thin thread through *all* lenses, scoped down by surface area, not by feature**
(operator decision 2026-06-13: keep every lens present; limit scope another way). It still ends with
code + tests + live proof + docs per `ROADMAP.md`. Slice 1 limits by:
- **one workspace + one Scope** (the Floe dogfooding workspace) and a couple of real Actors;
- **minimum viable rendering per lens**, end-to-end, rather than any one lens built deep;
- **read + a single primary write per lens** — Briefing: see + approve/redirect/comment on one card
  type; Context: surface/descend + reply; Field: render Contexts/Pulses + open one; Timeline: scrub
  events + trace-back; Floe command: navigate + emit; feedback: free-text attach to one element type;
- **Tauri shell + one OS notification** on a decision-card arrival;
- **defer:** multiple card types, derived-relationship editing, multi-lens replay,
  thumbs/alternatives feedback, the org lens, the momentum read.

Slice 1 still depends on all three substrate gaps (read watermark, work-log retrieval, required
impact summary) landing first, because the thread touches the Briefing diff, the descend view, and
decision cards. The cutover that deletes `floe-web` lands with this slice (clean break, no parity
gate).

**Later slices deepen each lens** rather than introduce it: more card types and the momentum slot;
derived-relationship editing in the Field; full replay lenses on the Timeline; richer feedback modes;
the actor-org lens; agent-YAML model config in the Inspector.

## 5. Decisions (resolved 2026-06-13) and remaining choices

Resolved by the operator:
- **Platform:** Tauri desktop shell up front; OS notifications in slice 1; frontend stays
  browser-runnable.
- **First version:** all lenses present as one thin vertical slice, scope limited by surface area
  (see §4), not by cutting features.
- **Retire old UI:** hard-delete `floe-web` at slice 1 — clean break, no parity gate.
- **Impact summary on decisions:** always required; enforced as a substrate requirement (§3 gap 3).

Still to settle (low-stakes, can decide during build):
- **New package name:** `floe-app` proposed.
- **Required-impact-summary mechanism:** schema-validated payload on the emit path vs. a light
  dedicated approval primitive — a call for the substrate session.
