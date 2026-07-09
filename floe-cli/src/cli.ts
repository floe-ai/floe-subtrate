import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { ensureConfig, resolveLocalPath, saveConfig, type LocalConfig } from "./config.js";
import { buildResetPlan, executeReset } from "./reset.js";
import { seedDefaultActor } from "./actor-seed.js";
import type { OAuthProviderId } from "@earendil-works/pi-ai/oauth";
import {
  createAuthRuntime,
  findProfile,
  getAuthStatusLabel,
  listProviderOptions,
  removeProfile,
  saveProfiles,
  suggestProfileId,
  type ProfilesDocument,
  upsertProfile,
  validateProfileId
} from "./auth.js";
import {
  clearRecords,
  commandForNpm,
  isPidRunning,
  readRecords,
  repoRoot,
  serviceLogPath,
  startService,
  stopService,
  type ServiceName
} from "./process-manager.js";
import { checkCargoAvailable, missingCargoMessage } from "./desktop.js";

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
    const currentWorkspace = findAncestorWithFloe(process.cwd());
    if (currentWorkspace) {
      await registerCurrentWorkspace(config, currentWorkspace, true);
    }
    if (options.open) openUrl(config.app.bus_http_url ? appUrl(config) : "http://127.0.0.1:5379");
    console.log(`Floe is running: ${appUrl(config)}`);
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
  openUrl(appUrl(config));
  console.log(appUrl(config));
});

program.command("start").description("Start local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  await startAll(configPath, config);
  console.log("Started Floe services.");
});

program
  .command("desktop")
  .description("Open the Floe desktop window (start services if needed, attach Tauri to running 5379 frontend)")
  .action(async () => {
    const { configPath, config } = ensureConfig(program.opts().config);

    // Preflight: fail fast if Rust/cargo is not installed
    const toolchain = checkCargoAvailable();
    if (!toolchain.available) {
      console.error(missingCargoMessage());
      process.exit(1);
    }

    // Ensure services (bus, bridge, app/vite on 5379) are running
    await startAll(configPath, config);

    console.log(
      `Launching Floe desktop window attached to http://127.0.0.1:5379\n` +
      `(first run compiles Rust — this may take a few minutes)\n`
    );

    // Launch Tauri using a config override (tauri.attach.conf.json) that sets
    // beforeDevCommand to "" — this prevents Tauri from running `npm run dev`
    // and starting a second vite on 5379. Tauri connects directly to devUrl (5379)
    // which is already running from `floe start`.
    // NOTE: --no-dev-server does NOT suppress beforeDevCommand (it governs Tauri's
    // own static-file server only); the config override is the correct mechanism.
    const root = repoRoot();
    const { command, args } = commandForNpm(["run", "tauri:attach", "--workspace", "floe-app"]);
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit", // surface Rust compilation output so user is not left hanging
      env: { ...process.env },
    });

    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`Tauri window closed with exit code ${code}`));
      });
      child.on("error", reject);
    });
  });

program.command("stop").description("Stop local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["app", "bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  console.log("Stopped Floe services.");
});

program.command("restart").description("Restart local Floe services").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  for (const service of ["app", "bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  await startAll(configPath, config);
  console.log("Restarted Floe services.");
});

program
  .command("logs")
  .argument("[service]", "bus, bridge, or app")
  .description("Print service logs")
  .action((service?: ServiceName) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    const services = service ? [service] : ["bus", "bridge", "app"] as ServiceName[];
    for (const item of services) {
      const path = serviceLogPath(configPath, config, item);
      console.log(`\n== ${item}: ${path} ==`);
      console.log(existsSync(path) ? tail(readFileSync(path, "utf8"), 200) : "(no log file)");
    }
  });

