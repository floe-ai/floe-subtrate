import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
        log_dir: "./logs/bus",
        wait_policy: {
          held_yield_refresh_ms: 250,
          wait_refresh_event_type: "wait_refresh"
        }
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

  it("initializes .floe, registers endpoints, and resumes fake runtime waits", async () => {
    const registered = await post<{ workspace: any }>("/v1/workspaces/register", {
      locator: projectPath,
      init_authorized: true
    });
    const workspaceId = registered.workspace.workspace_id;
    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, {});

    await waitFor(() => fileExists(join(projectPath, ".floe", "agents", "floe.md")), ".floe template");
    const agentFile = readFileSync(join(projectPath, ".floe", "agents", "floe.md"), "utf8");
    expect(agentFile).not.toContain("endpoint_id");
    expect(agentFile).toContain("substrate-build");

    const agentEndpointId = `endpoint:${workspaceId}:agent:floe`;
    const humanEndpointId = `endpoint:${workspaceId}:user:operator`;
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId);
    }, "agent endpoint registration");

    await post("/v1/endpoints/register", {
      endpoint_id: humanEndpointId,
      workspace_id: workspaceId,
      actor_type: "human",
      name: "Operator",
      status: "online"
    });

    await post("/v1/events/emit", {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: humanEndpointId,
      destination_endpoint_id: agentEndpointId,
      thread_id: "thread:test",
      correlation_id: null,
      content: { text: "First local test message", data: {} },
      metadata: {}
    });

    await waitFor(async () => agentMessages(workspaceId, agentEndpointId, humanEndpointId).then((events) => events.length >= 2), "first fake response");
    await waitFor(() => sawBusEvents([
      "event_submitted",
      "event_queued",
      "delivery_reserved",
      "delivery_delivered_to_bridge",
      "delivery_injected_to_runtime",
      "delivery_acknowledged",
      "wait_registered"
    ]), "first delivery state progression");
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === agentEndpointId && endpoint.status === "waiting");
    }, "agent waiting after yield");

    await post("/v1/events/emit", {
      type: "message",
      workspace_id: workspaceId,
      source_endpoint_id: humanEndpointId,
      destination_endpoint_id: agentEndpointId,
      thread_id: "thread:test",
      correlation_id: null,
      content: { text: "Resume from user", data: {} },
      metadata: {}
    });

    const finalEvents = await waitFor(
      async () => {
        const messages = await agentMessages(workspaceId, agentEndpointId, humanEndpointId);
        return messages.length >= 4 ? messages : false;
      },
      "second fake response after wait resume"
    );
    expect(finalEvents.map((event) => event.type)).toContain("progress");
    expect(finalEvents.some((event) => event.content.text?.includes("waiting for the next eligible event"))).toBe(true);
    await waitFor(() => busMessages.filter((message) => message.type === "wait_resolved").length >= 1, "resume delivered to yielded runtime");

    const timerAgentEndpointId = `endpoint:${workspaceId}:agent:timer`;
    await post("/v1/endpoints/register", {
      endpoint_id: timerAgentEndpointId,
      workspace_id: workspaceId,
      actor_type: "agent",
      name: "Timer Agent",
      agent_id: "timer",
      bridge_id: "bridge:local",
      status: "idle"
    });
    await post("/v1/events/yield", {
      event: {
        type: "message",
        workspace_id: workspaceId,
        source_endpoint_id: timerAgentEndpointId,
        destination_endpoint_id: humanEndpointId,
        thread_id: "thread:wait-refresh",
        correlation_id: null,
        content: { text: "Waiting for bus-owned wait refresh", data: {} },
        metadata: { turn_state: "waiting_for_input" }
      },
      wait: {
        mode: "open",
        max_batch_events: 5
      }
    });
    await waitFor(async () => {
      const result = await get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=200`);
      return result.events.some((event) => event.type === "wait_refresh" && event.destination_endpoint_id === timerAgentEndpointId);
    }, "wait_refresh event resume");
    await waitFor(() => busMessages.some((message) => message.type === "delivery_acknowledged"), "wait_refresh acknowledged");
    const deliveries = await get<{ deliveries: any[] }>(`/v1/delivery?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
    expect(deliveries.deliveries.some((delivery) => delivery.state === "acknowledged")).toBe(true);

    const statusBeforeDrift = await workspaceStatus(workspaceId);
    expect(statusBeforeDrift.active_config_hash).toBeTruthy();
    writeFileSync(join(projectPath, ".floe", "agents", "floe.md"), "\n\nDrift marker for tests.\n", { flag: "a" });
    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, {});
    const drifted = await waitFor(async () => {
      const workspace = await workspaceStatus(workspaceId);
      return workspace.status === "config_drift" ? workspace : false;
    }, "config drift detection");
    expect(drifted.active_config_hash).toBe(statusBeforeDrift.active_config_hash);

    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/config-snapshot`, {});
    await waitFor(async () => {
      const workspace = await workspaceStatus(workspaceId);
      return workspace.status === "attached" && workspace.active_config_hash !== statusBeforeDrift.active_config_hash;
    }, "config snapshot import");

    const savedConfig = await post<{ config: any }>("/v1/configs", {
      name: "Test reviewer config",
      config: {
        agents: [
          {
            id: "reviewer",
            name: "Reviewer",
            instructions: "Review local changes and yield with a concrete summary.",
            skills: []
          }
        ]
      }
    });
    await post(`/v1/workspaces/${encodeURIComponent(workspaceId)}/apply-config`, {
      config_id: savedConfig.config.config_id
    });
    await waitFor(() => fileExists(join(projectPath, ".floe", "agents", "reviewer.md")), "saved config materialization");
    await waitFor(async () => {
      const endpoints = await get<{ endpoints: any[] }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/endpoints`);
      return endpoints.endpoints.some((endpoint) => endpoint.endpoint_id === `endpoint:${workspaceId}:agent:reviewer`);
    }, "saved config agent endpoint");
  }, 90_000);

  function sawBusEvents(types: string[]): boolean {
    return types.every((type) => busMessages.some((message) => message.type === type));
  }

  async function agentMessages(workspaceId: string, agentEndpointId: string, humanEndpointId: string) {
    const result = await get<{ events: any[] }>(`/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=100`);
    return result.events.filter((event) => event.source_endpoint_id === agentEndpointId && event.destination_endpoint_id === humanEndpointId);
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

  async function workspaceStatus(workspaceId: string): Promise<any> {
    const result = await get<{ workspace: any }>(`/v1/workspaces/${encodeURIComponent(workspaceId)}/config-status`);
    return result.workspace;
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
