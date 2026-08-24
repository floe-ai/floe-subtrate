# Floe Runtime Contracts

This document is the implementation contract for the first TypeScript build.
Services may use matching TypeScript types internally, but they must communicate
only through HTTP, WebSocket, and persisted state they own.

## Local Ports

- `floe-bus`: `127.0.0.1:5377`
- `floe-app`: `127.0.0.1:5379`
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

## Turn Results, Emits, and Requests

One non-empty natural model completion is recorded as an actor-attributed
message in the delivery's originating Context. This is a record-only operation:
it does not resolve destinations, fan out, wake subscribers, or create another
response expectation. Tool calls, scratch reasoning, and telemetry remain work
trace rather than Context conversation.

`emit` remains the intentional event/effect operation. The model-facing
`request(actor, work)` affordance establishes one durable dependency using the
existing Event, delivery, pending-response, and correlation machinery. The
requested actor completes normally; the bus owns the exact return path and
resumes the requester with the result or terminal failure.

Runtime prompts contain a compact causal Context orientation and the current
input. Context history, participant inventory, and the workspace actor directory
are not injected automatically; actors retrieve bounded history or discover
actors when the current work requires it.

## Validation Baseline

Local and CI validation use:

- Unit tests for IDs, config, queue eligibility, and `.floe/` template logic.
- Contract tests against real daemon processes using temp `FLOE_HOME`.
- Browser/UI tests against the fake adapter.
- Live runtime smoke tests only when `FLOE_LIVE_COPILOT=1`.
