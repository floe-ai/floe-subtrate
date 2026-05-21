# Architecture Integration Brief: issue-5-field-actor-file-tools-proof

> Slice 4 of the Field PRD. Prove that a runtime-backed Floe actor can inspect and edit a Field via its **ordinary workspace file tools** — no new field-specific tools, no CLI changes — and that the bus watcher + index pick up the actor's edit through the existing path.

## Existing ownership

- Package/component/module/library:
  - `floe-bridge\src\tools\read.ts`, `edit.ts`, `write.ts`, `ls.ts`, `grep.ts`, `find.ts`, `bash.ts` own the ordinary workspace file tools. They are constructed by `createWorkspaceTools(ctx)` and exposed as `AgentTool[]` (`floe-bridge\src\tools\index.ts:30-40`).
  - `floe-bridge\src\tools\path-scoping.ts` owns workspace containment via `safeWorkspacePath(workspaceRoot, relPath)` — every read/edit/write resolves through it (`floe-bridge\src\tools\read.ts:33-37`, `edit.ts:71-75`, `write.ts:39-43`).
  - `floe-bridge\src\adapters\pi-agent-core-adapter.ts` owns tool registration into Pi sessions and only registers workspace tools when `context.workspace_locator` is set: `const workspaceTools = context.workspace_locator ? createWorkspaceTools({ workspaceRoot: context.workspace_locator, ... }) : []` and merges them into the Agent's `tools` array alongside `emit`, `list_endpoints`, `resolve_destination`, pulse tools, actor tools, extension tools (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:370-385`).
  - `floe-bridge\src\adapters\runtime-adapter.ts` defines `RuntimeContext.workspace_locator` as the filesystem path used both for work-log writing and tool scoping (`floe-bridge\src\adapters\runtime-adapter.ts:6-17`).
  - `floe-bus\src\fields-store.ts` owns `.floe\fields\<field-id>.yaml` semantic file I/O, `FieldSemanticSchema` (`schema: "floe.field.v1"`), `loadField()`, `loadAllFields()`, and `crossValidateSemantic()` (`floe-bus\src\fields-store.ts:42-52,222-288`).
  - `floe-bus\src\fields-watcher.ts` owns the chokidar watcher on `<locator>\.floe\fields\` with `awaitWriteFinish` (75 ms / 10 ms poll). On any `add`/`change` to a parsed semantic file it calls `loadField()` and broadcasts `field.upserted` with `source: "watcher", changed: "semantic"` (`floe-bus\src\fields-watcher.ts:67-89,142-163`).
  - `floe-bus\src\server.ts` owns the HTTP/WS surface. `GET /v1/workspaces/:workspace_id/fields/:field_id` returns `{ semantic, layout }` straight from `loadField()` (`floe-bus\src\server.ts:203-217`). `FieldsWatcherRegistry` is wired in `createBusServer()` and watches every registered workspace, including ones added via `POST /v1/workspaces/register` (`floe-bus\src\server.ts:111-329`).
- Current owner rationale:
  - PRD #14 spec line: *"The runtime-actor proof relies on ordinary file-read / file-edit tools the actor already has. No new actor tools (`field_list`, `field_add_item`, etc.) and no `floe-cli` field subcommands are introduced"* (`docs\field-substrate-slice-prd.md:133,176,185`).
  - ADR 0003 states fields are workspace files; the substrate's file-write path through the chokidar watcher is the documented closure of the loop: *"Fields can be created or edited entirely outside FloeWeb (any text editor, any actor with file-write tools); a chokidar watcher on `.floe/fields/` closes the loop"* (`docs\adr\0003-field-substrate-primitive.md:32`).
  - CONTEXT.md glossary: the workspace file at `.floe/fields/<field-id>.yaml` is the source of truth; the bus index is derived (`CONTEXT.md:78-83`).
- Source evidence:
  - The pattern for driving ordinary tools from an automated test already exists in the `"Full actor work loop acceptance"` block: a `FakeAgent` registers itself via `agentFactory: (input) => { fakeAgent.registeredTools = input.tools ?? []; return fakeAgent; }` and during `prompt()` it locates `read`/`write`/`edit` from `registeredTools` and invokes them with proper `tool_execution_start`/`tool_execution_end` Pi lifecycle events (`floe-bridge\src\adapters\pi-agent-core-adapter.test.ts:1662-1830`).
  - The pattern for asserting a real chokidar watcher fires `field.upserted` against a real bus already exists in `"external semantic file write broadcasts field.upserted from watcher"` (`floe-bus\src\fields-server.test.ts:387-432`).
  - The pattern for asserting the GET-index reflects a write already exists in `"GET list returns summary after PUT"` and `"GET one returns semantic and null layout when no layout written"` (`floe-bus\src\fields-server.test.ts:155-188`).

## Existing interaction model

- User/system behaviors that already exist:
  - A runtime-backed actor receives a delivery bundle through `PiAgentCoreAdapter.handleBundle()` and is given `read`/`edit`/`write`/`ls`/`grep`/`find`/`bash` plus `emit`/`list_endpoints`/`resolve_destination`/pulse/actor/extension tools, scoped to `context.workspace_locator` (`pi-agent-core-adapter.ts:370-385`).
  - `read` returns numbered file contents and reports a tool-activity summary; `edit` performs exact `old_text`→`new_text` replacement, normalises line endings/BOM, writes via `writeFileSync`, and returns a unified diff (`read.ts:39-77`, `edit.ts:77-117`).
  - When the bridge writes any file under `<locator>\.floe\fields\<field-id>.yaml`, the bus chokidar watcher fires (debounced 50 ms inside the registry, on top of chokidar's 75 ms write-finish window), loads/validates via `loadField()`, and broadcasts `field.upserted` (`fields-watcher.ts:119-163`).
  - `GET /v1/workspaces/:workspace_id/fields/:field_id` re-reads the file off disk through `loadField()` on every call — no caching layer to invalidate (`server.ts:203-217`; `fields-store.ts:222-239`).
  - Visible assistant output is captured as `visible_output_worklog` telemetry (`pi-agent-core-adapter.test.ts:131-150,237-246`).
- Behaviors that must remain unchanged:
  - `createWorkspaceTools()` must remain the single registration point; no field-specific tool may be added to the array.
  - `read`/`edit` must continue to refuse paths outside the workspace via `safeWorkspacePath`.
  - The fields watcher must continue to debounce semantic writes and emit `field.upserted` with `source: "watcher", changed: "semantic"`.
  - `GET /v1/workspaces/:ws/fields/:id` must continue to return the latest on-disk state without a separate refresh call.
  - Pulse-tool, actor-tool, extension-tool, emit, list_endpoints, resolve_destination, and existing read/write/edit/ls/grep/find/bash behavior must remain green (`tools.test.ts`, `pulse-tools.test.ts`, `actor-tools.test.ts`, `pi-agent-core-adapter.test.ts`, `fields-server.test.ts`, `fields-store.test.ts`).
  - The full work-loop acceptance test must remain green and continue to assert the full tool set is registered exactly as today (`pi-agent-core-adapter.test.ts:1820-1830`).
- Runtime or UX evidence:
  - Bridge daemon attaches workspaces, sets `workspace_locator` from registered workspace records, and the same `.floe/fields/` directory is watched by the bus (different process, same filesystem path). The integration boundary is the filesystem, exactly as the PRD intends.

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - `createWorkspaceTools({ workspaceRoot, getActiveTurn? })` to obtain the same `read`/`edit` tools the production adapter wires (`tools\index.ts:30-40`).
  - `PiAgentCoreAdapter` constructor's `agentFactory` injection hook for substituting a `FakeAgent` while still receiving the real registered tool list (`pi-agent-core-adapter.test.ts:1693-1697`).
  - `FakeAgent` Pi lifecycle envelope: `tool_execution_start` → `tool.execute(callId, args)` → `tool_execution_end` → `message_update`/`message_end` → `turn_end` → `agent_end` (`pi-agent-core-adapter.test.ts:1747-1791`).
  - Real bus boot via `createBusServer(cfgPath, cfg)` + `handle.app.ready()` + `handle.store.registerWorkspace({ locator, name }, () => {})` to obtain a watched workspace and a `workspace_id`, then `handle.app.listen({ port: 0, host: "127.0.0.1" })` for WS subscription (`fields-server.test.ts:11-41,275-306,387-432`).
  - WS event stream at `/v1/events/stream` for asserting `field.upserted` payload (`fields-server.test.ts:276-306`).
  - `handle.app.inject({ method: "GET", url: "/v1/workspaces/:ws/fields/:id" })` for asserting bus-index reflects the actor's edit (`fields-server.test.ts:155-222`).
  - `eventually(read, timeoutMs)` helper for tolerating chokidar's stabilisation window (`fields-server.test.ts:65-75`).
  - `FieldSemanticSchema.safeParse(YAML.parse(rawDisk))` to assert the post-edit YAML still parses as `floe.field.v1` (`fields-store.ts:42-52`).
- Relevant docs or library capabilities:
  - PRD §"Test plan" explicitly names this slice: *"Bridge actor field-edit test (floe-bridge, vitest, fake/recorded adapter). Covers scenarios 7–8: a Floe actor instance uses its ordinary file-read tool to read `.floe/fields/<id>.yaml` and reports items + connections; the same actor uses its ordinary file-edit tool to add an item; the bus watcher picks up the edit; the bus's field index reflects the change"* (`docs\field-substrate-slice-prd.md:176`).
  - PRD §"Out of scope": *"No new actor tools … No bridge changes in this slice; the bridge does not own field file I/O"* (`docs\field-substrate-slice-prd.md:185,192`).
  - ADR 0003 §"Considered options": bridge-owned file I/O for fields is **deferred**, not part of this slice (`docs\adr\0003-field-substrate-primitive.md:28`).
- Existing examples in this codebase:
  - `pi-agent-core-adapter.test.ts:1725-1830` — FakeAgent drives `ls`, `read`, `write`, `bash`, `emit` end-to-end and asserts visible_output_worklog and emitted message events.
  - `fields-server.test.ts:387-432` — real chokidar fileWrite → `field.upserted` from `source: "watcher"`.
  - `fields-store.test.ts` round-trip tests prove `loadField()` reflects external writes.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not introduce a `field_read`, `field_edit`, `field_add_item`, `field_connect`, `field_list`, or any other field-specific `AgentTool`. The proof is invalid if it ships a new tool — that is the whole point of the slice (PRD §Out of scope, line 185).
  - Do not add a `floe-cli` field subcommand for this slice.
  - Do not bypass `createWorkspaceTools()` — both tests must use the same factory the adapter uses, so that "ordinary" means the literal production tool. Do not hand-construct a one-off read/edit tool inside the test.
  - Do not bypass `safeWorkspacePath`/`workspaceRoot` scoping — the seed Field file must live inside the temp workspace's `.floe\fields\`.
  - Do not bypass `FieldsWatcherRegistry` by manually injecting a fake `field.upserted` event; the watcher integration test must boot `createBusServer()` against the same workspace locator the bridge tools wrote to.
  - Do not bypass the HTTP API for the bus-index assertion — call `GET /v1/workspaces/:ws/fields/:id`, not `loadField()` directly. The acceptance criterion says "Bus field index returns the updated Field on GET", which is the HTTP path.
- Shortcuts or parallel paths to avoid:
  - Do not let the `FakeAgent`'s assistant reply contain a hardcoded literal that matches the seed without actually deriving from the `read` tool's text output. The acceptance criterion says "the actor's chat reply **mentions** the seeded items + connections" — derive the reply from the read result so the assertion proves the read tool produced the substance, not the test author's foreknowledge. Otherwise this is a fake-only success path (forbidden by AGENTS.md Quality Bar).
  - Do not assert items/connections by re-reading the file in the test before constructing the FakeAgent reply; that would prove file I/O, not tool I/O.
  - Do not call `upsertFieldSemantic()` from the test to "edit" the field — that bypasses the actor tool path entirely.
  - Do not pre-register the field via `PUT /v1/workspaces/:ws/fields/:id`; the seed must be a direct file write to `.floe\fields\<id>.yaml` before bus startup (or via the watcher API), because Slice 4 proves the file-tool path, not the HTTP path.
  - Do not silence chokidar timing flakiness by writing twice or sleeping ad hoc; use `eventually()` with a generous timeout (≥1500 ms on Windows).
- Invariants:
  - Semantic source of truth is `.floe\fields\<field-id>.yaml`; post-edit content must still satisfy `FieldSemanticSchema` (`schema: "floe.field.v1"`).
  - No field-specific tool is registered into the Pi agent; the full registered toolset equals the existing acceptance list (read, write, edit, ls, grep, find, bash, emit, list_endpoints, plus pulse/actor/extension tools).
  - Bus watcher fires `field.upserted` with `source: "watcher"` for writes that did not originate at the bus HTTP API.
  - `GET /v1/workspaces/:ws/fields/:id` returns the post-edit semantic body within the watcher's stabilisation window.

## Integration plan

- Insert the change at:
  - **Primary:** `floe-bridge\src\adapters\pi-agent-core-adapter.test.ts`, in a new `describe("Slice 4 — Field via ordinary file tools (actor proof)")` block adjacent to the existing `"Full actor work loop acceptance"` block (`pi-agent-core-adapter.test.ts:1662`). Reuse `makeAcceptanceAdapter` (rename/export if helpful, or copy locally) and `makeAcceptanceDelivery`. This block contains three vitest cases mapping 1:1 to the acceptance criteria:
    1. **Read proof (vitest, fake/recorded adapter, no real bus):** seed `<tmp>\.floe\fields\demo.yaml` with a valid `floe.field.v1` semantic body containing ≥2 items and ≥1 connection; run a delivery; the FakeAgent invokes `read` on `.floe/fields/demo.yaml`, parses the YAML inside `prompt()` from the returned text, and emits an assistant `message_end` reply that concatenates the item refs and the connection's `from→to` label. Assertions: the captured `visible_output_worklog.payload.text` contains each seeded `ref` string and the connection text; the `read` tool was actually called (assert via `registeredTools` lookup + `tool_execution_start` recording, or via a spy on the tool's `execute`); no field-specific tool name appears in `registeredTools`.
    2. **Edit proof (vitest, fake/recorded adapter, no real bus):** same seed; FakeAgent invokes `edit` with `old_text: "items:\n"` + the existing items block, `new_text:` the same block plus one new `{ item_id: <new>, ref: <kind>:<id> }` line, **plus** an `updated_at` bump if needed to keep the file schema-valid (or seed `items:` empty so a single-item insert works without touching `updated_at`). After the turn, the test reads the file from disk, `YAML.parse`s it, and asserts `FieldSemanticSchema.safeParse(parsed).success === true` and that the new item is present. No field-specific tool is registered.
  - **Secondary:** a new integration case **in the same describe block** that combines both bus-watcher + bus-index criteria. This test boots a real bus (`createBusServer(...)`) against a temp workspace, registers that workspace, starts a WS subscriber on `/v1/events/stream`, runs the bridge adapter against the same `workspace_locator`, drives the FakeAgent to perform an `edit` on the seeded field, then:
    - awaits via `eventually()` a WS message with `type: "field.upserted"`, `payload.source === "watcher"`, `payload.changed === "semantic"`, `payload.workspace_id === wsId`, `payload.field_id === "demo"`;
    - asserts `handle.app.inject({ method: "GET", url: \`/v1/workspaces/${wsId}/fields/demo\` })` returns 200 and `body.semantic.items` includes the new item.
    - This single integration case covers acceptance criteria 3 and 4 with shared setup (chokidar boot is the expensive part).
  - **Optionally split** into `floe-bridge\src\adapters\field-file-tools.proof.test.ts` if the existing test file is judged too long; either location satisfies "vitest integration".
- Why this is the correct integration point:
  - The PRD names this exact test artefact (`docs\field-substrate-slice-prd.md:176`) and the prior `"Full actor work loop acceptance"` block establishes the FakeAgent-with-real-tools pattern. Mirroring it keeps Slice 4 readable and avoids duplicating adapter wiring.
  - Both halves of the proof — the actor reading/editing via ordinary tools, and the bus reacting via its watcher — meet at the filesystem. Tests must exercise both halves through the same filesystem path; placing both inside the bridge package (which already imports nothing from `floe-bus`) means we need to construct the bus via a normal `import` from `floe-bus` *in the test only*. Verify the bridge package already depends on `floe-bus` for tests (it does — the watcher integration test pattern lives next door in `floe-bus`, but the bridge can import `createBusServer` for tests; if monorepo plumbing rejects the import, alternative: keep the integration test in `floe-bus\src\fields-server.test.ts` and have it spawn the bridge adapter, mirroring the existing watcher proof).
  - Keeping the read/edit/integration cases together gives one place for a future reviewer to verify "no new field-specific tool was sneakily added".
- Alternatives considered and rejected:
  - **Introduce `field_*` AgentTools that wrap `read`/`edit`.** Rejected — explicitly forbidden by the PRD and ADR; this is the whole point of the slice.
  - **Bypass the FakeAgent and call `tool.execute()` directly from the test.** Rejected — that would not exercise `PiAgentCoreAdapter`'s tool registration or visible-output capture, so the "actor's chat reply" criterion would be unverifiable.
  - **Assert `field.upserted` via a direct `broadcast` spy instead of WS.** Rejected — the PRD wants the proof of the substrate path; `fields-server.test.ts:275-306` already demonstrates the WS subscription pattern with negligible overhead.
  - **Use `app.inject` for the WS stream.** Rejected — Fastify inject does not handle WS upgrade; use `handle.app.listen({ port: 0 })` plus `ws` like the precedent test (`fields-server.test.ts:276-280`).
  - **Make the FakeAgent reply a hardcoded string containing the seeded refs.** Rejected — fake-only success path; the reply text must be **derived** from the `read` tool result inside `prompt()`.
  - **Have the FakeAgent edit through `write` (full overwrite) instead of `edit`.** Rejected — the acceptance criterion names the edit tool specifically; `write` is a separate tool with different fuzzy-match semantics.

## Regression checklist

- Behavior: `createWorkspaceTools()` returns exactly the existing seven tools (read, ls, grep, find, write, edit, bash) in the existing order, and `PiAgentCoreAdapter` continues to register them only when `workspace_locator` is present.
- Behavior: full work-loop acceptance test (`pi-agent-core-adapter.test.ts:1725`) still passes with the same registered tool name set, including the assertion that exactly those tool names exist.
- Behavior: `tools.test.ts` (path-scoping, truncation, env-sanitise, read/ls/grep/find/write/edit/bash unit tests) remain green.
- Behavior: `fields-store.test.ts` — semantic round-trip, schema rejection, sidecar separation, multi-sidecar delete remain green.
- Behavior: `fields-server.test.ts` — HTTP PUT/GET/DELETE, `if_absent`, WS `field.upserted`/`field.deleted` from api+watcher, layout PUT semantics remain green (`fields-server.test.ts:77-432`).
- Behavior: chokidar watcher still debounces, still resolves through `loadField()`, and still distinguishes `changed: "semantic"` vs `changed: "layout"` (`fields-watcher.ts:119-163`).
- Behavior: `safeWorkspacePath` still rejects paths outside the workspace root for read/edit/write.
- Behavior: `bridge` does not gain any new dependency on `floe-bus` in *production* code (test-only import is acceptable).
- Behavior: no new `AgentTool` is registered in `pi-agent-core-adapter.ts` (verify by diff and by the registered-tool assertion).

## Test plan

- Existing tests to keep green:
  - `floe-bridge\src\tools\tools.test.ts`
  - `floe-bridge\src\tools\pulse-tools.test.ts`, `actor-tools.test.ts`
  - `floe-bridge\src\adapters\pi-agent-core-adapter.test.ts` (especially the existing `"Full actor work loop acceptance"` block at line 1725)
  - `floe-bridge\src\adapters\pi-agent-core-adapter.neutral.test.ts`
  - `floe-bridge\src\daemon.test.ts`, `extension-loader.test.ts`, `hooks.test.ts`, `hooks-injection.test.ts`, `auth.test.ts`, `project.test.ts`
  - `floe-bus\src\fields-store.test.ts`, `fields-server.test.ts`, `server.test.ts`, `pulse-*.test.ts`, `delivery-symmetry.test.ts`
- New tests to add before/with implementation:
  - **Test A — Read proof (vitest, fake adapter, no real bus).** Inside a new `describe("Slice 4 — Field via ordinary file tools (actor proof)")` block in `pi-agent-core-adapter.test.ts`:
    - Setup: temp workspace dir; write `<tmp>\.floe\fields\demo.yaml` with seeded semantic (e.g. items `floe_actor` → `actor:floe`, `github_webhook` → `webhook:github-pr`; connection `c_1` from `github_webhook` to `floe_actor` label `routes-to`).
    - FakeAgent in `prompt()` calls `read` for `.floe/fields/demo.yaml`, parses YAML from `result.content[0].text` (strip the leading line-number prefixes), and emits an assistant `message_end` whose text concatenates each item's `ref` and each connection's `from`/`to`/`label`.
    - Assert: `visible_output_worklog` text includes `actor:floe`, `webhook:github-pr`, and `routes-to`; `registeredTools` contains the seven workspace tool names and **does not** contain any name starting with `field_`; the read tool's `execute` was invoked.
  - **Test B — Edit proof (vitest, fake adapter, no real bus).** Same setup. FakeAgent calls `edit` with an `old_text`/`new_text` pair that inserts a new item line into the YAML and bumps `updated_at` if needed; ends turn normally. After `handleBundle` resolves, read `<tmp>\.floe\fields\demo.yaml` from disk, `YAML.parse`, and assert `FieldSemanticSchema.safeParse(parsed).success === true`; assert the new item appears in `parsed.items`; assert no new field-specific tool was registered.
  - **Test C — Bus watcher + index integration (vitest integration).** Boot `createBusServer` against a temp config whose workspace locator is the same temp dir; seed `demo.yaml` *before* `registerWorkspace`; subscribe via WS to `/v1/events/stream`; run the bridge adapter against the same `workspace_locator`; drive the FakeAgent through `edit`; `eventually()` wait for `{ type: "field.upserted", payload: { source: "watcher", changed: "semantic", workspace_id, field_id: "demo" } }`; then `handle.app.inject({ method: "GET", url: \`/v1/workspaces/${wsId}/fields/demo\` })` and assert status 200 and `body.semantic.items` includes the new item.
  - Negative guard (cheap, recommended): in any of A/B/C, also assert `registeredTools.find(t => /^field/.test(t.name))` is `undefined`.
- Live proof required:
  - After the three vitest cases above are green and no existing test regresses, capture a single live end-to-end run as the PRD specifies (`docs\field-substrate-slice-prd.md:180`): bus + bridge + FloeWeb up against a sample workspace; instruct the live Floe actor in chat to first describe the Field by reading the YAML, then to add a new item via the file-edit tool. Record screenshots + runtime transcript under a session artifact path (do not commit secrets/tokens). The live pass is independent of CI.
  - Confirm FloeWeb re-renders the new item live within seconds of the actor's edit (visual proof that the watcher round-trip works end-to-end, beyond the headless integration test).

## Risk assessment

- Risk: **Hardcoded reply leaks the seed.** A FakeAgent that emits a fixed assistant string containing the items' refs would technically pass the chat-reply assertion without proving the read tool produced them. Mitigation: derive the reply by parsing the `read` tool's text output inside `prompt()`; additionally, randomise/parameterise the item refs and connection label in the test so the seed cannot match a string baked into the reply by accident.
- Risk: **Chokidar timing on Windows.** The bus uses `awaitWriteFinish: { stabilityThreshold: 75, pollInterval: 10 }` plus a 50 ms internal debounce; integration assertions can flake. Mitigation: use the existing `eventually()` helper with a ≥1500 ms timeout (matches `fields-server.test.ts:387-432` precedent) and let the test poll WS messages, not a single shot.
- Risk: **`edit` tool match failure** on a freshly seeded YAML if `YAML.stringify` produces slightly different whitespace than the FakeAgent expects (e.g. trailing newlines, key ordering). Mitigation: write the seed YAML as an explicit string literal (not via `YAML.stringify`), so the `old_text` the FakeAgent uses is byte-stable; the `edit` tool also tolerates minor whitespace differences but byte-stability is safer.
- Risk: **Schema rejection on `updated_at`.** The `FieldSemanticSchema` requires `updated_at` to parse as an ISO datetime; an `edit` that only inserts an item line still leaves the original `updated_at`, which is fine (validator does not enforce monotonicity). However, the bus watcher will call `loadField()` and parse — if the user's edit accidentally breaks YAML indentation, the watcher silently skips (`fields-watcher.ts:154-155`) and the integration test will time out with no `field.upserted`. Mitigation: keep the edit minimal and assert disk content parses *before* awaiting the WS event, so a malformed-edit failure is diagnosed locally.
- Risk: **Cross-package import.** If `floe-bridge` cannot currently `import` from `floe-bus` in its vitest config, Test C must live in `floe-bus\src\fields-server.test.ts` instead and drive `PiAgentCoreAdapter` from there. Verify before writing the test; if it works, prefer co-location; if not, mirror the existing watcher-proof file. Either placement satisfies the acceptance criterion.
- Risk: **Conflict between PRD line 192 ("no bridge changes in this slice") and AGENTS.md Architecture Integration Gate.** Strictly interpreted, the brief should authorise *no product-code change to `floe-bridge`* for this slice — only new tests. If implementation discovers a real bug in `createWorkspaceTools()` or `PiAgentCoreAdapter` registration, raise a `Question` before patching product code; otherwise keep the diff test-only. Flagged for the implementer.
- Risk: **Acceptance criterion "Test does NOT register or invoke any field-specific tool" is currently true by construction** (none exist) but could regress if a future slice lands first. Add an explicit assertion in each of A/B/C so a future regression fails this slice's tests.

## Decision confidence

- Confidence: **high**
- Reasons:
  - Every required mechanism already exists and is exercised by precedent tests: workspace tool registration (`pi-agent-core-adapter.ts:370-385`), FakeAgent-driven tool invocation (`pi-agent-core-adapter.test.ts:1725-1830`), chokidar `field.upserted` broadcast (`fields-server.test.ts:387-432`), and disk-backed GET (`fields-server.test.ts:155-222`).
  - The slice is explicitly named in the PRD test plan, with the file/test-pattern already identified (`docs\field-substrate-slice-prd.md:176`).
  - No product-code change is required; the work is test authorship.
  - Documented invariants (no new field-specific tool, no CLI changes, bus owns file I/O) are aligned across CONTEXT.md, ADR 0003, and the PRD.
- Open questions:
  - Co-location of Test C: confirm `floe-bridge` vitest can import `createBusServer` from `floe-bus` at test time. If not, place Test C in `floe-bus\src\fields-server.test.ts` and import the bridge adapter there; raise a `Question` if neither direction works cleanly.
  - Whether to randomise seed item refs / connection label per test run to harden the "reply must derive from read" guarantee. Recommendation: yes, use a per-test `randomUUID()`-flavoured suffix so a hardcoded literal cannot ever pass.
  - Whether the live end-to-end pass (PRD line 180) should produce committed evidence under `docs/evidence/field-block-slice/`. Recommendation: keep ad hoc live QA evidence in the session workspace unless the user explicitly asks for it to be committed; the PRD suggests a path but the AGENTS.md "no token leakage / no tracking markdown" guidance points the other way.
