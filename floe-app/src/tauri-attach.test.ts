/**
 * Verifies the Tauri attach mechanism:
 * - tauri:attach script uses --config with the override file (not --no-dev-server)
 * - tauri.attach.conf.json sets beforeDevCommand to "" (prevents second vite)
 * - tauri.conf.json base config still has a non-empty beforeDevCommand (for standalone tauri dev)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve relative to the floe-app workspace root (two levels up from src/)
const appRoot = resolve(__dirname, "..");

describe("tauri:attach override config", () => {
  it("tauri:attach script uses --config override, not --no-dev-server", () => {
    const pkg = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf-8"));
    const attachScript: string = pkg.scripts["tauri:attach"];
    expect(attachScript).toContain("--config");
    expect(attachScript).not.toContain("--no-dev-server");
  });

  it("tauri:attach script references the attach conf file", () => {
    const pkg = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf-8"));
    const attachScript: string = pkg.scripts["tauri:attach"];
    expect(attachScript).toContain("tauri.attach.conf.json");
  });

  it("tauri.attach.conf.json sets beforeDevCommand to empty string", () => {
    const conf = JSON.parse(
      readFileSync(resolve(appRoot, "src-tauri", "tauri.attach.conf.json"), "utf-8")
    );
    expect(conf.build.beforeDevCommand).toBe("");
  });

  it("tauri.conf.json base config retains a non-empty beforeDevCommand (standalone tauri dev)", () => {
    const conf = JSON.parse(
      readFileSync(resolve(appRoot, "src-tauri", "tauri.conf.json"), "utf-8")
    );
    expect(conf.build.beforeDevCommand).toBeTruthy();
    expect(conf.build.beforeDevCommand.length).toBeGreaterThan(0);
  });

  it("tauri:dev standalone script does NOT use --config override (must run its own vite)", () => {
    const pkg = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf-8"));
    const devScript: string = pkg.scripts["tauri:dev"];
    expect(devScript).not.toContain("tauri.attach.conf.json");
  });
});
