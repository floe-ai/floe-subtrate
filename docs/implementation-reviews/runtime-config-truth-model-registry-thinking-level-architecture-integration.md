# Architecture Integration Brief: runtime-config-truth-model-registry-thinking-level

**Scout role:** Architecture Scout (no product code changed). This brief is the integration gate for a non-trivial cross-layer slice spanning `floe-bus`, `floe-bridge`, `floe-web`, and the embedded `pi-agent-core` runtime.

**Slice (three coupled corrections):**
1. **Runtime truth** — Floe Web must reflect the *effective running bridge adapter*, not a config-inferred guess that collapses to "fake".
2. **Model/auth registry truth** — the bus auth/model list must come from Floe's shared auth/model registry (built-ins **plus** `models.json` overlays), not raw `pi-ai` built-ins.
3. **Workspace-default thinking level** — add a workspace-default reasoning/thinking level (no per-agent override yet) wired bus → bridge → Pi Agent Core, surfaced and editable in the web Runtime section.

> Note: `architecture.map.yaml` does **not** exist in this repository. Ownership is mapped below from the actual package layout and the source-of-truth docs (`CONTEXT.md`, `PRODUCT.md`, `docs/north-star.md`, `docs/adr/`). If a future `architecture.map.yaml` is introduced, reconcile the cluster/cell names there with this brief.

---

## 1. Ownership and affected clusters / cells / modules

Floe is a 4-package monorepo. Treat each package as a **cluster**; the files below are the affected **cells/modules**.

### `floe-bus` (substrate + public HTTP API cluster) — **owns truth surfaced to web**
- `floe-bus/src/server.ts` — public API boundary. Affected endpoints:
  - `GET /v1/local-config/status` (`server.ts:127`)
  - `GET /v1/auth/profiles` + `loadAuthProfiles()` (`server.ts:490`, `server.ts:1165`)
  - `GET /v1/auth/models` (`server.ts:500`) — **currently raw `pi-ai` built-ins** via `getModels`/`getProviders` (`server.ts:8`, `server.ts:502-505`)
  - `GET/POST /v1/runtime/bindings`, `/clear`, `/resolve` (`server.ts:426`, `431`, `461`, `482`)
  - `RuntimeBindingUpsertSchema` (`server.ts:52-58`)
- `floe-bus/src/store.ts` — persistence. Affected:
  - `runtime_bindings` table + `model` column migration (`store.ts:368-379`, `store.ts:434`)
  - `RuntimeBindingRecord` type (`store.ts:182-191`), `rowToRuntimeBinding` (`store.ts:2203`)
  - `upsertRuntimeBinding` (`store.ts:778`), `getRuntimeBindingResolution` (`store.ts:742`), `listRuntimeBindings` (`store.ts:735`)
  - `bridges` table + `registerBridge` storing `capabilities_json` incl. `runtime_adapters` (`store.ts:259-265`, `store.ts:1011-1024`)
- `floe-bus/src/config.ts` — `LocalConfigSchema`. **Conflict source:** bus schema has **no** `bridge.runtime_adapter` field (`config.ts:23-30`).

### `floe-bridge` (runtime embodiment cluster) — **owns effective adapter + runtime auth**
- `floe-bridge/src/daemon.ts` — `chooseAdapter()` (`daemon.ts:581-594`), bridge registration with `runtime_adapters` (`daemon.ts:48-52`), endpoint metadata `runtime_adapter` (`daemon.ts:254`, `daemon.ts:408`), `resolveAuthProfile()` (`daemon.ts:531`), `effectiveRuntime` assembly (`daemon.ts:457-465`).
- `floe-bridge/src/config.ts` — bridge `LocalConfigSchema` **does** include `bridge.runtime_adapter` (`config.ts:27`).
- `floe-bridge/src/auth.ts` — `BridgeModelRegistry` (built-ins + `models.json` overlay, `auth.ts:174-234`), `resolveRuntimeAuth()` (`auth.ts:250-376`), `AgentRuntimeConfig` (`auth.ts:85-97`).
- `floe-bridge/src/adapters/pi-agent-core-adapter.ts` — `AgentFactoryInput` (`:23-28`), `getOrCreateSession` (`:308-402`), `createDefaultAgent` building `new Agent({ initialState: { model, systemPrompt, tools } })` (`:843-849`). **No `thinkingLevel` is threaded today.**
- `floe-bridge/src/adapters/runtime-adapter.ts` — `RuntimeAdapter`/`RuntimeContext` contract.
- `floe-bridge/src/bus-client.ts` — `resolveRuntimeBinding()` (`:180`) and `RuntimeBindingResolution` type.