program
  .command("login")
  .description("Configure a Floe auth profile")
  .option("--provider <provider>", "provider id")
  .option("--profile <profile>", "profile id")
  .option("--model <model>", "default model id for this profile")
  .option("--api-key-env <name>", "read API key from environment variable")
  .action(async (options) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    const runtime = createAuthRuntime(configPath, config);
    const providerOptions = listProviderOptions(runtime);
    if (providerOptions.length === 0) {
      throw new Error("No providers are available in the local model registry.");
    }

    const providerOption = await resolveProviderOption(providerOptions, options.provider);
    const profileId = await resolveProfileId(runtime.profiles, providerOption.id, options.profile);
    const model = typeof options.model === "string" && options.model.trim().length > 0 ? options.model.trim() : undefined;

    if (providerOption.auth_type === "oauth") {
      await loginWithOAuth(runtime, providerOption.id, providerOption.name);
    } else {
      const apiKey = await resolveApiKey(options.apiKeyEnv);
      runtime.authStorage.set(providerOption.id, { type: "api_key", key: apiKey });
    }

    upsertProfile(runtime.profiles, {
      id: profileId,
      provider: providerOption.id,
      model,
      label: providerOption.name
    });
    saveProfiles(runtime.paths.profilesYamlPath, runtime.profiles);
    if (providerOption.id !== "fake" && config.bridge.runtime_adapter !== "pi-agent-core") {
      config.bridge.runtime_adapter = "pi-agent-core";
      saveConfig(configPath, config);
      console.log("Runtime adapter: pi-agent-core");
    }
    runtime.modelRegistry.refresh();
    console.log(`Saved profile '${profileId}' for provider '${providerOption.id}'.`);
    if (model) console.log(`Default model: ${model}`);
  });

const authCommand = program.command("auth").description("Inspect Floe auth profiles");
authCommand.command("list").description("List configured Floe auth profiles").action(() => {
  const { configPath, config } = ensureConfig(program.opts().config);
  const runtime = createAuthRuntime(configPath, config);
  if (runtime.profiles.profiles.length === 0) {
    console.log("No Floe auth profiles are configured.");
    return;
  }
  for (const profile of runtime.profiles.profiles) {
    const status = runtime.modelRegistry.getProviderAuthStatus(profile.provider);
    const configured = status.configured ? "configured" : "missing";
    const modelText = profile.model ? profile.model : "(default)";
    console.log(
      `${profile.id} | provider=${profile.provider} | model=${modelText} | auth=${configured} (${getAuthStatusLabel(status)})`
    );
  }
});

authCommand.command("doctor").description("Validate Floe auth/profile setup").action(async () => {
  const { configPath, config } = ensureConfig(program.opts().config);
  const runtime = createAuthRuntime(configPath, config);
  const errors: string[] = [];
  const warnings: string[] = [];
  const providersInRegistry = new Set(runtime.modelRegistry.getAll().map((model) => model.provider));

  if (!existsSync(runtime.paths.authJsonPath)) errors.push(`Missing auth file: ${runtime.paths.authJsonPath}`);
  if (!existsSync(runtime.paths.modelsJsonPath)) errors.push(`Missing model config file: ${runtime.paths.modelsJsonPath}`);
  if (!existsSync(runtime.paths.profilesYamlPath)) errors.push(`Missing profiles file: ${runtime.paths.profilesYamlPath}`);

  if (runtime.modelRegistry.getError()) {
    warnings.push(`models.json warning: ${runtime.modelRegistry.getError()}`);
  }
  if (runtime.profilesLoadError) {
    errors.push(`profiles.yaml parse/schema error: ${runtime.profilesLoadError}`);
  }

  for (const profile of runtime.profiles.profiles) {
    if (!providersInRegistry.has(profile.provider)) {
      errors.push(`Profile '${profile.id}' uses unknown provider '${profile.provider}'.`);
      continue;
    }
    if (profile.model && !runtime.modelRegistry.find(profile.provider, profile.model)) {
      errors.push(`Profile '${profile.id}' references unknown model '${profile.provider}/${profile.model}'.`);
    }
  }

  const profileProviders = new Set(runtime.profiles.profiles.map((profile) => profile.provider));
  for (const provider of profileProviders) {
    try {
      const apiKey = await runtime.authStorage.getApiKey(provider);
      if (!apiKey) {
        errors.push(`Provider '${provider}' has no usable auth. Run 'floe login --provider ${provider}'.`);
      }
    } catch (error) {
      errors.push(`Provider '${provider}' auth check failed: ${(error as Error).message}`);
    }
  }

  for (const authError of runtime.authStorage.drainErrors()) {
    warnings.push(`Auth refresh warning: ${authError.message}`);
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log("Auth doctor: OK");
    return;
  }

  if (errors.length > 0) {
    console.log("Auth doctor errors:");
    for (const error of errors) console.log(`- ${error}`);
  }
  if (warnings.length > 0) {
    console.log("Auth doctor warnings:");
    for (const warning of warnings) console.log(`- ${warning}`);
  }
  if (errors.length > 0) process.exitCode = 1;
});

