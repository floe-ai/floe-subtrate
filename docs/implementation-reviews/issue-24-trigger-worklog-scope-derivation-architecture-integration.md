# Architecture Integration Brief: issue-24-trigger-worklog-scope-derivation

## Existing ownership

- Package/component/module/library:
  - `floe-bus` owns webhook trigger creation through `BusStore.ingestWebhook`, the webhook HTTP route, trigger Event insertion, Context creation, Delivery queueing, Runtime Telemetry, ScopeStore, ContextStore, Event APIs, and Pulse-fired Scope propagation (`floe-bus\src\server.ts:797-800`, `floe-bus\src\store.ts:1259-1281`, `floe-bus\src\store.ts:874-920`, `floe-bus\src\store.ts:1097-1142`, `floe-bus\src\scopes\store.ts:34-154`, `floe-bus\src\contexts\store.ts:42-184`).
  - `emitTriggerEvent` owns trigger Event Scope fallback today: with no `context_id`, it creates a target-only Context and calls `resolveScopeId(command.scope_id ?? null)`, which falls back to the Default Scope (`floe-bus\src\store.ts:880-895`, `floe-bus\src\store.ts:1493-1529`).
  - `ContextStore` owns delivery/current Context Scope because Context rows carry authoritative `scope_id`; Event `scope_id` is denormalised from the Context when inserted (`floe-bus\src\contexts\store.ts:5-12`, `floe-bus\src\store.ts:1497-1559`).
  - `floe-bridge` owns runtime delivery processing, active turn state, runtime telemetry emission, and the committed Work Log write path (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:89-137`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:672-696`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:777-833`).
  - `floe-bridge\src\runtime-core\worklog.ts` owns the Markdown Work Log schema/rendering under `.floe\agents\<agent_id>\worklogs\YYYY-MM-DD.md` (`floe-bridge\src\runtime-core\worklog.ts:1-20`, `floe-bridge\src\runtime-core\worklog.ts:25-78`).
  - Workspace tool activity and touched-file evidence are owned by bridge tools and active-turn enrichment, not by file/resource Scope metadata (`floe-bridge\src\tools\types.ts:5-22`, `floe-bridge\src\tools\read.ts:58-63`, `floe-bridge\src\tools\write.ts:50-53`, `floe-bridge\src\tools\edit.ts:92-96`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:613-630`).
  - Current query/index surface for activity is bus Runtime Telemetry and FloeWeb telemetry rendering; committed Work Logs have no bus API/index yet (`floe-bus\src\server.ts:748-771`, `floe-web\src\main.tsx:140-148`, `floe-web\src\main.tsx:525-553`, `floe-web\src\main.tsx:3032-3035`).
- Current owner rationale:
  - Webhook ingress and trigger Context creation must remain in bus because the bus already owns route handling, trigger Events, Context/Event Scope defaulting, queueing, and delivery.
  - Work Log Scope derivation belongs in bridge at the point it writes the Work Log, but the final source of Scope must be the bus-supplied delivery Event/Context data, not bridge-side inference.
  - Tool-touched paths are activity evidence inside Work Logs/telemetry only. No existing owner supplies file/resource Scope metadata, extension Scope metadata, or capability Scope metadata.
- Source evidence:
  - `CONTEXT.md` defines Scope, Default Scope, Context/Event inheritance, webhook Default Scope fallback, Work Log derivation from delivery/context, and warns that Work Logs are activity records rather than communication (`CONTEXT.md:5-19`, `CONTEXT.md:80-88`, `CONTEXT.md:123-135`).
  - Accepted PRD says webhooks land in Default Scope until route config exists, Work Logs derive Scope from delivery/current Context, and files/extensions/capabilities must not be faked into membership (`docs\scope-substrate-slice-prd.md:13-17`, `docs\scope-substrate-slice-prd.md:79-83`).
  - ADR-0004 supersedes Field-owned membership and rejects `.floe/blocks` as substrate (`docs\adr\0004-scope-as-substrate-organising-boundary.md:5-11`).

