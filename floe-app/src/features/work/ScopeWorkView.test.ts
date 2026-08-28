import { describe, expect, it } from "vitest";
import type { ScopeCompositionNode } from "../../bus-client/types.ts";
import { buildScopeWorkLinks } from "./ScopeWorkView.tsx";

describe("Scope work projection", () => {
  it("derives visible routing only from Event subscriptions and Command results", () => {
    const nodes: ScopeCompositionNode[] = [
      { node_id: "start", kind: "trigger", label: "Start", event_type: "work.requested" },
      { node_id: "checked", kind: "trigger", label: "Checked", event_type: "quality.checked" },
      { node_id: "builder", kind: "actor", endpoint_id: "actor:builder", event_types: ["work.requested"] },
      {
        node_id: "check",
        kind: "command",
        endpoint_id: "command:check",
        event_types: ["work.requested"],
        result_event_type: "quality.checked",
        command: "npm test",
      },
      { node_id: "judge", kind: "actor", endpoint_id: "actor:judge", event_types: ["quality.checked"] },
    ];

    expect(buildScopeWorkLinks(nodes)).toEqual([
      { source: "start", target: "builder", label: "work.requested" },
      { source: "start", target: "check", label: "work.requested" },
      { source: "checked", target: "judge", label: "quality.checked" },
      { source: "check", target: "checked", label: "quality.checked" },
    ]);
  });
});
