import { describe, expect, it, vi, afterEach } from "vitest";
import { toNeutralRef, fromNeutralRef, toNeutralEndpoint } from "./neutral-ref.js";

describe("toNeutralRef — new actor:<ws>:<id> shape", () => {
  it("extracts actor_id from actor:<ws>:<id>", () => {
    expect(toNeutralRef("actor:workspace_abc:floe")).toBe("floe");
  });

  it("extracts actor_id from actor:<ws>:<id> with simple ws", () => {
    expect(toNeutralRef("actor:ws-a:operator")).toBe("operator");
  });

  it("extracts multi-segment trailing actor_id", () => {
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
    const out = toNeutralRef("actor:workspace_abc:floe");
    expect(out.startsWith("agent:")).toBe(false);
    expect(out.startsWith("user:")).toBe(false);
    expect(out.startsWith("endpoint:")).toBe(false);
    expect(out.startsWith("actor:")).toBe(false);
  });
});

describe("fromNeutralRef — new actor shape", () => {
  const WORKSPACE_ID = "workspace_abc";
  const endpoints = [
    { endpoint_id: "actor:workspace_abc:floe" },
    { endpoint_id: "actor:workspace_abc:operator" },
  ];

  it("resolves neutral ref to actor:<ws>:<id> when unique", () => {
    expect(fromNeutralRef("floe", endpoints)).toBe("actor:workspace_abc:floe");
    expect(fromNeutralRef("operator", endpoints)).toBe("actor:workspace_abc:operator");
  });

  it("returns null when no candidate matches", () => {
    expect(fromNeutralRef("missing", endpoints)).toBeNull();
  });

  it("passes through an already-full actor:<ws>:<id> present in list", () => {
    expect(fromNeutralRef("actor:workspace_abc:floe", endpoints)).toBe("actor:workspace_abc:floe");
  });

  it("throws on legacy endpoint: prefix (cutover assertion)", () => {
    expect(() => fromNeutralRef("endpoint:workspace:abc:agent:floe", endpoints)).toThrow();
  });

  it("returns null and warns on collision", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const colliding = [
      { endpoint_id: "actor:ws:foo" },
      { endpoint_id: "actor:ws2:foo" },
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
      endpoint_id: "actor:ws_abc:floe",
      name: "Floe",
      status: "idle",
      actor_type: "agent",
    });
    expect(out).toEqual({ ref: "floe", name: "Floe", status: "idle" });
    expect(Object.keys(out).sort()).toEqual(["name", "ref", "status"]);
  });

  it("does not include endpoint_id or actor_type", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "actor:ws_abc:operator",
      name: "Operator",
      status: "active",
      actor_type: "human",
    }) as Record<string, unknown>;
    expect("endpoint_id" in out).toBe(false);
    expect("actor_type" in out).toBe(false);
  });

  it("works without actor_type input field", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "actor:ws_abc:floe",
      name: "Floe",
      status: "idle",
    });
    expect(out.ref).toBe("floe");
  });
});