program
  .command("logout")
  .argument("<profile>", "profile id")
  .description("Remove a Floe auth profile")
  .action((profile) => {
    const { configPath, config } = ensureConfig(program.opts().config);
    const runtime = createAuthRuntime(configPath, config);
    const existing = findProfile(runtime.profiles, profile);
    if (!existing) {
      throw new Error(`Unknown profile '${profile}'.`);
    }
    removeProfile(runtime.profiles, profile);
    saveProfiles(runtime.paths.profilesYamlPath, runtime.profiles);
    const providerStillReferenced = runtime.profiles.profiles.some((item) => item.provider === existing.provider);
    if (!providerStillReferenced) {
      runtime.authStorage.logout(existing.provider);
      console.log(`Removed profile '${profile}' and provider auth '${existing.provider}'.`);
      return;
    }
    console.log(`Removed profile '${profile}'. Provider auth '${existing.provider}' is still used by other profiles.`);
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
  for (const service of ["app", "bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);
  uninstallAutostart();
  console.log("Removed Floe service entries. Local data is preserved.");
});

program
  .command("reset")
  .description("Factory reset: wipe all Floe state (workspaces, contexts, boards, agents) while preserving provider credentials and service config")
  .option("--yes", "skip confirmation prompt")
  .action(async (options) => {
    const { configPath, config } = ensureConfig(program.opts().config);

    // Stop running services before wiping their databases
    for (const service of ["app", "bridge", "bus"] as ServiceName[]) stopService(configPath, config, service);

    const plan = buildResetPlan(configPath, config);

    console.log("\nFloe Factory Reset");
    console.log("==================");
    console.log("\nWILL WIPE:");
    for (const target of plan.wipe) {
      console.log(`  - ${target.label}`);
      console.log(`    ${target.path}`);
    }
    console.log("\nWILL PRESERVE:");
    for (const target of plan.preserve) {
      console.log(`  + ${target.label}`);
      console.log(`    ${target.path}`);
    }
    console.log("");

    if (!options.yes) {
      const rl = createInterface({ input, output });
      try {
        const answer = (await rl.question("This is destructive and cannot be undone. Continue? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          console.log("Reset cancelled.");
          process.exit(0);
        }
      } finally {
        rl.close();
      }
    }

    executeReset(configPath, config);
    console.log("\nReset complete. Run \`floe setup\` or \`floe start\` to start fresh.");
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
    openUrl(`${appUrl(config)}?workspace=${encodeURIComponent(currentWorkspace)}`);
  } else {
    openUrl(`${appUrl(config)}?candidate=${encodeURIComponent(process.cwd())}`);
  }
});

await program.parseAsync(normalizeLegacyCommandArgs(process.argv));

async function resolveProviderOption(
  options: Array<{ id: string; name: string; auth_type: "oauth" | "api_key" }>,
  providerFlag?: string
): Promise<{ id: string; name: string; auth_type: "oauth" | "api_key" }> {
  if (providerFlag) {
    const explicit = options.find((option) => option.id === providerFlag);
    if (!explicit) {
      throw new Error(`Unknown provider '${providerFlag}'. Run 'floe auth list' and 'floe auth doctor' for details.`);
    }
    return explicit;
  }

  const rl = createInterface({ input, output });
  try {
    console.log("Select provider:");
    for (const [index, option] of options.entries()) {
      console.log(`  ${index + 1}. ${option.name} (${option.id}, ${option.auth_type})`);
    }
    const answer = (await rl.question(`Enter number (1-${options.length}): `)).trim();
    const parsed = Number(answer);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > options.length) {
      throw new Error("Invalid provider selection.");
    }
    return options[parsed - 1];
  } finally {
    rl.close();
  }
}

async function resolveProfileId(profiles: ProfilesDocument, provider: string, profileFlag?: string): Promise<string> {
  if (profileFlag) return validateProfileId(profileFlag);
  const suggested = suggestProfileId(profiles, provider);
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`Profile id [${suggested}]: `)).trim();
    return validateProfileId(answer || suggested);
  } finally {
    rl.close();
  }
}

