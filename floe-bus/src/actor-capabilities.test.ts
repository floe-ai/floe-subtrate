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
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]).toMatchObject({
      capability_id: "scope.compose",
      category: "organisation",
      effect: "write",
      title: "Compose connected operation",
    });
    expect(capabilities[0].description).toContain("folder-driven workflow");
    expect(capabilities[0].input_schema.properties.event_nodes.description).toContain("shared scoped Context");
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
    expect(composed.summary).toBe("Composed Scope 'concept-processing' with 2 nodes.");
    expect(composed.data).toMatchObject({
      scope_id: "concept-processing",
      graph_id: expect.any(String),
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
      compositions: [expect.objectContaining({ graph_id: composed.data.graph_id })],
    });

    const fire = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/capabilities/scope.event.fire/invoke`,
      payload: {
        caller_endpoint_id: floeEndpointId,
        input: {
          graph_id: composed.data.graph_id,
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
});
