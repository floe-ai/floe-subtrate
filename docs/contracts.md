# Floe Runtime Contracts

This document is the implementation contract for the first TypeScript build.
Services may use matching TypeScript types internally, but they must communicate
only through HTTP, WebSocket, and persisted state they own.

## Local Ports

- `floe-bus`: `127.0.0.1:5377`
- `floe-web`: `127.0.0.1:5378`
- `floe-bridge`: outbound bus connection only

## Runtime Adapter Boundary

The bridge owns runtime-specific behavior. Runtime adapters implement:

```ts
interface RuntimeAdapter {
  readonly name: string;
  handleBundle(context: RuntimeContext, bundle: DeliveryBundle): Promise<void>;
}
```

Local development and CI use `FakeRuntimeAdapter` to exercise the real
bus/bridge/runtime boundary without consuming Copilot premium requests. It is
development-only and must not define product semantics. `CopilotSdkAdapter` is
the first real runtime target and remains gated behind explicit configuration
and live-test environment flags.

## Event Semantics

- The bus persists one canonical event envelope.
- Routing uses `destination_endpoint_id`.
- `emit` persists an event, queues it for the destination, and returns.
- `yield` persists an outbound event and registers a wait for the source
  endpoint as one durable operation.
- Open waits can be resumed by any queued event addressed to the waiting agent.
- Correlated waits filter only when `wait.mode` is `correlated` and an expected
  correlation id is present.
- Queued events are delivered as bundles at safe bridge/runtime boundaries.
- Delivery state progresses durably as `queued -> reserved ->
  delivered_to_bridge -> injected_to_runtime -> acknowledged`, with failed and
  dead-letter states available for retries and lease expiry.
- Wait refresh timing is bus-owned. The agent-facing `yield` contract contains
  only the outbound event and wait filter/batch options; `wait_refresh` is an
  internal bus-generated resume event for held yielded waits.

## Validation Baseline

Local and CI validation use:

- Unit tests for IDs, config, queue eligibility, and `.floe/` template logic.
- Contract tests against real daemon processes using temp `FLOE_HOME`.
- Browser/UI tests against the fake adapter.
- Live Copilot smoke tests only when `FLOE_LIVE_COPILOT=1`.
