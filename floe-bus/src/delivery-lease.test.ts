/**
 * D5 — Lease-expiry requeue must NOT poll.
 *
 * Validates that the bus-internal lease-expiry timer fires on schedule (a
 * single-shot timer at the next lease-expiry deadline, not a recurring scan)
 * and correctly requeues expired deliveries without any explicit poll trigger.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { BusStore, type EventCommand } from "./store.js";
import { defaultConfig } from "./config.js";

const WS = "workspace:lease-test";
const EP = "actor:lease:agent";
const BRIDGE = "bridge:lease:b1";

function makeStore(): { store: BusStore; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-lease-test-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const store = new BusStore(cfgPath, cfg);
  return {
    store,
    cleanup: () => {
      try { store.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("D5 — lease-expiry requeue via scheduled single-shot timer (no recurring poll)", () => {
  it("requeues an expired delivery via the scheduled timer without any claimDeliveries call", async () => {
    vi.useFakeTimers();

    const { store, cleanup } = makeStore();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      // Inject broadcast so the store can self-schedule (D5).
      store.setBroadcast(broadcast);

      store.registerWorkspace({ locator: "/fake/path", name: "Lease Test", init_authorized: true }, broadcast);
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      const eventCmd: EventCommand = {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:1",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "hello" },
        response: { expected: false }
      };

      // Submitting an event creates a delivery bundle; the store schedules a
      // single-shot timer at the bundle's lease_expires_at (30 s from now).
      store.submitEvent(eventCmd, broadcast);

      // Verify a bundle was created (delivery_bundle_available broadcast).
      const bundleAvailable = broadcasts.find(b => b.type === "delivery_bundle_available");
      expect(bundleAvailable).toBeDefined();
      const bundle = bundleAvailable!.payload.delivery;
      expect(bundle.endpoint_id).toBe(EP);

      // Advance time past the lease expiry (30 000ms + a little) without
      // calling claimDeliveries. The scheduled timer should fire and requeue.
      broadcasts.length = 0; // reset for clean assertion
      vi.advanceTimersByTime(31_000);

      // The timer callback should have run requeueExpiredDeliveryLeases.
      // It broadcasts "delivery_failed" (attempt 1 < 3) and then
      // tryCreateDeliveryForEndpoint → "delivery_bundle_available" again.
      const failedBroadcast = broadcasts.find(b => b.type === "delivery_failed");
      expect(failedBroadcast).toBeDefined();
      expect(failedBroadcast?.payload.delivery_id).toBe(bundle.delivery_id);

      // The endpoint should get a new delivery after requeue.
      const newBundle = broadcasts.find(b => b.type === "delivery_bundle_available");
      expect(newBundle).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("does not schedule a recurring setInterval — the timer is a one-shot per deadline", async () => {
    vi.useFakeTimers();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const { store, cleanup } = makeStore();
    const broadcast = (type: string, payload: any = {}) => {};

    try {
      store.setBroadcast(broadcast);

      store.registerWorkspace({ locator: "/fake/path", name: "Timer Test", init_authorized: true }, broadcast);
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      const eventCmd: EventCommand = {
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:2",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "hello" },
        response: { expected: false }
      };

      store.submitEvent(eventCmd, broadcast);

      // setInterval must NOT have been called for lease tracking.
      // (There may be setTimeouts from other things, but NO setInterval for leases.)
      const intervalCallsForLeases = setIntervalSpy.mock.calls.filter(
        ([, ms]) => ms === 30_000 || ms === 31_000
      );
      expect(intervalCallsForLeases).toHaveLength(0);

      // setTimeout SHOULD have been called at least once (for the lease timer).
      expect(setTimeoutSpy).toHaveBeenCalled();
    } finally {
      cleanup();
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it("schedules a NEW one-shot timer after processing expired leases", async () => {
    vi.useFakeTimers();

    const { store, cleanup } = makeStore();
    const broadcasts: Array<{ type: string; payload: any }> = [];
    const broadcast = (type: string, payload: any = {}) => broadcasts.push({ type, payload });

    try {
      store.setBroadcast(broadcast);

      store.registerWorkspace({ locator: "/fake/path", name: "Reschedule Test", init_authorized: true }, broadcast);
      store.registerEndpoint({ endpoint_id: EP, workspace_id: WS, name: "Agent", bridge_id: BRIDGE, status: "idle" }, broadcast);

      // Create first bundle
      store.submitEvent({
        type: "message",
        workspace_id: WS,
        source_endpoint_id: "actor:lease:operator",
        thread_id: "thread:lease:3",
        destination: { kind: "endpoint", endpoint_id: EP },
        content: { text: "first" },
        response: { expected: false }
      }, broadcast);

      // Advance past first lease expiry → timer fires, requeues, creates new bundle,
      // and schedules a NEW one-shot timer for the new bundle's lease.
      broadcasts.length = 0;
      vi.advanceTimersByTime(31_000);

      // First bundle expired and was requeued → new bundle created
      expect(broadcasts.find(b => b.type === "delivery_bundle_available")).toBeDefined();

      // Advance past the second lease — the rescheduled timer should fire too
      broadcasts.length = 0;
      vi.advanceTimersByTime(31_000);

      expect(broadcasts.find(b => b.type === "delivery_failed")).toBeDefined();
    } finally {
      cleanup();
    }
  });
});
