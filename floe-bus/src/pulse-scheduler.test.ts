import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PulseScheduler } from "./pulse-scheduler.js";

describe("PulseScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a one-off pulse at the scheduled time", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    const fireAt = new Date(Date.now() + 60_000); // 1 minute from now
    scheduler.addPulse("test-pulse", fireAt);
    scheduler.start();

    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(59_999);
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual(["test-pulse"]);

    scheduler.stop();
  });

  it("fires multiple pulses in chronological order", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    scheduler.addPulse("second", new Date(Date.now() + 120_000));
    scheduler.addPulse("first", new Date(Date.now() + 60_000));
    scheduler.addPulse("third", new Date(Date.now() + 180_000));
    scheduler.start();

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(["first"]);

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(["first", "second"]);

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(["first", "second", "third"]);

    scheduler.stop();
  });

  it("does not fire a removed pulse", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    scheduler.addPulse("keep", new Date(Date.now() + 60_000));
    scheduler.addPulse("remove-me", new Date(Date.now() + 30_000));
    scheduler.start();

    scheduler.removePulse("remove-me");

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(["keep"]);

    scheduler.stop();
  });

  it("fires overdue pulses immediately", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    // Fire time is in the past
    scheduler.addPulse("overdue", new Date(Date.now() - 5_000));
    scheduler.start();

    vi.advanceTimersByTime(0);
    expect(fired).toEqual(["overdue"]);

    scheduler.stop();
  });

  it("reschedules when a nearer pulse is added", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    scheduler.addPulse("far", new Date(Date.now() + 120_000));
    scheduler.start();

    // Add a nearer pulse — scheduler should reschedule
    scheduler.addPulse("near", new Date(Date.now() + 30_000));

    vi.advanceTimersByTime(30_000);
    expect(fired).toEqual(["near"]);

    vi.advanceTimersByTime(90_000);
    expect(fired).toEqual(["near", "far"]);

    scheduler.stop();
  });
});
