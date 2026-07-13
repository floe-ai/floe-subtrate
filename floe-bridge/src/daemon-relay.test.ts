/**
 * Regression tests for relay server lifecycle (Fix 2).
 *
 * Verifies that repeated attachWorkspace calls (e.g. on genuine config
 * reimport) do NOT accumulate relay servers or process.exit listeners.
 *
 * These tests live in a separate file so that vi.mock() of extension-relay
 * and extension-loader is scoped here and does not affect the existing
 * daemon.test.ts suite.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { vi, describe, it, expect, afterEach } from "vitest";
import { defaultConfig } from "./config.js";
import { BridgeDaemon } from "./daemon.js";

// ---------------------------------------------------------------------------
// Mock extension-relay: each call returns a new fake server with a spy close()
// ---------------------------------------------------------------------------

const createdServers: Array<{ close: ReturnType<typeof vi.fn> }> = [];

vi.mock("./extension-relay.js", () => ({
  startExtensionRelayServer: vi.fn(async () => {
    const server = { close: vi.fn() };
    createdServers.push(server);
    return { server, baseUrl: "http://127.0.0.1:0" };
  })
}));

// Mock extension-loader to return one extension that has an HTTP handler
// (so the relay startup path is exercised on every attach)
vi.mock("./extension-loader.js", () => ({
  loadExtensions: vi.fn(async () => [
    {
      name: "test-ext",
      errors: [],
      tools: [],
      pulses: [],
      bundledAgents: [],
      views: [],
      httpHandlers: [
        {
          method: "GET",
          path: "/ping",
          handler: async () => ({ status: 200, body: { ok: true } })
        }
      ]
    }
  ])
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-relay-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeEnv(): { workspacePath: string; configPath: string; config: ReturnType<typeof defaultConfig> } {
  const home = makeTmp();
  // Use a separate workspace subdirectory so loadExtensions does not treat
  // the config home as an extensions directory (per extension-loader test isolation rule)
  const workspacePath = join(home, "workspace");
  mkdirSync(workspacePath, { recursive: true });
  const config = defaultConfig(home);
  const configPath = join(home, "config.yaml");
  writeFileSync(configPath, YAML.stringify(config), "utf8");
  return { workspacePath, configPath, config };
}

function makeBusMock() {
  return {
    async importConfigSnapshot() {},
    async registerEndpoint() {},
    async createPulse() {},
    async reportExtensions() {},
    async reportAttachment() {},
    async resolveRuntimeBinding() {
      return {
        endpoint_auth_profile: null,
        workspace_auth_profile: null,
        global_auth_profile: null,
        endpoint_model: null,
        workspace_model: null,
        global_model: null,
        endpoint_thinking_level: null,
        workspace_thinking_level: null,
        global_thinking_level: null
      };
    }
  };
}

afterEach(() => {
  // Remove any lingering exit handlers registered by the relay under test
  // by asking the daemon to clean up, then forcibly clear the Map.
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs.length = 0;
  createdServers.length = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BridgeDaemon relay lifecycle (Fix 2)", () => {
  it("closes the previous relay server before starting a new one on reimport", async () => {
    const { workspacePath, configPath, config } = makeEnv();
    const daemon = new BridgeDaemon(configPath, config);
    (daemon as any).bus = makeBusMock();

    const workspace = {
      workspace_id: "workspace:relay-test",
      locator: workspacePath,
      name: "Relay Test",
      init_authorized: true,
      active_config_hash: "" // no drift check
    };

    // First attach: relay server 1 is created
    await (daemon as any).attachWorkspace(workspace);
    expect(createdServers).toHaveLength(1);
    const server1Close = createdServers[0].close;
    expect(server1Close).not.toHaveBeenCalled();

    // Second attach (simulating a reimport): relay server 2 is created,
    // and server 1 must have been closed first.
    await (daemon as any).attachWorkspace(workspace);
    expect(createdServers).toHaveLength(2);
    expect(server1Close).toHaveBeenCalledTimes(1);

    // Cleanup: stop the daemon to remove the surviving exit handler
    await daemon.stop();
  });

  it("does not accumulate process exit listeners across repeated reimports", async () => {
    const { workspacePath, configPath, config } = makeEnv();
    const daemon = new BridgeDaemon(configPath, config);
    (daemon as any).bus = makeBusMock();

    const workspace = {
      workspace_id: "workspace:listener-test",
      locator: workspacePath,
      name: "Listener Test",
      init_authorized: true,
      active_config_hash: ""
    };

    const listenersBefore = process.listenerCount("exit");

    // Three successive attaches (simulating three reimports)
    await (daemon as any).attachWorkspace(workspace);
    await (daemon as any).attachWorkspace(workspace);
    await (daemon as any).attachWorkspace(workspace);

    const listenersAfter = process.listenerCount("exit");

    // After 3 attaches, the net growth is at most 1 (the one live relay).
    // Before Fix 2 this would have been 3 (one per attach, never removed).
    expect(listenersAfter - listenersBefore).toBeLessThanOrEqual(1);

    // stop() removes the final relay's exit handler: count must return to baseline
    await daemon.stop();
    expect(process.listenerCount("exit")).toBe(listenersBefore);
  });

  it("workspaceRelays map holds exactly one entry per workspace after multiple attaches", async () => {
    const { workspacePath, configPath, config } = makeEnv();
    const daemon = new BridgeDaemon(configPath, config);
    (daemon as any).bus = makeBusMock();

    const workspace = {
      workspace_id: "workspace:map-test",
      locator: workspacePath,
      name: "Map Test",
      init_authorized: true,
      active_config_hash: ""
    };

    await (daemon as any).attachWorkspace(workspace);
    await (daemon as any).attachWorkspace(workspace);
    await (daemon as any).attachWorkspace(workspace);

    const relays: Map<string, unknown> = (daemon as any).workspaceRelays;
    expect(relays.size).toBe(1);
    expect(relays.has("workspace:map-test")).toBe(true);

    await daemon.stop();
  });
});
