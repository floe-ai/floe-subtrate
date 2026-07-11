/**
 * Slice 3 — First-class human actor identity.
 *
 * A human actor is a first-class endpoint (participant, can emit) that is
 * NEVER auto-woken by a delivery bundle.  actor_kind = 'human' skips
 * tryCreateDeliveryForEndpoint regardless of bridge_id or status.
 *
 * Agent actors (default) are unchanged.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "../store.js";
import { defaultConfig } from "../config.js";

const WS = "workspace:test-human";
const AGENT_EP = "actor:human-test:agent1";
const HUMAN_EP = "actor:human-test:human1";
const BRIDGE = "bridge:test-human";

const noop = () => {};

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-human-"));
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
    thread_id: overrides.thread_id ?? "",
    correlation_id: overrides.correlation_id ?? null,
    content: overrides.content ?? { text: "hello" },
    response: overrides.response,
    metadata: overrides.metadata ?? {},
    idempotency_key: overrides.idempotency_key ?? null,
    context_id: overrides.context_id,
    current_delivery_context_id: overrides.current_delivery_context_id,
  };
}

describe("BusStore — human actor identity (Slice 3)", () => {
  let store: BusStore;
  let cleanup: () => void;

  beforeEach(() => {
    const made = makeStore();
    store = made.store;
    cleanup = made.cleanup;
  });
  afterEach(() => cleanup());

  it("registerEndpoint stores actor_kind='human' and returns it", () => {
    const ep = store.registerEndpoint(
      { endpoint_id: HUMAN_EP, workspace_id: WS, name: "Human User", actor_kind: "human" },
      noop
    ) as any;
    expect(ep.actor_kind).toBe("human");
  });

  it("registerEndpoint defaults actor_kind to 'agent' when omitted", () => {
    const ep = store.registerEndpoint(
      { endpoint_id: AGENT_EP, workspace_id: WS, name: "My Agent" },
      noop
    ) as any;
    expect(ep.actor_kind).toBe("agent");
  });

  it("human actor can be added as a context participant (same as any other actor)", () => {
    store.registerEndpoint(
      { endpoint_id: HUMAN_EP, workspace_id: WS, name: "Human User", actor_kind: "human" },
      noop
    );
    store.registerEndpoint(
      { endpoint_id: AGENT_EP, workspace_id: WS, name: "Agent", actor_kind: "agent" },
      noop
    );
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: HUMAN_EP,
      participants: [HUMAN_EP, AGENT_EP],
    });
    expect(store.contextStore.isParticipant(ctx, HUMAN_EP)).toBe(true);
    expect(store.contextStore.isParticipant(ctx, AGENT_EP)).toBe(true);
  });

  it("human actor can emit into a context it participates in (participation gate passes)", () => {
    store.registerEndpoint(
      { endpoint_id: HUMAN_EP, workspace_id: WS, name: "Human User", actor_kind: "human" },
      noop
    );
    store.registerEndpoint(
      { endpoint_id: AGENT_EP, workspace_id: WS, name: "Agent", actor_kind: "agent" },
      noop
    );

    const result = store.submitEvent(
      emitCommand({
        source_endpoint_id: HUMAN_EP,
        destination: { kind: "endpoint", endpoint_id: AGENT_EP },
      }),
      noop
    );
    expect(result.event.event_id).toMatch(/^evt_/);
    expect(result.event.context_id).toMatch(/^ctx_/);
  });

  it("human actor is NEVER auto-woken — no delivery bundle created even with bridge_id attached", () => {
    // Register a bridge so the endpoint has a bridge_id (required for agent delivery)
    store.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', '{}', ?, ?)
    `).run(BRIDGE, new Date().toISOString(), new Date().toISOString());

    store.registerEndpoint(
      { endpoint_id: HUMAN_EP, workspace_id: WS, name: "Human User", actor_kind: "human", bridge_id: BRIDGE },
      noop
    );
    store.registerEndpoint(
      { endpoint_id: AGENT_EP, workspace_id: WS, name: "Agent", actor_kind: "agent" },
      noop
    );

    // Agent emits to human — queues an event for HUMAN_EP
    store.submitEvent(
      emitCommand({
        source_endpoint_id: AGENT_EP,
        destination: { kind: "endpoint", endpoint_id: HUMAN_EP },
      }),
      noop
    );

    // No delivery bundle must exist for the human endpoint
    const bundles = store.db
      .prepare("SELECT * FROM delivery_bundles WHERE endpoint_id = ?")
      .all(HUMAN_EP) as any[];
    expect(bundles).toHaveLength(0);

    // But the event IS queued (the human can read it via event history)
    const queued = store.db
      .prepare("SELECT * FROM event_queue WHERE destination_endpoint_id = ?")
      .all(HUMAN_EP) as any[];
    expect(queued.length).toBeGreaterThan(0);
  });

  it("agent actor DOES receive a delivery bundle when it has a bridge_id (unchanged behaviour)", () => {
    store.db.prepare(`
      INSERT INTO bridges (bridge_id, status, capabilities_json, last_seen_at, created_at)
      VALUES (?, 'online', '{}', ?, ?)
    `).run(BRIDGE, new Date().toISOString(), new Date().toISOString());

    store.registerEndpoint(
      { endpoint_id: HUMAN_EP, workspace_id: WS, name: "Human User", actor_kind: "human" },
      noop
    );
    store.registerEndpoint(
      {
        endpoint_id: AGENT_EP,
        workspace_id: WS,
        name: "Agent",
        actor_kind: "agent",
        bridge_id: BRIDGE,
        status: "idle",
      },
      noop
    );

    // Human emits to agent
    store.submitEvent(
      emitCommand({
        source_endpoint_id: HUMAN_EP,
        destination: { kind: "endpoint", endpoint_id: AGENT_EP },
      }),
      noop
    );

    const bundles = store.db
      .prepare("SELECT * FROM delivery_bundles WHERE endpoint_id = ?")
      .all(AGENT_EP) as any[];
    // Agent should receive a delivery
    expect(bundles.length).toBeGreaterThan(0);
  });

  it("human actor can subscribe to context events (wakeup model is irrelevant to subscription record)", () => {
    store.registerEndpoint(
      { endpoint_id: HUMAN_EP, workspace_id: WS, name: "Human User", actor_kind: "human" },
      noop
    );
    const ctx = store.contextStore.createContext({
      workspace_id: WS,
      created_by_endpoint_id: HUMAN_EP,
      participants: [HUMAN_EP],
    });
    store.contextStore.subscribeToContext(ctx, HUMAN_EP, ["message"]);
    expect(store.contextStore.isSubscribed(ctx, HUMAN_EP, "message")).toBe(true);
    // Even though subscribed, fan-out does NOT create a delivery for the human
    // (tryCreateDeliveryForEndpoint returns null for actor_kind='human')
  });
});
