/**
 * Slice 3 (reworked) — Runtime-based delivery gate.
 *
 * The substrate has exactly ONE actor abstraction. Delivery is gated on
 * runtime attachment (bridge_id + status), never on a stored backing label.
 *
 * - An actor with no live agent runtime (bridge_id = null) queues events as
 *   readable context history but never receives a delivery bundle.
 * - An actor with a live agent runtime attached gets delivered normally.
 *
 * No actor_kind column; no human/agent distinction stored anywhere.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "../store.js";
import { defaultConfig } from "../config.js";

const WS = "workspace:test-runtime-delivery";
const ACTOR_NO_RUNTIME = "actor:runtime-test:no-runtime";
const ACTOR_WITH_RUNTIME = "actor:runtime-test:with-runtime";
const BRIDGE = "bridge:test-runtime";

const noop = () => {};

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-runtime-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function emitCommand(
  overrides: Partial<EventCommand> & {
    source_endpoint_id: string;
    destination: EventCommand["destination"];
  }
): EventCommand {
  return {
    type: overrides.type ?? "message",
    workspace_id: overrides.workspace_id ?? WS,
    source_endpoint_id: overrides.source_endpoint_id,
    destination: overrides.destination,
    thread_id: "",
    correlation_id: null,
    content: overrides.content ?? { text: "hello" },
    response: overrides.response,
    metadata: {},
    idempotency_key: null,
    context_id: overrides.context_id,
    current_delivery_context_id: overrides.current_delivery_context_id,
  };
}

describe("BusStore — runtime-based delivery gate (Slice 3 rework)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  it("an actor with no runtime attached receives no delivery bundle but accrues context history", () => {
    // Register actor with no bridge_id (runtime-less)
    store.registerEndpoint(
      { endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Actor A" },
      noop
    );
    store.registerEndpoint(
      { endpoint_id: ACTOR_WITH_RUNTIME, workspace_id: WS, name: "Actor B" },
      noop
    );

    // Route a message to the runtime-less actor
    const result = store.submitEvent(
      emitCommand({
        source_endpoint_id: ACTOR_WITH_RUNTIME,
        destination: { kind: "endpoint", endpoint_id: ACTOR_NO_RUNTIME },
      }),
      noop
    );

    // No delivery bundle for the runtime-less actor
    const bundles = store.db
      .prepare("SELECT * FROM delivery_bundles WHERE endpoint_id = ?")
      .all(ACTOR_NO_RUNTIME) as any[];
    expect(bundles).toHaveLength(0);

    // But the event IS queued and readable via context history
    const queued = store.db
      .prepare("SELECT * FROM event_queue WHERE destination_endpoint_id = ?")
      .all(ACTOR_NO_RUNTIME) as any[];
    expect(queued.length).toBeGreaterThan(0);

    const eventRow = store.db
      .prepare("SELECT event_id FROM events WHERE event_id = ?")
      .get(result.event.event_id);
    expect(eventRow).not.toBeUndefined();
  });

  it("an actor with a live runtime attached receives a delivery bundle", () => {
    // Provision a bridge so ACTOR_WITH_RUNTIME has a real runtime
    store.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', '{}', ?, ?)
    `).run(BRIDGE, new Date().toISOString(), new Date().toISOString());

    store.registerEndpoint(
      { endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Actor A" },
      noop
    );
    store.registerEndpoint(
      {
        endpoint_id: ACTOR_WITH_RUNTIME,
        workspace_id: WS,
        name: "Actor B",
        bridge_id: BRIDGE,
        status: "idle",
      },
      noop
    );

    // Route a message to the runtime-connected actor
    store.submitEvent(
      emitCommand({
        source_endpoint_id: ACTOR_NO_RUNTIME,
        destination: { kind: "endpoint", endpoint_id: ACTOR_WITH_RUNTIME },
      }),
      noop
    );

    const bundles = store.db
      .prepare("SELECT * FROM delivery_bundles WHERE endpoint_id = ?")
      .all(ACTOR_WITH_RUNTIME) as any[];
    expect(bundles.length).toBeGreaterThan(0);
  });

  it("endpoints table has no actor_kind column", () => {
    // The substrate must not store any backing label on actors
    const columns = store.db
      .prepare("PRAGMA table_info(endpoints)")
      .all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    expect(names).not.toContain("actor_kind");
  });

  it("registerEndpoint does not accept or persist any backing-kind field", () => {
    const ep = store.registerEndpoint(
      { endpoint_id: ACTOR_NO_RUNTIME, workspace_id: WS, name: "Actor A" },
      noop
    ) as any;
    // No backing-kind property on the returned endpoint
    expect(ep.actor_kind).toBeUndefined();
  });
});
