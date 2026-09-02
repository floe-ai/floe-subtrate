import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  ContextRef,
  DeliveryRow,
  EndpointRef,
  EventEnvelope,
  ScopeComposition,
} from "../../bus-client/types.ts";
import type { ArtifactLineageGraph } from "./ArtifactLineageView.tsx";
import {
  buildScopePipelineFocusProjection,
  ScopePipelineFocusView,
} from "./ScopePipelineFocusView.tsx";

vi.mock("./ArtifactPreview.tsx", () => ({
  artifactFileKind: (path: string | null) => path?.toLowerCase().endsWith(".png") ? "image" : "file",
  ArtifactPreview: ({ node }: { node: { id: string } }) => <div data-testid={`preview-${node.id}`} />,
}));

const SCOPE = "scope:concept-pipeline";
const REGISTRY = "workspace:registry";
const OBSERVER = "workspace:observer";
const COMMAND = "workspace:contact-sheet-command";

const composition: ScopeComposition = {
  graph_id: "graph:current",
  workspace_id: "workspace",
  scope_id: SCOPE,
  context_id: "context:composition",
  created_at: "2026-09-02T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  nodes: [
    {
      node_id: "concept-found",
      kind: "trigger",
      label: "New concept image found",
      event_type: "concept.found",
      source: { kind: "folder", path: "concepts" },
    },
    {
      node_id: "registry-ready",
      kind: "trigger",
      label: "Registry ready",
      event_type: "registry.ready",
    },
    {
      node_id: "contact-sheet-ready",
      kind: "trigger",
      label: "Contact sheet ready",
      event_type: "contact-sheet.ready",
    },
    {
      node_id: "registry",
      kind: "actor",
      label: "Concept registry analyst",
      endpoint_id: REGISTRY,
      event_types: ["concept.found"],
    },
    {
      node_id: "observer",
      kind: "actor",
      label: "Lineage observer",
      endpoint_id: OBSERVER,
      event_types: ["*"],
    },
    {
      node_id: "contact-sheet-command",
      kind: "command",
      label: "Build contact sheets",
      endpoint_id: COMMAND,
      event_types: ["concept.found"],
      result_event_type: "contact-sheet.ready",
      command: "build-contact-sheets",
    },
  ],
};

const endpoints: EndpointRef[] = [
  endpoint(REGISTRY, "Concept Registry Analyst"),
  endpoint(OBSERVER, "Lineage Observer"),
  endpoint(COMMAND, "Contact Sheet Builder"),
];
const workspace = { workspace_id: "workspace", locator: "C:/workspace" };

function endpoint(endpointId: string, name: string): EndpointRef {
  return {
    endpoint_id: endpointId,
    workspace_id: "workspace",
    name,
    agent_id: endpointId.split(":").at(-1) ?? null,
    bridge_id: null,
    status: "active",
    metadata_json: "{}",
    created_at: "2026-09-02T00:00:00Z",
    updated_at: "2026-09-02T00:00:00Z",
  };
}

function context(
  contextId: string,
  scopeId: string | null,
  participants: string[],
  title: string,
): ContextRef {
  return {
    context_id: contextId,
    workspace_id: "workspace",
    scope_id: scopeId,
    parent_context_id: null,
    created_by_endpoint_id: participants[0] ?? null,
    created_at: "2026-09-02T00:00:00Z",
    last_event_at: "2026-09-02T00:01:00Z",
    participants,
    title,
    first_message_preview: null,
  };
}

function event(
  eventId: string,
  type: string,
  contextId: string,
  scopeId = SCOPE,
  metadata: Record<string, unknown> = {},
): EventEnvelope {
  return {
    event_id: eventId,
    type,
    workspace_id: "workspace",
    source_endpoint_id: null,
    thread_id: contextId,
    context_id: contextId,
    scope_id: scopeId,
    correlation_id: null,
    destination_json: { kind: "broadcast", scope: "workspace", target: "all" },
    content: {},
    response: { expected: false },
    metadata,
    created_at: "2026-09-02T00:00:30Z",
  };
}

