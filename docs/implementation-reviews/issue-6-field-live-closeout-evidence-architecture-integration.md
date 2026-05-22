# Architecture Integration Brief: issue-6-field-live-closeout-evidence

> Slice 5 of the Field PRD. This slice is a **live, full-stack, HITL close-out** of the Field substrate primitive: prove end-to-end that an operator + a runtime-backed Floe actor can drive the loop FloeWeb-create → file-on-disk → ordinary-actor-edit → watcher → live re-render against the real bus/bridge/FloeWeb stack with a real model provider, then capture committed evidence and advance `docs/ROADMAP.md` §2.
>
> This slice is **documentation + live QA + ROADMAP update**, not product code. The only product-code change permitted is a fix narrowly scoped to a real bug the live pass surfaces — and only after that bug is escalated through the slice's stop/approval path (see Risk assessment).

## Existing ownership

- Package/component/module/library:
  - `floe-bus\src\server.ts` owns the HTTP/WS Field surface and the Fastify logger (`logger: true`, `server.ts:92`). It is the only path FloeWeb consumes for fields, and the only place `field.upserted` / `field.deleted` events originate with `source: "api"` (`server.ts:231,260,285`).
  - `floe-bus\src\fields-watcher.ts` owns chokidar watching of `<locator>\.floe\fields\` and emits `field.upserted` with `source: "watcher"` for external writes (`fields-watcher.ts:1-50`).
  - `floe-bus\src\fields-store.ts` owns YAML I/O, `FieldSemanticSchema` (`floe.field.v1`), `FieldLayoutFloewebSchema` (`floe.field.layout.floeweb.v1`), and the bus's derived index (`fields-store.ts:42-52,222-402`).
  - `floe-bridge\src\daemon.ts` owns runtime resolution (`provider`, `model`, `auth_profile`) used when the Floe actor is activated; it picks the binding/workspace/global model and surfaces auth errors (`daemon.ts:459-540`).
  - `floe-bridge\src\adapters\pi-agent-core-adapter.ts` owns Pi agent construction and tool registration. Workspace tools (`read`, `edit`, `write`, `ls`, `grep`, `find`, `bash`) are registered exactly when `context.workspace_locator` is set (`pi-agent-core-adapter.ts:370-385`). This is the path the Floe actor uses to read/edit the Field YAML.
  - `floe-bridge\src\tools\{read,edit,write,path-scoping}.ts` own the ordinary file tools the actor uses; all paths are scoped through `safeWorkspacePath()`.
  - `floe-web\src\main.tsx` owns the FloeWeb Field/canvas UI: Block Library drag/drop, Inspector "Delete field", Add Actor Item, layout debounced save, WS `field.upserted/field.deleted` subscription, and React Flow wiring (`main.tsx:923-1234,1740-1755,2065-2095`).
  - `floe-web\src\fields-api.ts` owns the bus REST/WS client for fields; FloeWeb never reads `.floe/` directly (`fields-api.ts:204-229`).
  - `floe-web\src\fields.ts` owns pure semantic↔React Flow transforms and `applyNodeChangesToLayout()` (sidecar-only) (`fields.ts:165-260`).
  - `examples\sample-project\` is the workspace fixture; its `.floe\floe.yaml` already declares the `floe` agent (`examples\sample-project\.floe\floe.yaml:7-9`). `.floe\fields\` does not yet exist and will be created by the live pass.
  - `docs\ROADMAP.md` §2 (lines 136–296) owns the "Block model for substrate representation" framing and the "Required first slice" list. The framing-correction callout (line 140) and the "Required first slice" header (line 278) are the two anchors this slice must update.
  - `docs\evidence\` is the conventional location named by PRD line 180 and Issue #6 acceptance criteria; it does not yet exist in the repo.
- Current owner rationale:
  - PRD §"Live one-off pass": *"After all automated suites are green, run a single end-to-end live pass … Capture screenshots and the runtime transcript into `docs/evidence/field-block-slice/`. This satisfies the AGENTS.md 'live proof' gate without forcing real-provider runs into CI"* (`docs\field-substrate-slice-prd.md:178-180`).
  - PRD §"Further Notes": *"After this slice merges, ROADMAP §2 should advance from 'framing locked' to 'first slice complete' and the follow-on slice family (substrate↔FloeWeb parity for each Item kind) should be enumerated"* (`docs\field-substrate-slice-prd.md:205`).
  - Issue #6 acceptance criteria require: README checklist, screenshots, transcript, file diffs, bus-log excerpts, stop/edit/restart proof, ROADMAP §2 update, and a per-criterion check of the brief's acceptance list.
  - ADR 0003 line 32: *"Fields can be created or edited entirely outside FloeWeb … chokidar watcher on `.floe/fields/` closes the loop and FloeWeb re-renders live."* The live pass is the user-visible proof of this claim.
- Source evidence:
  - Slice 4 (commit `9fa3879`) closed #5 by proving the same actor-tool path inside Vitest with a real bus watcher and real `FieldSemanticSchema` round-trip (`docs\implementation-reviews\issue-5-field-actor-file-tools-proof-architecture-integration.md`).
  - Slice 3 (commit `88a3288`) closed #11/#4 by proving layout sidecar isolation under React Flow drag and whole-Field delete (`docs\implementation-reviews\issue-11-field-layout-sidecar-proof-architecture-integration.md`).
  - Mocked + real-bus Playwright suites for Field already exist in `floe-web\tests\field-substrate.spec.ts` (lines 46–1113).
  - Bus logger is on (`server.ts:92`), so `bus-log-excerpts.md` can be sourced from real daemon stdout/stderr.
  - Session-only live QA artefacts already exist in this working session's files directory (`field-connections-live-qa`, `field-item-deletion-live-qa`, `field-layout-delete-live-qa`, `field-referenced-primitive-live-qa`, `nested-field-live-qa`, `deletion-live-qa`, `live-qa-3868ede`) and are precedent for the format, but **none of them are committed**. Issue #6 explicitly requires committed evidence for the close-out.

## Existing interaction model

- User/system behaviors that already exist:
  - `npm run dev:bus`, `npm run dev:bridge`, `npm run dev:web` start the three processes individually; FloeWeb serves on `http://127.0.0.1:5378` (`package.json:15-17`, `floe-web\package.json`).
  - Workspace attach is operator-driven from FloeWeb's UI (or via `POST /v1/workspaces/register`). On attach, the bus indexes `.floe\fields\` and starts a chokidar watcher (`server.ts:111-329`).
  - Creating a Field from FloeWeb writes `.floe\fields\<id>.yaml` via `PUT /v1/workspaces/:ws/fields/:id` and broadcasts `field.upserted` with `source: "api"`.
  - Adding an Actor Item uses the FloeWeb Add-Item picker (`actor` kind) — the existing FloeWeb pickers are explicitly limited to `actor` and `field` for slice 1 (`docs\field-substrate-slice-prd.md:123-127`).
  - Saving layout (positions/viewport) writes only `.floe\fields\<id>.layout.floeweb.yaml` via `PUT .../layout/floeweb` and broadcasts `field.upserted` with `changed: "layout"`.
  - An external write to `.floe\fields\<id>.yaml` (text editor or actor `edit` tool) is picked up by the chokidar watcher after the 75 ms `awaitWriteFinish` window and broadcast as `field.upserted` with `source: "watcher", changed: "semantic"`.
  - FloeWeb's WS subscriber receives both `source: "api"` (echo) and `source: "watcher"` events and re-renders idempotently.
  - The Floe actor (real model provider, e.g. Anthropic/OpenAI/Copilot per `floe-bridge\src\auth.ts`) receives a chat instruction in FloeWeb's context view; it gets `read` and `edit` tools scoped to `workspace_locator` and can act on `.floe\fields\<id>.yaml` as plain workspace text.
