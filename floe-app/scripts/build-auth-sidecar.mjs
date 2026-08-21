import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rustInfo = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
const host = /^host:\s+(\S+)$/m.exec(rustInfo)?.[1];
const target = process.env.TAURI_ENV_TARGET_TRIPLE || host;
if (!target) throw new Error("Could not determine the Rust target triple for the auth sidecar");

const extension = process.platform === "win32" ? ".exe" : "";
const output = resolve(appRoot, "src-tauri", "binaries", `floe-auth-${target}${extension}`);
mkdirSync(dirname(output), { recursive: true });

execFileSync(
  "bun",
  ["build", resolve(appRoot, "src-auth-sidecar", "index.ts"), "--compile", "--outfile", output],
  { cwd: appRoot, stdio: "inherit" },
);
