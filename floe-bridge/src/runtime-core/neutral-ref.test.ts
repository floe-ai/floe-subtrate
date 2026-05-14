import { describe, expect, it, vi, afterEach } from "vitest";
import { toNeutralRef, fromNeutralRef, toNeutralEndpoint } from "./neutral-ref.js";

describe("toNeutralRef — new actor:<ws>:<id> shape", () => {
  it("extracts actor_id from actor:workspace:<hash>:<id> (production format)", () => {
    expect(toNeutralRef("actor:workspace:abc123:floe")).toBe("floe");
    expect(toNeutralRef("actor:workspace:test:operator")).toBe("operator");
  });

  it("extracts actor_id from actor:<short_ws>:<id> (test fixtures)", () => {
    expect(toNeutralRef("actor:ws-a:operator")).toBe("operator");
    expect(toNeutralRef("actor:ws_abc:floe")).toBe("floe");
  });

  it("extracts multi-segment trailing actor_id with workspace: prefix", () => {
    expect(toNeutralRef("actor:workspace:abc:my:special:agent")).toBe("my:special:agent");
  });

  it("extracts multi-segment trailing actor_id with short ws", () => {
    expect(toNeutralRef("actor:ws:my:special:agent")).toBe("my:special:agent");
  });

  it("returns already-neutral single-word ref unchanged", () => {
    expect(toNeutralRef("operator")).toBe("operator");
    expect(toNeutralRef("floe")).toBe("floe");
  });

  it("throws on legacy endpoint:<ws>:<type>:<id> shape (cutover assertion)", () => {
    expect(() => toNeutralRef("endpoint:workspace:abc:agent:floe")).toThrow();
    expect(() => toNeutralRef("endpoint:ws:abc:user:operator")).toThrow();
  });

  it("never returns a string containing a category prefix", () => {
    const out = toNeutralRef("actor:workspace:abc:floe");
    expect(out.startsWith("agent:")).toBe(false);
    expect(out.startsWith("user:")).toBe(false);
    expect(out.startsWith("endpoint:")).toBe(false);
    expect(out.startsWith("actor:")).toBe(false);
  });
});

describe("fromNeutralRef — new actor shape", () => {
  const endpoints = [
    { endpoint_id: "actor:workspace:abc:floe" },
    { endpoint_id: "actor:workspace:abc:operator" },
  ];

  it("resolves neutral ref to actor:<ws>:<id> when unique", () => {
    expect(fromNeutralRef("floe", endpoints)).toBe("actor:workspace:abc:floe");
    expect(fromNeutralRef("operator", endpoints)).toBe("actor:workspace:abc:operator");
  });

  it("returns null when no candidate matches", () => {
    expect(fromNeutralRef("missing", endpoints)).toBeNull();
  });

  it("passes through an already-full actor:<ws>:<id> present in list", () => {
    expect(fromNeutralRef("actor:workspace:abc:floe", endpoints)).toBe("actor:workspace:abc:floe");
  });

  it("throws on legacy endpoint: prefix (cutover assertion)", () => {
    expect(() => fromNeutralRef("endpoint:workspace:abc:agent:floe", endpoints)).toThrow();
  });

  it("returns null and warns on collision", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const colliding = [
      { endpoint_id: "actor:workspace:ws1:foo" },
      { endpoint_id: "actor:workspace:ws2:foo" },
    ];
    // Both resolve to neutral ref "foo"
    expect(fromNeutralRef("foo", colliding)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("toNeutralEndpoint — new actor shape", () => {
  it("returns exactly { ref, name, status }", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "actor:workspace:abc:floe",
      name: "Floe",
      status: "idle",
      actor_type: "agent",
    });
    expect(out).toEqual({ ref: "floe", name: "Floe", status: "idle" });
    expect(Object.keys(out).sort()).toEqual(["name", "ref", "status"]);
  });

  it("does not include endpoint_id or actor_type", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "actor:workspace:abc:operator",
      name: "Operator",
      status: "active",
      actor_type: "human",
    }) as Record<string, unknown>;
    expect("endpoint_id" in out).toBe(false);
    expect("actor_type" in out).toBe(false);
  });

  it("works without actor_type input field", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "actor:workspace:abc:floe",
      name: "Floe",
      status: "idle",
    });
    expect(out.ref).toBe("floe");
  });
});
