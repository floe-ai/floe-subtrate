/**
 * Floe pulse tools — agent-facing tools for creating and managing pulses.
 *
 * Pulses are scheduled events (one-off or cron) that fire into the Floe event
 * bus and get delivered to subscribed endpoints. These tools let agents create,
 * list, pause, resume, and cancel pulses within their workspace.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import YAML from "yaml";
import type { BusClient } from "../bus-client.js";

export type PulseDef = {
  pulse_id: string;
  trigger: { type: string; at?: string; schedule?: string; timezone?: string };
  content: Record<string, unknown>;
  subscribers: Array<{ endpoint_ref: string }>;
};

function writePulseToFloeYaml(workspaceLocator: string, pulseDef: PulseDef): void {
  const yamlPath = join(workspaceLocator, ".floe", "floe.yaml");
  const content = readFileSync(yamlPath, "utf8");
  const doc = YAML.parseDocument(content);

  let pulses = doc.get("pulses");
  if (!pulses) {
    doc.set("pulses", doc.createNode([]));
    pulses = doc.get("pulses");
  }

  const entry: Record<string, unknown> = {
    id: pulseDef.pulse_id,
    trigger: pulseDef.trigger,
    content: pulseDef.content,
  };
  if (pulseDef.subscribers.length > 0) {
    entry.subscribers = pulseDef.subscribers;
  }

  (pulses as YAML.YAMLSeq).add(doc.createNode(entry));
  writeFileSync(yamlPath, doc.toString(), "utf8");
}

export function createPulseTools(
  bus: BusClient,
  workspaceId: string,
  workspaceLocator: string | undefined,
): AgentTool[] {
  const createPulseTool: AgentTool = {
    name: "create_pulse",
    label: "Create Pulse",
    description:
      "Create a scheduled pulse (one-off or cron) that fires an event to subscribed endpoints. " +
      "Set scope to 'workspace' to persist the pulse definition in floe.yaml.",
    parameters: Type.Object({
      pulse_id: Type.String({ description: "Unique pulse identifier" }),
      trigger: Type.Object({
        type: Type.Union([Type.Literal("once"), Type.Literal("cron")]),
        at: Type.Optional(Type.String({ description: "ISO 8601 timestamp for one-off pulses" })),
        schedule: Type.Optional(Type.String({ description: "Cron expression for recurring pulses" })),
        timezone: Type.Optional(Type.String({ description: "IANA timezone (default: UTC)" })),
      }),
      content: Type.Object({
        text: Type.String({ description: "Message text for the pulse event" }),
      }),
      subscribers: Type.Array(
        Type.Object({
          endpoint_ref: Type.String({ description: "Endpoint reference to receive the pulse" }),
        }),
      ),
      scope: Type.Optional(
        Type.Union([Type.Literal("workspace"), Type.Literal("local")], {
          description: "Scope: 'workspace' persists to floe.yaml, 'local' is ephemeral (default: local)",
        }),
      ),
    }),
    execute: async (_toolCallId, params: any) => {
      const scope = params?.scope ?? "local";
      const pulseDef: PulseDef = {
        pulse_id: String(params.pulse_id),
        trigger: params.trigger,
        content: params.content,
        subscribers: Array.isArray(params.subscribers) ? params.subscribers : [],
      };

      const result = await bus.createPulse({
        pulse_id: pulseDef.pulse_id,
        workspace_id: workspaceId,
        scope,
        trigger: pulseDef.trigger,
        content: pulseDef.content,
        subscribers: pulseDef.subscribers,
        created_by: "agent",
      });

      if (scope === "workspace" && workspaceLocator) {
        try {
          writePulseToFloeYaml(workspaceLocator, pulseDef);
        } catch (err) {
          console.error("[bridge] pulse write-back to floe.yaml failed", { pulse_id: pulseDef.pulse_id, error: err });
        }
      }

      return {
        content: [{ type: "text", text: `Pulse '${pulseDef.pulse_id}' created (scope: ${scope}).\n${JSON.stringify(result, null, 2)}` }],
        details: { ok: true, pulse_id: pulseDef.pulse_id, scope },
      };
    },
  };

  const listPulsesTool: AgentTool = {
    name: "list_pulses",
    label: "List Pulses",
    description: "List pulses registered for this workspace. Optionally filter by status.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status: active, paused, cancelled, fired" })),
    }),
    execute: async (_toolCallId, params: any) => {
      const result = await bus.listPulses({
        workspace_id: workspaceId,
        status: params?.status,
      });
      const pulses = result.pulses ?? [];
      const text = pulses.length === 0
        ? "No pulses found for this workspace."
        : JSON.stringify(pulses, null, 2);
      return {
        content: [{ type: "text", text }],
        details: { ok: true, count: pulses.length },
      };
    },
  };

  const pausePulseTool: AgentTool = {
    name: "pause_pulse",
    label: "Pause Pulse",
    description: "Pause an active pulse. It can be resumed later.",
    parameters: Type.Object({
      pulse_id: Type.String({ description: "The pulse ID to pause" }),
    }),
    execute: async (_toolCallId, params: any) => {
      const result = await bus.pausePulse(String(params.pulse_id));
      return {
        content: [{ type: "text", text: `Pulse '${params.pulse_id}' paused.\n${JSON.stringify(result, null, 2)}` }],
        details: { ok: true, pulse_id: params.pulse_id },
      };
    },
  };

  const resumePulseTool: AgentTool = {
    name: "resume_pulse",
    label: "Resume Pulse",
    description: "Resume a paused pulse.",
    parameters: Type.Object({
      pulse_id: Type.String({ description: "The pulse ID to resume" }),
    }),
    execute: async (_toolCallId, params: any) => {
      const result = await bus.resumePulse(String(params.pulse_id));
      return {
        content: [{ type: "text", text: `Pulse '${params.pulse_id}' resumed.\n${JSON.stringify(result, null, 2)}` }],
        details: { ok: true, pulse_id: params.pulse_id },
      };
    },
  };

  const cancelPulseTool: AgentTool = {
    name: "cancel_pulse",
    label: "Cancel Pulse",
    description: "Permanently cancel a pulse. This cannot be undone.",
    parameters: Type.Object({
      pulse_id: Type.String({ description: "The pulse ID to cancel" }),
    }),
    execute: async (_toolCallId, params: any) => {
      const result = await bus.cancelPulse(String(params.pulse_id));
      return {
        content: [{ type: "text", text: `Pulse '${params.pulse_id}' cancelled.\n${JSON.stringify(result, null, 2)}` }],
        details: { ok: true, pulse_id: params.pulse_id },
      };
    },
  };

  return [createPulseTool, listPulsesTool, pausePulseTool, resumePulseTool, cancelPulseTool];
}
