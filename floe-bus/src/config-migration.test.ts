import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { ensureConfig } from "./config.js";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "floe-bus-cfg-mig-"));
}

const OLD_CONFIG_WEB = {
  schema: "floe.local.v1",
  version: 1,
  home: "/tmp/floe",
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
    listen: "127.0.0.1:5379",
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

describe("config migration: web → app", () => {
  it("migrates an old config with web: key to app: key without Zod error", () => {
    const tmp = makeTmp();
    try {
      const cfgPath = join(tmp, "config.yaml");
      writeFileSync(cfgPath, YAML.stringify(OLD_CONFIG_WEB), "utf8");

      const { config } = ensureConfig(cfgPath);

      expect(config.app).toBeDefined();
      expect(config.app.listen).toBe("127.0.0.1:5379");
      expect(config.services.start_app).toBe(true);

      const onDisk = YAML.parse(readFileSync(cfgPath, "utf8"));
      expect(onDisk.app).toBeDefined();
      expect(onDisk.web).toBeUndefined();
      expect(onDisk.services.start_app).toBe(true);
      expect(onDisk.services.start_web).toBeUndefined();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent: running on an already-migrated config is a no-op", () => {
    const tmp = makeTmp();
    try {
      const cfgPath = join(tmp, "config.yaml");
      writeFileSync(cfgPath, YAML.stringify(OLD_CONFIG_WEB), "utf8");

      ensureConfig(cfgPath);
      const mtimeAfterFirst = readFileSync(cfgPath, "utf8");

      ensureConfig(cfgPath);
      const mtimeAfterSecond = readFileSync(cfgPath, "utf8");

      expect(mtimeAfterFirst).toBe(mtimeAfterSecond);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not touch a config that already has app: key", () => {
    const tmp = makeTmp();
    try {
      const cfgPath = join(tmp, "config.yaml");
      const newCfg = { ...OLD_CONFIG_WEB } as Record<string, unknown>;
      delete (newCfg as Record<string, unknown>).web;
      (newCfg as Record<string, unknown>).app = {
        listen: "127.0.0.1:5379",
        bus_http_url: "http://127.0.0.1:5377",
        bus_ws_url: "ws://127.0.0.1:5377",
        data_dir: "./app",
        log_dir: "./logs/app"
      };
      (newCfg as Record<string, unknown>).services = { autostart: true, manager: "auto", start_app: true };
      writeFileSync(cfgPath, YAML.stringify(newCfg), "utf8");

      const contentBefore = readFileSync(cfgPath, "utf8");
      ensureConfig(cfgPath);
      const contentAfter = readFileSync(cfgPath, "utf8");

      expect(contentAfter).toBe(contentBefore);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
