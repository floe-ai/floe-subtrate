import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { ProviderRuntimeAdapter } from "./provider-runtime-adapter.js";

describe("ProviderRuntimeAdapter", () => {
  it("routes only Codex app-server profiles away from the Pi compatibility runtime", async () => {
    const home = mkdtempSync(join(tmpdir(), "floe-provider-router-"));
    try {
      const config = defaultConfig(home);
      const configPath = join(home, "config.yaml");
      writeFileSync(configPath, YAML.stringify(config));
      mkdirSync(join(home, "auth"), { recursive: true });
      writeFileSync(join(home, "auth", "profiles.yaml"), YAML.stringify({
        version: 1,
        profiles: [
          { id: "chatgpt-codex", provider: "openai-codex-app-server" },
          { id: "copilot", provider: "github-copilot" },
        ],
      }));

      const compatibilityHandle = vi.fn().mockResolvedValue(undefined);
      const codexHandle = vi.fn().mockResolvedValue(undefined);
      const compatibility: RuntimeAdapter = { name: "pi-agent-core", handleBundle: compatibilityHandle };
      const codex: RuntimeAdapter = { name: "codex-app-server", handleBundle: codexHandle };
      const router = new ProviderRuntimeAdapter(configPath, config, compatibility, codex);
      const context = {} as any;
      const bundle = {} as any;

      await router.handleBundle(context, bundle, {
        provider: "configured_by_pi_ai",
        auth_profile: "chatgpt-codex",
        auth_profile_source: "workspace_binding",
        model: "gpt-5.6-sol",
      });
      await router.handleBundle(context, bundle, { auth_profile: "copilot", model: "gpt-4.1" });

      expect(codexHandle).toHaveBeenCalledTimes(1);
      expect(codexHandle).toHaveBeenCalledWith(context, bundle, expect.objectContaining({ provider: "openai-codex-app-server" }));
      expect(compatibilityHandle).toHaveBeenCalledTimes(1);
      expect(compatibilityHandle).toHaveBeenCalledWith(context, bundle, expect.objectContaining({ provider: "github-copilot" }));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
