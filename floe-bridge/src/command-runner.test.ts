import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  resolveCommandInputValues,
  substituteCommandPlaceholders,
  buildCommandResultContent,
  executeCommand,
  runCommandNode,
  CommandInputMissingError,
  HIDDEN_WINDOWS_CHILD_PROCESS,
  type CommandNodeConfig
} from "./command-runner.js";

const repoRoot = resolve(process.cwd(), "..");

function makeConfig(overrides: Partial<CommandNodeConfig> = {}): CommandNodeConfig {
  return {
    graph_id: "graph_1",
    node_id: "check_node",
    context_id: "ctx_1",
    endpoint_id: "endpoint:check",
    command: `node -e "process.exit(0)"`,
    inputs: [],
    outputs: [],
    result_event_type: "command.result",
    workspace_locator: process.cwd(),
    ...overrides
  };
}

describe("resolveCommandInputValues", () => {
  it("resolves named inputs from event content by content_key", () => {
    const config = makeConfig({
      inputs: [{ name: "file", content_key: "file_path", required: true }]
    });
    const values = resolveCommandInputValues(config, { file_path: "a.txt" });
    expect(values).toEqual({ file: "a.txt" });
  });

  it("skips optional inputs with no value", () => {
    const config = makeConfig({
      inputs: [{ name: "flag", content_key: "flag", required: false }]
    });
    const values = resolveCommandInputValues(config, {});
    expect(values).toEqual({});
  });

  it("throws CommandInputMissingError when a required input has no value", () => {
    const config = makeConfig({
      inputs: [{ name: "file", content_key: "file_path", required: true }]
    });
    expect(() => resolveCommandInputValues(config, {})).toThrow(CommandInputMissingError);
  });

  it("includes the node_id and input name in the error message", () => {
    const config = makeConfig({
      inputs: [{ name: "should_pass", content_key: "should_pass", required: true }]
    });
    expect(() => resolveCommandInputValues(config, {})).toThrow(
      "Command node 'check_node' is missing required input 'should_pass'"
    );
  });
});

describe("substituteCommandPlaceholders", () => {
  it("replaces {{name}} placeholders with resolved values", () => {
    const result = substituteCommandPlaceholders("echo {{message}}", { message: "hi" });
    expect(result).toBe("echo hi");
  });

  it("leaves unresolved placeholders untouched", () => {
    const result = substituteCommandPlaceholders("echo {{missing}}", {});
    expect(result).toBe("echo {{missing}}");
  });
});

describe("buildCommandResultContent", () => {
  it("emits raw execution facts as-is when no outputs are declared", () => {
    const config = makeConfig({ outputs: [] });
    const content = buildCommandResultContent(
      config,
      { exit_code: 0, passed: true, stdout: "ok", stderr: "" },
      "node -e \"process.exit(0)\""
    );
    expect(content).toEqual({
      command: "node -e \"process.exit(0)\"",
      exit_code: 0,
      passed: true,
      stdout: "ok",
      stderr: ""
    });
  });

  it("maps raw facts onto declared output names", () => {
    const config = makeConfig({ outputs: [{ name: "succeeded", from: "passed" }] });
    const content = buildCommandResultContent(
      config,
      { exit_code: 1, passed: false, stdout: "", stderr: "boom" },
      "false"
    );
    expect(content).toEqual({ command: "false", succeeded: false });
  });
});

describe("executeCommand", () => {
  it("keeps deterministic command and cancellation helpers hidden from desktop users", () => {
    expect(HIDDEN_WINDOWS_CHILD_PROCESS).toEqual({ windowsHide: true });
  });

  it("reports passed: true and exit_code: 0 on success", async () => {
    const facts = await executeCommand(`node -e "process.exit(0)"`, process.cwd());
    expect(facts.passed).toBe(true);
    expect(facts.exit_code).toBe(0);
  });

  it("reports passed: false and a non-zero exit_code on failure", async () => {
    const facts = await executeCommand(`node -e "process.exit(1)"`, process.cwd());
    expect(facts.passed).toBe(false);
    expect(facts.exit_code).toBe(1);
  });

  it("captures stdout", async () => {
    const facts = await executeCommand(`node -e "console.log('hello-from-command')"`, process.cwd());
    expect(facts.stdout).toContain("hello-from-command");
  });

  it("stops an exact command process when its delivery is cancelled", async () => {
    const controller = new AbortController();
    const pending = executeCommand(`node -e "setTimeout(() => {}, 30000)"`, process.cwd(), controller.signal);
    controller.abort();

    await expect(pending).resolves.toMatchObject({
      passed: false,
      exit_code: 130,
      stderr: "Command stopped by operator",
    });
  });
});

describe("runCommandNode", () => {
  it("runs the full cycle and returns pass content for a passing command", async () => {
    const config = makeConfig({
      command: `node -e "process.exit(0)"`,
      outputs: [{ name: "passed", from: "passed" }]
    });
    const result = await runCommandNode(config, {});
    expect(result.passed).toBe(true);
  });

  it("runs the full cycle and returns fail content for a failing command", async () => {
    const config = makeConfig({
      command: `node -e "process.exit(1)"`,
      outputs: [{ name: "passed", from: "passed" }]
    });
    const result = await runCommandNode(config, {});
    expect(result.passed).toBe(false);
  });

  it("rejects with CommandInputMissingError when a required input is absent", async () => {
    const config = makeConfig({
      inputs: [{ name: "should_pass", content_key: "should_pass", required: true }]
    });
    await expect(runCommandNode(config, {})).rejects.toThrow(CommandInputMissingError);
  });

  it("proves the ticket's case: runs a real vitest file as a command node and branches on pass/fail", async () => {
    const config = makeConfig({
      command: `npx vitest run floe-bus/src/docs-vocabulary.test.ts`,
      workspace_locator: repoRoot,
      outputs: [{ name: "passed", from: "passed" }, { name: "stdout", from: "stdout" }]
    });
    const result = await runCommandNode(config, {});
    expect(result.passed).toBe(true);
  }, 30_000);
});
