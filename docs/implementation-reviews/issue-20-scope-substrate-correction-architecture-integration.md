# Architecture Integration Brief: issue-20-scope-substrate-correction

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns durable substrate state and public HTTP/WS APIs: workspaces, endpoints, events, delivery, contexts, runtime telemetry, pulses, runtime bindings (`floe-bus\src\store.ts:150`, `server.ts:86`).
  - `ContextStore` owns context rows and participants; `resolveContext` owns participant-aware continue/new-context rules (`contexts\store.ts:33-56`, `resolver.ts:86-115`).
  - `floe-bus` currently owns Field file I/O and watcher state through `fields-store`/`fields-watcher` and exposes `/v1/workspaces/:id/fields` (`server.ts:13-20`, `server.ts:190-292`, `fields-store.ts:42-71`, `fields-watcher.ts:44-88`). This is now a conflict, not the future source of truth.
  - `floe-bus` owns Pulse storage, scheduling and subscriber fanout (`store.ts:303-330`, `server.ts:715-906`). Current `pulses.scope` means local/workspace storage and conflicts with corrected Scope language.
  - `floe-bridge` owns `.floe/` template materialisation, workspace attach, endpoint registration, extension loading, runtime delivery processing, and work-log writes (`daemon.ts:46-58`, `daemon.ts:186-260`, `project.ts:43-134`, `pi-agent-core-adapter.ts:89-185`, `pi-agent-core-adapter.ts:800-831`).
  - `floe-web` is a bus client/renderer. It currently fetches fields through `fields-api` and renders them with React Flow (`fields-api.ts:169-229`, `main.tsx:925-949`, `main.tsx:2180-2210`).
- Current owner rationale:
  - Default Scope, Scope records, Scope propagation, scope-filtered primitive queries, and safe Scope deletion belong in `floe-bus`, because existing Workspace registration, Context/Event/Pulse persistence, and query APIs are already bus-owned.
  - Bridge should consume Scope through bus payloads and runtime context only; it should not create a parallel Scope store or read Scope files directly.
  - FloeWeb should list Scopes as Fields and render projections from bus APIs only; browser code must not read/write workspace files directly (`PRODUCT.md:40-45`, `field-substrate-slice-prd.md:131-135`).
- Source evidence:
  - Corrected docs: `CONTEXT.md:5-23`, `CONTEXT.md:121-148`, `PRODUCT.md:30-33`, `PRODUCT.md:58-73`, `docs\adr\0004-scope-as-substrate-organising-boundary.md:5-11`, `docs\scope-substrate-slice-prd.md:65-89`.
  - Existing conflict: ADR-0003 is explicitly superseded but code still implements `.floe/fields/<id>.yaml` semantic membership and connections (`docs\adr\0003-field-substrate-primitive.md:1-5`, `fields-store.ts:42-52`, `fields-store.ts:165-195`).

## Existing interaction model

- User/system behaviors that already exist:
  - Workspaces register/select through bus and bridge attach follows bus events (`server.ts:294-321`, `daemon.ts:101-124`).
  - Events are emitted through `/v1/events/emit`; bus resolves/creates Contexts and stores Events with `context_id` (`server.ts:538-566`, `store.ts:724-776`).
  - Triggers (`pulse.fired`, webhook) create target-only Contexts with `source_endpoint_id = null`; no synthetic system/pulse/webhook participant (`store.ts:778-832`, `contexts\trigger.test.ts:51-131`).
  - Context subscribers append `pulse.fired` into an existing Context without endpoint delivery; endpoint subscribers create delivery and may use an associated Context (`server.ts:832-889`, `pulse-subscribers.test.ts:65-163`).
  - Bridge runtime turns pass `current_delivery_context_id` back to the bus on emit and include `context_id` in telemetry (`pi-agent-core-adapter.ts:447-478`, `pi-agent-core-adapter.ts:775-797`).
  - Work logs are committed Markdown activity records, not messages, written under `.floe/agents/<agent_id>/worklogs/` (`runtime-core\worklog.ts:1-20`, `pi-agent-core-adapter.ts:800-831`).
  - FloeWeb Workspace Home lists Fields, opens a Field Surface, renders React Flow nodes/edges, preserves channel/sidebar conversation affordances, and uses DialogHost rather than native dialogs (`main.tsx:2004-2071`, `main.tsx:2106-2220`, `main.tsx:2457-2683`, `field-substrate.spec.ts:127-183`).
