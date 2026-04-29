#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { ensureConfig, resolveLocalPath, saveConfig, type LocalConfig } from "./config.js";
import {
  clearRecords,
  isPidRunning,
  readRecords,
  serviceLogPath,
  startService,
  stopService,
  type ServiceName
} from "./process-manager.js";

const program = new Command();

program
  .name("floe")
  .description("Launch and manage the local Floe substrate")
  .option("--config <path>", "config path");

program
  .command("setup")
  .description("Create config, optionally enable autostart, start services, verify health, and open web")
  .option("--yes", "accept setup defaults")
  .option("--no-autostart", "do not enable user-level autostart")
  .option("--no-open", "do not open the web UI")
  .option("--repair", "reconcile local service records")
  .action(async (options) => {
    const { configPath, config, created } = ensureConfig(program.opts().config);
    if (options.repair) clearRecords(configPath, config);
    if (created || options.yes || options.autostart === false) {
      await applyAutostartChoice(configPath, config, options);
    }
    await startAll(configPath, config);
    await verifyHealth(config);
    if (options.open) openUrl(config.web.bus_http_url ? webUrl(config) : "http://127.0.0.1:5378");
    console.log(`Floe is running: ${webUrl(config)}`);
  });

program
  .command("status")
  .description("Show service health and configured URLs")
  .action(async () => {
    const { configPath, config } = ensureConfig(program.opts().config);
    await printStatus(configPath, config);
  });

program.command("open").description("Open the Floe web UI").action(async () => {
  const { config } = ensureConfig(program.opts().config);
  openUrl(webUrl(config));
  console.log(webUrl(config));
});

program.command("start").description("Start local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  await startAll(configPath, config);
  console.log("Started Floe services.");
});

program.command("stop").description("Stop local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["web", "bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  console.log("Stopped Floe services.");
});

program.command("restart").description("Restart local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["web", "bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  await startAll(configPath, config);
  console.log("Restarted Floe services.");
});

program
  .command("logs")
  .argument("[service]", "bus, bridge, or web")
  .description("Print service logs")
  .action((service?: ServiceName) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    const services = service ? [service] : ["bus", "bridge", "web"] as ServiceName[];
    for (const item of services) {
      const path = serviceLogPath(configPath, config, item);
      console.log(`\n== ${item}: ${path} ==`);
      console.log(existsSync(path) ? tail(readFileSync(path, "utf8"), 200) : "(no log file)");
    }
  });

program.command("doctor").description("Diagnose local Floe setup").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  await printStatus(configPath, config);
  console.log(`Config: ${configPath}`);
  console.log(`Home: ${resolveLocalPath(configPath, config.home, ".")}`);
});

const configCommand = program.command("config").description("Inspect local config");
configCommand.command("path").description("Print active config path").action(() => {
  const { configPath } = ensureConfig(program.opts().config);
  console.log(configPath);
});
configCommand.command("edit").description("Open config in EDITOR or print path").action(() => {
  const { configPath } = ensureConfig(program.opts().config);
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    console.log(configPath);
    return;
  }
  spawn(editor, [configPath], { stdio: "inherit", shell: true });
});

const autostart = program.command("autostart").description("Manage user-level autostart");
autostart.command("on").description("Enable user-level autostart").action(() => {
  const { configPath, config } = ensureConfig(program.opts().config);
  config.services.autostart = true;
  saveConfig(configPath, config);
  installAutostart(configPath);
  console.log("Autostart enabled.");
});
autostart.command("off").description("Disable user-level autostart").action(() => {
  const { configPath, config } = ensureConfig(program.opts().config);
  config.services.autostart = false;
  saveConfig(configPath, config);
  uninstallAutostart();
  console.log("Autostart disabled.");
});

program.command("uninstall").description("Remove autostart entries and stop services; preserve ~/.floe data").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["web", "bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  uninstallAutostart();
  console.log("Removed Floe service entries. Local data is preserved.");
});