function delivery(
  deliveryId: string,
  endpointId: string,
  triggerEventId: string,
  state = "acknowledged",
): DeliveryRow {
  return {
    delivery_id: deliveryId,
    endpoint_id: endpointId,
    workspace_id: "workspace",
    trigger_event_id: triggerEventId,
    events_json: "[]",
    state,
    lease_expires_at: null,
    attempt_count: 1,
    last_error: null,
    created_at: "2026-09-02T00:00:40Z",
    claimed_at: "2026-09-02T00:00:41Z",
  };
}

const contexts = [
  context("context:concept", SCOPE, [REGISTRY, OBSERVER], "Overgrown courtyard"),
  context("context:command", SCOPE, [COMMAND], "Contact sheet one"),
  context("context:outside", "scope:other", [REGISTRY], "Unrelated"),
];

const triggerMetadata = {
  trigger_kind: "scope_graph",
  graph_id: "graph:current",
  node_id: "concept-found",
  trigger_fire_id: "trigger_fire_concept_1",
};

const events = [
  {
    ...event("event:found-registry", "concept.found", "context:concept", SCOPE, triggerMetadata),
    content: { file_name: "overgrown-courtyard.png" },
    destination_json: { kind: "endpoint" as const, endpoint_id: REGISTRY },
  },
  {
    ...event("event:found-observer", "concept.found", "context:concept", SCOPE, triggerMetadata),
    content: { file_name: "overgrown-courtyard.png" },
    destination_json: { kind: "endpoint" as const, endpoint_id: OBSERVER },
  },
  {
    ...event("event:found-command", "concept.found", "context:concept", SCOPE, triggerMetadata),
    content: { file_name: "overgrown-courtyard.png" },
    destination_json: { kind: "endpoint" as const, endpoint_id: COMMAND },
  },
  {
    ...event("event:registry-ready", "registry.ready", "context:concept", SCOPE, {
      origin: "pi_emit_tool",
      delivery_id: "delivery:registry",
    }),
    source_endpoint_id: REGISTRY,
  },
  event("event:ready", "contact-sheet.ready", "context:command"),
  event("event:outside", "concept.found", "context:outside", "scope:other", {
    trigger_kind: "scope_graph",
    graph_id: "graph:current",
    node_id: "concept-found",
  }),
];

const deliveries = [
  delivery("delivery:registry", REGISTRY, "event:found-registry"),
  delivery("delivery:observer", OBSERVER, "event:found-observer"),
  delivery("delivery:command", COMMAND, "event:found-command", "injected_to_runtime"),
];

const artifactGraph: ArtifactLineageGraph = {
  graphId: "lineage:concept",
  nodes: [
    {
      id: "artifact:source",
      type: "source-concept",
      path: "concepts/overgrown-courtyard.png",
      status: "current",
      revision: 1,
      conceptName: "overgrown-courtyard",
      contextRefs: ["context:concept"],
      raw: { display_name: "Overgrown courtyard", event_refs: ["event:found-registry"] },
    },
    {
      id: "artifact:registry",
      type: "registry",
      path: "output/registry.json",
      status: "current_generated",
      revision: 2,
      conceptName: "overgrown-courtyard",
      contextRefs: ["context:concept"],
      raw: { file_name: "registry.json", event_refs: ["event:registry-ready"] },
    },
    {
      id: "artifact:old-registry",
      type: "registry",
      path: "history/registry-r001.json",
      status: "historical_superseded",
      revision: 1,
      conceptName: "overgrown-courtyard",
      contextRefs: ["context:concept"],
      raw: { display_name: "Old registry", event_refs: ["event:found-registry"] },
    },
    {
      id: "artifact:unreferenced",
      type: "registry",
      path: "registry.json",
      status: "current",
      revision: 2,
      conceptName: "overgrown-courtyard",
      contextRefs: [],
      raw: { display_name: "Unreferenced registry", event_refs: [] },
    },
  ],
  edges: [],
};