### `floe-cli` (operator/config cluster) — **owns the canonical shared registry**
- `floe-cli/src/auth.ts` — `FloeModelRegistry` (`auth.ts:206-288`), `FloeAuthStorage`, `createAuthRuntime()` (`auth.ts:301-314`), `ProfilesDocumentSchema` / `ModelsConfigSchema` (`auth.ts:18-52`), `getProviderAuthStatus` for `models_json_key`/`models_json_command` sources (`auth.ts:270-279`).

### `floe-web` (FloeWeb rendering cluster) — **consumes truth; must not own it**
- `floe-web/src/main.tsx` — `LocalConfigStatus`/`ModelInfo`/`RuntimeBinding` types (`:105-126`), runtime adapter derivation (`:438`, `:453-463`, `:2603-2613`), `refresh()` fetches (`:750-756`, `:773`), models fetch (`:821-829`), `RuntimeSection` (`:1947`), `setWorkspaceProfile`/`setWorkspaceModel` (`:1454-1487`), fake-adapter callout (`:2272-2277`), `canMessageRuntime` gating (`:463`, `:2363`, `:2370`).
- Playwright specs that mock these endpoints: `floe-web/tests/helpers.ts:104-122`, `channel-activity.spec.ts:133-228`, `context-rendering.spec.ts:164-206`, `workspace-management.spec.ts:291-299`, `no-actor-bleed.spec.ts`, `actor-neutral-ui.spec.ts`.

### `pi-mono/packages/agent` (external runtime engine — **read-only dependency, do not modify**)
- `src/types.ts:231` `ThinkingLevel = "off"|"minimal"|"low"|"medium"|"high"|"xhigh"`; `AgentState.thinkingLevel` (`:264-270`).
- `src/agent.ts:73` accepts `initialState.thinkingLevel` (default `"off"`); `:414` maps it to `reasoning` in the loop config. **`thinkingLevel` is the only wiring needed; the engine already supports it.**

---

## 2. Current interaction model and source-of-truth problems

### 2.1 Effective adapter (Problem 1 — misleading "fake" state)

How the adapter is actually decided (ground truth, bridge-owned):
- `chooseAdapter(configPath, config)` (`daemon.ts:581`): uses `FLOE_RUNTIME_ADAPTER` env **or** `config.bridge.runtime_adapter`; when **unset**, it defaults to `PiAgentCoreAdapter` if any non-`fake` profile exists, else `FakeRuntimeAdapter` (`daemon.ts:583-589`).
- The chosen adapter name is reported to the bus two ways:
  - bridge registration capabilities `runtime_adapters: [adapter.name]` → persisted in `bridges.capabilities_json` (`daemon.ts:49`, `store.ts:1011-1024`).
  - per-endpoint `metadata.runtime_adapter` (`daemon.ts:254`, `daemon.ts:408`).

How the web currently decides (`main.tsx:453-463`):
- **Preferred source:** `endpointRuntimeAdapter(selectedAgent)` reads `metadata.runtime_adapter` from the selected endpoint (`:2603-2613`) — this is correct, bridge-reported truth, but only available when an agent endpoint is selected and carries metadata.
- **Fallback source:** `bridgeRuntimeAdapter` from `GET /v1/local-config/status` → `config.bridge.runtime_adapter` (`:756`), defaulting to `"fake"` when null (`:456`).

