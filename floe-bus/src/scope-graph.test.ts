import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{ handle: ServerHandle; tmp: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-scope-graph-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg);
  await handle.app.ready();
  return { handle, tmp };
}

async function registerWorkspace(handle: ServerHandle, tmp: string): Promise<string> {
  const locator = join(tmp, "ws");
  mkdirSync(locator, { recursive: true });
  const res = await handle.app.inject({
    method: "POST",
    url: "/v1/workspaces/register",
    payload: { locator, name: "scope-graph" }
  });
  expect(res.statusCode).toBe(201);
  return res.json().workspace.workspace_id;
}

function registerEndpoint(handle: ServerHandle, workspaceId: string, endpointId: string): void {
  handle.store.registerEndpoint({
    endpoint_id: endpointId,
    workspace_id: workspaceId,
    name: endpointId,
    bridge_id: "bridge:test",
    status: "idle"
  }, () => {});
}

async function createScope(handle: ServerHandle, workspaceId: string, scopeId: string): Promise<void> {
  const created = await handle.app.inject({
    method: "POST",
    url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
    payload: { scope_id: scopeId, title: scopeId }
  });
  expect(created.statusCode).toBe(201);
}

describe("Scope Graph API", () => {
  let handle: ServerHandle;
  let tmp: string;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    tmp = made.tmp;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("stores an authored graph before anything runs, then fires the trigger to wake the actor", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    // The graph is authored — stored — before it ever runs. No bespoke "edge"
    // is authored: the actor node's connection is realised via existing
    // Context participant + subscription primitives, which the graph's
    // shared context_id ties together.
    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed", label: "note landed" },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer, label: "writer" }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const graph = created.json().graph;
    expect(graph.graph_id).toMatch(/^graph_/);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.context_id).toMatch(/^ctx_/);

    // Authoring the actor node already wired it into the graph's Context via
    // the EXISTING participant + subscription primitives — verified directly
    // against those tables, not a bespoke scope-graph routing record.
    const participant = handle.store.db.prepare(
      "SELECT * FROM context_participants WHERE context_id = ? AND endpoint_id = ?"
    ).get(graph.context_id, writer);
    expect(participant).toBeTruthy();
    const subscription = handle.store.contextStore.getContextSubscriptions(graph.context_id);
    expect(subscription).toEqual([{ endpoint_id: writer, event_types: ["*"], subscribed_at: expect.any(String) }]);

    // Nothing has run yet: no event exists for the writer.
    const beforeFire = handle.store.db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
    expect(beforeFire.count).toBe(0);

    // Firing the trigger node causes the actor node to be woken — resolved by
    // reading the Context's own EXISTING subscription state, not a stored edge.
    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/watcher/fire`,
      payload: { content: { path: "docs/README.md" } }
    });
    expect(fired.statusCode).toBe(201);
    const events = fired.json().events;
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("note.landed");
    expect(events[0].destination_json).toEqual({ kind: "endpoint", endpoint_id: writer });
    expect(events[0].context_id).toBe(graph.context_id);
    expect(events[0].source_endpoint_id).toBeNull();
    expect(events[0].content).toEqual({ path: "docs/README.md" });

    const queued = handle.store.db.prepare(
      "SELECT * FROM event_queue WHERE destination_endpoint_id = ?"
    ).get(writer) as any;
    expect(queued).toBeTruthy();
    expect(queued.event_id).toBe(events[0].event_id);

    // The graph persists as read afterward — it did not vanish on firing.
    const reread = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}`
    });
    expect(reread.statusCode).toBe(200);
    expect(reread.json().graph.graph_id).toBe(graph.graph_id);
  });

  it("does not wake an actor whose Context subscription does not match the trigger's event type", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer, event_types: ["review.requested"] }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const graph = created.json().graph;

    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/watcher/fire`,
      payload: { content: {} }
    });
    expect(fired.statusCode).toBe(201);
    expect(fired.json().events).toHaveLength(0);
  });

  it("rejects a graph with a duplicate node id", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" }
        ]
      }
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error).toBe("scope_graph_invalid");
  });

  it("rejects firing a node that is not a trigger", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer }
        ]
      }
    });
    expect(created.statusCode).toBe(201);
    const graph = created.json().graph;

    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/writer_node/fire`,
      payload: { content: {} }
    });
    expect(fired.statusCode).toBe(400);
    expect(fired.json().error).toBe("scope_graph_node_not_a_trigger");
  });

  it("fires a trigger with arrival facts (channel, locator, observed_at, raw_reference) as ordinary content — no origin envelope", async () => {
    const workspaceId = await registerWorkspace(handle, tmp);
    const writer = `actor:${workspaceId}:writer`;
    registerEndpoint(handle, workspaceId, writer);
    await createScope(handle, workspaceId, "docs");

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/docs/graphs`,
      payload: {
        nodes: [
          { node_id: "watcher", kind: "trigger", event_type: "note.landed" },
          { node_id: "writer_node", kind: "actor", endpoint_id: writer }
        ]
      }
    });
    const graph = created.json().graph;
    const observedAt = new Date().toISOString();

    const fired = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/graphs/${graph.graph_id}/nodes/watcher/fire`,
      payload: {
        content: {
          file_name: "README.md",
          channel: "watched_folder",
          locator: "C:\\ws\\inbox\\README.md",
          observed_at: observedAt,
          raw_reference: "C:\\ws\\inbox\\README.md"
        }
      }
    });
    expect(fired.statusCode).toBe(201);
    const event = fired.json().events[0];
    // Arrival facts are just content — no separate origin field or kind tag.
    expect(event.content).toEqual({
      file_name: "README.md",
      channel: "watched_folder",
      locator: "C:\\ws\\inbox\\README.md",
      observed_at: observedAt,
      raw_reference: "C:\\ws\\inbox\\README.md"
    });
    expect(event.origin).toBeUndefined();
    // No speaker: source_endpoint_id stays null exactly as any other trigger fire.
    expect(event.source_endpoint_id).toBeNull();
  });
});