- Behaviors that must remain unchanged:
  - Context isolation/no-bleed and participant-aware resolver rules (`contexts\resolver.test.ts:50-220`, `server.test.ts:177-267`, `no-actor-bleed.spec.ts:186-240`).
  - Explicit `emit` remains the only communication path; visible output and tool activity remain telemetry/work-log material, not chat messages (`pi-agent-core-adapter.ts:414-491`, `pi-agent-core-adapter.ts:714-763`).
  - Pulse subscriber semantics and `pulse.fired` canonical event behavior remain intact (`pulse-subscribers.test.ts:65-294`).
  - React Flow-native pan, zoom, drag, selection, handles, reconnect/connect, MiniMap, Controls, and drop behavior remain available (`main.tsx:2180-2210`).
  - Block Library drag/drop can supplement canvas creation but must not replace native canvas flows (`main.tsx:1886-1910`, `main.tsx:2307-2339`).
  - Existing dialog/sidebar affordances stay: rename uses inline toolbar, dialogs use `promptDialog`/`confirmDialog`, context nodes must open/use the existing right-side Channel path (`main.tsx:1628-1649`, `main.tsx:1814-1876`, `main.tsx:2493-2683`).
- Runtime or UX evidence:
  - Existing automated surfaces: bus context/server/pulse/field tests; bridge pulse/worklog/adapter tests; FloeWeb unit tests for `fields`/`fields-api`; Playwright Field, context, and no-actor-bleed specs.
  - React Flow is already installed and used via `@xyflow/react` (`floe-web\package.json:14-18`, `main.tsx:27-48`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Add `ScopeStore`/schema application beside `ContextStore` in `floe-bus\src`, invoked from `BusStore.migrate()` after workspace schema and before context/event propagation uses it.
  - Ensure Default Scope idempotently in bus-owned Workspace paths: `BusStore.registerWorkspace`, `BusStore.selectWorkspace`, and startup/reconciliation over existing workspaces after migration. Also guard creation lazily in Scope APIs and scoped primitive creation.
  - Add bus endpoints under `/v1/workspaces/:workspace_id/scopes` and scoped projection endpoints; keep FloeWeb behind bus-only clients.
  - Extend `ContextRecord`, `createContext`, `getContext`, list APIs, `resolveContext` input/result only as needed to carry a requested/default `scope_id` without weakening participant checks.
  - For Events, add `scope_id` only as a denormalised query/index column if useful; queries must derive/validate from Context/source primitive and prevent drift.
  - Rename Pulse public API/tooling to `persistence` for storage location while adding `scope_id` for organising Scope. If legacy `scope` is temporarily accepted, treat it only as `persistence` compatibility and do not expose it as organising Scope.
  - Extend work-log data with derived `scope_id` from delivery/current Context where available, otherwise Default Scope; do not infer file Scope from `files_touched`.
  - Add FloeWeb pure transforms for Scope projection (e.g. `scope-projection.ts`) mirroring the `fields.ts` pure-transform convention; continue using React Flow node/edge transforms, not hand-rolled canvas state.
  - For layout, add a separate bus-owned renderer metadata endpoint/store keyed by `workspace_id + scope_id + rendered_ref`, not by Field Item ids. Prefer a new store/module (for example `scope-layout-store`) over extending semantic `fields-store`.
- Relevant docs or library capabilities:
  - `@xyflow/react` provides `ReactFlow`, `Handle`, `Controls`, `MiniMap`, `Background`, node/edge change callbacks, connection callbacks, drag/drop integration, pan/zoom, and selection already used in `main.tsx:27-48` and `main.tsx:2180-2210`.
  - Fastify/zod patterns already validate bus payloads (`server.ts:22-51`, `server.ts:719-737`).
  - Vitest and Playwright are existing test frameworks (`floe-bus\package.json:10-14`, `floe-bridge\package.json:10-14`, `floe-web\package.json:6-12`).
- Existing examples in this codebase:
  - Context deep module and resolver isolation (`contexts\store.ts`, `contexts\resolver.ts`).
  - Pulse scheduler/subscriber API and tests (`server.ts:715-906`, `pulse-subscribers.test.ts`).
  - FloeWeb pure module + thin API module pattern (`fields.ts`, `fields-api.ts`) should be reused structurally, while replacing its semantics.

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass `BusStore`, ContextStore, resolver, bus HTTP/WS APIs, PulseScheduler, pulse subscriber fanout, delivery queue, bridge runtime path, bridge work-log path, or FloeWeb bus-only boundary.
  - Do not bypass React Flow for canvas interactions; do not replace native pan/zoom/drag/selection/connect with custom DOM gesture code.
  - Do not bypass existing DialogHost/sidebar/channel affordances with native dialogs or a second conversation UI.
- Shortcuts or parallel paths to avoid:
  - No field-owned canonical item list.
  - No field-owned canonical connection graph.
  - No `.floe/blocks` substrate.
  - No actor containment in Scopes/Fields; actors remain workspace-scoped endpoints and may appear only through relationships such as context participants or pulse subscribers.
  - No fake file/resource/extension/capability membership. Tool-touched files may appear in scoped Work Log activity, but the file itself is not scoped unless explicit file/resource metadata exists later.
  - No webhook route/config Scope invented in this tranche; current webhook ingress falls back to Default Scope.
  - No many-to-many Scope membership.
- Invariants:
  - Scope is the substrate organising boundary inside a Workspace; Field is FloeWeb's rendering/projection of a Scope.
  - Every Workspace has exactly one Default Scope with workspace-local `scope_id = "default"`; it is never hidden and never deletable.
  - Context/source primitive owns Event Scope truth. Event `scope_id`, if present, is denormalised index/query data only.
  - Pulse Persistence (`workspace-backed` vs `local/runtime-backed`) is separate from organising `scope_id`.
  - Field layout stores UI state only: positions, dimensions, viewport, collapsed state. Layout cannot create, remove, or reassign membership.
  - Unsupported primitives are omitted or shown honestly as unsupported; never fabricated into membership.

## Integration plan

- Insert the change at:
  - #21 Scope store/API: add bus-owned `scopes` schema and `ScopeStore`; call idempotent `ensureDefaultScope(workspace_id)` from `registerWorkspace`, `selectWorkspace`, migration/startup reconciliation, and scoped primitive creation fallbacks. Expose list/create/update APIs; omit Scope deletion API in the first implementation. If deletion is later demanded, allow only empty non-default delete after a scoped-primitive emptiness check across contexts, pulses, work logs/projection indexes, and any future owned primitives. Default Scope deletion is always rejected/unavailable.
  - #22 Context/Event propagation: add `scope_id` to `contexts`; accept optional explicit `scope_id` in event/context creation and default via `ScopeStore`. Return `scope_id` from context list/get APIs. Normal Events derive Scope from Context. Add `events.scope_id` only for indexed reads and keep it synchronized from Context/source at insert time; never allow callers to set authoritative Event Scope independently.
  - #23 Pulse Persistence/Scope: rename public request/response/tool language from `scope` to `persistence`; add `scope_id`. Pulse creation inherits active Context Scope when supplied by bridge/runtime context unless explicitly overridden; otherwise Default Scope. Context subscribers inherit subscriber Context Scope; endpoint subscribers use associated Context Scope when present, otherwise Pulse Scope. `pulse -> subscriber` relationships are query data from `pulse_subscribers`, not Field edges.
  - #24 Trigger/Work Log derivation: webhook ingress calls Default Scope until route config exists. Work logs derive `scope_id` from delivery/current Context via event/delivery data; fallback Default Scope. Add scoped projection/query support for work logs without treating `files_touched` as file membership.
  - #25 FloeWeb projection: replace `fields-api` semantic membership calls in the product flow with Scopes/projection bus APIs. Home lists Scopes as Fields; open Field renders scoped contexts, pulses, events, work logs and derived relationships. Context/thread nodes open the existing Channel/sidebar path. Pulse subscriber edits, if implemented, call Pulse APIs.
  - #26 Layout sidecar: implement bus-owned layout metadata keyed by Scope rendering and stable rendered refs. Node moves/viewport writes use layout endpoint only. Do not extend `.floe/fields/<id>.yaml` semantic files or `FieldConnection` as membership.
  - #27 Live acceptance/docs: run fresh-workspace proof, compare docs to runtime, and use a separate review agent to verify invariants from this brief.
- Why this is the correct integration point:
  - Current code already centralises Workspace, Context, Event, Pulse and Delivery ownership in the bus; Scope must be adjacent to those tables so fallback/defaulting and queries are atomic and testable.
  - Bridge and FloeWeb already depend on bus contracts; extending those contracts preserves the existing substrate boundary.
  - React Flow already provides the canvas behavior and tests already assert layout-vs-semantic behavior; the correction should preserve the UI interaction model while replacing the data source.
- Alternatives considered and rejected:
  - Extending `.floe/fields/*.yaml` items/connections: rejected because docs now supersede Field-owned membership and it would preserve a duplicate source of truth.
  - Storing actors/files/extensions as scoped Field items: rejected because those primitives do not currently own Scope metadata and actor containment is explicitly forbidden.
  - Making Event `scope_id` authoritative: rejected because Context/source primitive owns Event Scope truth and denormalised event data can drift.
  - Building a new canvas renderer: rejected because React Flow already owns the interaction model and regressions in pan/zoom/drag are blockers.
  - Implementing broad Scope deletion now: rejected because safe non-empty deletion requires reassignment semantics across multiple primitive owners that are deferred.

## Regression checklist

- Behavior: every Workspace has one idempotent Default Scope (`scope_id = "default"`), and Default Scope cannot be deleted.
- Behavior: no new Context/Event/Pulse/Work Log becomes unscoped; missing explicit Scope falls back to Default Scope.
- Behavior: Context/source primitive remains Event Scope truth; denormalised Event Scope cannot be independently set or drift.
- Behavior: Pulse Persistence language replaces old Pulse `scope` storage wording in new public surfaces; organising `scope_id` is separate.
- Behavior: current pulse subscriber semantics, context isolation/no-bleed, trigger target-only contexts, and explicit emit-only communication remain unchanged.
- Behavior: webhook ingress uses Default Scope and does not invent route Scope/config.
- Behavior: Work Log scoping does not make touched files/resources scoped members.
- Behavior: FloeWeb lists Scopes as Fields and never reads/writes `.floe/` directly.
- Behavior: no field-owned item list, no field-owned connection graph, no `.floe/blocks`, no actor containment, no fake file/resource/extension membership.
- Behavior: layout metadata only; moving nodes or viewport changes never changes primitive `scope_id` or projection membership.
- Behavior: React Flow pan, zoom, drag, selection, handles, rename/open affordances, connection affordances, Block Library drag/drop, and channel/sidebar flows remain usable and tested.
- Behavior: performance regressions in Scope navigation, pan, zoom, or node drag are blockers.

## Test plan

- Existing tests to keep green:
  - Bus: `npm run test --workspace floe-bus` covering context store/resolver/server, trigger events, pulse scheduler/subscribers, delivery symmetry, and existing field tests until replaced/retired.
  - Bridge: `npm run test --workspace floe-bridge` covering pulse tools, work logs, daemon, project loading, adapter behavior, hooks/extensions.
  - FloeWeb: `npm run test:unit --workspace floe-web` and `npm run test:e2e --workspace floe-web` covering pure transforms/API, context rendering, no actor bleed, Field/canvas affordances.
  - Repo build: `npm run build`.
- New tests to add before/with implementation:
  - #21: ScopeStore create/list/update/default idempotency; register/select/restart default creation; no deletion endpoint or 405/404 for deletion; Default deletion rejected if endpoint exists; non-default deletion omitted or empty-only.
  - #22: context `scope_id` explicit/default creation; context APIs expose Scope; events inherit from Context; scope-filtered context/event queries; denormalised `events.scope_id` backfill/sync if added; no orphan/unscoped rows.
  - #23: Pulse `persistence` and `scope_id` validation; active Context inheritance; Default fallback; context-subscriber and endpoint-subscriber Scope inheritance; public old `scope` wording regression guards in tools/docs/API responses.
  - #24: webhook Default Scope fallback; work-log derivation from delivery/current Context; no file/resource/extension fake membership from tool activity.
  - #25: FloeWeb lists Scopes as Fields; opens selected Scope projection from bus; renders context participants/pulse subscribers/events/work logs; context node opens existing sidebar; unsupported primitives omitted/honest; no actor containment copy.
  - #26: layout writes keyed to stable rendered refs; node move/viewport tests prove only layout endpoint/file/table changes; projection membership unchanged after reload.
  - Regression search/guards: no `.floe/blocks`; no new `FieldSemantic.items` or `FieldConnection` as membership source; no `.floe/fields/*.yaml` semantic writes in new Scope paths; no broad `scope` Pulse storage language in new public surfaces.
- Live proof required:
  - Start real bus + bridge + FloeWeb, create/open a fresh Workspace, observe Default Scope listed as a Field.
  - Create scoped Context and Pulse via real product/tool paths; verify Events inherit Context/Pulse/Default Scope and Work Logs derive Scope.
  - Open Scope Field and capture screenshot/video showing scoped contexts/pulses, context participants and pulse subscribers as derived relationships.
  - Drag/pan/zoom/move nodes; verify layout persists and membership/scope IDs do not change.
  - Inspect filesystem/API evidence proving no `.floe/blocks`, no canonical field item list, and no canonical field connection graph.

## Risk assessment

- Risk: Existing Field implementation is still live and semantically conflicts with corrected docs; implementers may accidentally extend `fields-store`/`.floe/fields/*.yaml` membership. Mitigation: treat current Field semantic APIs as superseded compatibility/retirement targets; new Scope projection APIs must not write `items`/`connections`.
- Risk: Pulse currently uses `scope` in DB, API, bridge client, and tool copy for persistence (`store.ts:303-306`, `server.ts:719-724`, `bus-client.ts:181-195`, `pulse-tools.ts:197-237`). Mitigation: introduce `persistence` public language and separate `scope_id`; add regression tests for wording and payload shape.
- Risk: Denormalised Event Scope could become authoritative. Mitigation: derive from Context/source on insert and query; make direct caller event scope writes invalid or ignored except through source primitive.
- Risk: Scope deletion can orphan primitives. Mitigation: first implementation omits deletion API; if later added, only empty non-default deletion with cross-primitive emptiness checks.
- Risk: FloeWeb projection refactor can regress React Flow interactions. Mitigation: keep React Flow native callbacks/components, add Playwright coverage before changing canvas behavior, and treat pan/zoom/drag performance regressions as blockers.
- Risk: Work Log and file/resource scoping can be conflated. Mitigation: Work Log entries may carry/derive Scope, but `files_touched` stays activity evidence only.

## Decision confidence

- Confidence: high
- Reasons:
  - Source docs are aligned and explicit that Scope supersedes Field-owned membership (`CONTEXT.md:145-148`, `ADR-0004:5-11`, `scope-substrate-slice-prd.md:120-124`).
  - Code ownership is clear: bus owns state/API, bridge owns runtime/work logs/template, FloeWeb owns rendering over bus data.
  - Existing tests define strong invariants for contexts, pulse subscribers, no actor bleed, and React Flow canvas affordances.
- Open questions:
  - Exact physical storage for Scope layout metadata should be finalised in #26, but it must be separate from field-owned semantic files and bus-mediated.
  - Whether legacy Field semantic endpoints are removed immediately or left as non-product compatibility during the tranche should be decided by the implementer/reviewer; either way they must not feed Scope projection membership.
  - Whether legacy Pulse `scope` input is accepted temporarily as `persistence` compatibility should be decided with migration/backcompat needs; new public surfaces must use `persistence` plus organising `scope_id`.
