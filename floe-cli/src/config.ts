import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { z } from "zod";

const LocalConfigSchema = z.object({
  schema: z.literal("floe.local.v1"),
  version: z.number().int(),
  home: z.string(),
  services: z.object({
    autostart: z.boolean(),
    manager: z.string(),
    start_web: z.boolean()
  }),
  bus: z.object({
    listen: z.string(),
    http_base_url: z.string(),
    ws_base_url: z.string(),
    data_dir: z.string(),
    log_dir: z.string()
  }),
  bridge: z.object({
    data_dir: z.string(),
    log_dir: z.string(),
    bus_url: z.string(),
    workspace_access: z.object({ local_paths: z.boolean() }),
    runtime_adapter: z.string().optional()
  }),
  web: z.object({
    listen: z.string(),
    bus_http_url: z.string(),
    bus_ws_url: z.string(),
    data_dir: z.string(),
    log_dir: z.string()
  }),
  library: z.object({
    configs_dir: z.string(),
    skills_dir: z.string(),
    extensions_dir: z.string(),
    mcp_dir: z.string(),
    templates_dir: z.string()
  }),
  runtime: z.object({
    default_auth_profile: z.string().optional()
  }).optional()
});

export type LocalConfig = z.infer<typeof LocalConfigSchema>;

export function defaultConfig(home = join(homedir(), ".floe")): LocalConfig {
  return {
    schema: "floe.local.v1",
    version: 1,
    home,
    services: { autostart: true, manager: "auto", start_web: true },
    bus: {
      listen: "127.0.0.1:5377",
      http_base_url: "http://127.0.0.1:5377",
      ws_base_url: "ws://127.0.0.1:5377",
      data_dir: "./bus",
      log_dir: "./logs/bus"
    },
    bridge: {
      data_dir: "./bridge",
      log_dir: "./logs/bridge",
      bus_url: "ws://127.0.0.1:5377",
      workspace_access: { local_paths: true }
    },
    web: {
      listen: "127.0.0.1:5378",
      bus_http_url: "http://127.0.0.1:5377",
      bus_ws_url: "ws://127.0.0.1:5377",
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
  };
}

export function expandHome(pathValue: string): string {
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

export function resolveConfigPath(explicitPath?: string): string {
  return resolve(expandHome(explicitPath ?? process.env.FLOE_CONFIG ?? join(homedir(), ".floe", "config.yaml")));
}

export function resolveLocalPath(configPath: string, home: string, pathValue: string): string {
  const expanded = expandHome(pathValue);
  if (isAbsolute(expanded)) return resolve(expanded);
  return resolve(home ? expandHome(home) : dirname(configPath), expanded);
}

export function ensureConfig(explicitPath?: string): { configPath: string; config: LocalConfig; created: boolean } {
  const configPath = resolveConfigPath(explicitPath);
  let created = false;
  if (!existsSync(configPath)) {
    const config = defaultConfig(join(homedir(), ".floe"));
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    created = true;
  }
  const config = LocalConfigSchema.parse(YAML.parse(readFileSync(configPath, "utf8")));
  ensureLocalDirs(configPath, config);
  return { configPath, config, created };
}

export function saveConfig(configPath: string, config: LocalConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, YAML.stringify(config), "utf8");
}

export function ensureLocalDirs(configPath: string, config: LocalConfig): void {
  const paths = [
    config.bus.data_dir,
    config.bus.log_dir,
    config.bridge.data_dir,
    config.bridge.log_dir,
    config.web.data_dir,
    config.web.log_dir,
    config.library.configs_dir,
    config.library.skills_dir,
    config.library.extensions_dir,
    config.library.mcp_dir,
    config.library.templates_dir
  ];
  for (const path of paths) mkdirSync(resolveLocalPath(configPath, config.home, path), { recursive: true });
}
