import { expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createBusServer } from "../../floe-bus/src/server";
import { defaultConfig } from "../../floe-bus/src/config";
import {
  test,
  seedApp,
  seedAppWithFields,
  makeFieldSemantic,
  WORKSPACE_ID
} from "./helpers";

test.describe("Field substrate (slice 1)", () => {
  test("lists existing substrate fields from the bus", async ({ page }) => {
    const semantic = makeFieldSemantic(
      "inbound-pr-review",
      "Inbound PR Review",
      [
        { item_id: "i1", ref: "actor:floe" },
        { item_id: "i2", ref: "context:default" },
        { item_id: "i3", ref: "pulse:nightly" }
      ],
      [
        { id: "c1", from: "i1", to: "i2" },
        { id: "c2", from: "i2", to: "i3" }
      ]
    );

    await seedAppWithFields(page, [{ semantic }]);

    const card = page.locator(".field-block", { hasText: "Inbound PR Review" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("3 items");
  });

  test("empty workspace shows empty-state instead of field cards", async ({ page }) => {
    await seedAppWithFields(page, []);

    await expect(page.locator(".field-block")).toHaveCount(0);
    await expect(page.getByText("No Fields yet")).toBeVisible();
  });

  test("opens a field and renders items as ReactFlow nodes", async ({ page }) => {
    const semantic = makeFieldSemantic(
      "two-items",
      "Two Items",
      [
        { item_id: "n1", ref: "actor:floe" },
        { item_id: "n2", ref: "context:default" }
      ]
    );

    await seedAppWithFields(page, [{ semantic }]);
    await page.locator(".field-block", { hasText: "Two Items" }).click();

    const nodes = page.locator(".react-flow__node");
    await expect(nodes).toHaveCount(2);
    await expect(nodes.filter({ hasText: "floe" })).toHaveCount(1);
    await expect(nodes.filter({ hasText: "default" })).toHaveCount(1);
  });

  test("opens a field and renders connections as edges", async ({ page }) => {
    const semantic = makeFieldSemantic(
      "with-edge",
      "With Edge",
      [
        { item_id: "n1", ref: "actor:floe" },
        { item_id: "n2", ref: "context:default" }
      ],
      [{ id: "e1", from: "n1", to: "n2" }]
    );

    await seedAppWithFields(page, [{ semantic }]);
    await page.locator(".field-block", { hasText: "With Edge" }).click();

    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);
  });

  test("opens each Field with its persisted viewport instead of stale canvas position", async ({ page }) => {
    const first = makeFieldSemantic(
      "first-field",
      "First Field",
      [{ item_id: "actor-a", ref: "actor:a" }]
    );
    const second = makeFieldSemantic(
      "second-field",
      "Second Field",
      [{ item_id: "actor-b", ref: "actor:b" }]
    );
    await seedAppWithFields(page, [
      {
        semantic: first,
        layout: {
          schema: "floe.field.layout.floeweb.v1",
          field_id: "first-field",
          viewport: { x: 80, y: 45, zoom: 1.2 },
          items: { "actor-a": { x: 10, y: 10 } }
        }
      },
      {
        semantic: second,
        layout: {
          schema: "floe.field.layout.floeweb.v1",
          field_id: "second-field",
          viewport: { x: -120, y: 30, zoom: 0.75 },
          items: { "actor-b": { x: 20, y: 20 } }
        }
      }
    ]);

    await page.locator(".field-block", { hasText: "First Field" }).click();
    await expect.poll(async () =>
      page.locator(".react-flow__viewport").evaluate((element) => (element as HTMLElement).style.transform)
    ).toContain("translate(80px, 45px) scale(1.2)");

    await page.getByRole("button", { name: /Workspace Home/i }).click();
    await page.locator(".field-block", { hasText: "Second Field" }).click();
    await expect.poll(async () =>
      page.locator(".react-flow__viewport").evaluate((element) => (element as HTMLElement).style.transform)
    ).toContain("translate(-120px, 30px) scale(0.75)");
  });

  test("dragging the Field primitive into an open Field canvas creates a nested Field item there", async ({ page }) => {
    const parent = makeFieldSemantic("parent-field", "Parent Field");
    await seedAppWithFields(page, [{ semantic: parent }]);
    await page.locator(".field-block", { hasText: "Parent Field" }).click();

    page.once("dialog", (dialog) => {
      void dialog.accept("Dropped Field");
    });

    const childPut = page.waitForRequest((request) =>
      request.method() === "PUT" &&
      request.url().includes(`/v1/workspaces/${WORKSPACE_ID}/fields/dropped-field`) &&
      request.url().includes("if_absent=true")
    );
    const parentPut = page.waitForRequest((request) =>
      request.method() === "PUT" &&
      request.url().includes(`/v1/workspaces/${WORKSPACE_ID}/fields/parent-field`) &&
      !request.url().includes("/layout/")
    );

    const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
    const source = page.locator(".library-primitive", { hasText: "Field" });
    const target = page.locator(".react-flow").first();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    await source.dispatchEvent("dragstart", { dataTransfer });
    await target.dispatchEvent("dragover", {
      dataTransfer,
      clientX: box!.x + 180,
      clientY: box!.y + 140
    });
    await target.dispatchEvent("drop", {
      dataTransfer,
      clientX: box!.x + 180,
      clientY: box!.y + 140
    });

    const [childRequest, parentRequest] = await Promise.all([childPut, parentPut]);
    const childBody = JSON.parse(childRequest.postData() ?? "{}");
    expect(childBody).toEqual(expect.objectContaining({ id: "dropped-field", title: "Dropped Field" }));
    const parentBody = JSON.parse(parentRequest.postData() ?? "{}");
    expect(parentBody.items).toEqual([
      expect.objectContaining({
        item_id: "field-dropped-field",
        ref: "field:dropped-field"
      })
    ]);

    await expect(page.getByRole("heading", { name: "Parent Field" })).toBeVisible();
    await expect(page.locator(".react-flow__node").filter({ hasText: /dropped-field|Dropped Field/ })).toHaveCount(1);
  });

  test("double-clicking a nested Field node opens that Field for editing", async ({ page }) => {
    const parent = makeFieldSemantic(
      "parent-field",
      "Parent Field",
      [{ item_id: "field-child-field", ref: "field:child-field" }]
    );
    const child = makeFieldSemantic("child-field", "Child Field");
    await seedAppWithFields(page, [{ semantic: parent }, { semantic: child }]);
    await page.locator(".field-block", { hasText: "Parent Field" }).click();

    await page.locator(".react-flow__node").filter({ hasText: /child-field|Child Field/ }).dblclick();

    await expect(page.getByRole("heading", { name: "Child Field" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename field" })).toBeVisible();
  });

  test("create field — sends PUT and the new field appears in the list", async ({ page }) => {
    await seedAppWithFields(page, []);

    page.once("dialog", (dialog) => {
      void dialog.accept("My New Field");
    });

    const putWait = page.waitForRequest((request) =>
      request.method() === "PUT" &&
      request.url().includes(`/v1/workspaces/${WORKSPACE_ID}/fields/my-new-field`)
    );

    await page.getByRole("button", { name: /Add field/i }).click();

    const request = await putWait;
    const url = new URL(request.url());
    expect(url.searchParams.get("if_absent")).toBe("true");
    const body = JSON.parse(request.postData() ?? "{}");
    expect(body.id).toBe("my-new-field");
    expect(body.title).toBe("My New Field");

    // After creation the app opens the new field directly. Go back home, then
    // confirm the list reflects what the helper now has in its in-memory map.
    await page.getByRole("button", { name: /Workspace Home/i }).click();
    await expect(
      page.locator(".field-block", { hasText: "My New Field" })
    ).toBeVisible();
  });

  test("delete field — sends DELETE and field disappears", async ({ page }) => {
    const semantic = makeFieldSemantic("foo-field", "Foo");
    await seedAppWithFields(page, [{ semantic }]);

    // Open it
    await page.locator(".field-block", { hasText: "Foo" }).click();

    page.on("dialog", (dialog) => { void dialog.accept(); });

    const deleteWait = page.waitForRequest((request) =>
      request.method() === "DELETE" &&
      request.url().includes(`/v1/workspaces/${WORKSPACE_ID}/fields/foo-field`)
    );

    await page.getByRole("button", { name: /Delete field/i }).click();
    await deleteWait;

    // Returned to home with empty field list
    await expect(page.locator(".field-block")).toHaveCount(0);
    await expect(page.getByText("No Fields yet")).toBeVisible();
  });

  // App selects fields via in-memory `view` state only; there's no deep-link
  // URL routing for ?field=... in Wave C1. Skip until a routing layer exists.
  test.skip("non-existent field shows nothing (or empty canvas)", async () => {
    // intentionally skipped: no deep-link routing in current main.tsx
  });

  test("seedApp (default) still boots cleanly with no fields", async ({ page }) => {
    await seedApp(page);
    await expect(page.locator(".field-block")).toHaveCount(0);
  });

  test("real bus stack persists a created Field to workspace YAML and deletes it from disk", async ({ page }) => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-field-substrate-e2e-"));
    const configPath = join(tmp, "config.yaml");
    const workspacePath = join(tmp, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const config = defaultConfig(tmp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    const handle = await createBusServer(configPath, config);
    const busUrl = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const semanticPath = join(workspacePath, ".floe", "fields", "live-field.yaml");
    const semanticPutRequests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PUT" &&
        request.url().includes("/fields/live-field") &&
        !request.url().includes("/layout/")
      ) {
        semanticPutRequests.push(request.url());
      }
    });

    try {
      await page.addInitScript((url) => localStorage.setItem("floe.busUrl", url), busUrl);
      await page.goto("/");

      await page.getByLabel("Workspace folder").fill(workspacePath);
      await page.getByLabel("Name").fill("Field E2E Workspace");
      await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
      await expect(page.locator(".workspace-home")).toBeVisible();

      page.once("dialog", (dialog) => {
        void dialog.accept("Live Field");
      });
      await page.getByRole("button", { name: /Add field/i }).click();

      await expect.poll(() => existsSync(semanticPath)).toBe(true);
      await expect.poll(() => semanticPutRequests.length).toBe(1);
      await page.waitForTimeout(500);
      expect(semanticPutRequests).toHaveLength(1);
      const written = YAML.parse(readFileSync(semanticPath, "utf8")) as Record<string, unknown>;
      expect(written.schema).toBe("floe.field.v1");
      expect(written.id).toBe("live-field");
      expect(written.title).toBe("Live Field");

      await page.reload();
      await expect(page.locator(".field-block", { hasText: "Live Field" })).toBeVisible();

      await page.locator(".field-block", { hasText: "Live Field" }).click();
      page.once("dialog", (dialog) => {
        void dialog.accept();
      });
      await page.getByRole("button", { name: /Delete field/i }).click();

      await expect.poll(() => existsSync(semanticPath)).toBe(false);
      await expect(page.getByText("No Fields yet")).toBeVisible();
    } finally {
      if (!page.isClosed()) {
        await page.close();
      }
      handle.app.server.closeAllConnections();
      await handle.app.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("real bus stack renames a Field title without changing id, filename, items, connections, or layout", async ({ page }) => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-field-rename-e2e-"));
    const configPath = join(tmp, "config.yaml");
    const workspacePath = join(tmp, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const config = defaultConfig(tmp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    const handle = await createBusServer(configPath, config);
    const busUrl = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const fieldsDir = join(workspacePath, ".floe", "fields");
    const semanticPath = join(fieldsDir, "rename-me.yaml");
    const layoutPath = join(fieldsDir, "rename-me.layout.floeweb.yaml");
    const semantic = makeFieldSemantic(
      "rename-me",
      "Rename Me",
      [
        { item_id: "floe_actor", ref: "actor:floe" },
        { item_id: "nested_field", ref: "field:other-field" }
      ],
      [{ id: "connection_1", from: "floe_actor", to: "nested_field", label: "relates" }]
    );
    const layout = {
      schema: "floe.field.layout.floeweb.v1",
      field_id: "rename-me",
      viewport: { x: 10, y: 20, zoom: 1.2 },
      items: { floe_actor: { x: 100, y: 150 }, nested_field: { x: 360, y: 150 } }
    };

    try {
      await page.addInitScript((url) => localStorage.setItem("floe.busUrl", url), busUrl);
      await page.goto("/");

      await page.getByLabel("Workspace folder").fill(workspacePath);
      await page.getByLabel("Name").fill("Field Rename Workspace");
      await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
      await expect(page.locator(".workspace-home")).toBeVisible();

      mkdirSync(fieldsDir, { recursive: true });
      writeFileSync(semanticPath, YAML.stringify(semantic), "utf8");
      writeFileSync(layoutPath, YAML.stringify(layout), "utf8");
      await expect(page.locator(".field-block", { hasText: "Rename Me" })).toBeVisible();
      await page.locator(".field-block", { hasText: "Rename Me" }).click();

      await page.getByRole("button", { name: /Rename field/i }).click();
      await page.getByLabel("Field title").fill("Renamed Field");
      await page.getByRole("button", { name: /^Save rename$/i }).click();

      await expect(page.getByRole("heading", { name: "Renamed Field" })).toBeVisible();
      await page.getByRole("button", { name: /Workspace Home/i }).click();
      await expect(page.locator(".field-block", { hasText: "Renamed Field" })).toBeVisible();

      await expect.poll(() => {
        const written = YAML.parse(readFileSync(semanticPath, "utf8")) as Record<string, unknown>;
        return written.title;
      }).toBe("Renamed Field");
      expect(existsSync(semanticPath)).toBe(true);
      expect(existsSync(join(fieldsDir, "renamed-field.yaml"))).toBe(false);
      const written = YAML.parse(readFileSync(semanticPath, "utf8")) as Record<string, any>;
      expect(written.id).toBe("rename-me");
      expect(written.items).toEqual(semantic.items);
      expect(written.connections).toEqual(semantic.connections);
      expect(YAML.parse(readFileSync(layoutPath, "utf8"))).toEqual(layout);
    } finally {
      if (!page.isClosed()) {
        await page.close();
      }
      handle.app.server.closeAllConnections();
      await handle.app.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("real bus stack adds Actor and nested Field Items with stable substrate refs", async ({ page }) => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-field-add-items-e2e-"));
    const configPath = join(tmp, "config.yaml");
    const workspacePath = join(tmp, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const config = defaultConfig(tmp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    const handle = await createBusServer(configPath, config);
    const busUrl = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const fieldsDir = join(workspacePath, ".floe", "fields");
    const parentPath = join(fieldsDir, "parent-field.yaml");
    const childPath = join(fieldsDir, "child-field.yaml");
    const layoutPath = join(fieldsDir, "parent-field.layout.floeweb.yaml");

    try {
      await page.addInitScript((url) => localStorage.setItem("floe.busUrl", url), busUrl);
      await page.goto("/");

      await page.getByLabel("Workspace folder").fill(workspacePath);
      await page.getByLabel("Name").fill("Field Add Items Workspace");
      await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
      await expect(page.locator(".workspace-home")).toBeVisible();

      const workspace = handle.store.listWorkspaces()[0] as { workspace_id: string };
      const actorRef = `actor:${workspace.workspace_id}:floe`;
      await handle.app.inject({
        method: "POST",
        url: "/v1/endpoints/register",
        payload: {
          endpoint_id: actorRef,
          workspace_id: workspace.workspace_id,
          name: "Floe",
          agent_id: "floe",
          status: "idle"
        }
      });

      mkdirSync(fieldsDir, { recursive: true });
      writeFileSync(parentPath, YAML.stringify(makeFieldSemantic("parent-field", "Parent Field")), "utf8");
      writeFileSync(childPath, YAML.stringify(makeFieldSemantic("child-field", "Child Field")), "utf8");
      const layout = {
        schema: "floe.field.layout.floeweb.v1",
        field_id: "parent-field",
        viewport: { x: 0, y: 0, zoom: 1 },
        items: {}
      };
      writeFileSync(layoutPath, YAML.stringify(layout), "utf8");

      await page.getByTitle("Refresh").first().click();
      await expect(page.locator(".field-block", { hasText: "Parent Field" })).toBeVisible();
      await page.locator(".field-block", { hasText: "Parent Field" }).click();

      await page.getByRole("button", { name: /Add actor item/i }).click();
      await expect(page.getByLabel("Actor item")).toBeVisible();
      await expect(page.getByText(actorRef)).toHaveCount(0);
      await page.getByLabel("Actor item").selectOption({ label: "Floe" });
      await page.getByRole("button", { name: /Save actor item/i }).click();
      await expect(page.locator(".react-flow__node").filter({ hasText: "floe" })).toHaveCount(1);
      await expect(page.locator(".canvas-field-node[data-kind='actor']")).not.toHaveAttribute("title", actorRef);
      await expect(page.getByText(actorRef)).toHaveCount(0);

      await page.getByRole("button", { name: /Add field item/i }).click();
      await expect(page.getByLabel("Field item")).toBeVisible();
      await expect(page.getByRole("option", { name: "Parent Field" })).toHaveCount(0);
      await page.getByLabel("Field item").selectOption({ label: "Child Field" });
      await page.getByRole("button", { name: /Save field item/i }).click();
      await expect(page.locator(".react-flow__node").filter({ hasText: "child-field" })).toHaveCount(1);

      await expect.poll(() => {
        const written = YAML.parse(readFileSync(parentPath, "utf8")) as Record<string, any>;
        return written.items?.length;
      }).toBe(2);
      const written = YAML.parse(readFileSync(parentPath, "utf8")) as Record<string, any>;
      expect(written.items).toEqual([
        expect.objectContaining({ ref: actorRef }),
        expect.objectContaining({ ref: "field:child-field" })
      ]);
      expect(new Set(written.items.map((item: any) => item.item_id)).size).toBe(2);
      expect(YAML.parse(readFileSync(layoutPath, "utf8"))).toEqual(layout);
      const endpointList = await handle.app.inject({
        method: "GET",
        url: `/v1/workspaces/${encodeURIComponent(workspace.workspace_id)}/endpoints`
      });
      expect(endpointList.json().endpoints.filter((endpoint: any) => endpoint.endpoint_id === actorRef)).toHaveLength(1);
      expect(existsSync(childPath)).toBe(true);
    } finally {
      if (!page.isClosed()) {
        await page.close();
      }
      handle.app.server.closeAllConnections();
      await handle.app.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("real bus stack live-renders external Field YAML edits and persists layout sidecar only", async ({ page }) => {
    const tmp = mkdtempSync(join(tmpdir(), "floe-field-live-e2e-"));
    const configPath = join(tmp, "config.yaml");
    const workspacePath = join(tmp, "workspace");
    mkdirSync(workspacePath, { recursive: true });
    const config = defaultConfig(tmp);
    writeFileSync(configPath, YAML.stringify(config), "utf8");
    const handle = await createBusServer(configPath, config);
    const busUrl = await handle.app.listen({ host: "127.0.0.1", port: 0 });
    const fieldsDir = join(workspacePath, ".floe", "fields");
    const semanticPath = join(fieldsDir, "watched-field.yaml");
    const layoutPath = join(fieldsDir, "watched-field.layout.floeweb.yaml");
    const createdAt = new Date().toISOString();
    const semantic = makeFieldSemantic("watched-field", "Watched Field");

    try {
      await page.addInitScript((url) => localStorage.setItem("floe.busUrl", url), busUrl);
      await page.goto("/");

      await page.getByLabel("Workspace folder").fill(workspacePath);
      await page.getByLabel("Name").fill("Field Live Workspace");
      await page.getByRole("button", { name: "Create Workspace", exact: true }).click();
      await expect(page.locator(".workspace-home")).toBeVisible();

      mkdirSync(fieldsDir, { recursive: true });
      writeFileSync(semanticPath, YAML.stringify({ ...semantic, created_at: createdAt, updated_at: createdAt }), "utf8");
      await expect(page.locator(".field-block", { hasText: "Watched Field" })).toBeVisible();
      await page.locator(".field-block", { hasText: "Watched Field" }).click();

      const updatedAt = new Date(Date.now() + 1000).toISOString();
      const withItem = {
        ...semantic,
        created_at: createdAt,
        updated_at: updatedAt,
        items: [{ item_id: "floe_actor", ref: "actor:floe" }]
      };
      writeFileSync(semanticPath, YAML.stringify(withItem), "utf8");
      const actorNode = page.locator(".react-flow__node").filter({ hasText: "floe" });
      await expect(actorNode).toHaveCount(1);

      const semanticBeforeLayout = readFileSync(semanticPath, "utf8");
      const semanticMtimeBeforeLayout = statSync(semanticPath).mtimeMs;

      await expect.poll(() => existsSync(layoutPath)).toBe(true);
      expect(readFileSync(semanticPath, "utf8")).toBe(semanticBeforeLayout);
      expect(statSync(semanticPath).mtimeMs).toBe(semanticMtimeBeforeLayout);
      const layout = YAML.parse(readFileSync(layoutPath, "utf8")) as Record<string, any>;
      expect(layout.schema).toBe("floe.field.layout.floeweb.v1");
      expect(layout.field_id).toBe("watched-field");
      expect(layout.items.floe_actor).toEqual(expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number)
      }));
    } finally {
      if (!page.isClosed()) {
        await page.close();
      }
      handle.app.server.closeAllConnections();
      await handle.app.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
