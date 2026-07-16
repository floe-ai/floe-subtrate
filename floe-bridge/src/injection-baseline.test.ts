/**
 * InjectionBaseline — inject-once dedup substrate primitive (Slice C).
 *
 * Tests cover:
 *   - Dedup skips identical content on second inject
 *   - Dedup re-injects when content changes
 *   - Always injects when context_id is null (no key available)
 *   - clearContext resets baseline so next turn re-injects
 *   - Non-string content passes through unchanged (can't hash)
 *   - Results without inject pass through unchanged
 *   - Multiple sources are tracked independently
 */
import { describe, it, expect } from "vitest";
import { InjectionBaseline } from "./injection-baseline.js";

const CTX_A = "ctx:ws:card-a";
const CTX_B = "ctx:ws:card-b";

function makeResult(source: string, content: string): { inject: Record<string, unknown> } {
  return { inject: { source, content } };
}

describe("InjectionBaseline.applyDedup", () => {
  it("passes through all results on first inject", () => {
    const baseline = new InjectionBaseline();
    const results = [makeResult("snowball", "column instructions v1")];
    const filtered = baseline.applyDedup(CTX_A, results);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.inject?.content).toBe("column instructions v1");
  });

  it("skips injection when content is identical on subsequent call", () => {
    const baseline = new InjectionBaseline();
    const result = makeResult("snowball", "column instructions v1");
    baseline.applyDedup(CTX_A, [result]); // first: inject + record hash
    const filtered = baseline.applyDedup(CTX_A, [result]); // second: same content
    expect(filtered).toHaveLength(1);
    // inject field should be stripped (skipped)
    expect(filtered[0]).not.toHaveProperty("inject");
  });

  it("re-injects when content changes", () => {
    const baseline = new InjectionBaseline();
    baseline.applyDedup(CTX_A, [makeResult("snowball", "v1")]);
    const filtered = baseline.applyDedup(CTX_A, [makeResult("snowball", "v2 — changed instruction")]);
    expect(filtered[0]?.inject?.content).toBe("v2 — changed instruction");
  });

  it("tracks different sources independently", () => {
    const baseline = new InjectionBaseline();
    const r1 = makeResult("snowball", "snowball content");
    const r2 = makeResult("memory", "memory content");
    baseline.applyDedup(CTX_A, [r1, r2]);

    // Only change snowball; memory unchanged
    const r1b = makeResult("snowball", "snowball content updated");
    const r2b = makeResult("memory", "memory content"); // unchanged
    const filtered = baseline.applyDedup(CTX_A, [r1b, r2b]);

    // snowball re-injects; memory skips
    expect(filtered[0]?.inject?.content).toBe("snowball content updated");
    expect(filtered[1]).not.toHaveProperty("inject");
  });

  it("tracks different contexts independently", () => {
    const baseline = new InjectionBaseline();
    const result = makeResult("snowball", "instructions");
    baseline.applyDedup(CTX_A, [result]); // inject into ctx A

    // Same content but different context: ctx B has no record yet → inject
    const filteredB = baseline.applyDedup(CTX_B, [result]);
    expect(filteredB[0]?.inject?.content).toBe("instructions");

    // Second call into ctx B: same content → skip
    const filteredB2 = baseline.applyDedup(CTX_B, [result]);
    expect(filteredB2[0]).not.toHaveProperty("inject");

    // ctx A unchanged: still skips
    const filteredA2 = baseline.applyDedup(CTX_A, [result]);
    expect(filteredA2[0]).not.toHaveProperty("inject");
  });

  it("passes through all results unchanged when context_id is null", () => {
    const baseline = new InjectionBaseline();
    const result = makeResult("snowball", "instructions");
    // First call: inject (null context)
    const f1 = baseline.applyDedup(null, [result]);
    expect(f1[0]?.inject?.content).toBe("instructions");
    // Second call: still inject (no state recorded)
    const f2 = baseline.applyDedup(null, [result]);
    expect(f2[0]?.inject?.content).toBe("instructions");
  });

  it("passes through results without inject unchanged", () => {
    const baseline = new InjectionBaseline();
    const result = {}; // no inject field
    const filtered = baseline.applyDedup(CTX_A, [result]);
    expect(filtered[0]).toEqual({});
  });

  it("passes through non-string inject content unchanged (cannot hash)", () => {
    const baseline = new InjectionBaseline();
    const result = { inject: { source: "ext", rules: ["a", "b"] } };
    const f1 = baseline.applyDedup(CTX_A, [result]);
    expect(f1[0]?.inject?.rules).toEqual(["a", "b"]);
    // Second call: same object, still passes through (no content to hash)
    const f2 = baseline.applyDedup(CTX_A, [result]);
    expect(f2[0]?.inject?.rules).toEqual(["a", "b"]);
  });

  it("uses 'extension' as default source when source is not a string", () => {
    const baseline = new InjectionBaseline();
    const r1 = { inject: { content: "hello" } }; // no source field
    baseline.applyDedup(CTX_A, [r1]);
    const r2 = { inject: { content: "hello" } };
    const f2 = baseline.applyDedup(CTX_A, [r2]);
    // Same content, same implicit source ("extension") → skipped
    expect(f2[0]).not.toHaveProperty("inject");
  });
});

describe("InjectionBaseline.clearContext", () => {
  it("resets baseline for a context so next turn re-injects", () => {
    const baseline = new InjectionBaseline();
    const result = makeResult("snowball", "instructions v1");
    baseline.applyDedup(CTX_A, [result]); // inject + record
    baseline.applyDedup(CTX_A, [result]); // second: skip (same content)

    // Simulate ContextHistoryCleared / ContextCompacted
    baseline.clearContext(CTX_A);

    // After reset: same content → re-injected (baseline forgotten)
    const afterReset = baseline.applyDedup(CTX_A, [result]);
    expect(afterReset[0]?.inject?.content).toBe("instructions v1");
  });

  it("clearing one context does not affect other contexts", () => {
    const baseline = new InjectionBaseline();
    const rA = makeResult("snowball", "ctx-a instructions");
    const rB = makeResult("snowball", "ctx-b instructions");
    baseline.applyDedup(CTX_A, [rA]);
    baseline.applyDedup(CTX_B, [rB]);

    baseline.clearContext(CTX_A); // only clear A

    // ctx A: re-injects after clear
    const fA = baseline.applyDedup(CTX_A, [rA]);
    expect(fA[0]?.inject?.content).toBe("ctx-a instructions");

    // ctx B: unchanged, still skips (content same as recorded)
    const fB = baseline.applyDedup(CTX_B, [rB]);
    expect(fB[0]).not.toHaveProperty("inject");
  });

  it("trackedContextCount decrements after clear", () => {
    const baseline = new InjectionBaseline();
    baseline.applyDedup(CTX_A, [makeResult("s", "a")]);
    baseline.applyDedup(CTX_B, [makeResult("s", "b")]);
    expect(baseline.trackedContextCount).toBe(2);
    baseline.clearContext(CTX_A);
    expect(baseline.trackedContextCount).toBe(1);
  });

  it("clearContext on unknown context is a no-op", () => {
    const baseline = new InjectionBaseline();
    expect(() => baseline.clearContext("ctx:unknown")).not.toThrow();
    expect(baseline.trackedContextCount).toBe(0);
  });
});
