# Floe Runtime Contracts

This document is the implementation contract for the first TypeScript build.
Services may use matching TypeScript types internally, but they must communicate
only through HTTP, WebSocket, and persisted state they own.

## Local Ports

- `floe-bus`: `127.0.0.1:5377`
- `floe-web`: `127.0.0.1:5378`
- `floe-bridge`: outbound bus connection only

## Runtime Adapter Boundary

The bridge owns runtime-specific behavior. Runtime adapters implement the
`floe-runtime-core` contract, which defines the Floe-native endpoint processing
boundary. The operational interface is:

```ts
interface RuntimeAdapter {
  readonly name: string;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle): Promise<void>;
}
```

The semantic contract (in `floe-bridge/src/runtime-core/types.ts`) defines:
- `EndpointProcessingInput` — what the adapter receives
- `EndpointProcessingOutput` — what the adapter produces
- `FloeRuntimeContract` — the future strongly-typed adapter interface

Runtime adapters translate between the Floe-native event/endpoint model and
engine-specific assumptions. Pi's user/assistant/message model is contained
inside `PiRuntimeAdapter`.

Local development and CI use `FakeRuntimeAdapter` to exercise the real
bus/bridge/runtime boundary without consuming premium requests. It is
development-only and must not define product semantics.

## Event Semantics

- The bus persists one canonical event envelope.
- Routing uses destination selectors (endpoint or broadcast).
- `emit` persists an event, queues it for the destination, and returns.
- Events that expect a future response declare it through structured event
  metadata (`response.expected: true`), not through held runtime calls.
- Queued events are delivered as bundles at safe bridge/runtime boundaries.
- Delivery state progresses durably as `queued -> reserved ->
  delivered_to_bridge -> injected_to_runtime -> acknowledged`, with failed and
  dead-letter states available for retries and lease expiry.
- Turn end is a lifecycle signal, not a message. The bridge observes native
  runtime turn completion and reports endpoint state to the bus.

## Visible Output Policy

Runtime visible output (model-generated text) is NOT automatically converted
into a message event. It is recorded as work log / runtime trace only.

Communication happens exclusively through explicit `emit` calls. See
`docs/substrate-semantics.md` §6 for the full rule.

The previous `runtime_turn_output` adapter compatibility behaviour has been
removed. Agents must emit message events explicitly to communicate.

## Validation Baseline

Local and CI validation use:

- Unit tests for IDs, config, queue eligibility, and `.floe/` template logic.
- Contract tests against real daemon processes using temp `FLOE_HOME`.
- Browser/UI tests against the fake adapter.
- Live runtime smoke tests only when `FLOE_LIVE_COPILOT=1`.
