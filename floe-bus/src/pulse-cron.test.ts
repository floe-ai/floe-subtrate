import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PulseScheduler } from "./pulse-scheduler.js";
import { CronExpressionParser } from "cron-parser";

describe("PulseScheduler — cron recurring pulses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a cron pulse at the next scheduled time", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    // Schedule 1 minute from now
    const fireAt = new Date(Date.now() + 60_000);
    scheduler.addPulse("cron-1", fireAt);
    scheduler.start();

    vi.advanceTimersByTime(59_999);
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual(["cron-1"]);

    scheduler.stop();
  });

  it("re-schedules a cron pulse after firing (fires multiple times)", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
      // Simulate the cron re-schedule loop: compute next fire time and re-add
      const nextFire = new Date(Date.now() + 60_000); // every 60 seconds
      scheduler.addPulse(pulseId, nextFire);
    });

    scheduler.addPulse("cron-recurring", new Date(Date.now() + 60_000));
    scheduler.start();

    // First fire at T+60s
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(1);

    // Second fire at T+120s
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(2);

    // Third fire at T+180s
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(3);

    expect(fired).toEqual(["cron-recurring", "cron-recurring", "cron-recurring"]);
    scheduler.stop();
  });

  it("does not fire a paused (removed) cron pulse", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    scheduler.addPulse("cron-pause", new Date(Date.now() + 60_000));
    scheduler.start();

    // Simulate pause by removing
    scheduler.removePulse("cron-pause");

    vi.advanceTimersByTime(120_000);
    expect(fired).toHaveLength(0);

    scheduler.stop();
  });

  it("fires a resumed cron pulse at the next occurrence from resume time", () => {
    const fired: string[] = [];
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
    });

    scheduler.addPulse("cron-resume", new Date(Date.now() + 60_000));
    scheduler.start();

    // Pause at T+30s (before it fires)
    vi.advanceTimersByTime(30_000);
    scheduler.removePulse("cron-resume");

    // Advance past original fire time — should not fire
    vi.advanceTimersByTime(60_000);
    expect(fired).toHaveLength(0);

    // Resume: schedule from now (T+90s), next fire at T+90s + 60s = T+150s
    const resumeFireAt = new Date(Date.now() + 60_000);
    scheduler.addPulse("cron-resume", resumeFireAt);

    vi.advanceTimersByTime(59_999);
    expect(fired).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual(["cron-resume"]);

    scheduler.stop();
  });

  it("permanently stops a cancelled (removed) cron pulse", () => {
    const fired: string[] = [];
    let fireCount = 0;
    const scheduler = new PulseScheduler((pulseId) => {
      fired.push(pulseId);
      fireCount++;
      // Simulate re-schedule — but if cancelled externally, removePulse is called
      scheduler.addPulse(pulseId, new Date(Date.now() + 60_000));
    });

    scheduler.addPulse("cron-cancel", new Date(Date.now() + 60_000));
    scheduler.start();

    // Let it fire once
    vi.advanceTimersByTime(60_000);
    expect(fireCount).toBe(1);

    // Cancel (remove) — simulates what the API does
    scheduler.removePulse("cron-cancel");

    // Advance time — no more fires
    vi.advanceTimersByTime(300_000);
    expect(fireCount).toBe(1);

    scheduler.stop();
  });
});

describe("calculateNextFireAt — cron-parser integration", () => {
  it("computes next fire time for a cron expression", () => {
    const baseDate = new Date("2026-01-01T00:00:00Z");
    const expr = CronExpressionParser.parse("*/5 * * * *", { currentDate: baseDate });
    const next = expr.next().toDate();
    expect(next.toISOString()).toBe("2026-01-01T00:05:00.000Z");
  });

  it("respects timezone in cron calculation", () => {
    // 00:30 in UTC vs 00:30 in Sydney should produce different absolute times
    const baseDate = new Date("2026-06-15T12:00:00Z"); // midday UTC

    // "At 23:00" — in UTC this would be 2026-06-15T23:00:00Z
    const exprUtc = CronExpressionParser.parse("0 23 * * *", {
      currentDate: baseDate,
      tz: "UTC"
    });
    const nextUtc = exprUtc.next().toDate();

    // "At 23:00" in Sydney — AEST is UTC+10, so 23:00 AEST = 13:00 UTC
    const exprSydney = CronExpressionParser.parse("0 23 * * *", {
      currentDate: baseDate,
      tz: "Australia/Sydney"
    });
    const nextSydney = exprSydney.next().toDate();

    // They should be different absolute times
    expect(nextUtc.toISOString()).not.toBe(nextSydney.toISOString());
    // UTC: 2026-06-15T23:00:00Z
    expect(nextUtc.getUTCHours()).toBe(23);
    // Sydney (AEST +10): 23:00 local = 13:00 UTC
    expect(nextSydney.getUTCHours()).toBe(13);
  });

  it("supports 6-field cron expressions (with seconds)", () => {
    const baseDate = new Date("2026-01-01T00:00:00Z");
    const expr = CronExpressionParser.parse("*/10 * * * * *", { currentDate: baseDate });
    const next = expr.next().toDate();
    expect(next.toISOString()).toBe("2026-01-01T00:00:10.000Z");
  });

  it("returns sequential next occurrences", () => {
    const baseDate = new Date("2026-01-01T00:00:00Z");
    const expr = CronExpressionParser.parse("0 * * * *", { currentDate: baseDate });
    const first = expr.next().toDate();
    const second = expr.next().toDate();
    expect(first.toISOString()).toBe("2026-01-01T01:00:00.000Z");
    expect(second.toISOString()).toBe("2026-01-01T02:00:00.000Z");
  });
});