async function loginWithOAuth(runtime: ReturnType<typeof createAuthRuntime>, providerId: string, providerName: string): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    await runtime.authStorage.login(providerId as OAuthProviderId, {
      onAuth: (info) => {
        console.log(`Open this URL to authenticate ${providerName}:`);
        console.log(info.url);
        if (info.instructions) console.log(info.instructions);
        openUrl(info.url);
      },
      onDeviceCode: (info) => {
        console.log(`Device code: ${info.userCode}`);
        console.log(`Verify at: ${info.verificationUri}`);
        openUrl(info.verificationUri);
      },
      onPrompt: async (prompt) => {
        const hint = prompt.placeholder ? ` (${prompt.placeholder})` : "";
        return rl.question(`${prompt.message}${hint}: `);
      },
      onProgress: (message) => {
        console.log(message);
      },
      onManualCodeInput: async () => rl.question("Paste redirect URL or auth code: "),
      onSelect: async (prompt) => {
        console.log(prompt.message);
        prompt.options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt.label}`));
        const answer = (await rl.question("Select option number: ")).trim();
        const idx = parseInt(answer, 10) - 1;
        return prompt.options[idx]?.id;
      }
    });
  } finally {
    rl.close();
  }
}

async function resolveApiKey(apiKeyEnv?: string): Promise<string> {
  if (apiKeyEnv) {
    const value = process.env[apiKeyEnv];
    if (!value) throw new Error(`Environment variable '${apiKeyEnv}' is not set.`);
    if (!value.trim()) throw new Error(`Environment variable '${apiKeyEnv}' is empty.`);
    return value.trim();
  }
  const rl = createInterface({ input, output });
  try {
    const entered = (await rl.question("API key: ")).trim();
    if (!entered) throw new Error("API key cannot be empty.");
    return entered;
  } finally {
    rl.close();
  }
}

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
  if (config.services.start_app && !(await isHealthy(appUrl(config)))) await startService(configPath, config, "app");
  if (config.services.start_app) await waitForHealth(appUrl(config), "floe-app");
}

async function verifyHealth(config: LocalConfig): Promise<void> {
  await waitForHealth(config.bus.http_base_url, "floe-bus");
  await waitForHealth(appUrl(config), "floe-app");
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
  for (const service of ["bus", "bridge", "app"] as ServiceName[]) {
    const record = records[service];
    const running = record ? isPidRunning(record.pid) : false;
    console.log(`${service}: ${running ? "running" : "not running"}${record ? ` pid=${record.pid}` : ""}`);
  }
  console.log(`bus: ${config.bus.http_base_url} ${await isHealthy(config.bus.http_base_url) ? "healthy" : "unreachable"}`);
  console.log(`app: ${appUrl(config)} ${await isHealthy(appUrl(config)) ? "healthy" : "unreachable"}`);
}

function appUrl(config: LocalConfig): string {
  const listen = config.app.listen;
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
  const workspaceId: string = result.workspace.workspace_id;
  await fetch(`${config.bus.http_base_url}/v1/workspaces/${encodeURIComponent(workspaceId)}/select`, {
    method: "POST"
  });
  // Seed a default human operator actor if none exists yet.
  // Stored bus-DB-only (no workspace file written) so git status stays clean.
  const seedResult = await seedDefaultActor(config.bus.http_base_url, workspaceId);
  if (seedResult.seeded) {
    console.log(`Seeded default actor: ${seedResult.endpoint_id}`);
  }
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

function normalizeLegacyCommandArgs(argv: string[]): string[] {
  const map: Record<string, string> = {
    "--start": "start",
    "--stop": "stop",
    "--status": "status",
    "--doctor": "doctor",
    "--restart": "restart",
    "--open": "open",
    "--setup": "setup",
    "--logs": "logs",
    "--uninstall": "uninstall"
  };
  let commandInjected = false;
  const normalized = [...argv.slice(0, 2)];
  for (const token of argv.slice(2)) {
    if (!commandInjected && map[token]) {
      normalized.push(map[token]);
      commandInjected = true;
      continue;
    }
    normalized.push(token);
  }
  return normalized;
}
