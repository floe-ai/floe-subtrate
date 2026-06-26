/**
 * Floe pulse tools — agent-facing tools for creating and managing pulses.
 *
 * Pulses are scheduled events (one-off or cron) that fire into the Floe event
 * bus and get delivered to subscribed endpoints. These tools let agents create,
 * list, pause, resume, and cancel pulses within their workspace.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import YAML from "yaml";
import type { BusClient } from "../bus-client.js";
import type { ToolContext } from "./types.js";

type PulsePersistence = "workspace" | "local";

export type PulseDef = {
  pulse_id: string;
  persistence: PulsePersistence;
  scope_id?: string;
  trigger: { type: string; at?: string; schedule?: string; timezone?: string };
  event: { type: "pulse.fired"; content: Record<string, unknown> };
  content: Record<string, unknown>;
  subscribers: Array<
    | { kind: "context"; context_id: string }
    | { kind: "endpoint"; endpoint_ref: string; context_id?: string | null }
  >;
};

const ISO_DURATION_RE = /^p(?:t)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/i;
const NATURAL_RELATIVE_RE = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)(?:\s*(?:from\s+now|later))?$/i;

function finiteRelativeSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const maxRelativeSeconds = (8.64e15 - Date.now()) / 1000;
  return seconds <= maxRelativeSeconds ? seconds : null;
}

function isRelativeExpression(input: string): boolean {
  const value = input.trim().toLowerCase();
  return ISO_DURATION_RE.test(value) || NATURAL_RELATIVE_RE.test(value);
}

function relativeSeconds(input: unknown): number | null {
  if (typeof input === "number") {
    return finiteRelativeSeconds(input);
  }
  if (typeof input !== "string") return null;

  const value = input.trim().toLowerCase();
  if (!value) return null;

  const isoDuration = value.match(ISO_DURATION_RE);
  if (isoDuration && (isoDuration[1] || isoDuration[2] || isoDuration[3])) {
    const hours = Number(isoDuration[1] ?? 0);
    const minutes = Number(isoDuration[2] ?? 0);
    const seconds = Number(isoDuration[3] ?? 0);
    const total = (hours * 3600) + (minutes * 60) + seconds;
    return finiteRelativeSeconds(total);
  }

  const natural = value.match(NATURAL_RELATIVE_RE);
  if (!natural) return null;
  const amount = Number(natural[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = natural[2];
  if (["s", "sec", "secs", "second", "seconds"].includes(unit)) return finiteRelativeSeconds(amount);
  if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return finiteRelativeSeconds(amount * 60);
  return finiteRelativeSeconds(amount * 3600);
}

function isoFromNow(seconds: number): string {
  return new Date(Date.now() + Math.round(seconds * 1000)).toISOString();
}

function normalizeOnceAt(raw: Record<string, unknown>): string | undefined {
  const at = typeof raw.at === "string" ? raw.at.trim() : "";
  if (at) {
    const seconds = relativeSeconds(at);
    if (seconds !== null) return isoFromNow(seconds);
    return isRelativeExpression(at) ? undefined : at;
  }

  const relativeFields = ["after_seconds", "delay_seconds", "in_seconds", "seconds_from_now", "after"];
  for (const field of relativeFields) {
    const seconds = relativeSeconds(raw[field]);
    if (seconds !== null) return isoFromNow(seconds);
  }

  return undefined;
}

function normalizePulseTrigger(input: unknown): PulseDef["trigger"] | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: "trigger must be an object with type 'once' or 'cron'." };
  }
  const raw = input as Record<string, unknown>;
  const rawType = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  const schedule = typeof raw.schedule === "string" ? raw.schedule : undefined;
  const timezone = typeof raw.timezone === "string" ? raw.timezone : undefined;

  if (rawType === "cron") {
    if (!schedule) return { error: "cron pulses require trigger.schedule." };
    return { type: "cron", schedule, timezone };
  }

  const onceAliases = new Set([
    "once",
    "one-off",
    "one_off",
    "oneoff",
    "at",
    "at_time",
    "at_time_utc",
    "datetime",
    "time",
    "time.at",
    "time.at.utc"
  ]);
  if (rawType === "" || onceAliases.has(rawType)) {
    const at = normalizeOnceAt(raw);
    if (!at) return { error: "one-off pulses require trigger.at or trigger.after_seconds." };
    return { type: "once", at, timezone };
  }

  return { error: `Unsupported trigger.type '${rawType}'. Use 'once' with trigger.at or 'cron' with trigger.schedule.` };
}

function normalizePulseSubscribers(input: unknown): PulseDef["subscribers"] | { error: string } {
  if (!Array.isArray(input)) return [];
  const subscribers: PulseDef["subscribers"] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "subscribers must contain objects." };
    }
    const raw = item as Record<string, unknown>;
    const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
    if (kind === "context") {
      if (typeof raw.context_id !== "string" || !raw.context_id.trim()) {
        return { error: "context subscribers require context_id." };
      }
      subscribers.push({ kind: "context", context_id: raw.context_id });
      continue;
    }
    if (kind === "" || kind === "endpoint") {
      if (typeof raw.endpoint_ref !== "string" || !raw.endpoint_ref.trim()) {
        return { error: "endpoint subscribers require endpoint_ref." };
      }
      subscribers.push({
        kind: "endpoint",
        endpoint_ref: raw.endpoint_ref,
        context_id: typeof raw.context_id === "string" ? raw.context_id : undefined
      });
      continue;
    }
    return { error: `Unsupported subscriber.kind '${kind}'. Use 'context' or 'endpoint'.` };
  }
  return subscribers;
}

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
    persistence: pulseDef.persistence,
    trigger: pulseDef.trigger,
    event: pulseDef.event,
  };
  if (pulseDef.scope_id) entry.scope_id = pulseDef.scope_id;
  if (pulseDef.subscribers.length > 0) {
    entry.subscribers = pulseDef.subscribers;
  }

  (pulses as YAML.YAMLSeq).add(doc.createNode(entry));
  writeFileSync(yamlPath, doc.toString(), "utf8");
}

function resolvedScopeIdFromCreatePulseResult(result: unknown): string | undefined {
  const candidate = result && typeof result === "object" && "pulse" in result
    ? (result as { pulse?: unknown }).pulse
    : result;
  if (!candidate || typeof candidate !== "object") return undefined;
  const scopeId = (candidate as { scope_id?: unknown }).scope_id;
  return typeof scopeId === "string" && scopeId ? scopeId : undefined;
}

export function createPulseTools(
  bus: BusClient,
  workspaceId: string,
  workspaceLocator: string | undefined,
  context: Pick<ToolContext, "getActiveTurn"> = {},
): AgentTool[] {
  const createPulseTool: AgentTool = {
    name: "create_pulse",
    label: "Create Pulse",
    description:
      "Create a scheduled pulse (one-off or cron) that creates canonical pulse.fired events for subscribers. " +
      "For one-off pulses, use trigger.type exactly 'once' with trigger.at as an ISO timestamp, " +
      "or use trigger.after_seconds for relative one-off delays such as 30 seconds from now. " +
      "For simple reminders, use a context subscriber with the current_context_id so the pulse renders in that conversation without waking an actor. " +
      "For scheduled actor work, use an endpoint subscriber with endpoint_ref and the current_context_id. " +
      "For recurring pulses, use trigger.type exactly 'cron' with trigger.schedule. " +
      "Use persistence 'workspace' for workspace-backed Pulse Persistence in floe.yaml, or 'local' for local runtime-backed pulses. " +
      "Use scope_id only for the workspace organising Scope.",
    parameters: Type.Object({
      pulse_id: Type.String({ description: "Unique pulse identifier" }),
      trigger: Type.Object({
        type: Type.Union([Type.Literal("once"), Type.Literal("cron")], {
          description: "Use exactly 'once' for one-off scheduled pulses or 'cron' for recurring pulses",
        }),
        at: Type.Optional(Type.String({ description: "ISO 8601 timestamp for one-off pulses, or simple relative text like '30 seconds from now'" })),
        after_seconds: Type.Optional(Type.Number({ description: "Relative one-off delay in seconds. Use 30 for '30 seconds from now'." })),
        schedule: Type.Optional(Type.String({ description: "Cron expression for recurring pulses" })),
        timezone: Type.Optional(Type.String({ description: "IANA timezone (default: UTC)" })),
      }),
      event: Type.Optional(Type.Object({
        type: Type.Literal("pulse.fired"),
        content: Type.Object({
          text: Type.Optional(Type.String({ description: "Text to render for context subscribers" })),
          instructions: Type.Optional(Type.String({ description: "Instructions for endpoint subscribers to process when delivered" })),
        }),
      })),
      content: Type.Optional(Type.Object({
        text: Type.Optional(Type.String({ description: "Backward-compatible pulse event text. Prefer event.content.text." })),
        instructions: Type.Optional(Type.String({ description: "Backward-compatible endpoint instructions. Prefer event.content.instructions." })),
      })),
      subscribers: Type.Array(
        Type.Union([
          Type.Object({
            kind: Type.Literal("context"),
            context_id: Type.String({ description: "Context that should render the pulse.fired event" }),
          }),
          Type.Object({
            kind: Type.Optional(Type.Literal("endpoint")),
            endpoint_ref: Type.String({ description: "Endpoint reference to receive the pulse delivery" }),
            context_id: Type.Optional(Type.String({ description: "Context associated with this endpoint delivery for reply/continuation" })),
          }),
        ]),
      ),
      persistence: Type.Optional(
        Type.Union([Type.Literal("workspace"), Type.Literal("local")], {
          description: "Pulse Persistence: 'workspace' is workspace-backed in floe.yaml, 'local' is local runtime-backed (default: local)",
        }),
      ),
      scope_id: Type.Optional(Type.String({ description: "Optional organising Scope id. If omitted, the pulse must still have an explicit valid Context/subscriber anchor; no Default Scope is invented." })),
    }),
    execute: async (_toolCallId, params: any) => {
      if (params && typeof params === "object" && "scope" in params) {
        const message = "Pulse storage is now Pulse Persistence. Use persistence 'workspace' or 'local', and scope_id for the organising Scope.";
        return {
          content: [{ type: "text", text: `Cannot create pulse: ${message}` }],
          details: { ok: false, error: "invalid_persistence", message },
        };
      }
      if (params?.persistence !== undefined && params.persistence !== "workspace" && params.persistence !== "local") {
        const message = "Use persistence 'workspace' or 'local'.";
        return {
          content: [{ type: "text", text: `Cannot create pulse: ${message}` }],
          details: { ok: false, error: "invalid_persistence", message },
        };
      }
      const persistence: PulsePersistence = params?.persistence === "workspace" ? "workspace" : "local";
      const scopeId = typeof params?.scope_id === "string" && params.scope_id.trim() ? params.scope_id : undefined;
      const currentContextId = context.getActiveTurn?.()?.context_id ?? undefined;
      const normalizedTrigger = normalizePulseTrigger(params?.trigger);
      if ("error" in normalizedTrigger) {
        return {
          content: [{ type: "text", text: `Cannot create pulse: ${normalizedTrigger.error}` }],
          details: { ok: false, error: "invalid_trigger", message: normalizedTrigger.error },
        };
      }
      const normalizedSubscribers = normalizePulseSubscribers(params?.subscribers);
      if ("error" in normalizedSubscribers) {
        return {
          content: [{ type: "text", text: `Cannot create pulse: ${normalizedSubscribers.error}` }],
          details: { ok: false, error: "invalid_subscribers", message: normalizedSubscribers.error },
        };
      }
      const eventContent =
        params?.event && typeof params.event === "object" && params.event.content && typeof params.event.content === "object"
          ? params.event.content
          : params?.content && typeof params.content === "object"
          ? params.content
          : {};
      const pulseDef: PulseDef = {
        pulse_id: String(params.pulse_id),
        persistence,
        scope_id: scopeId,
        trigger: normalizedTrigger,
        event: { type: "pulse.fired", content: eventContent },
        content: eventContent,
        subscribers: normalizedSubscribers,
      };

      const result = await bus.createPulse({
        pulse_id: pulseDef.pulse_id,
        workspace_id: workspaceId,
        persistence,
        scope_id: scopeId,
        current_context_id: currentContextId,
        trigger: pulseDef.trigger,
        event: pulseDef.event,
        content: pulseDef.content,
        subscribers: pulseDef.subscribers,
        created_by: "agent",
      });
      const resolvedScopeId = scopeId ?? resolvedScopeIdFromCreatePulseResult(result);

      if (persistence === "workspace" && workspaceLocator) {
        try {
          writePulseToFloeYaml(workspaceLocator, { ...pulseDef, scope_id: resolvedScopeId });
        } catch (err) {
          console.error("[bridge] pulse write-back to floe.yaml failed", { pulse_id: pulseDef.pulse_id, error: err });
        }
      }

      return {
        content: [{ type: "text", text: `Pulse '${pulseDef.pulse_id}' created (persistence: ${persistence}${resolvedScopeId ? `, scope_id: ${resolvedScopeId}` : ""}).\n${JSON.stringify(result, null, 2)}` }],
        details: { ok: true, pulse_id: pulseDef.pulse_id, persistence, scope_id: resolvedScopeId },
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