## Existing interaction model

- User/system behaviors that already exist:
  - Webhook ingress is `POST /v1/webhooks/:workspace_id/:route_id`; it selects the first registered processor endpoint in the Workspace and emits a non-actor `webhook_received` trigger with `source_endpoint_id: null` and `metadata.trigger_kind = "webhook"` (`floe-bus\src\server.ts:797-800`, `floe-bus\src\store.ts:1259-1281`).
  - Trigger Events bypass participant-aware actor emit resolution by design, create or use a target Context, and queue delivery to the target endpoint (`floe-bus\src\store.ts:865-920`).
  - Deliveries carry the bus-inserted Event envelopes; those Events already include `context_id` and `scope_id` in bus state, and delivery bundles persist the event JSON (`floe-bus\src\store.ts:116-139`, `floe-bus\src\store.ts:1688-1717`, `floe-bus\src\store.ts:1753-1768`).
  - Bridge `startTurn` derives the active turn's `context_id` from the trigger Event and forwards that Context on later `emit` calls as `current_delivery_context_id` (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:672-696`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:449-480`).
  - Bridge fetches Context details for prompt participants, degrades gracefully on failure, and writes Work Logs after completed or failed turns (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:160-184`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:252-286`).
  - Work Logs currently render turn id, trigger, thread, delivery, delivered events, visible output, tool activity including `files_touched`, emitted events, and outcome; they do not render or store `scope_id` (`floe-bridge\src\runtime-core\worklog.ts:25-61`, `floe-bridge\src\runtime-core\worklog.ts:80-152`).