afterEach(() => cleanup());

describe("Scope pipeline focus projection", () => {
  it("keeps every declared subscription and Command result route visible", () => {
    const projection = buildScopePipelineFocusProjection({
      composition,
      contexts,
      events,
      deliveries,
      artifactGraph,
    });

    expect(projection.routes).toEqual(expect.arrayContaining([
      {
        sourceNodeId: "concept-found",
        targetNodeId: "registry",
        kind: "subscription",
        eventType: "concept.found",
        sourceExecutionId: null,
        targetExecutionId: null,
      },
      {
        sourceNodeId: "concept-found",
        targetNodeId: "observer",
        kind: "subscription",
        eventType: "*",
        sourceExecutionId: null,
        targetExecutionId: null,
      },
      {
        sourceNodeId: "contact-sheet-command",
        targetNodeId: "contact-sheet-ready",
        kind: "command-result",
        eventType: "contact-sheet.ready",
        sourceExecutionId: null,
        targetExecutionId: null,
      },
      {
        sourceNodeId: "registry",
        targetNodeId: "registry-ready",
        kind: "actor-emission",
        eventType: "registry.ready",
        sourceExecutionId: "delivery:registry",
        targetExecutionId: "event:registry-ready",
      },
    ]));
    expect(projection.routes.filter((route) => route.targetNodeId === "observer")).toHaveLength(3);
  });

  it("includes only actual scoped Contexts and current referenced Artifacts", () => {
    const projection = buildScopePipelineFocusProjection({
      composition,
      contexts,
      events,
      deliveries,
      artifactGraph,
    });
    const registry = projection.nodes.find((item) => item.node.node_id === "registry");

    expect(registry?.executions.map((item) => [item.executionId, item.contextId])).toEqual([
      ["delivery:registry", "context:concept"],
    ]);
    expect(registry?.executions[0]?.arrivedArtifacts.map((artifact) => artifact.id)).toEqual(["artifact:source"]);
    expect(registry?.executions[0]?.producedArtifacts.map((artifact) => artifact.id)).toEqual(["artifact:registry"]);
  });

  it("groups per-subscriber Events from one trigger firing without merging legacy Events", () => {
    const legacy = {
      ...event("event:legacy", "concept.found", "context:concept", SCOPE, {
        trigger_kind: "scope_graph",
        graph_id: "graph:current",
        node_id: "concept-found",
      }),
      content: { file_name: "legacy.png" },
    };
    const projection = buildScopePipelineFocusProjection({
      composition,
      contexts,
      events: [...events, legacy],
      deliveries,
      artifactGraph,
    });
    const source = projection.nodes.find((item) => item.node.node_id === "concept-found");

    expect(source?.executions).toHaveLength(2);
    expect(source?.executions[0]?.eventIds).toEqual([
      "event:found-registry",
      "event:found-observer",
      "event:found-command",
    ]);
    expect(source?.executions[1]?.eventIds).toEqual(["event:legacy"]);
  });

  it("leaves a Delivery unattributed when multiple authored nodes could own it", () => {
    const ambiguous: ScopeComposition = {
      ...composition,
      nodes: [
        ...composition.nodes,
        {
          node_id: "registry-duplicate",
          kind: "actor",
          label: "Duplicate registry route",
          endpoint_id: REGISTRY,
          event_types: ["concept.found"],
        },
      ],
    };
    const projection = buildScopePipelineFocusProjection({
      composition: ambiguous,
      contexts,
      events,
      deliveries,
      artifactGraph,
    });

    expect(projection.nodes.find((item) => item.node.node_id === "registry")?.executions).toEqual([]);
    expect(projection.nodes.find((item) => item.node.node_id === "registry-duplicate")?.executions).toEqual([]);
    expect(projection.routes.some((route) => route.kind === "actor-emission" && route.sourceNodeId.startsWith("registry"))).toBe(false);
  });
});

