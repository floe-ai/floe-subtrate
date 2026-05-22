import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = dirname(fileURLToPath(import.meta.url));
const nativePopupPattern = /\bwindow\.(confirm|prompt|alert)\s*\(/;

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    const extension = extname(path);
    if (extension !== ".ts" && extension !== ".tsx") continue;
    if (/\.test\.[tj]sx?$/.test(path)) continue;
    files.push(path);
  }
  return files;
}

describe("FloeWeb native popup guard", () => {
  it("keeps app source on the global dialog system instead of browser popups", () => {
    const offenders = sourceFiles(srcDir).flatMap((path) => {
      const content = readFileSync(path, "utf8");
      return nativePopupPattern.test(content)
        ? [relative(srcDir, path)]
        : [];
    });

    expect(offenders).toEqual([]);
  });
});