program.action(async () => {
  const { configPath, config, created } = ensureConfig(program.opts().config);
  if (created) {
    await applyAutostartChoice(configPath, config, { yes: false, autostart: undefined });
  }
  await startAll(configPath, config);
  await verifyHealth(config);
  const currentWorkspace = findAncestorWithFloe(process.cwd());
  if (currentWorkspace) {
    await registerCurrentWorkspace(config, currentWorkspace, true);
    openUrl(`${webUrl(config)}?workspace=${encodeURIComponent(currentWorkspace)}`);
  } else {
    openUrl(`${webUrl(config)}?candidate=${encodeURIComponent(process.cwd())}`);
  }
});

await program.parseAsync(process.argv);

async function applyAutostartChoice(configPath: string, config: LocalConfig, options: any): Promise<void> {
  let enable = options.autostart !== false;
  if (!options.yes && options.autostart !== false) {
    const rl = createInterface({ input, output });
    const answer = await rl.question("Start Floe automatically when you log in? (recommended) [Y/n] ");
    rl.close();
    enable = !answer.trim().toLowerCase().startsWith("n");
  }
  config.services.autostart = enable;
  saveConfig(configPath, config);
  if (enable) installAutostart(configPath);
  else uninstallAutostart();
}

async function startAll(configPath: string, config: LocalConfig): Promise<void> {
  if (!(await isHealthy(config.bus.http_base_url))) await startService(configPath, config, "bus");
  await waitForHealth(config.bus.http_base_url, "floe-bus");
  await startService(configPath, config, "bridge");
  if (config.services.start_web && !(await isHealthy(webUrl(config)))) await startService(configPath, config, "web");
  if (config.services.start_web) await waitForHealth(webUrl(config), "floe-web");
}

async function verifyHealth(config: LocalConfig): Promise<void> {
  await waitForHealth(config.bus.http_base_url, "floe-bus");
  await waitForHealth(webUrl(config), "floe-web");
}

async function waitForHealth(baseUrl: string, label: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 30_000) {
    if (await isHealthy(baseUrl)) return;
    await sleep(500);
  }
  throw new Error(`${label} did not become healthy at ${baseUrl}`);
}

async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

async function printStatus(configPath: string, config: LocalConfig): Promise<void> {
  const records = readRecords(configPath, config);
  for (const service of ["bus", "bridge", "web"] as ServiceName[]) {
    const record = records[service];
    const running = record ? isPidRunning(record.pid) : false;
    console.log(`${service}: ${running ? "running" : "not running"}${record ? ` pid=${record.pid}` : ""}`);
  }
  console.log(`bus: ${config.bus.http_base_url} ${await isHealthy(config.bus.http_base_url) ? "healthy" : "unreachable"}`);
  console.log(`web: ${webUrl(config)} ${await isHealthy(webUrl(config)) ? "healthy" : "unreachable"}`);
}

function webUrl(config: LocalConfig): string {
  const listen = config.web.listen;
  return `http://${listen}`;
}

function openUrl(url: string): void {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

async function registerCurrentWorkspace(config: LocalConfig, locator: string, initAuthorized: boolean): Promise<void> {
  const response = await fetch(`${config.bus.http_base_url}/v1/workspaces/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      locator,
      init_authorized: initAuthorized
    })
  });
  if (!response.ok) throw new Error(`Workspace registration failed: ${response.status} ${await response.text()}`);
  const result = await response.json() as any;
  await fetch(`${config.bus.http_base_url}/v1/workspaces/${encodeURIComponent(result.workspace.workspace_id)}/select`, {
    method: "POST"
  });
}

function findAncestorWithFloe(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".floe"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function installAutostart(configPath: string): void {
  if (process.platform !== "win32") {
    const marker = join(dirname(configPath), "autostart.json");
    writeFileSync(marker, JSON.stringify({ enabled: true, note: "Autostart installation is implemented for Windows first." }, null, 2), "utf8");
    return;
  }
  const startupDir = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  mkdirSync(startupDir, { recursive: true });
  const script = join(startupDir, "floe.cmd");
  writeFileSync(script, `@echo off\r\ncd /d "${process.cwd()}"\r\nnpm run floe -- --config "${configPath}" start\r\n`, "utf8");
}

function uninstallAutostart(): void {
  if (process.platform !== "win32") return;
  const script = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "floe.cmd");
  if (existsSync(script)) rmSync(script);
}

function tail(text: string, lines: number): string {
  const parts = text.split(/\r?\n/);
  return parts.slice(Math.max(0, parts.length - lines)).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
