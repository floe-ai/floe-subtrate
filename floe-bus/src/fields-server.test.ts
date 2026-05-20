import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{
  handle: ServerHandle;
  cleanup: () => Promise<void>;
  tmp: string;
  wsId: string;
  wsLocator: string;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-fields-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg);
  await handle.app.ready();

  const wsLocator = join(tmp, "ws");
  mkdirSync(wsLocator, { recursive: true });
  const workspace = handle.store.registerWorkspace(
    { locator: wsLocator, name: "field-test" },
    () => {}
  ) as { workspace_id: string };
  return {
    handle,
    tmp,
    wsId: workspace.workspace_id,
    wsLocator,
    cleanup: async () => {
      try { await handle.app.close(); } catch {}
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

function makeSemantic(id: string, overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schema: "floe.field.v1",
    id,
    title: "Field " + id,
    items: [],
    connections: [],
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...overrides
  };
}

function makeLayout(fieldId: string): Record<string, unknown> {
  return {
    schema: "floe.field.layout.floeweb.v1",
    field_id: fieldId,
    viewport: { x: 0, y: 0, zoom: 1 },
    items: {}
  };
}

describe("Fields HTTP routes", () => {
  let handle: ServerHandle;
  let cleanup: () => Promise<void>;
  let wsId: string;
  let wsLocator: string;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    cleanup = made.cleanup;
    wsId = made.wsId;
    wsLocator = made.wsLocator;
  });
  afterEach(async () => { await cleanup(); });

  it("GET list on empty workspace returns empty array", async () => {
    const res = await handle.app.inject({ method: "GET", url: `/v1/workspaces/${wsId}/fields` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fields: [] });
  });

  it("PUT new field returns 201 and writes file to disk", async () => {
    const semantic = makeSemantic("alpha");
    const res = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/alpha`,
      payload: semantic
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.semantic.id).toBe("alpha");
    expect(body.semantic.title).toBe("Field alpha");
    expect(existsSync(join(wsLocator, ".floe", "fields", "alpha.yaml"))).toBe(true);
  });

  it("PUT existing field returns 200 and bumps updated_at, preserves created_at", async () => {
    const created = "2024-06-01T00:00:00.000Z";
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/beta`,
      payload: makeSemantic("beta", { created_at: created, updated_at: created, title: "Original" })
    });
    await new Promise((r) => setTimeout(r, 5));
    const res = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/beta`,
      payload: makeSemantic("beta", { created_at: created, updated_at: created, title: "Updated" })
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.semantic.title).toBe("Updated");
    expect(body.semantic.created_at).toBe(created);
    expect(body.semantic.updated_at).not.toBe(created);
  });

  it("PUT create-if-absent returns 409 when the field id already exists", async () => {
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/existing?if_absent=true`,
      payload: makeSemantic("existing")
    });

    const res = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/existing?if_absent=true`,
      payload: makeSemantic("existing", { title: "Should not overwrite" })
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("field_already_exists");

    const loaded = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${wsId}/fields/existing`
    });
    expect(loaded.json().semantic.title).toBe("Field existing");
  });

  it("GET list returns summary after PUT", async () => {
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/gamma`,
      payload: makeSemantic("gamma", {
        items: [{ item_id: "n1", ref: "note:abc" }, { item_id: "n2", ref: "note:def" }],
        connections: [{ id: "c1", from: "n1", to: "n2" }]
      })
    });
    const res = await handle.app.inject({ method: "GET", url: `/v1/workspaces/${wsId}/fields` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fields).toHaveLength(1);
    expect(body.fields[0]).toMatchObject({
      id: "gamma",
      title: "Field gamma",
      item_count: 2,
      connection_count: 1
    });
  });

  it("GET one returns semantic and null layout when no layout written", async () => {
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/delta`,
      payload: makeSemantic("delta")
    });
    const res = await handle.app.inject({ method: "GET", url: `/v1/workspaces/${wsId}/fields/delta` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.semantic.id).toBe("delta");
    expect(body.layout).toBeNull();
  });

  it("PUT layout (floeweb) writes layout file and returns 200", async () => {
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/eps`,
      payload: makeSemantic("eps")
    });
    const res = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/eps/layout/floeweb`,
      payload: makeLayout("eps")
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().layout.field_id).toBe("eps");
    expect(existsSync(join(wsLocator, ".floe", "fields", "eps.layout.floeweb.yaml"))).toBe(true);
  });

  it("GET one returns layout after it is written", async () => {
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/zeta`,
      payload: makeSemantic("zeta")
    });
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/zeta/layout/floeweb`,
      payload: makeLayout("zeta")
    });
    const res = await handle.app.inject({ method: "GET", url: `/v1/workspaces/${wsId}/fields/zeta` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.layout).not.toBeNull();
    expect(body.layout.field_id).toBe("zeta");
  });

  it("GET non-existent field returns 404", async () => {
    const res = await handle.app.inject({ method: "GET", url: `/v1/workspaces/${wsId}/fields/missing` });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "field_not_found" });
  });

  it("DELETE field removes semantic + layout files", async () => {
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/eta`,
      payload: makeSemantic("eta")
    });
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/eta/layout/floeweb`,
      payload: makeLayout("eta")
    });
    const res = await handle.app.inject({ method: "DELETE", url: `/v1/workspaces/${wsId}/fields/eta` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.semanticDeleted).toBe(true);
    expect(body.layoutsDeleted).toHaveLength(1);
    expect(existsSync(join(wsLocator, ".floe", "fields", "eta.yaml"))).toBe(false);
    expect(existsSync(join(wsLocator, ".floe", "fields", "eta.layout.floeweb.yaml"))).toBe(false);
  });

  it("PUT with mismatched id in body vs URL returns 400 field_id_mismatch", async () => {
    const res = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/theta`,
      payload: makeSemantic("not-theta")
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("field_id_mismatch");
  });

  it("PUT layout with invalid renderer returns 400 field_renderer_invalid", async () => {
    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/iota`,
      payload: makeSemantic("iota")
    });
    const res = await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/iota/layout/react-flow`,
      payload: makeLayout("iota")
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("field_renderer_invalid");
  });

  it("PUT field broadcasts field_updated to WS subscribers", async () => {
    const address = await handle.app.listen({ port: 0, host: "127.0.0.1" });
    const url = address.replace(/^http/, "ws") + "/v1/events/stream";
    const wsMod = await import("ws" as any);
    const WS = (wsMod as any).WebSocket ?? (wsMod as any).default;
    const ws = new WS(url);
    const messages: any[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (e: any) => reject(e));
    });
    ws.on("message", (data: any) => {
      messages.push(JSON.parse(data.toString()));
    });

    await handle.app.inject({
      method: "PUT",
      url: `/v1/workspaces/${wsId}/fields/kappa`,
      payload: makeSemantic("kappa")
    });

    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    const updated = messages.find((m) => m.type === "field_updated");
    expect(updated).toBeDefined();
    expect(updated.payload.field_id).toBe("kappa");
    expect(updated.payload.workspace_id).toBe(wsId);
    expect(updated.payload.semantic.id).toBe("kappa");
  });

  it("returns 404 workspace_not_found for unknown workspace", async () => {
    const res = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/workspace:doesnotexist/fields`
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "workspace_not_found" });
  });
});