- Behaviors that must remain unchanged:
  - Webhook/pulse triggers remain non-actor Events with null source; no synthetic webhook/system endpoint or extra participant should be introduced.
  - Existing Context/Event Scope propagation and Context-authoritative Event Scope must stay green; Event `scope_id` remains query/index data and not direct authority.
  - Bridge visible output and tool output remain Work Log/telemetry activity, not communication; explicit `emit` remains the only actor communication path (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:725-739`).
  - Tool activity can show touched files, but touched files are not scoped file/resource primitives.
  - FloeWeb Scope projection is out of scope for #24; no Field-owned item/connection work should be added.
- Runtime or UX evidence:
  - Existing tests cover Context/Event Scope propagation and Pulse Scope propagation (`floe-bus\src\scope-propagation.test.ts:58-390`, `floe-bus\src\pulse-scope-propagation.test.ts:80-373`).
  - Work Log tests cover current Markdown rendering and activity-vs-communication separation (`floe-bridge\src\runtime-core\worklog.test.ts:72-207`).
  - Current FloeWeb telemetry rendering attaches tool/runtime activity to chat segments by telemetry `context_id`, not Work Log files (`floe-web\src\main.tsx:525-625`, `floe-web\src\main.tsx:3032-3035`).

## Existing extension points

- APIs/hooks/components/library features/stores/conventions to use:
  - Use `ScopeStore.ensureDefaultScope`/`resolveScopeId` via `BusStore` for Default fallback and explicit Scope validation; do not hardcode a new defaulting mechanism outside bus Scope ownership.
  - Use `BusStore.ingestWebhook` and `emitTriggerEvent` for webhook ingress. The narrow #24 change is to make Default Scope explicit/tested there if needed, not to create webhook route/config Scope.
  - Use delivery `events[0].scope_id` and/or `events[0].context_id` as the primary bridge input for Work Log Scope; if the bridge needs to query, extend `BusClient.getContext` to include returned `scope_id` from the existing `/v1/contexts/:id` response.
  - Extend bridge `EventEnvelope`, `DeliveryBundle` typing, `RuntimeTurnContext`, `WorkLogEntry`, and Work Log rendering with `scope_id`.
  - Extend existing Runtime Telemetry payloads with `scope_id` alongside `context_id` so future rendering/indexing can filter activity without creating a second activity store (`floe-bridge\src\adapters\pi-agent-core-adapter.ts:777-799`).
  - If a Work Log query surface is needed in #24, keep it as an index over existing Work Log metadata/telemetry and make it bus-owned; do not introduce a separate parallel activity store or Field membership source.
- Relevant docs or library capabilities:
  - `CONTEXT.md` and the PRD define Work Logs as committed Markdown activity records, not communication, and Scope as primitive-owned/derived (`CONTEXT.md:86-88`, `docs\scope-substrate-slice-prd.md:79-82`).
  - Zod/Fastify schema patterns already exist for bus API validation (`floe-bus\src\server.ts:23-53`, `floe-bus\src\server.ts:748-755`).
  - Vitest is already used for bus and bridge tests; Work Log tests are pure filesystem tests around `appendWorkLog`.
- Existing examples in this codebase:
  - `emitTriggerEvent` already creates trigger Contexts in a resolved Scope and `insertEvent` derives Event Scope from Context (`floe-bus\src\store.ts:880-912`, `floe-bus\src\store.ts:1493-1559`).
  - Pulse firing already passes Pulse `scope_id` to `emitTriggerEvent` only when no subscriber Context exists (`floe-bus\src\server.ts:1005-1017`).
  - Bridge tools enrich active-turn activity in place, which Work Logs and telemetry already consume (`floe-bridge\src\tools\types.ts:19-22`, `floe-bridge\src\adapters\pi-agent-core-adapter.ts:613-630`).

## Do-not-bypass list

- Systems/libraries/components not to duplicate or replace:
  - Do not bypass `BusStore`, `ScopeStore`, `ContextStore`, `emitTriggerEvent`, `appendContextEvent`, Event/Delivery queues, bridge `BusClient`, bridge active-turn state, Runtime Telemetry, or `appendWorkLog`.
  - Do not bypass the bus by having bridge or FloeWeb read authoritative Scope/membership directly from workspace files.
- Shortcuts or parallel paths to avoid:
  - No webhook route Scope/config model in this slice.
  - No file/resource Scope inference from `files_touched`, tool name, actor identity, or a scoped turn.
  - No fake extension/capability membership and no invented extension/capability Scope association.
  - No Field-owned membership, no Field-owned canonical item list, no Field-owned connection graph, and no `.floe/blocks`.
  - No second activity store for Work Logs.
  - No direct Event authoritative Scope; Event `scope_id` remains denormalised from Context/source primitive.
- Invariants:
  - Current webhook ingress lands in Default Scope unless an existing owning primitive supplies Scope. Today no webhook route/config owning primitive exists.
  - Work Log `scope_id` is derived from delivery/current Context where available; fallback is Default Scope for indexing/rendering.
  - A scoped Work Log can contain tool activity and touched-file evidence without making those files/resources scoped primitives.
  - Unsupported files/resources/extensions/capabilities should be omitted from projection or labelled honestly as unsupported/default-level; never fabricated as Field members.

## Integration plan

- Insert the change at:
  1. `floe-bus\src\store.ts` webhook path:
     - Keep `ingestWebhook(workspaceId, routeId, body, broadcast)` as the only webhook ingress owner.
     - Make Default Scope fallback explicit by resolving/passing `scope_id: DEFAULT_SCOPE_ID` (or by a small helper using existing `resolveScopeId`) into `emitTriggerEvent`; no request body, route table, route config, or route-to-Scope mapping should be added.
     - Preserve metadata shape (`trigger_kind: "webhook"`, `route_id`) and null source trigger semantics.
  2. `floe-bridge\src\bus-client.ts` and adapter delivery typing:
     - Add `scope_id: string` to bridge `EventEnvelope` and `scope_id` to `getContext` response typing because the bus already returns it.
  3. `floe-bridge\src\adapters\pi-agent-core-adapter.ts` active turn/work-log path:
     - Add `scope_id` to `RuntimeTurnContext`.
     - In `startTurn`, derive `scope_id` from the trigger/current delivery Event (`bundle.events[0]?.scope_id`) when present.
     - If missing but `context_id` exists, optionally use the already-fetched Context `scope_id` from `context.bus.getContext(turn.context_id)`; if that query fails or no Context exists, use `default`.
     - Pass `scope_id` through `appendTelemetry` payloads and `writeWorkLog`.
  4. `floe-bridge\src\runtime-core\worklog.ts`:
     - Extend `WorkLogEntry` with `scope_id` and render a stable top-level line such as `**Scope:** <scope_id>` next to Trigger/Thread/Delivery.
     - Do not add any file/resource membership section. Keep `files_touched` under Tool activity only.
  5. Tests:
     - Add bus webhook tests at API/store boundary proving current ingress Events/Contexts have `scope_id: "default"` and no webhook route/config Scope exists.
     - Add bridge adapter/worklog tests proving scoped delivery Event -> Work Log `scope_id`, missing Context/Scope -> Default Scope, telemetry payload includes `scope_id`, and touched files remain only tool activity.
     - Add regression guards that no `.floe\blocks` path, Field item/connection membership file, extension/capability membership, or file/resource Scope metadata is created by this slice.
- Why this is the correct integration point:
  - Bus already owns webhook ingress, Default Scope, Context/Event Scope propagation, and delivery payloads, so webhook defaulting belongs there.
  - Bridge already owns runtime delivery processing, active turn state, telemetry payloads, and Work Log writes, so Work Log derivation belongs there while relying on bus-provided Context/Event Scope.
  - Extending Work Log metadata and existing telemetry creates future rendering/index hooks without inventing a Field projection or second activity store.
- Alternatives considered and rejected:
  - Add `scope_id` to webhook route config now: rejected; no route/config primitive exists and issue #24 explicitly forbids inventing it.
  - Infer file Scope from a scoped Work Log or `files_touched`: rejected; files/resources lack owning Scope metadata.
  - Store file/extension/capability refs as Field items for display: rejected; ADR-0004 supersedes Field membership and #24 does not implement FloeWeb projection.
  - Let bridge choose arbitrary Scope when delivery Event lacks Scope: rejected; bridge should use bus Event/Context data or Default fallback only.
  - Create a new Work Log/activity database separate from telemetry/Markdown: rejected as a parallel activity store.

## Regression checklist

- Behavior: webhook `POST /v1/webhooks/:workspace_id/:route_id` still creates a non-actor `webhook_received` trigger, targets the first processor endpoint, queues delivery, and uses null source.
- Behavior: current webhook ingress Event and created Context have `scope_id = "default"` when no existing owning primitive supplies Scope.
- Behavior: no webhook route Scope/config model, route schema, or route-to-Scope mapping is introduced.
- Behavior: Work Logs created from scoped deliveries render/index `scope_id` from the delivery/current Context.
- Behavior: Work Logs with no resolvable scoped Context fall back to `default` for metadata/telemetry.
- Behavior: `files_touched` remains nested under Tool activity and does not create scoped files/resources.
- Behavior: no fake Field membership is created for files/resources/extensions/capabilities/tools/actors.
- Behavior: no `.floe\blocks`, no Field-owned canonical item list, and no Field-owned connection graph are written.
- Behavior: Event `scope_id` remains Context/source-derived; no caller-authoritative Event Scope path is introduced.
- Behavior: existing Context/Event and Pulse Scope propagation tests remain green.

## Test plan

- Existing tests to keep green:
  - `npm run test --workspace floe-bus`, especially `scope-propagation.test.ts`, `pulse-scope-propagation.test.ts`, context trigger tests, server tests, pulse subscriber/scheduler tests.
  - `npm run test --workspace floe-bridge`, especially adapter, tools, pulse tools, and `runtime-core\worklog.test.ts`.
  - `npm run build` after implementation.
- New tests to add before/with implementation:
  - Bus API test: register workspace + endpoint, call `POST /v1/webhooks/:workspace_id/:route_id`, assert response `event.scope_id === "default"`, event `source_endpoint_id === null`, event metadata is webhook route metadata, and `GET /v1/contexts/:id` returns `scope_id === "default"`.
  - Bus regression test: no webhook route/config Scope API/table/file is added; at minimum assert webhook request does not accept/use a supplied Scope field and code/search guard does not introduce a route Scope model in this slice.
  - Bridge Work Log render test: `appendWorkLog` includes `**Scope:** research` when `WorkLogEntry.scope_id = "research"`.
  - Bridge adapter test: delivery Event with `scope_id: "research"` produces Work Log entry and Runtime Telemetry payload with `scope_id: "research"`.
  - Bridge fallback test: delivery/turn with missing `scope_id` and no resolvable Context writes/renders `scope_id: "default"`.
  - Tool activity regression test: a Work Log with `files_touched: ["config.json"]` renders only under Tool activity and does not write any file/resource Scope metadata or membership artifact.
  - Negative filesystem assertions: after scoped tool activity and Work Log write, assert no `.floe\blocks`, no new `.floe\fields` semantic membership file/connection, and no extension/capability membership artifact was created.
- Live proof required:
  - API-level/live-process proof is sufficient for #24; FloeWeb Scope projection is out of scope.
  - Start real bus/bridge against a disposable Workspace, create or use a scoped Context delivery where possible, run a runtime turn that writes a Work Log, and inspect:
    - webhook ingress response/Event/Context shows `scope_id: "default"`;
    - Work Log Markdown contains `**Scope:** <expected>`;
    - Runtime Telemetry payloads include matching `scope_id`;
    - touched files remain listed as activity only;
    - filesystem has no `.floe\blocks` or new Field membership artifacts.

## Risk assessment

- Risk: accidental webhook Scope model invention. Mitigation: keep changes inside `ingestWebhook`/`emitTriggerEvent`, add tests asserting Default Scope and no route/config Scope surface.
- Risk: file membership inference from tool activity. Mitigation: keep `files_touched` under Work Log/telemetry activity only and add negative filesystem/membership tests.
- Risk: Work Log schema/docs drift. Mitigation: update `WorkLogEntry`, renderer, tests, and any source-of-truth docs touched by this slice together; use `**Scope:**` consistently.
- Risk: runtime log writes missing Scope on error/fallback paths. Mitigation: set `turn.scope_id` in `startTurn` with Default fallback so both success and error `writeWorkLog` paths receive it.
- Risk: bridge type compatibility gaps. Mitigation: add optional/required `scope_id` typing to bridge `EventEnvelope` but tolerate old/malformed deliveries by falling back to Default; extend `getContext` typing to include existing bus `scope_id`.
- Risk: using Runtime Telemetry as future index could be mistaken for canonical Work Log storage. Mitigation: document telemetry as query/render hint and keep committed Markdown Work Log as the audit artifact; do not create a separate activity store.

## Decision confidence

- Confidence: high
- Reasons:
  - #21/#22/#23 code already provides ScopeStore, Context/Event Scope propagation, and Pulse-fired Scope propagation; #24 can reuse those owners rather than inventing new architecture.
  - Webhook Default Scope fallback already mostly emerges from `emitTriggerEvent` when `scope_id` is absent; #24 primarily needs explicitness and regression tests.
  - Work Log ownership is narrow and centralised in one bridge adapter path plus one renderer module.
  - Source docs, ADR-0004, and current code agree on the key invariant: Scope is substrate-owned/derived; Field/files/extensions/capabilities must not fake membership.
- Open questions:
  - None requiring human decision before implementation if the implementer limits indexing/rendering support to Work Log metadata plus existing Runtime Telemetry. If implementation proposes a new Work Log API/table or FloeWeb projection, stop for architecture review because that may become a second activity/projection path.