**The conflict (verified):**
- The **bus** `LocalConfigSchema` (`floe-bus/src/config.ts:23-30`) does **not** declare `bridge.runtime_adapter`. `GET /v1/local-config/status` returns the bus-parsed `config.bridge` (`server.ts:127-134`), so `runtime_adapter` is **silently stripped** and is always `undefined` over the wire.
- Therefore `bridgeRuntimeAdapter` is always `null` → `bridgeRuntimeAdapterName` falls back to `"fake"` whenever endpoint metadata is not the resolving source (e.g. no agent selected, or metadata absent).
- Worse: even if the bus schema were widened, `config.bridge.runtime_adapter` is frequently **unset** while `chooseAdapter` still selects `pi-agent-core` by default — so config inference can **never** be authoritative. Only the bridge's reported adapter is ground truth.
- There is **no GET endpoint** exposing `bridges.capabilities_json`/`runtime_adapters` (only `POST /v1/bridges/register` and `/liveness`, `server.ts:519`, `527`). The truth is persisted but unreachable by the web.

**Result:** The UI labels the runtime "fake" (`main.tsx:2272-2277`) and disables messaging via `runtimeBlockedByFakeAdapter` even when `pi-agent-core` is the live adapter — a fake-only-looking failure path that violates the "no fake-only success path unless explicitly labelled" quality bar (`AGENTS.md:174`).

### 2.2 Auth/model registry (Problem 2 — divergent model list)

- `GET /v1/auth/models` (`server.ts:500-517`) enumerates **only** `pi-ai` built-ins (`getProviders().flatMap(getModels)`); it ignores `~/.floe/auth/models.json` overlays.
- The bridge runtime path uses `BridgeModelRegistry` (`floe-bridge/src/auth.ts:174-234`) which merges built-ins **plus** `models.json` custom models/providers, and `resolveRuntimeAuth` rejects unknown models with `runtime_model_unknown` (`auth.ts:352-357`).
- The canonical implementation is `FloeModelRegistry` in `floe-cli/src/auth.ts:206-288` (same merge logic, plus `getProviderAuthStatus` reporting `models_json_key`/`models_json_command`).
- `GET /v1/auth/profiles` + `loadAuthProfiles` (`server.ts:490`, `1165-1188`) re-parse `auth/profiles.yaml` with a thin ad-hoc reader instead of the shared `ProfilesDocumentSchema`/loader.

