import { describe, expect, it, vi } from "vitest";
import { createPulseTools } from "./pulse-tools.js";

describe("createPulseTools", () => {
  it("advertises context subscribers for render-only pulse events", () => {
    const [tool] = createPulseTools({ createPulse: vi.fn() } as any, "workspace:test", undefined);

    const schema = JSON.stringify(tool.parameters);

    expect(schema).toContain("context_id");
    expect(schema).toContain("endpoint_ref");
    expect(schema).toContain("pulse.fired");
  });

  it("converts relative one-off seconds to an ISO timestamp before calling the bus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T04:30:00.000Z"));
    const createPulse = vi.fn(async (input: unknown) => ({ pulse: input }));
    const [tool] = createPulseTools({ createPulse } as any, "workspace:test", undefined);

    try {
      const result = await tool.execute("call_1", {
        pulse_id: "pulse-1",
        trigger: { type: "once", after_seconds: 30 },
        content: { text: "hello" },
        subscribers: [{ endpoint_ref: "floe" }],
        scope: "local",
      });

      expect(result.details).toMatchObject({ ok: true, pulse_id: "pulse-1", scope: "local" });
      expect(createPulse).toHaveBeenCalledWith(expect.objectContaining({
        pulse_id: "pulse-1",
        trigger: { type: "once", at: "2026-05-15T04:30:30.000Z", timezone: undefined },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("converts natural relative one-off at values to an ISO timestamp before calling the bus", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T04:30:00.000Z"));
    const createPulse = vi.fn(async (input: unknown) => ({ pulse: input }));
    const [tool] = createPulseTools({ createPulse } as any, "workspace:test", undefined);

    try {
      const result = await tool.execute("call_1", {
        pulse_id: "pulse-1",
        trigger: { type: "once", at: "30 seconds from now" },
        content: { text: "hello" },
        subscribers: [{ endpoint_ref: "floe" }],
        scope: "local",
      });

      expect(result.details).toMatchObject({ ok: true, pulse_id: "pulse-1", scope: "local" });
      expect(createPulse).toHaveBeenCalledWith(expect.objectContaining({
        pulse_id: "pulse-1",
        trigger: { type: "once", at: "2026-05-15T04:30:30.000Z", timezone: undefined },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes common one-off trigger aliases to once before calling the bus", async () => {
    const createPulse = vi.fn(async (input: unknown) => ({ pulse: input }));
    const [tool] = createPulseTools({ createPulse } as any, "workspace:test", undefined);

    const result = await tool.execute("call_1", {
      pulse_id: "pulse-1",
      trigger: { type: "one-off", at: "2026-05-15T04:30:00.000Z" },
      content: { text: "hello" },
      subscribers: [{ endpoint_ref: "floe" }],
      scope: "local",
    });

    expect(result.details).toMatchObject({ ok: true, pulse_id: "pulse-1", scope: "local" });
    expect(createPulse).toHaveBeenCalledWith(expect.objectContaining({
      pulse_id: "pulse-1",
      trigger: { type: "once", at: "2026-05-15T04:30:00.000Z", timezone: undefined },
    }));
  });

  it("returns a clear tool error instead of calling the bus for invalid triggers", async () => {
    const createPulse = vi.fn();
    const [tool] = createPulseTools({ createPulse } as any, "workspace:test", undefined);

    const result = await tool.execute("call_1", {
      pulse_id: "pulse-1",
      trigger: { type: "later" },
      content: { text: "hello" },
      subscribers: [{ endpoint_ref: "floe" }],
      scope: "local",
    });

    expect(result.details).toMatchObject({ ok: false, error: "invalid_trigger" });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Unsupported trigger.type") });
    expect(createPulse).not.toHaveBeenCalled();
  });

  it("returns a clear tool error for overflowing relative trigger values", async () => {
    const createPulse = vi.fn();
    const [tool] = createPulseTools({ createPulse } as any, "workspace:test", undefined);
    const hugeFiniteAmount = `1${"0".repeat(305)}`;

    const naturalResult = await tool.execute("call_1", {
      pulse_id: "pulse-1",
      trigger: { type: "once", at: `${hugeFiniteAmount} hours from now` },
      content: { text: "hello" },
      subscribers: [{ endpoint_ref: "floe" }],
      scope: "local",
    });
    const numericResult = await tool.execute("call_2", {
      pulse_id: "pulse-2",
      trigger: { type: "once", after_seconds: Number.MAX_VALUE },
      content: { text: "hello" },
      subscribers: [{ endpoint_ref: "floe" }],
      scope: "local",
    });

    expect(naturalResult.details).toMatchObject({ ok: false, error: "invalid_trigger" });
    expect(numericResult.details).toMatchObject({ ok: false, error: "invalid_trigger" });
    expect(createPulse).not.toHaveBeenCalled();
  });
});
