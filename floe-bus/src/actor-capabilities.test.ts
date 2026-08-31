import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { defaultConfig, type LocalConfig } from "./config.js";
import { createBusServer } from "./server.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

describe("actor-safe capability discovery and invocation", () => {
  let handle: ServerHandle;
  let root: string;
  let workspaceId: string;
  let floeEndpointId: string;
  let builderEndpointId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "floe-capabilities-"));
    const workspace = join(root, "workspace");
    mkdirSync(join(workspace, "concepts"), { recursive: true });
    const configPath = join(root, "config.yaml");
    const config: LocalConfig = defaultConfig(root);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    handle = await createBusServer(configPath, config);
    await handle.app.ready();
    const registered = handle.store.registerWorkspace({
      locator: workspace,
      name: "Capability test",
      init_authorized: true,
    }, handle.broadcast) as { workspace_id: string };
    workspaceId = registered.workspace_id;
    floeEndpointId = `actor:${workspaceId}:floe`;
    builderEndpointId = `actor:${workspaceId}:builder`;
    for (const [endpointId, name] of [[floeEndpointId, "Floe"], [builderEndpointId, "Builder"]]) {
      handle.store.registerEndpoint({
        endpoint_id: endpointId,
        workspace_id: workspaceId,
        name,
        bridge_id: null,
        status: "idle",
      }, handle.broadcast);
    }
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the Bus-owned description and exact schema only when discovered", async () => {
    const response = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities?query=monitor%20a%20folder%20pipeline%20automatically`,
    });

    expect(response.statusCode).toBe(200);
    const capabilities = response.json().capabilities as any[];
    const compose = capabilities.find((capability) => capability.capability_id === "scope.compose");
    expect(compose).toMatchObject({
      capability_id: "scope.compose",
      category: "organisation",
      effect: "write",
      title: "Compose connected operation",
    });
    expect(compose.description).toContain("folder-driven workflow");
    expect(compose.input_schema.properties.event_nodes.description).toContain("shared scoped Context");
  });

  it("uses the discovered JSON Schema as the invocation validator", async () => {
    const response = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "delivery",
          title: "Delivery",
          event_nodes: [{ node_id: "start", event_type: "work.requested" }],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "capability_input_invalid",
      capability_id: "scope.compose",
    });
    expect(response.json().validation_errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ instancePath: "", keyword: "required" }),
    ]));
  });

  it("composes, inspects, and starts real Scope work through the generic endpoint", async () => {
    const compose = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "concept-processing",
          title: "Concept processing",
          description: "Process arriving concept images.",
          event_nodes: [{
            node_id: "concept-arrived",
            label: "Concept arrived",
            event_type: "concept.image.arrived",
            source: { kind: "folder", path: "concepts" },
          }],
          actor_nodes: [{
            node_id: "builder",
            actor: "builder",
            event_types: ["concept.image.arrived"],
            instructions: "Inspect and process the concept image.",
          }],
          command_nodes: [],
        },
      },
    });

    expect(compose.statusCode).toBe(201);
    const composed = compose.json().result;
    expect(composed.summary).toBe("Composed Scope 'concept-processing' with 2 current nodes.");
    expect(composed.data).toMatchObject({
      scope_id: "concept-processing",
      graph_id: expect.stringMatching(/^graph_/),
      context_id: expect.any(String),
      nodes: [
        expect.objectContaining({ kind: "trigger", node_id: "concept-arrived" }),
        expect.objectContaining({ kind: "actor", endpoint_id: builderEndpointId }),
      ],
    });

    const inspect = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.inspect/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "concept-processing" },
      },
    });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json().result.data.scopes[0]).toMatchObject({
      scope_id: "concept-processing",
      composition: expect.objectContaining({
        graph_id: expect.stringMatching(/^graph_/),
        context_id: composed.data.context_id,
        operation: expect.objectContaining({
          state: "settled",
          active_deliveries: [],
          queued_event_count: 0,
        }),
      }),
    });

    const fire = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.event.fire/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "concept-processing",
          event_node_id: "concept-arrived",
          content: { file_path: "concepts/castle.png" },
        },
      },
    });
    expect(fire.statusCode).toBe(201);
    expect(fire.json().result).toMatchObject({
      summary: "Event node 'concept-arrived' fired; 1 subscribed participant(s) were woken.",
      data: { event_count: 1 },
    });

    const workingInspect = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.inspect/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "concept-processing" },
      },
    });
    expect(workingInspect.json().result.data.scopes[0].composition.operation).toMatchObject({
      state: "queued",
      active_deliveries: [],
      queued_event_count: 1,
    });
  });

  it("corrects one stable Scope composition in place and preserves its Context history", async () => {
    const first = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "delivery",
          title: "Delivery",
          event_nodes: [{ node_id: "start", event_type: "work.requested" }],
          actor_nodes: [{ node_id: "builder", actor: "builder", event_types: ["work.requested"] }],
        },
      },
    });
    const firstData = first.json().result.data;
    const firstGraph = handle.store.getScopeGraphForScope(workspaceId, "delivery")!;

    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.event.fire/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "delivery", event_node_id: "start", content: { slice: "one" } },
      },
    });

    const revised = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "delivery",
          title: "Delivery corrected",
          event_nodes: [{ node_id: "resume", event_type: "work.resumed" }],
          actor_nodes: [{ node_id: "floe", actor: "floe", event_types: ["work.resumed"] }],
        },
      },
    });

    expect(revised.statusCode).toBe(201);
    expect(revised.json().result.summary).toContain("Updated Scope 'delivery'");
    const current = handle.store.getScopeGraphForScope(workspaceId, "delivery")!;
    expect(current.graph_id).toBe(firstGraph.graph_id);
    expect(current.context_id).toBe(firstData.context_id);
    expect(handle.store.listScopeGraphs(workspaceId, "delivery")).toHaveLength(1);
    expect(current.nodes.map((node) => node.node_id)).toEqual(["resume", "floe"]);
    expect(handle.store.contextStore.getContextSubscriptions(current.context_id)).toEqual([
      expect.objectContaining({ endpoint_id: floeEndpointId, event_types: ["work.resumed"] }),
    ]);
    const historical = handle.store.db.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE context_id = ?"
    ).get(current.context_id) as { count: number };
    expect(historical.count).toBe(1);
  });

  it("retires obsolete connected work without deleting its Context history", async () => {
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "old-delivery",
          title: "Old delivery",
          event_nodes: [{ node_id: "start", event_type: "work.requested" }],
          actor_nodes: [{ node_id: "builder", actor: "builder", event_types: ["work.requested"] }],
        },
      },
    });
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.event.fire/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "old-delivery", event_node_id: "start", content: {} },
      },
    });
    const contextId = handle.store.getScopeGraphForScope(workspaceId, "old-delivery")!.context_id;

    const retired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.retire/invoke`,
      payload: { caller_endpoint_id: floeEndpointId, input: { scope_id: "old-delivery" } },
    });
    expect(retired.statusCode).toBe(201);
    expect(retired.json().result.data).toMatchObject({
      status: "retired",
      cancelled_queue_count: 1,
    });
    expect(handle.store.getScope(workspaceId, "old-delivery")?.status).toBe("retired");
    expect(handle.store.contextStore.getContext(contextId)).not.toBeNull();
    expect(handle.store.contextStore.getContextSubscriptions(contextId)).toEqual([]);

    const fire = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.event.fire/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "old-delivery", event_node_id: "start", content: {} },
      },
    });
    expect(fire.statusCode).toBe(409);
    expect(fire.json()).toMatchObject({ error: "scope_retired", scope_id: "old-delivery" });
  });

  it("stops an injected Scope turn durably instead of allowing it to resume", async () => {
    const bridgeId = "bridge:stop-test";
    handle.store.registerBridge({ bridge_id: bridgeId }, handle.broadcast);
    handle.store.registerEndpoint({
      endpoint_id: builderEndpointId,
      workspace_id: workspaceId,
      name: "Builder",
      bridge_id: bridgeId,
      status: "idle",
    }, handle.broadcast);
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "active-delivery",
          title: "Active delivery",
          event_nodes: [{ node_id: "start", event_type: "work.requested" }],
          actor_nodes: [{ node_id: "builder", actor: "builder", event_types: ["work.requested"] }],
        },
      },
    });
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.event.fire/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "active-delivery", event_node_id: "start", content: {} },
      },
    });
    const delivery = handle.store.claimDeliveries(bridgeId, 1, handle.broadcast)[0]!;
    handle.store.reportDeliveryStatus({
      bridge_id: bridgeId,
      delivery_id: delivery.delivery_id,
      state: "injected_to_runtime",
    }, handle.broadcast);

    const stopped = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/active-delivery/retire`,
      payload: {},
    });

    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({
      status: "retired",
      cancelled_delivery_count: 1,
      cancelled_queue_count: 1,
    });
    expect((handle.store.listDeliveries({ workspace_id: workspaceId }) as any[])
      .find((row) => row.delivery_id === delivery.delivery_id)?.state).toBe("cancelled");
    handle.store.reportDeliveryStatus({
      bridge_id: bridgeId,
      delivery_id: delivery.delivery_id,
      state: "acknowledged",
    }, handle.broadcast);
    expect((handle.store.listDeliveries({ workspace_id: workspaceId }) as any[])
      .find((row) => row.delivery_id === delivery.delivery_id)?.state).toBe("cancelled");
    const contextId = handle.store.getScopeGraphForScope(workspaceId, "active-delivery")!.context_id;
    expect(handle.store.listEvents({ context_id: contextId, limit: 20 }))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: "work.stopped" })]));
  });

  it("rejects folder sources that escape the workspace", async () => {
    const response = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "unsafe",
          title: "Unsafe",
          event_nodes: [{
            node_id: "arrival",
            event_type: "file.arrived",
            source: { kind: "folder", path: "../outside" },
          }],
          actor_nodes: [{ node_id: "builder", actor: "builder", event_types: ["file.arrived"] }],
        },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "invalid_folder_source" });
    expect(handle.store.getScope(workspaceId, "unsafe")).toBeNull();
  });

  it("removes an obsolete composition only while its Context is still unused", async () => {
    const compose = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "obsolete",
          title: "Obsolete organisation",
          event_nodes: [{ node_id: "start", event_type: "work.requested" }],
          actor_nodes: [{ node_id: "builder", actor: "builder", event_types: ["work.requested"] }],
        },
      },
    });
    const composed = compose.json().result.data;
    const graphId = handle.store.getScopeGraphForScope(workspaceId, "obsolete")?.graph_id as string;

    const remove = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.remove-unused/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "obsolete" },
      },
    });

    expect(remove.statusCode).toBe(201);
    expect(remove.json().result).toMatchObject({
      summary: "Removed unused Scope 'obsolete' and its inactive composition.",
      data: { scope_id: "obsolete", graph_count: 1, context_count: 1 },
    });
    expect(handle.store.getScope(workspaceId, "obsolete")).toBeNull();
    expect(handle.store.getScopeGraph(workspaceId, graphId)).toBeNull();
    expect(handle.store.contextStore.getContext(composed.context_id)).toBeNull();
    expect(handle.store.contextStore.getContextSubscriptions(composed.context_id)).toEqual([]);
  });

  it("refuses to remove a Scope after work has been recorded", async () => {
    const compose = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "historical",
          title: "Historical organisation",
          event_nodes: [{ node_id: "start", event_type: "work.requested" }],
          actor_nodes: [{ node_id: "builder", actor: "builder", event_types: ["work.requested"] }],
        },
      },
    });
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.event.fire/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "historical", event_node_id: "start", content: {} },
      },
    });

    const remove = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.remove-unused/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "historical" },
      },
    });

    expect(remove.statusCode).toBe(409);
    expect(remove.json()).toMatchObject({
      error: "scope_removal_blocked",
      scope_id: "historical",
      event_count: 1,
    });
    expect(handle.store.getScope(workspaceId, "historical")).not.toBeNull();
    expect(handle.store.getScopeGraphForScope(workspaceId, "historical")).not.toBeNull();
  });

  it("refuses to remove an unused Scope while one of its Command endpoints is still working", async () => {
    const compose = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.compose/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          scope_id: "busy-command",
          title: "Busy command",
          event_nodes: [{ node_id: "start", event_type: "work.requested" }],
          actor_nodes: [],
          command_nodes: [{
            node_id: "build",
            event_types: ["work.requested"],
            command: "echo building",
          }],
        },
      },
    });
    const commandEndpointId = compose.json().result.data.nodes.find((node: any) => node.kind === "command").endpoint_id;
    handle.store.registerEndpoint({
      endpoint_id: commandEndpointId,
      workspace_id: workspaceId,
      name: "Build",
      bridge_id: "bridge:test",
      status: "active",
    }, handle.broadcast);

    const remove = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.remove-unused/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: { scope_id: "busy-command" },
      },
    });

    expect(remove.statusCode).toBe(409);
    expect(remove.json()).toMatchObject({
      error: "scope_removal_blocked",
      scope_id: "busy-command",
      busy_endpoint_count: 1,
    });
    expect(handle.store.getScope(workspaceId, "busy-command")).not.toBeNull();
  });
});