describe("ScopePipelineFocusView", () => {
  it("shows six recent executions by default and preserves a selected earlier run", () => {
    const laterEvents = Array.from({ length: 7 }, (_, index) => ({
      ...event(`event:found-${index + 2}`, "concept.found", "context:concept", SCOPE, {
        trigger_kind: "scope_graph",
        graph_id: "graph:current",
        node_id: "concept-found",
      }),
      content: { file_name: `concept-${index + 2}.png` },
      created_at: `2026-09-02T${String(index + 1).padStart(2, "0")}:00:00Z`,
    }));
    render(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={[...events, ...laterEvents]}
        deliveries={deliveries}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );

    expect(screen.queryByLabelText("Executions for focused step")).toBeNull();
    expect(screen.queryByRole("button", { name: /Run 1 · Overgrown courtyard/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Change run/ }));
    let choices = screen.getByLabelText("Executions for focused step");
    expect(within(choices).getAllByRole("button", { name: /^Run / })).toHaveLength(6);
    fireEvent.click(within(choices).getByRole("button", { name: "Show 2 earlier runs" }));
    expect(within(choices).getAllByRole("button", { name: /^Run / })).toHaveLength(8);
    fireEvent.click(within(choices).getByRole("button", { name: /Run 1 · Overgrown courtyard/ }));
    expect(screen.queryByLabelText("Executions for focused step")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Run 1 · Overgrown courtyard.*Change run/ }));
    choices = screen.getByLabelText("Executions for focused step");
    fireEvent.click(within(choices).getByRole("button", { name: "Show latest 6" }));
    expect(within(choices).getAllByRole("button", { name: /^Run / })).toHaveLength(7);
    expect(within(choices).getByRole("button", { name: /Run 1 · Overgrown courtyard/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("File attached to Event")).toBeTruthy();
  });

  it("follows new evidence while latest is selected and preserves an explicit older run", () => {
    const { rerender } = render(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={events}
        deliveries={deliveries}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );
    expect(screen.getByText("concepts/overgrown-courtyard.png")).toBeTruthy();

    const latest = {
      ...event("event:newest", "concept.found", "context:concept", SCOPE, {
        trigger_kind: "scope_graph",
        graph_id: "graph:current",
        node_id: "concept-found",
        trigger_fire_id: "trigger_fire_concept_2",
      }),
      content: { file_name: "newest.png" },
      created_at: "2026-09-02T12:00:00Z",
    };
    rerender(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={[...events, latest]}
        deliveries={deliveries}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );
    expect(screen.getByText("concepts/newest.png")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Change run/ }));
    fireEvent.click(screen.getByRole("button", { name: /Run 1 · Overgrown courtyard/ }));
    expect(screen.getByText("concepts/overgrown-courtyard.png")).toBeTruthy();

    const later = { ...latest, event_id: "event:later", content: { file_name: "later.png" }, created_at: "2026-09-02T13:00:00Z", metadata: { ...latest.metadata, trigger_fire_id: "trigger_fire_concept_3" } };
    rerender(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={[...events, latest, later]}
        deliveries={deliveries}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );
    expect(screen.getByText("concepts/overgrown-courtyard.png")).toBeTruthy();
    expect(screen.queryByText("concepts/later.png")).toBeNull();
  });

  it("keeps a followed downstream execution fixed when a newer source run arrives", () => {
    const { rerender } = render(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={events}
        deliveries={deliveries}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Follow Concept registry analyst" }));

    const newerTrigger = {
      ...event("event:new-registry", "concept.found", "context:concept", SCOPE, {
        trigger_kind: "scope_graph",
        graph_id: "graph:current",
        node_id: "concept-found",
        trigger_fire_id: "trigger_fire_concept_2",
      }),
      content: { file_name: "newer.png" },
      destination_json: { kind: "endpoint" as const, endpoint_id: REGISTRY },
      created_at: "2026-09-02T12:00:00Z",
    };
    const newerDelivery = {
      ...delivery("delivery:new-registry", REGISTRY, "event:new-registry"),
      created_at: "2026-09-02T12:00:01Z",
    };
    rerender(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={[...events, newerTrigger]}
        deliveries={[...deliveries, newerDelivery]}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );

    expect(screen.getByRole("button", { name: /Run 1 · registry.json.*Change run/ })).toBeTruthy();
    expect(screen.queryByText("concepts/newer.png")).toBeNull();
  });

  it("resets to the replacement graph even when its node ids are unchanged", () => {
    const { rerender } = render(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={events}
        deliveries={deliveries}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Follow Concept registry analyst" }));

    const replacementComposition = { ...composition, graph_id: "graph:replacement" };
    const replacementEvent = {
      ...event("event:replacement", "concept.found", "context:concept", SCOPE, {
        trigger_kind: "scope_graph",
        graph_id: "graph:replacement",
        node_id: "concept-found",
        trigger_fire_id: "trigger_fire_replacement_1",
      }),
      content: { file_name: "replacement.png" },
      created_at: "2026-09-02T14:00:00Z",
    };
    rerender(
      <ScopePipelineFocusView
        composition={replacementComposition}
        contexts={contexts}
        events={[replacementEvent]}
        deliveries={[]}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );

    expect(screen.getByRole("heading", { name: "New concept image found" })).toBeTruthy();
    expect(screen.getByText("concepts/replacement.png")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Concept registry analyst" })).toBeNull();
  });

  it("puts exact downstream executions ahead of collapsed planned subscriptions", () => {
    render(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={events}
        deliveries={[deliveries[0]!]}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );

    expect(screen.getByText("1 observed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow Concept registry analyst" })).toBeTruthy();
    const planned = screen.getByText("Other planned routes (2)").closest("details");
    expect(planned?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("Receives any Event")).toBeTruthy();
  });

  it("shows every planned subscription when no downstream execution exists", () => {
    render(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={events}
        deliveries={[]}
        endpoints={endpoints}
        artifactGraph={artifactGraph}
      />,
    );

    expect(screen.getByText("3 planned")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow Concept registry analyst" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow Lineage observer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow Build contact sheets" })).toBeTruthy();
    expect(screen.queryByText(/Other planned routes/)).toBeNull();
  });

  it("reveals one real downstream layer at a time without hiding supporting subscriptions", () => {
    const onOpenContext = vi.fn();
    render(
      <ScopePipelineFocusView
        composition={composition}
        contexts={contexts}
        events={events}
        deliveries={deliveries}
        endpoints={endpoints}
        workspace={workspace}
        artifactGraph={artifactGraph}
        onOpenContext={onOpenContext}
      />,
    );

    expect(screen.getByRole("heading", { name: "New concept image found" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow Concept registry analyst" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Follow Lineage observer" })).toBeTruthy();
    expect(screen.getByText("Receives any Event")).toBeTruthy();
    expect(screen.queryByText("Old registry")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Follow Concept registry analyst" }));

    expect(screen.getByRole("heading", { name: "Concept registry analyst" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New concept image found" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Concept registry analyst" }).getAttribute("aria-current")).toBe("step");
    expect(screen.getByTestId("preview-attached-file:event:found-registry")).toBeTruthy();
    expect(screen.getByText("File attached to Event")).toBeTruthy();
    expect(screen.getAllByText("Overgrown courtyard").length).toBeGreaterThan(0);
    expect(screen.getByText("Arrived with this Event")).toBeTruthy();
    expect(screen.getByText("Current Artifacts from this execution")).toBeTruthy();
    expect(screen.getAllByText("registry.json").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Follow Registry ready" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Open Context" }));
    expect(onOpenContext).toHaveBeenCalledWith("context:concept");
  });
});
