# Floe

Floe is a local daemon-driven substrate with three independent services:

- `floe-bus`: durable event, queue, wait, workspace, and endpoint daemon
- `floe-bridge`: runtime boundary and project `.floe/` loader
- `floe-web`: local operator console

The local development and CI runtime adapter is deterministic fake runtime, so
the core substrate can be tested without spending Copilot premium requests. It
is development-only; the first real runtime target remains the Copilot CLI SDK.

## Local Start

```bash
npm install
npm run floe -- setup -- --no-autostart --no-open
```

Open:

```text
http://127.0.0.1:5378
```

Useful commands:

```bash
npm run floe -- status
npm run floe -- stop
npm run floe -- restart
npm run floe -- logs
npm run floe -- autostart off
```

When passing CLI flags through `npm run floe`, put `--` before the flags, as in
`npm run floe -- setup -- --no-autostart --no-open`. A packaged `floe` binary
does not need the extra separator.

## Validation

```bash
npm run build
npm test
```

The black-box vertical-slice test starts real bus and bridge processes against a
temporary `FLOE_HOME`, registers a project, verifies `.floe/` initialization,
sends a human message, receives fake agent progress/output, and resumes a
waiting fake agent with a later message. It also verifies bus-owned
`wait_refresh` generation and delivery acknowledgement state.

## Copilot Adapter

`CopilotSdkAdapter` is intentionally gated. The fake adapter is the baseline for
normal local development and CI. Live Copilot smoke tests should only run with:

```bash
FLOE_RUNTIME_ADAPTER=copilot FLOE_LIVE_COPILOT=1
```

The live adapter should stay sparse until premium requests are available.
