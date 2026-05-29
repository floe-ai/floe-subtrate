import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "./server.js";
import { defaultConfig, type LocalConfig } from "./config.js";

type ServerHandle = Awaited<ReturnType<typeof createBusServer>>;

async function makeServer(): Promise<{
  handle: ServerHandle;
  tmp: string;
  cfgPath: string;
  cfg: LocalConfig;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "floe-bus-scopes-"));
  const cfgPath = join(tmp, "config.yaml");
  const cfg: LocalConfig = defaultConfig(tmp);
  writeFileSync(cfgPath, YAML.stringify(cfg), "utf8");
  const handle = await createBusServer(cfgPath, cfg);
  await handle.app.ready();
  return {
    handle,
    tmp,
    cfgPath,
    cfg
  };
}

describe("Scope HTTP routes", () => {
  let handle: ServerHandle;
  let tmp: string;
  let cfgPath: string;
  let cfg: LocalConfig;

  beforeEach(async () => {
    const made = await makeServer();
    handle = made.handle;
    tmp = made.tmp;
    cfgPath = made.cfgPath;
    cfg = made.cfg;
  });

  afterEach(async () => {
    try { await handle.app.close(); } catch {}
    rmSync(tmp, { recursive: true, force: true });
  });

  it("registering a workspace does not create a Default Scope", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test" }
    });
    expect(registered.statusCode).toBe(201);
    const workspaceId = registered.json().workspace.workspace_id;

    const scopes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`
    });

    expect(scopes.statusCode).toBe(200);
    expect(scopes.json()).toEqual({ scopes: [] });
  });

  it("creates a named Scope without inventing a Default Scope", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test" }
    });
    expect(registered.statusCode).toBe(201);
    const workspaceId = registered.json().workspace.workspace_id;

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "research",
        title: "Research",
        description: "Discovery work"
      }
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().scope).toMatchObject({
      scope_id: "research",
      workspace_id: workspaceId,
      title: "Research",
      description: "Discovery work",
      is_default: false
    });

    const scopes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`
    });
    expect(scopes.statusCode).toBe(200);
    expect(scopes.json().scopes.map((scope: { scope_id: string }) => scope.scope_id)).toEqual([
      "research"
    ]);
  });

  it("rejects user-created Scope id 'default' because it is reserved for stale cleanup", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = registered.json().workspace.workspace_id;

    const created = await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "default",
        title: "Default"
      }
    });

    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      error: "scope_id_reserved",
      workspace_id: workspaceId,
      scope_id: "default"
    });
  });

  it("updates Scope metadata through the workspace API", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = registered.json().workspace.workspace_id;
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "research",
        title: "Research",
        description: "Discovery work"
      }
    });

    const updated = await handle.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research`,
      payload: {
        title: "Validated Research",
        description: null
      }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().scope).toMatchObject({
      scope_id: "research",
      workspace_id: workspaceId,
      title: "Validated Research",
      description: null,
      is_default: false
    });
  });

  it("preserves existing Scope description when PATCH updates only the title", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = registered.json().workspace.workspace_id;
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`,
      payload: {
        scope_id: "research",
        title: "Research",
        description: "Discovery work"
      }
    });

    const updated = await handle.app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/research`,
      payload: { title: "Validated Research" }
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().scope).toMatchObject({
      scope_id: "research",
      title: "Validated Research",
      description: "Discovery work"
    });
  });

  it("does not create a Default Scope across register, select, and server restart", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const firstRegistration = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = firstRegistration.json().workspace.workspace_id;
    await handle.app.inject({
      method: "POST",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/select`
    });
    await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test-renamed" }
    });

    await handle.app.close();
    handle = await createBusServer(cfgPath, cfg);
    await handle.app.ready();

    const scopes = await handle.app.inject({
      method: "GET",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes`
    });
    expect(scopes.statusCode).toBe(200);
    expect(scopes.json().scopes.filter((scope: { scope_id: string }) => scope.scope_id === "default")).toHaveLength(0);
  });

  it("does not expose Scope deletion in the first Scope slice", async () => {
    const wsLocator = join(tmp, "ws");
    mkdirSync(wsLocator, { recursive: true });
    const registered = await handle.app.inject({
      method: "POST",
      url: "/v1/workspaces/register",
      payload: { locator: wsLocator, name: "scope-test" }
    });
    const workspaceId = registered.json().workspace.workspace_id;

    const deleted = await handle.app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${encodeURIComponent(workspaceId)}/scopes/default`
    });

    expect(deleted.statusCode).toBe(404);
  });
});
