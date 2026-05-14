import { describe, expect, it, vi, afterEach } from "vitest";
import { toNeutralRef, fromNeutralRef, toNeutralEndpoint } from "./neutral-ref.js";

describe("toNeutralRef", () => {
  it("strips workspace + user type segment", () => {
    expect(toNeutralRef("endpoint:workspace:abc:user:operator")).toBe("operator");
  });

  it("strips workspace + agent type segment", () => {
    expect(toNeutralRef("endpoint:workspace:abc:agent:floe")).toBe("floe");
  });

  it("strips workspace + webhook type segment", () => {
    expect(toNeutralRef("endpoint:ws:abc:webhook:foo")).toBe("foo");
  });

  it("strips workspace + runtime type segment", () => {
    expect(toNeutralRef("endpoint:ws:abc:runtime:bridge")).toBe("bridge");
  });

  it("strips workspace + system type segment", () => {
    expect(toNeutralRef("endpoint:ws:abc:system:scheduler")).toBe("scheduler");
  });

  it("strips workspace + human type segment (legacy)", () => {
    expect(toNeutralRef("endpoint:ws:abc:human:operator")).toBe("operator");
  });

  it("rejoins multi-segment trailing identity", () => {
    expect(toNeutralRef("endpoint:workspace:abc:agent:my:special:agent")).toBe(
      "my:special:agent",
    );
  });

  it("returns already-neutral input unchanged", () => {
    expect(toNeutralRef("operator")).toBe("operator");
    expect(toNeutralRef("floe")).toBe("floe");
  });

  it("returns input as-is when no recognised type segment", () => {
    expect(toNeutralRef("short:ref")).toBe("short:ref");
  });

  it("never returns a string containing a category prefix", () => {
    const out = toNeutralRef("endpoint:workspace:abc:agent:floe");
    expect(out.startsWith("agent:")).toBe(false);
    expect(out.startsWith("user:")).toBe(false);
    expect(out.startsWith("endpoint:")).toBe(false);
  });
});

describe("fromNeutralRef", () => {
  const endpoints = [
    { endpoint_id: "endpoint:workspace:abc:agent:floe" },
    { endpoint_id: "endpoint:workspace:abc:user:operator" },
  ];

  it("returns matching legacy endpoint id when unique", () => {
    expect(fromNeutralRef("floe", endpoints)).toBe("endpoint:workspace:abc:agent:floe");
    expect(fromNeutralRef("operator", endpoints)).toBe(
      "endpoint:workspace:abc:user:operator",
    );
  });

  it("returns null when no candidate matches", () => {
    expect(fromNeutralRef("missing", endpoints)).toBeNull();
  });

  it("returns null and warns on collision across types", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const colliding = [
      { endpoint_id: "endpoint:ws:abc:agent:foo" },
      { endpoint_id: "endpoint:ws:abc:user:foo" },
    ];
    expect(fromNeutralRef("foo", colliding)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("accepts an already-legacy endpoint id and returns it when present in list", () => {
    // Pass-through helper for callers that may already hold a legacy id.
    expect(
      fromNeutralRef("endpoint:workspace:abc:agent:floe", endpoints),
    ).toBe("endpoint:workspace:abc:agent:floe");
  });
});

describe("toNeutralEndpoint", () => {
  it("returns exactly { ref, name, status }", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "endpoint:ws:abc:agent:floe",
      name: "Floe",
      status: "idle",
      actor_type: "agent",
    });
    expect(out).toEqual({ ref: "floe", name: "Floe", status: "idle" });
    expect(Object.keys(out).sort()).toEqual(["name", "ref", "status"]);
  });

  it("does not include endpoint_id or actor_type", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "endpoint:ws:abc:user:operator",
      name: "Operator",
      status: "active",
      actor_type: "human",
    }) as Record<string, unknown>;
    expect("endpoint_id" in out).toBe(false);
    expect("actor_type" in out).toBe(false);
  });

  it("works without actor_type input field", () => {
    const out = toNeutralEndpoint({
      endpoint_id: "endpoint:ws:abc:agent:floe",
      name: "Floe",
      status: "idle",
    });
    expect(out.ref).toBe("floe");
  });
});
