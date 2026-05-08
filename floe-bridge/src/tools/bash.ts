/**
 * Floe workspace tool — bash
 *
 * Executes a shell command in the workspace directory.
 * Platform-aware: uses cmd.exe on Windows, /bin/bash on Unix.
 * Workspace-cwd (runs in workspace root but NOT path-contained).
 * Environment is sanitised to strip Floe-managed secrets.
 * Output is bounded (2000 lines / 50KB, tail-truncated).
 *
 * Key design decisions:
 * - Bash is cwd-scoped, NOT strictly contained (unlike file tools)
 * - Agent can specify an optional timeout
 * - Output includes both stdout and stderr (interleaved)
 * - Exit code is always returned
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { sanitiseEnvironment } from "./env-sanitise.js";
import { truncateOutput } from "./truncation.js";
import type { ToolContext } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_TIMEOUT_MS = 600_000; // 10 minutes

export function createBashTool(ctx: ToolContext): AgentTool {
  return {
    name: "bash",
    label: "Run Command",
    description:
      "Execute a shell command in the workspace directory. " +
      "Uses the platform shell (cmd on Windows, bash on Unix). " +
      "Returns stdout+stderr and exit code. " +
      "Optional timeout in seconds (default 120, max 600). " +
      "Environment is sanitised — Floe auth tokens and API keys are stripped. " +
      "The command runs with the workspace root as the working directory.",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default 120, max 600)" })
      ),
    }),
    execute: async (toolCallId, params: any) => {
      const startTime = Date.now();
      const command = String(params?.command ?? "");
      const timeoutSec = params?.timeout != null ? Number(params.timeout) : undefined;

      if (!command.trim()) {
        enrichToolActivity(ctx, toolCallId, "bash — no command provided", true, [], startTime);
        return { content: [{ type: "text", text: "Error: command is required." }], details: { ok: false } };
      }

      const timeoutMs = timeoutSec != null
        ? Math.min(Math.max(Math.round(timeoutSec * 1000), 1000), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

      const env = sanitiseEnvironment();
      const isWindows = platform() === "win32";
      const shell = isWindows ? "cmd.exe" : "/bin/bash";
      const shellArgs = isWindows ? ["/c", command] : ["-c", command];

      const proc = spawnSync(shell, shellArgs, {
        cwd: ctx.workspaceRoot,
        env,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
        windowsHide: true,
      });

      const stdout = typeof proc.stdout === "string" ? proc.stdout : "";
      const stderr = typeof proc.stderr === "string" ? proc.stderr : "";
      const output = (stdout + (stderr ? "\n" + stderr : "")).trimEnd();
      const exitCode = proc.status ?? 1;
      const timedOut = proc.signal === "SIGTERM";

      const truncated = truncateOutput(output);
      const durationMs = Date.now() - startTime;

      const commandPreview = command.length > 60 ? command.slice(0, 57) + "..." : command;
      const statusLabel = timedOut ? "timeout" : exitCode === 0 ? "ok" : `exit ${exitCode}`;
      const summary = `bash: ${commandPreview} (${statusLabel}, ${durationMs}ms)`;
      enrichToolActivity(ctx, toolCallId, summary, exitCode !== 0, [], startTime);

      const header = timedOut
        ? `Command timed out after ${Math.round(timeoutMs / 1000)}s (exit code ${exitCode})`
        : `Exit code: ${exitCode}`;
      const responseText = truncated.truncated
        ? `${header}\n[output truncated: ${truncated.original_lines} lines → ${truncated.text.split("\n").length} lines]\n\n${truncated.text}`
        : `${header}\n\n${truncated.text}`;

      return {
        content: [{ type: "text", text: responseText }],
        details: {
          ok: exitCode === 0,
          exit_code: exitCode,
          timed_out: timedOut,
          duration_ms: durationMs,
          truncated: truncated.truncated,
        },
      };
    },
  };
}

function enrichToolActivity(
  ctx: ToolContext,
  toolCallId: string,
  summary: string,
  isError: boolean,
  filesTouched: string[],
  startTime: number
): void {
  const turn = ctx.getActiveTurn?.();
  if (!turn) return;
  const entry = turn.tool_activity.find((t) => t.call_id === toolCallId);
  if (entry) {
    entry.summary = summary;
    entry.is_error = isError;
    entry.files_touched = filesTouched;
    entry.duration_ms = Date.now() - startTime;
  }
}
