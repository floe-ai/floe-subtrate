import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = "floe-bus/src/extension-boundary.test.ts";
const BANNED_EXTENSION_NAMES = ["snowball"];
const SOURCE_ROOTS = ["floe-bus/src", "floe-bridge/src", "floe-app/src"];
const SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", "build", ".git"]);

function collectSourceFiles(root: string): string[] {
  const absolute = join(REPO_ROOT, root);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    if (SKIPPED_DIR_NAMES.has(entry)) continue;
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) {
      files.push(...collectSourceFiles(relative(REPO_ROOT, child)));
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      files.push(child);
    }
  }
  return files;
}

describe("extension boundary", () => {
  it("keeps substrate source independent of specific extensions", () => {
    const violations: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of collectSourceFiles(root)) {
        const repoPath = relative(REPO_ROOT, file).split(sep).join("/");
        if (repoPath === SELF) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (BANNED_EXTENSION_NAMES.some((name) => line.toLowerCase().includes(name))) {
            violations.push(`${repoPath}:${index + 1}  ${line.trim()}`);
          }
        });
      }
    }
    expect(
      violations,
      "Substrate code must not name a specific extension. Extensions are independent repositories that build against the substrate contract; use a neutral placeholder name such as acme in fixtures. See docs/adr/0006-external-extension-repositories.md."
    ).toEqual([]);
  });
});
