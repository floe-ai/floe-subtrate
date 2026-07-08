/**
 * Desktop (Tauri) launch helpers for `floe desktop`.
 *
 * Extracted as a separate module so the cargo-preflight logic can be unit-tested
 * without spawning real processes (use the injected `spawnFn` parameter).
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type CargoCheckResult = { available: boolean; error?: string };

/**
 * Check whether the Rust `cargo` toolchain is available on PATH.
 *
 * Accepts an optional `spawnFn` injection for testability; defaults to
 * the real `spawnSync`.
 */
export function checkCargoAvailable(
  spawnFn: (cmd: string, args: string[]) => Pick<SpawnSyncReturns<Buffer>, "error" | "status"> = (cmd, args) =>
    spawnSync(cmd, args, { stdio: "pipe", timeout: 5_000 })
): CargoCheckResult {
  try {
    const result = spawnFn("cargo", ["--version"]);
    if (result.error) {
      return { available: false, error: result.error.message };
    }
    if (result.status !== 0) {
      return { available: false, error: `cargo exited with status ${result.status}` };
    }
    return { available: true };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Human-readable, actionable message when cargo/Rust is not installed.
 */
export function missingCargoMessage(): string {
  return (
    "floe desktop requires the Rust toolchain (cargo) to compile the Tauri window.\n" +
    "Install Rust from https://rustup.rs/ and re-run `floe desktop`.\n" +
    "\n" +
    "The first launch compiles Rust (~2–5 min on a cold cache) — subsequent launches\n" +
    "are fast. Compilation output is shown inline so you can track progress."
  );
}
