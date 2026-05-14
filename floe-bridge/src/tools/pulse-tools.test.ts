import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createPulseTools } from "./pulse-tools.js";
import type { BusClient } from "../bus-client.js";

// Minimal mock bus client
function createMockBus(): BusClient & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    createPulse: async (...args: unknown[]) => {
      calls.push({ method: "createPulse", args });
      return { pulse_id: (args[0] as any).pulse_id, status: "active" };
    },
    listPulses: async (...args: unknown[]) => {
      calls.push({ method: "listPulses", args });
      return { pulses: [{ pulse_id: "test-pulse", status: "active" }] };
    },
    pausePulse: async (...args: unknown[]) => {
      calls.push({ method: "pausePulse", args });
      return { pulse_id: args[0], status: "paused" };
    },
    resumePulse: async (...args: unknown[]) => {
      calls.push({ method: "resumePulse", args });
      return { pulse_id: args[0], status: "active" };
    },
    cancelPulse: async (...args: unknown[]) => {
      calls.push({ method: "cancelPulse", args });
      return { pulse_id: args[0], status: "cancelled" };
    },
  } as unknown as BusClient & { calls: Array<{ method: string; args: unknown[] }> };
}

describe("pulse-tools", () => {
  let workspace: string;
  let bus: ReturnType<typeof createMockBus>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "floe-pulse-test-"));
    mkdirSync(join(workspace, ".floe"), { recursive: true });
    writeFileSync(
      join(workspace, ".floe", "floe.yaml"),
      YAML.stringify({
        schema: "floe.workspace.v1",
        version: 1,
        agents: [{ id: "floe", path: "./agents/floe.md" }],
      }),
      "utf8",
    );
    bus = createMockBus();
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("returns 5 tools", () => {
    const tools = createPulseTools(bus, "ws_test", workspace);
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      "create_pulse",
      "list_pulses",
      "pause_pulse",
      "resume_pulse",
      "cancel_pulse",
    ]);
  });

  describe("create_pulse", () => {
    it("calls bus.createPulse with correct params", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_pulse")!;
      await createTool.execute("call-1", {
        pulse_id: "daily-standup",
        trigger: { type: "cron", schedule: "0 9 * * 1-5", timezone: "Australia/Sydney" },
        content: { text: "Time for standup" },
        subscribers: [{ endpoint_ref: "floe" }],
      });

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0].method).toBe("createPulse");
      const input = bus.calls[0].args[0] as any;
      expect(input.pulse_id).toBe("daily-standup");
      expect(input.workspace_id).toBe("ws_test");
      expect(input.scope).toBe("local");
      expect(input.trigger.schedule).toBe("0 9 * * 1-5");
      expect(input.subscribers).toEqual([{ endpoint_ref: "floe" }]);
    });

    it("writes to floe.yaml when scope is workspace", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_pulse")!;
      await createTool.execute("call-1", {
        pulse_id: "nightly-review",
        trigger: { type: "cron", schedule: "0 22 * * *" },
        content: { text: "Time for nightly review" },
        subscribers: [{ endpoint_ref: "floe" }],
        scope: "workspace",
      });

      const yamlContent = readFileSync(join(workspace, ".floe", "floe.yaml"), "utf8");
      const parsed = YAML.parse(yamlContent);
      expect(parsed.pulses).toBeDefined();
      expect(parsed.pulses).toHaveLength(1);
      expect(parsed.pulses[0].id).toBe("nightly-review");
      expect(parsed.pulses[0].trigger.schedule).toBe("0 22 * * *");
      expect(parsed.pulses[0].content.text).toBe("Time for nightly review");
    });

    it("does not write to floe.yaml when scope is local", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const createTool = tools.find((t) => t.name === "create_pulse")!;
      await createTool.execute("call-1", {
        pulse_id: "ephemeral",
        trigger: { type: "once", at: "2025-01-01T00:00:00Z" },
        content: { text: "test" },
        subscribers: [],
      });

      const yamlContent = readFileSync(join(workspace, ".floe", "floe.yaml"), "utf8");
      const parsed = YAML.parse(yamlContent);
      expect(parsed.pulses).toBeUndefined();
    });
  });

  describe("list_pulses", () => {
    it("calls bus.listPulses with workspace_id", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const listTool = tools.find((t) => t.name === "list_pulses")!;
      const result = await listTool.execute("call-1", {});

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0].method).toBe("listPulses");
      expect((bus.calls[0].args[0] as any).workspace_id).toBe("ws_test");
      expect((result as any).details.count).toBe(1);
    });

    it("passes status filter when provided", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const listTool = tools.find((t) => t.name === "list_pulses")!;
      await listTool.execute("call-1", { status: "paused" });

      expect((bus.calls[0].args[0] as any).status).toBe("paused");
    });
  });

  describe("pause_pulse", () => {
    it("calls bus.pausePulse", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const pauseTool = tools.find((t) => t.name === "pause_pulse")!;
      await pauseTool.execute("call-1", { pulse_id: "daily-standup" });

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0].method).toBe("pausePulse");
      expect(bus.calls[0].args[0]).toBe("daily-standup");
    });
  });

  describe("resume_pulse", () => {
    it("calls bus.resumePulse", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const resumeTool = tools.find((t) => t.name === "resume_pulse")!;
      await resumeTool.execute("call-1", { pulse_id: "daily-standup" });

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0].method).toBe("resumePulse");
      expect(bus.calls[0].args[0]).toBe("daily-standup");
    });
  });

  describe("cancel_pulse", () => {
    it("calls bus.cancelPulse", async () => {
      const tools = createPulseTools(bus, "ws_test", workspace);
      const cancelTool = tools.find((t) => t.name === "cancel_pulse")!;
      await cancelTool.execute("call-1", { pulse_id: "daily-standup" });

      expect(bus.calls).toHaveLength(1);
      expect(bus.calls[0].method).toBe("cancelPulse");
      expect(bus.calls[0].args[0]).toBe("daily-standup");
    });
  });
});
