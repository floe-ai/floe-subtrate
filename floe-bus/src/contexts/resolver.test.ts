import { describe, expect, it } from "vitest";
import { resolveContext } from "./resolver.js";
import type { ContextStoreReader } from "./store.js";
import type { DestinationSelector } from "../store.js";

const WS = "workspace:test";
const E1 = "actor:test:e1";
const E2 = "actor:test:e2";
const E3 = "actor:test:e3";
const endpoint = (endpoint_id: string): DestinationSelector => ({ kind: "endpoint", endpoint_id });
function reader(participants: Record<string, string[]>): ContextStoreReader {
  return {
    getContext: (context_id) => participants[context_id] ? { context_id, workspace_id: WS, scope_id: null, parent_context_id: null, created_by_endpoint_id: E1, created_at: "2026-01-01T00:00:00Z", title: null } : null,
    getContextParticipants: (context_id) => participants[context_id] ?? [],
    isParticipant: (context_id, endpoint_id) => (participants[context_id] ?? []).includes(endpoint_id),
    listContextsForParticipant: (endpoint_id) => Object.entries(participants).filter(([, ps]) => ps.includes(endpoint_id)).map(([context_id, ps]) => ({ context_id, workspace_id: WS, scope_id: null, parent_context_id: null, created_by_endpoint_id: E1, created_at: "2026-01-01T00:00:00Z", last_event_at: null, topic: null, title: null, participants: ps }))
  };
}
function resolve(overrides: Partial<Parameters<typeof resolveContext>[0]> = {}) {
  return resolveContext({ source_endpoint_id: E1, destination: endpoint(E2), supplied_context_id: null, current_delivery_context_id: null, workspace_id: WS, ...overrides }, reader({ ctx_a: [E1, E2] })) as any;
}
describe("resolveContext rule matrix", () => {
  it("opens a UI peer context with its endpoints", () => expect(resolve()).toEqual({ context_id: expect.any(String), created: true, participants: [E1, E2], parent_context_id: null }));
  it("continues a runtime context for a participant destination", () => expect(resolve({ current_delivery_context_id: "ctx_a" })).toEqual({ context_id: "ctx_a", created: false }));
  it("opens a linked peer context for runtime Rule 3", () => expect(resolve({ destination: endpoint(E3), current_delivery_context_id: "ctx_a" })).toEqual({ context_id: expect.any(String), created: true, participants: [E1, E3], parent_context_id: "ctx_a" }));
  it("does not link a UI-created context", () => expect(resolve({ destination: endpoint(E3) }).parent_context_id).toBeNull());
  it("allows a self emit", () => expect(resolve({ destination: endpoint(E1) }).participants).toEqual([E1]));
  it("rejects an explicit context unknown to the source", () => expect(resolve({ supplied_context_id: "missing" })).toMatchObject({ error: "E_NOT_CONTEXT_PARTICIPANT" }));
  it("continues an explicitly supplied participating context", () => expect(resolve({ supplied_context_id: "ctx_a" })).toEqual({ context_id: "ctx_a", created: false }));
  it("links rule 3 for an origin where the source is not a participant", () => expect(resolve({ source_endpoint_id: E3, destination: endpoint(E1), current_delivery_context_id: "ctx_a" })).toMatchObject({ created: false }));
  it("uses the origin link only for a nonparticipant destination", () => expect(resolve({ destination: endpoint(E3), current_delivery_context_id: "ctx_a" }).parent_context_id).toBe("ctx_a"));
  it("preserves destination membership for Rule 2", () => expect(resolve({ current_delivery_context_id: "ctx_a" }).context_id).toBe("ctx_a"));
  it("returns two participants for an endpoint peer context", () => expect(resolve({ destination: endpoint(E3) }).participants).toEqual([E1, E3]));
  it("returns a generated context id for a peer context", () => expect(resolve({ destination: endpoint(E3) }).context_id).toMatch(/^ctx_/));
  it("does not create for explicit context", () => expect(resolve({ supplied_context_id: "ctx_a" }).created).toBe(false));
  it("marks UI peer contexts with null provenance", () => expect(resolve().parent_context_id).toBeNull());
  it("marks runtime peer contexts with origin provenance", () => expect(resolve({ destination: endpoint(E3), current_delivery_context_id: "ctx_a" }).parent_context_id).toBe("ctx_a"));
  it("keeps broadcasts as one-party peer contexts", () => expect(resolve({ destination: { kind: "broadcast", scope: "workspace", target: "all" } }).participants).toEqual([E1]));
  it("links runtime broadcasts to the origin", () => expect(resolve({ destination: { kind: "broadcast", scope: "workspace", target: "all" }, current_delivery_context_id: "ctx_a" }).parent_context_id).toBe("ctx_a"));
  it("does not create a parent link for supplied contexts", () => expect(resolve({ supplied_context_id: "ctx_a" }).parent_context_id).toBeUndefined());
  it("does not put the origin participants into a Rule 3 peer context", () => expect(resolve({ destination: endpoint(E3), current_delivery_context_id: "ctx_a" }).participants).toEqual([E1, E3]));
});
