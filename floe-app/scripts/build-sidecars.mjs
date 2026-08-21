import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rustInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = /^host:\s+(\S+)$/m.exec(rustInfo)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!target) throw new Error("Could not determine the Rust target triple for the desktop sidecars");

const extension = process.platform === "win32" ? ".exe" : "";
const nodeOutput = resolve(appRoot, "src-tauri", "binaries", `floe-node-${target}${extension}`);
const scriptOutput = resolve(appRoot, "src-tauri", "resources", "floe-desktop.js");
const promptOutput = resolve(appRoot, "src-tauri", "resources", "prompts");
mkdirSync(dirname(nodeOutput), { recursive: true });
mkdirSync(dirname(scriptOutput), { recursive: true });
mkdirSync(promptOutput, { recursive: true });
copyFileSync(process.execPath, nodeOutput);
chmodSync(nodeOutput, 0o755);
for (const name of ["default-floe-agent.md", "substrate-build-skill.md", "substrate-guidance.md"]) {
  copyFileSync(resolve(appRoot, "..", "floe-bridge", "src", "prompts", name), resolve(promptOutput, name));
}
execFileSync(
  "bun",
  ["build", resolve(appRoot, "src-desktop-sidecar", "index.ts"), "--target=node", "--outfile", scriptOutput],
  { cwd: appRoot, stdio: "inherit" },
);

const desktopBundle = readFileSync(scriptOutput, "utf8");
for (const providerLogin of ["loginOpenAICodex", "loginGitHubCopilot"]) {
  if (!desktopBundle.includes(providerLogin)) throw new Error(`Desktop bundle omitted Pi OAuth flow: ${providerLogin}`);
}
