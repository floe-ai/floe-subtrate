import { describe, it, expect } from "vitest";
import { checkCargoAvailable, missingCargoMessage } from "./desktop.js";

// ---------------------------------------------------------------------------
// checkCargoAvailable — injected spawnFn keeps tests hermetic
// ---------------------------------------------------------------------------

describe("checkCargoAvailable", () => {
  it("returns available=true when cargo exits 0", () => {
    const spy = () => ({ error: undefined, status: 0 });
    expect(checkCargoAvailable(spy)).toEqual({ available: true });
  });

  it("returns available=false with error message when spawn throws (cargo not on PATH)", () => {
    const spy = () => {
      throw new Error("spawn cargo ENOENT");
    };
    const result = checkCargoAvailable(spy);
    expect(result.available).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("returns available=false when spawnFn sets error (OS error)", () => {
    const spy = () => ({ error: new Error("ENOENT: no such file"), status: null });
    const result = checkCargoAvailable(spy);
    expect(result.available).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  it("returns available=false with status description when cargo exits non-zero", () => {
    const spy = () => ({ error: undefined, status: 127 });
    const result = checkCargoAvailable(spy);
    expect(result.available).toBe(false);
    expect(result.error).toContain("127");
  });
});

// ---------------------------------------------------------------------------
// missingCargoMessage — must be actionable
// ---------------------------------------------------------------------------

describe("missingCargoMessage", () => {
  it("mentions rustup.rs so user knows where to install", () => {
    expect(missingCargoMessage()).toContain("rustup.rs");
  });

  it("mentions floe desktop so user knows which command failed", () => {
    expect(missingCargoMessage()).toContain("floe desktop");
  });

  it("mentions first-launch compilation so user is not surprised by wait", () => {
    expect(missingCargoMessage()).toContain("first launch");
  });
});
