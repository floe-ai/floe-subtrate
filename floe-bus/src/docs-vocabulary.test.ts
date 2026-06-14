import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Standing regression check (ROADMAP "Standing regression checks": docs and code agree).
// Retired vocabulary must not reappear as live concepts. Canonical terminology and
// invariants live in CONTEXT.md; the per-rule `allowed` lists below are the explicit
// legacy-debt registry — every entry says why it is allowed and when to remove it.
// A rule that stops matching one of its allowed files fails too, so the registry
// cannot rot silently: when the debt is paid, delete the entry.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SELF = "floe-bus/src/docs-vocabulary.test.ts";

// Point-in-time directories are exempt wholesale: plans, implementation reviews,
// worklogs, evidence, QA.
const SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".scratch",
  "plans",
  "implementation-reviews",
  "worklogs",
  "evidence",
  "qa"
]);

interface VocabularyRule {
  name: string;
  pattern: RegExp;
  roots: string[];
  extensions: string[];
  /** Known legacy debt: repo-relative path -> why it is allowed / when to remove. */
  allowed: Record<string, string>;
}

const RULES: VocabularyRule[] = [
  {
    name: "Default Scope as a live concept (ADR-0004 correction: it does not exist)",
    pattern: /default[ -]scope/i,
    roots: ["docs", "CONTEXT.md", "PRODUCT.md", "AGENTS.md", "README.md"],
    extensions: [".md"],
    allowed: {
      "CONTEXT.md": "names the retired term in _Avoid_ lists",
      "PRODUCT.md": "states the ban (no inventing a Default Scope)",
      "docs/adr/0004-scope-as-substrate-organising-boundary.md":
        "the decision record that defines the correction",
      "docs/ROADMAP.md":
        "section 2 proof points and propagation bullets predate the correction; annotated, ADR-0004 governs"
    }
  },
  {
    name: 'Pulse "scope" storage wording (renamed to Pulse Persistence)',
    pattern: /pulse ["“]?scope/i,
    roots: ["docs", "CONTEXT.md", "PRODUCT.md", "AGENTS.md"],
    extensions: [".md"],
    allowed: {
      "CONTEXT.md": "names the retired term in _Avoid_ lists and the resolved-rename note",
      "docs/ROADMAP.md": "proof point 5 states the rename requirement"
    }
  },
  {
    name: "is_default scope machinery (no default scope exists; remove, do not guard)",
    pattern: /is_default/,
    roots: ["floe-bus/src", "floe-web/src"],
    extensions: [".ts", ".tsx"],
    allowed: {
      "floe-web/src/scope-projection.ts": "optional legacy field; remove with V6 shell",
      "floe-web/src/scope-projection-api.test.ts": "fixture for legacy field; remove with V6 shell",
      "floe-web/src/main.tsx": "locally derived legacy flag; remove with V6 shell"
    }
  },
  {
    name: 'chat-shaped "read receipt" framing (use Endpoint Watermark / Event Cursor)',
    pattern: /read[ -]receipt/i,
    roots: ["docs", "CONTEXT.md", "PRODUCT.md", "AGENTS.md", "floe-bus/src"],
    extensions: [".md", ".ts", ".tsx"],
    allowed: {
      "CONTEXT.md": "names the banned term in the Endpoint Watermark _Avoid_ list"
    }
  },
  {
    name: ".floe/blocks substrate (rejected; must not be introduced)",
    pattern: /\.floe\/blocks/,
    roots: ["floe-bus/src", "floe-web/src", "docs", "CONTEXT.md", "PRODUCT.md", "AGENTS.md"],
    extensions: [".ts", ".tsx", ".md"],
    allowed: {
      "CONTEXT.md": "names the rejected substrate in _Avoid_ lists",
      "docs/ROADMAP.md": "proof point 9 states the ban",
      "docs/adr/0003-field-substrate-primitive.md": "decision record that rejected it",
      "floe-bus/src/scope-projection.test.ts": "asserts the substrate stays absent"
    }
  }
];

function collectFiles(root: string, extensions: string[]): string[] {
  const absolute = join(REPO_ROOT, root);
  if (!existsSync(absolute)) return [];
  if (statSync(absolute).isFile()) {
    return extensions.some((ext) => absolute.endsWith(ext)) ? [absolute] : [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    if (SKIPPED_DIR_NAMES.has(entry)) continue;
    const child = join(absolute, entry);
    if (statSync(child).isDirectory()) {
      files.push(...collectFiles(relative(REPO_ROOT, child), extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      files.push(child);
    }
  }
  return files;
}

describe("vocabulary drift lint", () => {
  for (const rule of RULES) {
    it(`bans: ${rule.name}`, () => {
      const violations: string[] = [];
      const matchedAllowed = new Set<string>();
      for (const root of rule.roots) {
        for (const file of collectFiles(root, rule.extensions)) {
          const repoPath = relative(REPO_ROOT, file);
          if (repoPath === SELF) continue;
          const lines = readFileSync(file, "utf8").split("\n");
          lines.forEach((line, index) => {
            if (!rule.pattern.test(line)) return;
            if (repoPath in rule.allowed) {
              matchedAllowed.add(repoPath);
              return;
            }
            violations.push(`${repoPath}:${index + 1}  ${line.trim()}`);
          });
        }
      }
      expect(violations, "retired vocabulary reintroduced as a live concept").toEqual([]);
      const stale = Object.keys(rule.allowed).filter((path) => !matchedAllowed.has(path));
      expect(
        stale,
        "allowlist entries no longer match — the debt was paid, delete them from this file"
      ).toEqual([]);
    });
  }
});
