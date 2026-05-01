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
    workspace_access: z.object({
      local_paths: z.boolean()
    })
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
  })
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

export function ensureConfig(explicitPath?: string): { configPath: string; config: LocalConfig } {
  const configPath = resolveConfigPath(explicitPath);
  if (!existsSync(configPath)) {
    const config = defaultConfig(join(homedir(), ".floe"));
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, YAML.stringify(config), "utf8");
  }
  const config = LocalConfigSchema.parse(YAML.parse(readFileSync(configPath, "utf8")));
  mkdirSync(resolveLocalPath(configPath, config.home, config.bridge.data_dir), { recursive: true });
  mkdirSync(resolveLocalPath(configPath, config.home, config.bridge.log_dir), { recursive: true });
  return { configPath, config };
}

export function bridgeHttpBase(config: LocalConfig): string {
  if (process.env.FLOE_BUS_HTTP_URL) return process.env.FLOE_BUS_HTTP_URL;
  if (config.bus.http_base_url) return config.bus.http_base_url;
  return config.bridge.bus_url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

export function bridgeWsBase(config: LocalConfig): string {
  if (process.env.FLOE_BUS_WS_URL) return process.env.FLOE_BUS_WS_URL;
  if (config.bus.ws_base_url) return config.bus.ws_base_url;
  return config.bridge.bus_url;
}
