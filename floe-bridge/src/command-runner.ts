/**
 * @invariant A command node is bridge-local runtime embodiment, never a bus concept.
 * The bus only ever sees an ordinary Context participant/endpoint; nothing here introduces
 * a new envelope, kind tag, or discriminator visible outside the bridge. This module is the
 * ONLY place that substitutes deterministic command execution for the LLM adapter.
 */
import { exec, execFile } from "node:child_process";

const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const OUTPUT_TRUNCATE_CHARS = 4000;

/** Local mirror of the bus's ScopeGraphCommandInput shape — the bridge does not import floe-bus types directly. */
export type CommandNodeInput = {
  name: string;
  content_key: string;
  required?: boolean;
};

/** Local mirror of the bus's ScopeGraphCommandOutput shape. */
export type CommandNodeOutput = {
  name: string;
  from: "exit_code" | "passed" | "stdout" | "stderr";
};

export type CommandNodeConfig = {
  graph_id: string;
  node_id: string;
  context_id: string;
  endpoint_id: string;
  command: string;
  inputs: CommandNodeInput[];
  outputs: CommandNodeOutput[];
  result_event_type: string;
  workspace_locator: string;
};

export type CommandExecutionFacts = {
  exit_code: number;
  passed: boolean;
  stdout: string;
  stderr: string;
};

/** Thrown when a required input has no value in the triggering event's content. */
export class CommandInputMissingError extends Error {
  constructor(nodeId: string, inputName: string) {
    super(`Command node '${nodeId}' is missing required input '${inputName}'`);
    this.name = "CommandInputMissingError";
  }
}

/** Resolves each declared input's value from the triggering event's content, by content_key. */
export function resolveCommandInputValues(
  config: CommandNodeConfig,
  content: Record<string, unknown>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of config.inputs) {
    const value = content[input.content_key];
    if (value === undefined || value === null) {
      if (input.required) {
        throw new CommandInputMissingError(config.node_id, input.name);
      }
      continue;
    }
    values[input.name] = value;
  }
  return values;
}

/** Replaces `{{name}}` placeholders in `command` with resolved input values. */
export function substituteCommandPlaceholders(command: string, values: Record<string, unknown>): string {
  return command.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, name) => {
    if (!(name in values)) return match;
    return String(values[name]);
  });
}

function truncate(text: string): string {
  return text.length > OUTPUT_TRUNCATE_CHARS ? text.slice(0, OUTPUT_TRUNCATE_CHARS) : text;
}

/**
 * Runs a resolved shell command. Uses `child_process.exec` (NOT `execFile` with manually
 * constructed shell args) so Node handles platform-appropriate shell invocation — a manual
 * cmd.exe /d /s /c argv array mangles nested quoting on Windows and silently no-ops instead
 * of failing loudly. A non-zero exit code is data, never a thrown error.
 */
export function executeCommand(resolvedCommand: string, cwd: string, signal?: AbortSignal): Promise<CommandExecutionFacts> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const child = exec(
      resolvedCommand,
      { cwd, timeout: EXECUTION_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        const exit_code = error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
          ? (error as unknown as { code: number }).code
          : error
            ? 1
            : 0;
        resolvePromise({
          exit_code,
          passed: exit_code === 0,
          stdout: truncate(stdout ?? ""),
          stderr: truncate(stderr ?? "")
        });
      }
    );
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
      } else {
        child.kill("SIGTERM");
      }
      resolvePromise({ exit_code: 130, passed: false, stdout: "", stderr: "Command stopped by operator" });
    };
    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

/** Maps raw execution facts onto declared outputs, or emits the raw facts as-is if none declared. */
export function buildCommandResultContent(
  config: CommandNodeConfig,
  facts: CommandExecutionFacts,
  resolvedCommand: string
): Record<string, unknown> {
  const content: Record<string, unknown> = { command: resolvedCommand };
  if (!config.outputs || config.outputs.length === 0) {
    content.exit_code = facts.exit_code;
    content.passed = facts.passed;
    content.stdout = facts.stdout;
    content.stderr = facts.stderr;
    return content;
  }
  for (const output of config.outputs) {
    content[output.name] = facts[output.from];
  }
  return content;
}

/** Full command node cycle: resolve inputs -> substitute placeholders -> execute -> build result content. */
export async function runCommandNode(
  config: CommandNodeConfig,
  content: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const values = resolveCommandInputValues(config, content);
  const resolvedCommand = substituteCommandPlaceholders(config.command, values);
  const facts = await executeCommand(resolvedCommand, config.workspace_locator, signal);
  return buildCommandResultContent(config, facts, resolvedCommand);
}
