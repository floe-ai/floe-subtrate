import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import YAML from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const processes: ChildProcess[] = [];

describe("Floe local vertical slice", () => {
  let temp: string;
  let configPath: string;
  let busUrl: string;
  let wsUrl: string;
  let projectPath: string;
  let eventSocket: any;
  let busMessages: any[] = [];

  beforeEach(async () => {
    temp = mkdtempSync(join(tmpdir(), "floe-test-"));
    projectPath = join(temp, "project");
    mkdirSync(projectPath, { recursive: true });
    const busPort = await freePort();
    const webPort = await freePort();
    busUrl = `http://127.0.0.1:${busPort}`;
    wsUrl = `ws://127.0.0.1:${busPort}`;
    configPath = join(temp, "config.yaml");
    writeFileSync(configPath, YAML.stringify({
      schema: "floe.local.v1",
      version: 1,
      home: temp,
      services: {
        autostart: false,
        manager: "auto",
        start_web: false
      },
      bus: {
        listen: `127.0.0.1:${busPort}`,
        http_base_url: busUrl,
        ws_base_url: wsUrl,
        data_dir: "./bus",
        log_dir: "./logs/bus"
      },
      bridge: {
        data_dir: "./bridge",
        log_dir: "./logs/bridge",
        bus_url: wsUrl,
        workspace_access: {
          local_paths: true
        }
      },
      web: {
        listen: `127.0.0.1:${webPort}`,
        bus_http_url: busUrl,
        bus_ws_url: wsUrl,
        data_dir: "./web",
        log_dir: "./logs/web"
      },
      library: {
        configs_dir: "./configs",
        skills_dir: "./skills",
        extensions_dir: "./extensions",
        mcp_dir: "./mcp",
        templates_dir: "./templates"
      }
    }), "utf8");

    start("floe-bus", ["run", "dev", "--workspace", "floe-bus", "--", "--config", configPath]);
    await waitFor(async () => (await fetch(`${busUrl}/health`)).ok, "bus health");
    busMessages = [];
    eventSocket = new (globalThis as any).WebSocket(`${wsUrl}/v1/events/stream`);
    eventSocket.addEventListener("message", (event: any) => {
      busMessages.push(JSON.parse(String(event.data)));
    });
    await waitFor(() => busMessages.some((message) => message.type === "hello"), "bus event stream");
    start("floe-bridge", ["run", "dev", "--workspace", "floe-bridge", "--", "--config", configPath]);
  }, 60_000);

  afterEach(async () => {
    eventSocket?.close();
    for (const child of processes.splice(0).reverse()) killTree(child);
    if (temp) await removeTemp(temp);
  });

  it("initializes .floe and executes emit->delivery->turn-end lifecycle with fake runtime", async () => {
    const registered = await post<{ workspace: any }>("/v1/workspaces/register", {
      locator: projectPath,
      init_authorized: true
    });
    const workspaceId = registered.workspace.workspace_id;
    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, {});

    await waitFor(() => fileExists(join(projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentFile = readFileSync(join(projectPath, ".floe", "agents", "floe.md"), "utf8");
    expect(agentFile).not.toContain("endpoint_id");
    expect(agentFile).not.toContain("auth_profile: default");

    const agentEndpointId = `endpoint:${workspaceId}:agent:floe`;
    const humanEndpointId = `endpoint:${workspaceId}:user:operator`;
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some(
        (endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "runtime_unconfigured"
      );
    }, "runtime unconfigured status");

    await post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      actor_type: "human",
      name: "Operator",
      status: "online"
    });
    await post("/v1/runtime/bindings", {
      scope: "workspace_default",
      workspace_id: workspaceId,
      auth_profile: "copilot-atvi"
    });
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "runtime configured status");

    await post("/v1/events/emit", {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: humanEndpointId,
      destination: {
        kind: "endpoint",
        endpoint_id: agentEndpointId
      },
      thread_id: "thread:test",
      correlation_id: null,
      content: { text: "First local test message", data: {} },
      response: { expected: false },
      metadata: {}
    });

    await waitFor(async () => agentMessages(workspaceId, agentEndpointId, humanEndpointId).then((events) => events.length >= 2), "fake runtime response");
    await waitFor(() => sawBusEvents([
      "event_submitted",
      "destination_selector_resolved",
      "delivery_created",
      "delivery_reserved",
      "delivery_delivered_to_bridge",
      "delivery_injected_to_runtime",
      "delivery_acknowledged",
      "turn_end_observed"
    ]), "delivery lifecycle events");

    await waitFor(async () => {
      const telemetry = await get<{ records: any[] }>(`/v1/runtime/telemetry?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
      return telemetry.records.some((record) => record.kind === "visible_output");
    }, "visible runtime telemetry");

    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "idle");
    }, "endpoint returns to idle after normal reply");

    // Normal replies do not create pending responses
    const pending = await get<{ pending: any[] }>(`/v1/pending-responses?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
    expect(pending.pending.filter((item) => item.waiting_endpoint_id === agentEndpointId)).toHaveLength(0);

    const marker = join(projectPath, "delete-marker.txt");
    writeFileSync(marker, "cleanup proof", "utf8");
    const deleted = await post<{ ok: boolean; workspace_id: string; locator_deleted: boolean }>(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/delete`,
      { delete_locator: true }
    );
    expect(deleted.ok).toBe(true);
    expect(deleted.workspace_id).toBe(workspaceId);
    expect(deleted.locator_deleted).toBe(true);
    await waitFor(async () => {
      const result = await get<{ workspaces: any[] }>("/v1/workspaces");
      return !result.workspaces.some((workspace) => workspace.workspace_id === workspaceId);
    }, "workspace deletion propagation");
    expect(existsSync(projectPath)).toBe(false);
  }, 90_000);

  function sawBusEvents(types: string[]): boolean {
    return types.every((type) => busMessages.some((message) => message.type === type));
  }

  async function agentMessages(workspaceId: string, agentEndpointId: string, humanEndpointId: string) {
    const result = await get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
    return result.events.filter((event) => event.source_endpoint_id === agentEndpointId && event.destination_json?.endpoint_id === humanEndpointId);
  }

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${busUrl}${path}`);
    if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }

  async function post<T = any>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${busUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`${path} failed ${response.status}: ${await response.text()}`);
    return response.json() as Promise<T>;
  }
});

function start(label: string, args: string[]): void {
  const commandLine = commandForNpm(args);
  const child = spawn(commandLine.command, commandLine.args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      FLOE_RUNTIME_ADAPTER: "fake"
    }
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[${label}] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[${label}] ${chunk}`));
  processes.push(child);
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already stopped
      }
    }
  }
}

function commandForNpm(args: string[]): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npm", args };
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", ["npm", ...args.map(quoteCmdArg)].join(" ")]
  };
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@\\-]+$/.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function fileExists(path: string): boolean {
  try {
    return readFileSync(path).length >= 0;
  } catch {
    return false;
  }
}

async function removeTemp(path: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

async function waitFor<T>(check: () => Promise<T | false> | T | false, label: string, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("No free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