**Result / divergence:** A user can configure a working `models.json` model that the **bridge accepts** but the **web dropdown never shows** (web only lists built-ins). They cannot select it; or if a binding references it, the web synthesizes a placeholder option (`main.tsx:439-451`) while the real metadata (`reasoning`, `contextWindow`) is missing — which directly breaks Problem 3 (thinking control needs the model's `reasoning` flag). This is the same registry logic implemented **three times** (`floe-cli`, `floe-bridge`, and a thinner bus copy), drifting in the bus.

### 2.3 Runtime bindings + thinking level (Problem 3)

- Bindings carry `auth_profile` + `model`, at three scopes `agent | workspace_default | global_default` (`store.ts:180-191`), resolved with precedence agent → workspace → global (`getRuntimeBindingResolution`, `store.ts:742-776`; `resolveAuthProfile`, `daemon.ts:531-560`).
- `effectiveRuntime` (`daemon.ts:457-465`) flows into the adapter as `AgentRuntimeConfig`, then `getOrCreateSession` builds the Pi `Agent` (`pi-agent-core-adapter.ts:389-398`, `843-849`). **`thinkingLevel` is absent at every hop.**
- The web Runtime section (`main.tsx:1947-1987`) exposes workspace profile + model only; `setWorkspaceModel` (`:1475-1487`) is the exact template for adding a workspace-default thinking control.
- `/v1/auth/models` already returns a per-model `reasoning` boolean (`server.ts:511`), and the web already renders "reasoning" suffix (`main.tsx:1978`) — so reasoning-capability gating data is available once the registry is correct (depends on Problem 2).

---

## 3. Existing extension points (use these; do not invent parallels)

- **Effective adapter exposure:** the bridge already reports `runtime_adapters` via `registerBridge` capabilities (`store.ts:1011`) and per-endpoint `metadata.runtime_adapter`. Add a **read** path (e.g. `GET /v1/runtime/status` or fold an authoritative `runtime_adapter`/`bridge_online` into `GET /v1/local-config/status`) sourced from `bridges.capabilities_json`, **not** from static config. The web should consume that single authoritative signal in `main.tsx:453-463` instead of the config-inferred fallback.
- **Shared registry:** reuse `FloeModelRegistry` + profile loader from `floe-cli/src/auth.ts` (or promote it to a shared module imported by the bus). `createAuthRuntime(configPath, config)` (`floe-cli/src/auth.ts:301`) returns `{ modelRegistry, profiles, ... }` ready to back `/v1/auth/models` and `/v1/auth/profiles`. The bus already resolves `auth/profiles.yaml` and `auth/models.json` paths the same way (`resolveLocalPath` + `home/auth`, `server.ts:1171-1172`, `floe-cli/src/auth.ts:290-299`).
- **Thinking-level storage:** follow the existing `addColumnIfMissing("runtime_bindings", "model", "TEXT")` convention (`store.ts:434`) to add a nullable `thinking_level` column; extend `RuntimeBindingRecord`, `rowToRuntimeBinding`, `upsertRuntimeBinding`, `getRuntimeBindingResolution`. Validate via Zod in `RuntimeBindingUpsertSchema` (`server.ts:52`) using the `ThinkingLevel` enum.
- **Thinking-level runtime wiring:** thread through `AgentRuntimeConfig` (`floe-bridge/src/auth.ts:85`), `effectiveRuntime` (`daemon.ts:457`), `AgentFactoryInput` (`pi-agent-core-adapter.ts:23`), into `new Agent({ initialState: { ..., thinkingLevel } })` (`:844`). Engine maps it automatically (`pi-mono agent.ts:73,414`).
- **Web controls:** mirror `setWorkspaceModel` (`main.tsx:1475`) for `setWorkspaceThinkingLevel`; render a `<select>` in `RuntimeSection` (`:1969-1981`); gate visibility/options on the selected model's `reasoning` flag from `availableModels`.
- **Status transition reuse:** the `runtime_unconfigured → idle` flip is keyed on binding model presence (`server.ts:440-457`). Thinking level must **not** participate in that gating (it is optional).

---

## 4. Do-not-bypass systems

- **`floe-bus` is the only API the web may call.** Web must not read the bridge or config files directly, nor create a runtime path around bus/bridge (`PRODUCT.md:45`, `north-star.md:75`).
- **The effective adapter is bridge-owned truth.** The web must *reflect* it; it must never set it, and must not re-derive it from static config. `chooseAdapter` (`daemon.ts:581`) stays the sole decision point.
- **Do not add a 4th model-registry implementation.** Reuse/share `FloeModelRegistry`; do not extend the thin bus copy in `server.ts`.
- **Do not bypass `runtime_bindings`** for runtime selection. Thinking level is a binding-resolved value with the same precedence machinery; do not add a separate side table or config file for it.
- **Do not bypass Zod schemas** at the API boundary (`server.ts` schemas) or `BusStore` transactions.
- **Do not modify `pi-mono/packages/agent`.** It already supports `thinkingLevel`; treat it as a read-only dependency.
- **Secrets stay server-side.** `auth.json` credentials and `models.json` `apiKey`/`!command` values must never be serialized to the web. `/v1/auth/models` may expose model metadata only (id/name/provider/api/reasoning/contextWindow/maxTokens/input) — mirror the existing projection (`server.ts:506-515`).
- **Do not touch React Flow Field/canvas interaction.** This slice is confined to the inspector `RuntimeSection` and the channel panel; Block Library drag/drop, node icons/labels/handles/selection, pan/zoom/drag, rename/open and connection affordances must be untouched (`AGENTS.md:70`).

---

## 5. Integration plan (bus ↔ bridge ↔ web)

### Bus
1. **Adapter truth read path.** Add a GET that returns the authoritative effective adapter and bridge liveness from `bridges.capabilities_json` (e.g. `GET /v1/runtime/status` → `{ bridge_online, runtime_adapters }`, or augment `/v1/local-config/status` with a `runtime` block derived from the bridges table — **not** from `config.bridge`). Add a `listBridges()`/accessor on `BusStore`.
2. **Shared registry for `/v1/auth/models`.** Replace raw `getModels`/`getProviders` (`server.ts:500-517`) with the shared `FloeModelRegistry`, filtered by optional `provider`, projecting safe metadata only. Refresh on read or cache per request.
3. **Shared profile loader for `/v1/auth/profiles`.** Replace `loadAuthProfiles` (`server.ts:1165`) with the shared `ProfilesDocumentSchema` loader; preserve the existing `default_auth_profile` response field (`server.ts:493-497`).
4. **Thinking-level persistence.** Migration `addColumnIfMissing("runtime_bindings", "thinking_level", "TEXT")`; extend record type/mapper/upsert/resolution; add `thinking_level` (ThinkingLevel enum, nullable) to `RuntimeBindingUpsertSchema` and the upsert call (`server.ts:431-439`).

### Bridge
5. **Resolve + thread thinking level.** Extend `RuntimeBindingResolution` and `bus-client.resolveRuntimeBinding` to carry `workspace_thinking_level`; resolve in `resolveAuthProfile` (`daemon.ts:531`) with workspace-default precedence (agent override deferred); add to `AgentRuntimeConfig` and `effectiveRuntime` (`daemon.ts:457`).
6. **Apply in adapter.** Add `thinkingLevel` to `AgentFactoryInput` and pass into `new Agent({ initialState: { thinkingLevel } })` (`pi-agent-core-adapter.ts:23-28`, `843-849`). Include `thinking_level` in the session cache key (`getOrCreateSession`, `:316-317`) so changing it rebuilds the session. Clamp/ignore `xhigh` when the model family does not support it (use `pi-ai` capability check; default unknown/unsupported to `off`/clamp down rather than erroring).
7. **Adapter naming unchanged.** `FakeRuntimeAdapter.name = "fake"`, `PiAgentCoreAdapter.name = "pi-agent-core"` remain the canonical strings the web compares against.

### Web
8. **Consume authoritative adapter.** In `refresh()` (`main.tsx:750-756`) fetch the new adapter-truth signal and replace the `config.bridge.runtime_adapter` fallback in `bridgeRuntimeAdapterName` (`:453-463`). Keep `endpointRuntimeAdapter` as the per-agent override but ensure the no-agent/global case uses bridge truth, not `"fake"` by default. Update the callout copy (`:2272-2277`) to reflect real state and correct remediation.
9. **Model list now overlay-aware** automatically once `/v1/auth/models` is registry-backed; the placeholder synthesis (`:439-451`) becomes a rare fallback.
10. **Workspace-default thinking control.** Add `thinkingLevel` to `RuntimeBinding` type (`:105-112`); add `setWorkspaceThinkingLevel` (mirror `:1475`); render a gated `<select>` in `RuntimeSection` (`:1969-1981`) shown for reasoning-capable selected models.

---

## 6. Regression checklist

- [ ] `runtime_unconfigured → idle` status flip on binding upsert still works (`server.ts:440-457`); thinking level does not gate it.
- [ ] Binding precedence agent → workspace → global preserved for auth_profile and model (`daemon.ts:537-560`; `tests/src/vertical-slice.test.ts:121-129`).
- [ ] `/v1/auth/models` still honors the `provider` query filter and returns the same safe field projection shape (`server.ts:500-516`); existing web placeholder logic still tolerates an unknown bound model.
- [ ] `/v1/auth/profiles` still returns `{ profiles, default_auth_profile }` (`server.ts:490-498`); empty-profiles path (no `profiles.yaml`) still yields `[]` without throwing.
- [ ] Existing Playwright mocks still satisfy the app: `helpers.ts`, `channel-activity.spec.ts`, `context-rendering.spec.ts`, `workspace-management.spec.ts`, `no-actor-bleed.spec.ts`, `actor-neutral-ui.spec.ts` — any new endpoint must be mocked or gracefully `.catch(() => null)` like `/v1/local-config/status` (`main.tsx:753`).
- [ ] `canMessageRuntime`/`runtimeBlockedByFakeAdapter` no longer false-positives on a real `pi-agent-core` bridge; fake adapter still correctly blocks for non-`fake` provider profiles (`main.tsx:458-463`).
- [ ] Pi session reuse/replacement semantics intact when only thinking level changes (cache key includes it; `SessionEnd` hook still fires on replace, `:321-331`).
- [ ] No secret leakage: `auth.json`/`models.json` keys never appear in any web-facing response.
- [ ] React Flow Field canvas behavior unchanged (no edits to canvas modules).
- [ ] `FLOE_RUNTIME_ADAPTER` env override path (`daemon.ts:582`) and default-selection path (`:583-589`) still produce correct reported adapter names.

---

## 7. Targeted test plan (TDD, smallest covering selectors)

**Bus (`floe-bus`, vitest):**
- New/extended `server.test.ts`: `/v1/auth/models` includes a `models.json`-overlaid custom model and applies the `provider` filter; response excludes secret fields.
- `/v1/auth/profiles` reads via the shared loader (malformed YAML → empty + no throw).
- New adapter-truth endpoint returns `runtime_adapters` from a registered bridge; returns offline/empty when no bridge registered.
- `runtime_bindings` round-trip with `thinking_level` (upsert → list → resolve); `getRuntimeBindingResolution` surfaces workspace thinking level; null when unset; precedence unaffected.
- `RuntimeBindingUpsertSchema` rejects invalid thinking levels (zod enum).

**Bridge (`floe-bridge`, vitest):**
- `resolveAuthProfile` returns workspace thinking level; agent scope does not yet override (deferred) — assert workspace value used.
- `pi-agent-core-adapter` unit: injected `AgentFactory` receives `thinkingLevel`; `Agent` `initialState.thinkingLevel` set; changing thinking level busts the session cache key (`getOrCreateSession`).
- `chooseAdapter` reported-name matrix (env set/unset, profiles fake vs non-fake) unchanged.

**Web (`floe-web`, Playwright):**
- With endpoints carrying `metadata.runtime_adapter = "pi-agent-core"` (or the new bus truth signal), the channel is **not** blocked and the fake callout is absent.
- With fake adapter + non-fake profile, the fake callout shows and composer is disabled.
- Model dropdown lists an overlay model returned by mocked `/v1/auth/models`.
- Workspace thinking-level select renders for a reasoning-capable model, persists via POST `/v1/runtime/bindings`, and is hidden/disabled for non-reasoning models.

**End-to-end (`tests/src/vertical-slice.test.ts`):** extend to assert a workspace-default thinking level is persisted and reflected in `resolveRuntimeBinding`, and that a live `pi-agent-core` run is not reported as fake.

---

## 8. Risks / tradeoffs

- **R1 — Adapter-truth endpoint shape.** Folding adapter truth into `/v1/local-config/status` overloads a config endpoint with runtime state; a dedicated `/v1/runtime/status` is cleaner but adds a fetch + a web mock surface. *Recommendation:* dedicated read endpoint sourced from the bridges table; keep `/v1/local-config/status` config-only and stop the web from inferring adapter from it.
- **R2 — Registry sharing boundary.** `FloeModelRegistry` lives in `floe-cli`; importing CLI code into the bus may pull unwanted deps. *Recommendation:* extract the registry/profile loader into a shared module (or duplicate-then-converge) rather than importing `floe-cli` wholesale; the bus already has `pi-ai` and `zod`.
- **R3 — Registry freshness.** `FloeModelRegistry.refresh()` reads files at construction; the bus is long-lived, so `models.json` edits won't appear without a refresh. *Recommendation:* refresh per request (cheap) or expose a reload, matching `BridgeModelRegistry.refresh()` semantics.
- **R4 — `xhigh` capability.** `xhigh` is only valid for some model families (`pi-mono types.ts:228`). Passing it to an unsupported model risks provider errors. *Recommendation:* gate options to supported levels per model and clamp on the bridge.
- **R5 — Bridge liveness/staleness.** `bridges.last_seen_at` can be stale after a crash; reporting a stale adapter as "live" re-creates a subtler misleading state. *Recommendation:* incorporate a liveness/last-seen threshold in the truth signal and degrade to "offline/unknown" rather than "fake".
- **R6 — Stored thinking level vs provider-agnostic semantics.** Storing thinking level on the `workspace_default` binding row couples it to the presence of a workspace auth profile. *Recommendation:* acceptable for this slice (workspace-default only); document that thinking level applies when a workspace profile is configured, and revisit when per-agent override lands.

---

## 9. Confidence

**High** for the diagnosis (the fake-adapter inference bug, the registry divergence, and the missing `thinkingLevel` wiring are all confirmed in code with exact citations; the Pi engine already supports `thinkingLevel`).

**Medium** for the exact placement of the new adapter-truth endpoint and the registry-sharing mechanism (extract-vs-duplicate) — both are design choices to confirm with the user before implementation. Recommend a `Question` at the bus-API-shape decision and at the registry-sharing decision.

---

## 10. Invariants to preserve (explicit)

1. The web calls only `floe-bus`; no direct bridge/config/runtime path (`PRODUCT.md:45`, `north-star.md:75`, `:77`).
2. The effective runtime adapter is decided solely by the bridge (`chooseAdapter`, `daemon.ts:581`) and is **reported**, never set, by the web. The UI reflects bridge-reported truth, never static-config inference.
3. Adapter identity strings are stable: `"fake"` and `"pi-agent-core"` (`fake-runtime-adapter.ts`, `pi-agent-core-adapter.ts:74`).
4. There is exactly one runtime model/auth registry concept (built-ins + `models.json` overlay + `auth.json`/env/`models.json` key resolution); the bus must reuse it, not fork a thinner variant.
5. `runtime_bindings` is the single source of runtime selection; resolution precedence agent → workspace → global is unchanged. Per-agent thinking override is **explicitly deferred**.
6. `runtime_unconfigured ↔ idle` status transitions depend only on auth_profile/model presence, never on thinking level.
7. `emit` is the only runtime primitive exposed; no `yield`/keepalive reintroduced (`north-star.md:198-217`).
8. Secrets (`auth.json`, `models.json` keys/commands) never cross the bus→web boundary; only model metadata does.
9. Zod-at-the-boundary and `BusStore` transactional writes remain the validation/persistence path.
10. `pi-mono/packages/agent` is not modified.
11. React Flow Field/canvas interaction (Block Library DnD, node icons/labels/handles/selection, pan/zoom/drag, rename/open, connection affordances) is untouched (`AGENTS.md:70`).
12. "No fake-only success path unless explicitly labelled and approved" — the corrected UI must not present runtime state that contradicts the live adapter (`AGENTS.md:174`).

---

## 11. Evidence conflicts flagged

- **Schema conflict:** `floe-bridge/src/config.ts:27` declares `bridge.runtime_adapter`; `floe-bus/src/config.ts:23-30` omits it. Both parse the **same** `config.yaml`. `GET /v1/local-config/status` (served by the bus) therefore cannot surface `runtime_adapter`, which is the root of the web's "always fake" fallback. **Do not** "fix" this by merely adding the field to the bus schema — that still cannot reflect `chooseAdapter`'s default-selection branch (`daemon.ts:583-589`) where the adapter is `pi-agent-core` with `runtime_adapter` unset. The correct fix is bridge-reported truth.
- **Triplicated registry:** `FloeModelRegistry` (`floe-cli/src/auth.ts:206`), `BridgeModelRegistry` (`floe-bridge/src/auth.ts:174`), and the inline bus implementation (`server.ts:500-517`) encode the same intent with the bus copy already drifted (no overlay). Converge during this slice or explicitly accept the divergence (not recommended).
- **Docs vs behaviour:** `pulse-tools.ts` precedent shows tool descriptions can drift from behaviour; here the UI copy ("Set `bridge.runtime_adapter` to `pi-agent-core`", `main.tsx:2275`) prescribes a remediation the bus cannot even observe. Update copy to match the corrected, observable model.
