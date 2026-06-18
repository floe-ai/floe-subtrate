import { describe, expect, it, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PathEscapesRootError,
  RootNotFoundError,
  resolveWithinRoot,
} from "./resolveWithinRoot.js";

const cleanupDirs: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "floe-bus-fs-test-"));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWithinRoot", () => {
  it("rejects unix-style traversal escaping root", () => {
    const root = tempWorkspace();
    expect(() => resolveWithinRoot(root, "../../etc/passwd")).toThrow(PathEscapesRootError);
  });

  it("rejects windows-style traversal escaping root", () => {
    const root = tempWorkspace();
    expect(() => resolveWithinRoot(root, "..\\..\\Windows\\System32\\config\\SAM")).toThrow(
      PathEscapesRootError
    );
  });

  it("rejects absolute unix path", () => {
    const root = tempWorkspace();
    expect(() => resolveWithinRoot(root, "/etc/passwd")).toThrow(PathEscapesRootError);
  });

  it("rejects windows drive-prefixed path", () => {
    const root = tempWorkspace();
    expect(() => resolveWithinRoot(root, "C:\\Windows\\System32")).toThrow(PathEscapesRootError);
  });

  it("rejects symlink escaping root", () => {
    const root = tempWorkspace();
    const outside = tempWorkspace();
    writeFileSync(join(outside, "secret.txt"), "nope");
    symlinkSync(outside, join(root, "escape"));
    expect(() => resolveWithinRoot(root, "escape/secret.txt")).toThrow(PathEscapesRootError);
  });

  it("accepts simple relative path within root", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, ".floe/agents"), { recursive: true });
    writeFileSync(join(root, ".floe/agents/floe.md"), "hello");
    expect(() => resolveWithinRoot(root, ".floe/agents/floe.md")).not.toThrow();
  });

  it("accepts new file path not yet existing", () => {
    const root = tempWorkspace();
    mkdirSync(join(root, ".floe/agents"), { recursive: true });
    expect(() => resolveWithinRoot(root, ".floe/agents/new-agent.md")).not.toThrow();
  });

  it("rejects empty relative path", () => {
    const root = tempWorkspace();
    expect(() => resolveWithinRoot(root, "")).toThrow(PathEscapesRootError);
  });

  it("throws RootNotFoundError when workspace root does not exist", () => {
    expect(() => resolveWithinRoot("/nonexistent/floe-root-xyz", "a.md")).toThrow(
      RootNotFoundError
    );
  });

  it("rejects traversal hidden inside a later segment", () => {
    const root = tempWorkspace();
    expect(() => resolveWithinRoot(root, "agents/../../escape.md")).toThrow(PathEscapesRootError);
  });
});