- Behaviors that must remain unchanged (these are the FloeWeb Field/canvas invariants for this slice):
  - React Flow-native interaction patterns: `onNodesChange`, `onNodeDragStop`, `onMoveEnd`, `onConnect`, `onReconnect`, `onBeforeDelete`, `onEdgesDelete`, `onDrop`, `onDragOver` (`main.tsx:2065-2095`).
  - Block Library drag/drop, node labels/handles/selection styling, pan/zoom/drag performance, rename and open affordances, connection draw/label/reconnect affordances.
  - No parallel Field/canvas path: substrate-backed behaviour must continue to flow through the same React Flow graph; the live pass must not introduce DOM-side or out-of-band re-renderers.
  - FloeWeb must continue to talk only to the bus over HTTP/WS — never read or write `.floe/` directly (PRD §"Boundary rules" line 131).
  - Layout writes must remain sidecar-only; semantic file mtime must not change when only positions change.
  - Workspace tools must remain the unmodified `createWorkspaceTools()` set; no field-specific tool added (PRD §Out of scope line 185, ADR 0003).
  - Bridge ownership of file I/O for Fields stays deferred — Fields file I/O remains in the bus (ADR 0003 line 28).
- Runtime or UX evidence:
  - The bus, bridge and FloeWeb run in separate Node/Vite processes against the same filesystem; integration is across the FS boundary plus the bus HTTP/WS surface. The live pass exercises exactly this topology.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Bus HTTP endpoints already specified and tested: `GET /v1/workspaces/:ws/fields`, `GET /v1/workspaces/:ws/fields/:id`, `PUT .../fields/:id`, `PUT .../fields/:id/layout/floeweb`, `DELETE .../fields/:id` (`server.ts:203-286`).
  - Bus WS stream at `/v1/events/stream` for `field.upserted` / `field.deleted`.
  - FloeWeb's existing Add-Item flow for actor and field kinds (`main.tsx:923-1058`); Inspector's "Delete field" (`main.tsx:1740-1755`).
  - FloeWeb's existing real-bus Playwright harness (`floe-web\tests\field-substrate.spec.ts:641-1113`) is the canonical example for spinning a real bus inline; it is not used by this slice but is a fallback if the live pass needs a deterministic preflight.
  - `floe-bridge\src\auth.ts` runtime-auth model registry is the path by which the operator's real provider/model is supplied (binding > workspace > global). Use whichever real provider the operator has configured (e.g. Anthropic, OpenAI, GitHub Copilot).
  - Bus Fastify logger is already on — capture its stdout/stderr to a file during the live pass (`server.ts:92`).
  - `examples\sample-project\` is the agreed workspace fixture (Issue #6 scope).
- Relevant docs or library capabilities:
  - PRD §"Testing Decisions" line 180 names the live pass and the evidence path.
  - ROADMAP §"Required first slice" (line 278) and the framing-correction callout (line 140) are the close-out anchors.
  - AGENTS.md §"Quality bar" requires live validation, no fake-only success paths, no stale docs.
  - AGENTS.md §"Source of truth" ordering: code/runtime > tests/logs > repo docs > North Star. Any conflict surfaced by the live pass is escalated, not silently fixed.
- Existing examples in this codebase:
  - Session-only evidence directories under the agent session files directory show the de facto format already in use: PNG screenshots + a short README. This slice formalises that format into committed `docs/evidence/field-block-slice/`.
  - `docs\implementation-reviews\issue-5-…md` lines 158–162 explicitly flagged the open question of whether live evidence should be committed; Issue #6 resolves it (yes, committed under `docs/evidence/field-block-slice/`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass the bus HTTP API by having FloeWeb (or the live procedure) write `.floe/` directly. FloeWeb's only legal path is `fields-api.ts` (PRD line 131).
  - Do not bypass the bridge tool registration by giving the Floe actor a Field-specific tool. The actor must use the same `read` and `edit` tools `createWorkspaceTools()` already registers (PRD line 185; reaffirmed by Slice 4 brief).
  - Do not bypass the chokidar watcher by manually firing a `field.upserted` event from a helper script — the live pass's whole purpose is to observe the real watcher fire on a real disk write.
  - Do not bypass `safeWorkspacePath` by pointing the actor at a Field outside the attached workspace.
  - Do not bypass React Flow with a custom canvas: any cosmetic "evidence-friendly" re-render must come from the existing React Flow path. No parallel Field canvas, no DOM-side hot-reload shim, no separate evidence-only viewer.
  - Do not bypass `FieldSemanticSchema` / `FieldLayoutFloewebSchema` — the actor edit must leave the YAML valid per `floe.field.v1`. If the actor produces invalid YAML, that is a real bug in the actor prompt/path, not a reason to relax the schema.
- Shortcuts or parallel paths to avoid:
  - Do not script the "actor edit" by having the operator (or a helper script) write the YAML and then claim the actor did it. The transcript must show the model's tool call(s) for `read` and `edit`, with arguments and results, and the resulting `field.upserted` from `source: "watcher"`.
  - Do not capture only the happy path. If a step fails (e.g. the actor edits something invalid, the watcher misses a write, the WS reconnects), capture it in the evidence and either resolve it or escalate it. AGENTS.md forbids "fake-only success" paths.
  - Do not pre-edit `.floe\fields\inbound-pr-review.yaml` to "seed" the live pass — the operator must create it from FloeWeb so the first `field.upserted` is `source: "api"` and the file lands via the bus's PUT path.
  - Do not commit a "summary" of bus logs that paraphrases what happened. Commit raw excerpts (trimmed for length, not edited for content) with timestamps preserved.
  - Do not create planning markdown beyond what Issue #6 explicitly requires. The PRD and Issue #6 explicitly require this evidence directory and ROADMAP update; nothing more.
- Invariants:
  - Semantic source of truth: `.floe\fields\<field-id>.yaml`.
  - FloeWeb is one renderer; removing FloeWeb must not destroy a Field's meaning (verified by stop → external edit → restart step).
  - The bridge is unchanged in this slice family (ADR 0003 deferral).
  - No new actor tools, no `floe-cli` field subcommands, no relationship ontology, no permission model.
  - No token or secret leakage in committed evidence (screenshots/transcripts must redact any provider tokens, profile names that include secrets, or `.floe\state\auth*` content).

## Integration plan

- Insert the change at:
  - `docs\evidence\field-block-slice\` (new directory). Committed contents:
    - `README.md` — checklist mapping each Issue #6 acceptance criterion *and* each PRD acceptance criterion to the artefact that proves it.
    - `transcript.txt` — full operator↔Floe chat transcript covering the inspect step and the edit step, including the model's tool calls (`read` then `edit`) and their arguments/results as surfaced by the bridge.
    - `file-diffs.md` — unified diffs of `.floe\fields\inbound-pr-review.yaml` (before create / after create / after actor edit) and `.floe\fields\inbound-pr-review.layout.floeweb.yaml` (after layout save), plus the schema header of each file to make `floe.field.v1` / `floe.field.layout.floeweb.v1` visible.
    - `bus-log-excerpts.md` — trimmed Fastify log lines showing: `field.upserted source=api` after FloeWeb create, `field.upserted source=api changed=layout` after layout save, `field.upserted source=watcher changed=semantic` after the actor edit, and the `field.upserted source=watcher` after the stop/edit/restart proof.
    - `screenshots\` (subdir) — at minimum: `01-floeweb-empty.png`, `02-field-created.png`, `03-actor-item-added.png`, `04-layout-saved.png`, `05-chat-actor-inspect.png`, `06-chat-actor-edit.png`, `07-floeweb-rerendered-after-actor-edit.png`, `08-floeweb-stopped.png` (a terminal/state shot is fine), `09-external-yaml-edited.png` (editor view of the YAML diff), `10-floeweb-restarted-shows-edit.png`.
    - `stop-restart-check.md` — explicit step-by-step record of stopping FloeWeb, editing the YAML in a plain text editor, restarting FloeWeb, and observing the rehydration; with screenshot cross-refs and the resulting file diff.
  - `docs\ROADMAP.md` §2 (lines 136–296):
    - Update the framing-correction callout (line 140) from "first slice in this section adds the Field primitive" to a "first slice complete" statement that points at `docs/adr/0003-field-substrate-primitive.md`, `docs/field-substrate-slice-prd.md`, and `docs/evidence/field-block-slice/README.md`.
    - Replace or supplement §"Required first slice" (lines 278–295) with a "Status: complete" note and an enumerated **next slice family** anchor: "substrate↔FloeWeb parity for each remaining Item kind (context, file, extension, pulse, webhook, tool, work_log, event) — to be sliced into its own PRD after Issue #6 closes." Keep the bulleted list itself for historical reference or excise the items that the Field slice has demonstrably satisfied; whichever, the section must read as completed rather than required.
  - Issue/PR close-out:
    - Commit the evidence directory and the ROADMAP edit in a single PR. The PR description must check off each Issue #6 acceptance criterion and link to `docs/evidence/field-block-slice/README.md`.
    - Close Issue #6 when the PR merges and the live pass is reproducible from the README.
    - Close Issue #1 only if every PRD acceptance criterion is checked off in the evidence README.
- Why this is the correct integration point:
  - PRD line 180 names `docs/evidence/field-block-slice/` exactly. Issue #6 reaffirms the path and expands the file list. The repo policy against speculative planning markdown does not apply here because the evidence is the artefact the slice ships, not throwaway tracking.
  - ROADMAP §2 is the only doc that currently labels Field as "required" but unproven; updating it is the close-out signal that the framing has landed.
  - The bus already broadcasts the events with `source` and `changed` fields needed to make a credible evidence trail (`server.ts:228-286`, `fields-watcher.ts`). No new instrumentation is required to capture the evidence.
- Alternatives considered and rejected:
  - **Keep evidence session-only** (as done in prior slices). Rejected: Issue #6 explicitly requires committed evidence; future readers, future agents, and the close-out PR cannot reach session-state files. The PRD's path is `docs/evidence/field-block-slice/`.
  - **Commit a narrated markdown summary instead of raw artefacts.** Rejected: AGENTS.md forbids fake-only success paths; raw screenshots + raw log excerpts + raw diffs are the only credible proof.
  - **Add a Field-specific actor tool to make the live transcript shorter.** Rejected: PRD line 185 and ADR 0003 explicitly forbid this in slice 1, and Slice 4 proved the ordinary-tool path. Adding the tool would invalidate the slice's framing.
  - **Run the live pass against a fresh temp workspace instead of `examples\sample-project\`.** Rejected: Issue #6 specifies `examples/sample-project` so the close-out is reproducible by any operator on a clean checkout.
  - **Skip the stop/edit/restart proof and rely on the watcher proof.** Rejected: Issue #6 acceptance criterion explicitly requires it, and it is the only proof that FloeWeb is genuinely a renderer (not the source of truth).
  - **Update ROADMAP §2 in a separate PR after the evidence merges.** Rejected: Issue #6 requires the ROADMAP commit to be part of this slice's PR. Splitting risks the ROADMAP drifting from the evidence.

## Regression checklist

- Behavior: FloeWeb's React Flow Field canvas continues to drag/pan/zoom/select/connect/rename/open at the same performance and with the same affordances as before this slice. The live pass must not introduce any UI changes.
- Behavior: Block Library drag/drop continues to add Items.
- Behavior: Layout writes still hit only `.layout.floeweb.yaml`; the semantic file's mtime does not change during pure layout interactions (re-verifiable from `file-diffs.md` mtime annotations).
- Behavior: `field.upserted` and `field.deleted` continue to carry `source: "api" | "watcher"` and (where applicable) `changed: "semantic" | "layout"` (`server.ts:228-286`, `fields-watcher.ts`).
- Behavior: Bus continues to derive its index from disk on read — restarting the bus mid-pass and re-fetching `GET /v1/workspaces/:ws/fields/:id` returns the latest file content.
- Behavior: Bridge continues to register only `createWorkspaceTools()` (no Field-specific tools) and to scope every tool call through `safeWorkspacePath`.
- Behavior: FloeWeb continues to talk to the bus only — no direct `.floe/` reads/writes from the browser context.
- Behavior: Stopping FloeWeb, editing the YAML by hand, and restarting FloeWeb leaves the Field semantically intact and re-rendered.
- Behavior: All Vitest suites (`floe-bus`, `floe-bridge`, `floe-web` unit) and all Playwright suites (`floe-web/tests/*.spec.ts` — both mocked and real-bus) remain green on the live-pass branch before the live pass starts and after the ROADMAP commit lands.
- Behavior: Existing committed docs (`CONTEXT.md`, `PRODUCT.md`, `docs/adr/0003-field-substrate-primitive.md`, `docs/field-substrate-slice-prd.md`) remain consistent after the ROADMAP edit; if any of them describe ROADMAP §2 as "required first slice", reconcile in the same PR.

## Test plan

- Existing tests to keep green:
  - `npm run test` at repo root (runs `floe-tests` vertical slice).
  - `npm test --workspace floe-bus` (fields-store, fields-server, server, pulse, store).
  - `npm test --workspace floe-bridge` (pi-agent-core-adapter incl. fields actor-edit test from Slice 4, tools, auth, daemon, hooks, project, delivery-symmetry).
  - `npm test --workspace floe-web` (Vitest unit + Playwright `field-substrate.spec.ts` mocked + real-bus).
  - Run all of the above *before* the live pass and capture pass/fail in `bus-log-excerpts.md` or a sibling `test-runs.md` snippet.
- New tests to add before/with implementation:
  - **None** — this slice ships documentation and live evidence, not product code. Adding new automated tests would expand scope outside Issue #6.
  - Exception: if the live pass surfaces a real bug, the *fix* (in a follow-up issue, not this slice's PR) must come with the missing regression test; do not paper over the bug in evidence.
- Live proof required:
  1. Preflight: `git status` clean, `git log -1` matches `9fa3879` (or descendant), all automated suites green. Record in `README.md`.
  2. Start `dev:bus`, `dev:bridge`, `dev:web` in three terminals; tee bus stdout/stderr into a log file for later excerpting. Confirm operator's real model provider is configured via `floe-bridge` auth (provider/model resolved through `daemon.ts:459-540`); redact any token in screenshots.
  3. In FloeWeb, attach `examples\sample-project\` (or its absolute path) as the workspace. Capture `01-floeweb-empty.png`.
  4. Create Field `inbound-pr-review` from FloeWeb's UI. Confirm `.floe\fields\inbound-pr-review.yaml` exists on disk and validates against `floe.field.v1`. Capture `02-field-created.png` and append the file's contents to `file-diffs.md`. Confirm bus log shows `field.upserted source=api`.
  5. Add an Actor Item for the `floe` actor via the FloeWeb picker. Capture `03-actor-item-added.png`. Confirm the semantic file's `items` array has one entry with `ref: "actor:floe"`.
  6. Move the item; trigger viewport change. Confirm `.layout.floeweb.yaml` is written and `.yaml` (semantic) mtime is unchanged. Capture `04-layout-saved.png` and add the layout file to `file-diffs.md`. Confirm bus log shows `field.upserted source=api changed=layout`.
  7. In FloeWeb's chat with the Floe actor, ask: "Inspect the Field `inbound-pr-review` by reading its YAML and tell me the items and connections." Capture `05-chat-actor-inspect.png`. Save the model's reply + its `read` tool call(s) to `transcript.txt`. Verify the reply is derived from the read result, not from hardcoded knowledge.
  8. Ask the actor to add a second Item (e.g. `ref: "context:inbox"` with a fresh `item_id`) by editing the YAML. Capture `06-chat-actor-edit.png`. Save the model's `edit` tool call(s) and their unified diffs to `transcript.txt`. Confirm bus log shows `field.upserted source=watcher changed=semantic` within ~2s of the edit. Capture `07-floeweb-rerendered-after-actor-edit.png` showing the new item on the canvas with no manual refresh.
  9. Stop the FloeWeb dev server (Ctrl-C the `dev:web` terminal). Capture `08-floeweb-stopped.png`. Hand-edit the YAML in a plain text editor (e.g. add a connection between the two items, or update `title`). Save. Capture `09-external-yaml-edited.png`. Restart `dev:web`. Capture `10-floeweb-restarted-shows-edit.png` confirming the hand edit is present. Record bus log lines around restart in `bus-log-excerpts.md`. Record full procedure in `stop-restart-check.md`.
  10. Append final file diffs to `file-diffs.md`. Write the README checklist mapping every Issue #6 and PRD acceptance criterion to the artefact that proves it.
  11. Commit `docs\evidence\field-block-slice\*` and the `docs\ROADMAP.md` §2 edit in one PR. Reference Issue #6 and Issue #1 in the PR body.

## Risk assessment

- Risk: The live pass surfaces a real bug in the bus/bridge/FloeWeb (e.g. watcher misses the actor edit on Windows; FloeWeb does not re-render on `source: "watcher"`; the actor's `edit` produces invalid YAML).
  - Mitigation: Stop the slice and ask a `Question` with: which owner package (bus / bridge / floe-web) is affected, the smallest possible reproducer, and the smallest possible fix. Do not bundle the fix into the evidence slice — open a new issue, run its own Architecture Integration Gate, fix with TDD, then resume Issue #6 from step 1 against the new HEAD.
- Risk: The model provider is unavailable, rate-limited, or returns unstructured output that does not call the `read`/`edit` tool reliably.
  - Mitigation: Retry the chat with a clearer instruction; if still failing, document the failure mode in evidence and escalate via `Question`. Do not script the tool call yourself — that invalidates the proof.
- Risk: Token/credential leakage in screenshots, transcripts, or logs (bridge auth profile names, API keys in env, model IDs that imply private profiles).
  - Mitigation: Before committing, scrub screenshots for credential UIs; redact tokens in `transcript.txt`/`bus-log-excerpts.md` to `***`; never commit `floe-bridge` auth.json or env contents.
- Risk: Evidence drift — committed evidence references a code state that has since changed.
  - Mitigation: README must record the exact `git rev-parse HEAD` the live pass ran against. Re-run the pass and refresh evidence if a fix lands before merge.
- Risk: Scope creep — the operator notices a UX issue during the live pass and is tempted to fix it inside this slice.
  - Mitigation: File a separate issue; this slice ships docs/evidence only. The Field/canvas invariants list in this brief is the gate.
- Risk: ROADMAP edit accidentally removes content other contributors depend on.
  - Mitigation: Limit the edit to §2 framing-correction callout (line 140) and §"Required first slice" (lines 278–295); preserve every other line. Surface the diff in the PR description for review.
- Risk: The `field.upserted source=watcher` event arrives but FloeWeb suppresses re-render due to the recent-local-write window (`main.tsx:968-979,1245-1265`).
  - Mitigation: The window is keyed on FloeWeb's own writes; an external file edit (or the actor's bridge write) is not "local" by that definition. If suppression is observed, that is a real bug — escalate per the first risk above.

## Decision confidence

- Confidence: high
- Reasons:
  - Every piece of behaviour this slice is asked to *exhibit* is already implemented, unit-tested, integration-tested, and Playwright-tested. Slices 1–4 proved the watcher, the API, the schema, the layout sidecar, the whole-Field delete, and the actor-via-ordinary-tools path. Issue #6 is the final live, human-witnessed pass that converts those proofs into a single committed artefact.
  - The evidence path (`docs/evidence/field-block-slice/`) is named verbatim by the PRD and re-affirmed by Issue #6, resolving the open question flagged in Slice 4's brief (line 158–162) in favour of committing.
  - The ROADMAP edit anchors are concrete (file/line ranges identified) and bounded (§2 only).
  - The do-not-bypass list reproduces the same invariants Slices 3 and 4 already enforced; nothing about this slice tempts a shortcut around bus/bridge/FloeWeb owners.
- Open questions:
  - Real model provider choice (Anthropic / OpenAI / GitHub Copilot / other) is operator-dependent; the brief is provider-agnostic. The transcript must record which provider+model was used, not which credentials.
  - Whether to delete or merely annotate ROADMAP §"Required first slice" bullets 1–12 (lines 282–293). Recommendation: annotate ("Status: complete (Issue #1, evidence: docs/evidence/field-block-slice/)") and append the next-slice-family forward pointer; do not delete the historical list. Final wording can be agreed in the PR review.
  - Whether Issue #1 should auto-close on PR merge or require a follow-up review. Recommendation: close on merge if and only if the PR description checks off every PRD acceptance criterion against a concrete artefact; otherwise leave Issue #1 open with a list of unmet criteria.
