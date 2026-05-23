import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createPulseTools } from "./pulse-tools.js";

describe("createPulseTools", () => {
  it("advertises context subscribers for render-only pulse events", () => {
    const [tool] = createPulseTools({ createPulse: vi.fn() } as any, "workspace:test", undefined);

    const properties = (tool.parameters as any).properties;
    const schema = JSON.stringify(tool.parameters);

    expect(schema).toContain("context_id");
    expect(schema).toContain("endpoint_ref");
    expect(schema).toContain("pulse.fired");
    expect(properties).toHaveProperty("persistence");
    expect(properties).toHaveProperty("scope_id");
    expect(properties).not.toHaveProperty("scope");
    expect(schema).not.toContain("Scope:" + " 'workspace'");
  });

  it("passes persistence, explicit Scope, and active Context to the bus", async () => {
    const createPulse = vi.fn(async (input: unknown) => ({ pulse: input }));
    const [tool] = createPulseTools(
      { createPulse } as any,
      "workspace:test",
      undefined,
      { getActiveTurn: () => ({ context_id: "ctx_active", tool_activity: [] }) },
    );

    const result = await tool.execute("call_1", {
      pulse_id: "pulse-1",
      trigger: { type: "once", at: "2026-05-15T04:30:00.000Z" },
      content: { text: "hello" },
      subscribers: [{ endpoint_ref: "floe" }],
      persistence: "workspace",
      scope_id: "ops",
    });

    expect(result.details).toMatchObject({
      ok: true,
      pulse_id: "pulse-1",
      persistence: "workspace",
      scope_id: "ops",
    });
    expect(createPulse).toHaveBeenCalledWith(expect.objectContaining({
      pulse_id: "pulse-1",
      persistence: "workspace",
      scope_id: "ops",
      current_context_id: "ctx_active",
    }));
  });

  it("writes bus-resolved inherited scope_id for workspace-backed pulses", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-pulse-tool-"));
    mkdirSync(join(tmp, ".floe"), { recursive: true });
    writeFileSync(join(tmp, ".floe", "floe.yaml"), "pulses: []\n", "utf8");
    const createPulse = vi.fn(async (input: unknown) => ({
      pulse: { ...(input as Record<string, unknown>), scope_id: "research" }
    }));
    const [tool] = createPulseTools(
      { createPulse } as any,
      "workspace:test",
      tmp,
      { getActiveTurn: () => ({ context_id: "ctx_research", tool_activity: [] }) },
    );

    try {
      const result = await tool.execute("call_1", {
        pulse_id: "pulse-1",
        trigger: { type: "once", at: "2026-05-15T04:30:00.000Z" },
        content: { text: "hello" },
        subscribers: [{ endpoint_ref: "floe" }],
        persistence: "workspace",
      });

      expect(result.details).toMatchObject({ ok: true, pulse_id: "pulse-1", persistence: "workspace", scope_id: "research" });
      expect(createPulse).toHaveBeenCalledWith(expect.objectContaining({
        current_context_id: "ctx_research",
        scope_id: undefined,
      }));
      const parsed = YAML.parse(readFileSync(join(tmp, ".floe", "floe.yaml"), "utf8"));
      expect(parsed.pulses[0]).toMatchObject({
        id: "pulse-1",
        persistence: "workspace",
        scope_id: "research",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
        persistence: "local",
      });

      expect(result.details).toMatchObject({ ok: true, pulse_id: "pulse-1", persistence: "local" });
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
        persistence: "local",
      });

      expect(result.details).toMatchObject({ ok: true, pulse_id: "pulse-1", persistence: "local" });
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
      persistence: "local",
    });

    expect(result.details).toMatchObject({ ok: true, pulse_id: "pulse-1", persistence: "local" });
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
      persistence: "local",
    });

    expect(result.details).toMatchObject({ ok: false, error: "invalid_trigger" });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Unsupported trigger.type") });
    expect(createPulse).not.toHaveBeenCalled();
  });

  it("returns a clear tool error for stale Pulse scope input", async () => {
    const createPulse = vi.fn();
    const [tool] = createPulseTools({ createPulse } as any, "workspace:test", undefined);

    const result = await tool.execute("call_1", {
      pulse_id: "pulse-1",
      trigger: { type: "once", at: "2026-05-15T04:30:00.000Z" },
      content: { text: "hello" },
      subscribers: [{ endpoint_ref: "floe" }],
      scope: "workspace",
    });

    expect(result.details).toMatchObject({ ok: false, error: "invalid_persistence" });
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Use persistence") });
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
      persistence: "local",
    });
    const numericResult = await tool.execute("call_2", {
      pulse_id: "pulse-2",
      trigger: { type: "once", after_seconds: Number.MAX_VALUE },
      content: { text: "hello" },
      subscribers: [{ endpoint_ref: "floe" }],
      persistence: "local",
    });

    expect(naturalResult.details).toMatchObject({ ok: false, error: "invalid_trigger" });
    expect(numericResult.details).toMatchObject({ ok: false, error: "invalid_trigger" });
    expect(createPulse).not.toHaveBeenCalled();
  });
});
