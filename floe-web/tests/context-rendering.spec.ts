/**
 * Slice 5 — FloeWeb context-scoped rendering.
 *
 * Mirrors the live E2E proofs in design §6.2 (E2E-1, E2E-2, E2E-5, E2E-8) at
 * the component level using mocked bus routes. Slice 6 owns the live runs.
 */
import { test as base, expect, Page, Route } from "@playwright/test";

const test = base;

const WORKSPACE_ID = "ws_ctx";
const FLOE = `actor:${WORKSPACE_ID}:floe`;
const REVIEWER = `actor:${WORKSPACE_ID}:reviewer`;
const OPERATOR = `actor:${WORKSPACE_ID}:operator`;

type ContextSummary = {
  context_id: string;
  workspace_id: string;
  parent_context_id: string | null;
  created_by_endpoint_id: string | null;
  created_at: string;
  last_event_at: string | null;
  participants: string[];
  first_message_preview: string | null;
};

type ContextEvent = {
  event_id: string;
  type: string;
  workspace_id: string;
  context_id: string;
  source_endpoint_id: string | null;
  destination_json: { kind: "endpoint"; endpoint_id: string };
  thread_id?: string | null;
  content: { text?: string; data?: Record<string, unknown> };
  metadata?: Record<string, unknown>;
  created_at: string;
};

type TelemetryRecord = {
  telemetry_id: string;
  workspace_id: string;
  endpoint_id: string;
  delivery_id: string | null;
  kind: string;
  payload_json: string;
  created_at: string;
};

type WorldState = {
  contexts: ContextSummary[];
  eventsByContext: Record<string, ContextEvent[]>;
  contextEventDelayMs: Record<string, number>;
  telemetry: TelemetryRecord[];
  emitCalls: unknown[];
  legacyEventsCalls: number;
  contextEventsCalls: Record<string, number>;
  contextsListCalls: number;
  deleteContextCalls: string[];
  deleteContextFailure: { status: number; body: Record<string, unknown> } | null;
  bridgeRuntimeAdapter: string | null;
  endpointRuntimeAdapter: string | null;
};

function makeWorld(initial?: Partial<WorldState>): WorldState {
  return {
    contexts: [],
    eventsByContext: {},
    contextEventDelayMs: {},
    telemetry: [],
    emitCalls: [],
    legacyEventsCalls: 0,
    contextEventsCalls: {},
    contextsListCalls: 0,
    deleteContextCalls: [],
    deleteContextFailure: null,
    bridgeRuntimeAdapter: "pi-agent-core",
    endpointRuntimeAdapter: null,
    ...initial
  };
}

function makeContext(o: Partial<ContextSummary> & { context_id: string }): ContextSummary {
  return {
    workspace_id: WORKSPACE_ID,
    parent_context_id: null,
    created_by_endpoint_id: OPERATOR,
    created_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    participants: [OPERATOR, FLOE],
    first_message_preview: null,
    ...o
  };
}

function makeMessage(o: Partial<ContextEvent> & { context_id: string; created_at: string }): ContextEvent {
  return {
    event_id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: "message",
    workspace_id: WORKSPACE_ID,
    source_endpoint_id: OPERATOR,
    destination_json: { kind: "endpoint", endpoint_id: FLOE },
    content: { text: "" },
    metadata: {},
    ...o
  };
}

async function setupRoutes(page: Page, world: WorldState): Promise<void> {
  await page.route("**/v1/workspaces", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workspaces: [{
          workspace_id: WORKSPACE_ID,
          name: "Ctx WS",
          path: "/tmp/ctx",
          status: "attached",
          init_authorized: true,
          created_at: new Date().toISOString()
        }]
      })
    })
  );

  await page.route(`**/v1/workspaces/${WORKSPACE_ID}/endpoints`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        endpoints: [
          {
            endpoint_id: FLOE,
            workspace_id: WORKSPACE_ID,
            name: "Floe",
            status: "active",
            agent_id: "floe",
            metadata_json: world.endpointRuntimeAdapter
              ? JSON.stringify({ runtime_adapter: world.endpointRuntimeAdapter })
              : "{}"
          },
          {
            endpoint_id: REVIEWER,
            workspace_id: WORKSPACE_ID,
            name: "Reviewer",
            status: "active",
            agent_id: "reviewer",
            metadata_json: "{}"
          },
          {
            endpoint_id: OPERATOR,
            workspace_id: WORKSPACE_ID,
            name: "Operator",
            status: "idle",
            agent_id: null,
            metadata_json: "{}"
          }
        ]
      })
    })
  );

  await page.route("**/v1/auth/profiles", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        profiles: [{ id: "prof_1", provider: "openai", model: "gpt-4", label: "GPT-4" }]
      })
    })
  );

  await page.route("**/v1/local-config/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        bridge: world.bridgeRuntimeAdapter === null ? {} : { runtime_adapter: world.bridgeRuntimeAdapter }
      })
    })
  );

  await page.route("**/v1/runtime/bindings**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        bindings: [{
          binding_key: "b1",
          scope: "agent",
          workspace_id: WORKSPACE_ID,
          endpoint_id: FLOE,
          auth_profile: "prof_1",
          model: "gpt-4"
        }]
      })
    })
  );

  await page.route("**/v1/runtime/telemetry**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: world.telemetry }) })
  );

  await page.route("**/v1/auth/models**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: [] }) })
  );

  // Context-scoped events: must be hit (not the legacy workspace-wide one).
  await page.route(/\/v1\/contexts\/[^/]+\/events(?:\?.*)?$/, async (route: Route) => {
    const url = new URL(route.request().url());
    const m = url.pathname.match(/\/v1\/contexts\/([^/]+)\/events/);
    const id = m?.[1] ?? "";
    world.contextEventsCalls[id] = (world.contextEventsCalls[id] ?? 0) + 1;
    const events = world.eventsByContext[id] ?? [];
    const delayMs = world.contextEventDelayMs[id] ?? 0;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events })
    });
  });

  await page.route(/\/v1\/contexts\/[^/]+$/, async (route: Route) => {
    if (route.request().method() !== "DELETE") {
      return route.fulfill({ status: 405, contentType: "application/json", body: JSON.stringify({ error: "method_not_allowed" }) });
    }
    const url = new URL(route.request().url());
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    world.deleteContextCalls.push(id);
    if (world.deleteContextFailure) {
      return route.fulfill({
        status: world.deleteContextFailure.status,
        contentType: "application/json",
        body: JSON.stringify(world.deleteContextFailure.body)
      });
    }
    world.contexts = world.contexts.filter((ctx) => ctx.context_id !== id);
    delete world.eventsByContext[id];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, context_id: id, workspace_id: WORKSPACE_ID })
    });
  });

  // Context list (must include `participant=` query)
  await page.route(/\/v1\/contexts(?:\?.*)?$/, (route: Route) => {
    const url = new URL(route.request().url());
    const participant = url.searchParams.get("participant") ?? "";
    world.contextsListCalls++;
    const filtered = world.contexts.filter((c) => c.participants.includes(participant));
    const sorted = [...filtered].sort((a, b) =>
      (b.last_event_at ?? b.created_at).localeCompare(a.last_event_at ?? a.created_at)
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ contexts: sorted })
    });
  });

  // Legacy workspace-wide events — count usage
  await page.route(/\/v1\/events(?:\?[^/]*)?$/, (route) => {
    world.legacyEventsCalls++;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ events: [] })
    });
  });

  // Emit endpoint
  await page.route("**/v1/events/emit", async (route) => {
    const req = route.request();
    const body = JSON.parse(req.postData() ?? "{}");
    world.emitCalls.push(body);
    let context_id: string = body.context_id ?? "";
    if (!context_id) {
      // Bus would synthesize a new context for an unscoped emit.
      context_id = `ctx_new_${world.contexts.length + 1}`;
      const now = new Date().toISOString();
      const ctx = makeContext({
        context_id,
        created_at: now,
        last_event_at: now,
        first_message_preview: typeof body.content?.text === "string" ? body.content.text.slice(0, 80) : null,
        participants: [body.source_endpoint_id, body.destination?.endpoint_id].filter(Boolean) as string[]
      });
      world.contexts.push(ctx);
    }
    const created_at = new Date().toISOString();
    const event: ContextEvent = {
      event_id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      type: body.type,
      workspace_id: body.workspace_id,
      context_id,
      source_endpoint_id: body.source_endpoint_id,
      destination_json: body.destination,
      content: body.content ?? {},
      metadata: body.metadata ?? {},
      created_at
    };
    world.eventsByContext[context_id] = [...(world.eventsByContext[context_id] ?? []), event];
    const ctx = world.contexts.find((c) => c.context_id === context_id);
    if (ctx) ctx.last_event_at = created_at;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, event_id: event.event_id, accepted_at: created_at, deliveries_created: 0, event })
    });
  });

  await page.route("**/v1/endpoints/register", (route) =>
    route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ endpoint: {} }) })
  );

  await page.route("**/v1/events/stream", (route) => route.abort());
  await page.route("**/v1/workspaces/*/select", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  );
}

async function bootApp(page: Page, world: WorldState): Promise<void> {
  await setupRoutes(page, world);
  await page.goto("/");
  await page.evaluate((url) => localStorage.setItem("floe.busUrl", url), "http://127.0.0.1:5377");
  await page.reload();
  await page.waitForSelector(".workspace-home, [data-testid='workspace-loaded']", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  await page.getByLabel("Open Contexts for Floe").click();
  await page.waitForTimeout(400);
}

test.describe("Slice 5 — context-scoped chat rendering", () => {
  test("empty state: no contexts → primed composer + no creation calls (E2E-5 mirror)", async ({ page }) => {
    const world = makeWorld();
    await bootApp(page, world);

    // Empty state for the agent
    await expect(page.locator(".channel")).toContainText(/No conversations with .* yet/i);

    // Selecting an agent did NOT create or fetch a context's events.
    expect(world.emitCalls.length).toBe(0);
    expect(Object.keys(world.contextEventsCalls).length).toBe(0);
    // Context list IS fetched (cheap), but no contexts are created.
    expect(world.contextsListCalls).toBeGreaterThan(0);
    expect(world.contexts.length).toBe(0);
  });

  test("actor selection is a labeled actor list and switches the conversation scope", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_floe",
      first_message_preview: "floe only conversation",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T00:00:00.000Z",
      last_event_at: "2024-06-01T00:00:00.000Z"
    }));
    await bootApp(page, world);

    const actorList = page.getByRole("group", { name: "Actors" });
    await expect(actorList).toBeVisible();
    await expect(actorList.getByRole("button", { name: /Floe.*active/i })).toHaveAttribute("aria-pressed", "true");
    await expect(actorList.getByRole("button", { name: /Reviewer.*active/i })).toBeVisible();

    await actorList.getByRole("button", { name: /Reviewer.*active/i }).click();
    await expect(actorList.getByRole("button", { name: /Reviewer.*active/i })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-testid="context-list"]')).toContainText("No conversations with Reviewer yet");
    await expect(page.locator('[data-testid="context-list"]')).not.toContainText("floe only conversation");
  });

  test("first draft send omits context_id, adopts the returned id, then reuses it", async ({ page }) => {
    const world = makeWorld();
    await bootApp(page, world);

    await page.locator(".channel-composer input").fill("hello floe");
    await page.locator('.channel-composer .icon-button[title="Send"]').click();
    await page.waitForTimeout(600);

    expect(world.emitCalls.length).toBe(1);
    const body = world.emitCalls[0] as Record<string, unknown>;
    expect(body).not.toHaveProperty("context_id");
    expect((body as any).destination?.endpoint_id).toBe(FLOE);
    expect(world.contexts.length).toBe(1);

    const newId = world.contexts[0].context_id;
    // Wait for refresh / chat fetch on adopted context
    await page.waitForTimeout(600);
    expect(world.contextEventsCalls[newId]).toBeGreaterThan(0);

    await page.locator(".channel-composer input").fill("second message");
    await page.locator('.channel-composer .icon-button[title="Send"]').click();
    await page.waitForTimeout(500);

    expect(world.emitCalls.length).toBe(2);
    expect((world.emitCalls[1] as any).context_id).toBe(newId);
    expect(world.contexts.length).toBe(1);
  });

  test("continuing an existing conversation sends explicit context_id (User Story 20)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_existing";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "earlier hello",
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:01.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({ context_id: ctxId, created_at: "2024-06-01T10:00:00.000Z", content: { text: "earlier hello" } })
    ];

    await bootApp(page, world);

    // Click the existing context in the list
    await page.locator('[data-testid="context-list-item"]').first().click();
    await page.waitForTimeout(300);

    await page.locator(".channel-composer input").fill("follow up");
    await page.locator('.channel-composer .icon-button[title="Send"]').click();
    await page.waitForTimeout(500);

    expect(world.emitCalls.length).toBe(1);
    expect((world.emitCalls[0] as any).context_id).toBe(ctxId);
    // Must NOT pass current_delivery_context_id from UI emits
    expect((world.emitCalls[0] as any).current_delivery_context_id).toBeUndefined();
  });

  test("selected profile cannot silently send through the fake bridge adapter", async ({ page }) => {
    const world = makeWorld({ bridgeRuntimeAdapter: null });

    await bootApp(page, world);

    await expect(page.getByText(/bridge is running with the fake runtime adapter/i)).toBeVisible();
    await expect(page.locator(".channel-composer input")).toBeDisabled();
    expect(world.emitCalls.length).toBe(0);
  });

  test("endpoint runtime adapter metadata allows auto-selected pi bridge even when config omits adapter", async ({ page }) => {
    const world = makeWorld({ bridgeRuntimeAdapter: null, endpointRuntimeAdapter: "pi-agent-core" });

    await bootApp(page, world);

    await expect(page.getByText(/bridge is running with the fake runtime adapter/i)).toHaveCount(0);
    await expect(page.locator(".channel-composer input")).toBeEnabled();
  });

  test("chat fetch hits /v1/contexts/:id/events not /v1/events?workspace_id (E2E-8 mirror)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_a";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "aaa",
      last_event_at: "2024-06-01T10:00:01.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({ context_id: ctxId, created_at: "2024-06-01T10:00:00.000Z", content: { text: "aaa" } })
    ];
    await bootApp(page, world);

    await page.locator('[data-testid="context-list-item"]').first().click();
    await page.waitForTimeout(400);

    expect(world.contextEventsCalls[ctxId]).toBeGreaterThan(0);
    // Chat must contain the seeded message
    await expect(page.locator(".channel-message")).toContainText("aaa");
  });

  test("two contexts with the same participants render distinct event lists (E2E-2 mirror)", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_a",
      first_message_preview: "alpha topic",
      participants: [OPERATOR, FLOE, REVIEWER],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:00.000Z"
    }));
    world.contexts.push(makeContext({
      context_id: "ctx_b",
      first_message_preview: "beta topic",
      participants: [OPERATOR, FLOE, REVIEWER],
      created_at: "2024-06-02T10:00:00.000Z",
      last_event_at: "2024-06-02T10:00:00.000Z"
    }));
    world.eventsByContext["ctx_a"] = [
      makeMessage({ context_id: "ctx_a", created_at: "2024-06-01T10:00:00.000Z", content: { text: "ALPHA-MSG" } })
    ];
    world.eventsByContext["ctx_b"] = [
      makeMessage({ context_id: "ctx_b", created_at: "2024-06-02T10:00:00.000Z", content: { text: "BETA-MSG" } })
    ];
    await bootApp(page, world);

    const items = page.locator('[data-testid="context-list-item"]');
    await expect(items).toHaveCount(2);
    // List sorted by last_event_at desc → beta first
    await expect(items.nth(0)).toContainText("beta topic");
    await expect(items.nth(1)).toContainText("alpha topic");

    await items.nth(0).click();
    await page.waitForTimeout(300);
    await expect(page.locator(".channel-body")).toContainText("BETA-MSG");
    await expect(page.locator(".channel-body")).not.toContainText("ALPHA-MSG");

    await items.nth(1).click();
    await page.waitForTimeout(300);
    await expect(page.locator(".channel-body")).toContainText("ALPHA-MSG");
    await expect(page.locator(".channel-body")).not.toContainText("BETA-MSG");
  });

  test("delayed stale context event responses do not appear in the active conversation", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_a",
      first_message_preview: "alpha topic",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:00.000Z"
    }));
    world.contexts.push(makeContext({
      context_id: "ctx_b",
      first_message_preview: "beta topic",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-02T10:00:00.000Z",
      last_event_at: "2024-06-02T10:00:00.000Z"
    }));
    world.eventsByContext["ctx_a"] = [
      makeMessage({ context_id: "ctx_a", created_at: "2024-06-01T10:00:00.000Z", content: { text: "ALPHA-ACTIVE" } })
    ];
    world.eventsByContext["ctx_b"] = [
      makeMessage({ context_id: "ctx_b", created_at: "2024-06-02T10:00:00.000Z", content: { text: "BETA-STALE" } })
    ];
    world.contextEventDelayMs["ctx_b"] = 800;

    await bootApp(page, world);

    await page.locator('[data-testid="context-list-item"][data-context-id="ctx_a"]').click();
    await expect(page.locator(".channel-body")).toContainText("ALPHA-ACTIVE");
    await page.waitForTimeout(1000);

    await expect(page.locator(".channel-body")).toContainText("ALPHA-ACTIVE");
    await expect(page.locator(".channel-body")).not.toContainText("BETA-STALE");
  });

  test("unscoped streaming telemetry is not rendered into the selected conversation", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_a",
      first_message_preview: "alpha topic",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:02.000Z"
    }));
    world.contexts.push(makeContext({
      context_id: "ctx_b",
      first_message_preview: "beta topic",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-02T10:00:00.000Z",
      last_event_at: "2024-06-02T10:00:02.000Z"
    }));
    world.eventsByContext["ctx_a"] = [
      makeMessage({ context_id: "ctx_a", source_endpoint_id: OPERATOR, created_at: "2024-06-01T10:00:00.000Z", content: { text: "ALPHA-USER" } }),
      makeMessage({
        context_id: "ctx_a",
        source_endpoint_id: FLOE,
        created_at: "2024-06-01T10:00:02.000Z",
        content: { text: "ALPHA-REPLY", data: { runtime_turn_id: "rt_a" } },
        metadata: { runtime_turn_id: "rt_a" }
      })
    ];
    world.eventsByContext["ctx_b"] = [
      makeMessage({ context_id: "ctx_b", source_endpoint_id: OPERATOR, created_at: "2024-06-02T10:00:00.000Z", content: { text: "BETA-USER" } })
    ];
    world.telemetry = [{
      telemetry_id: "tel_unscoped_beta",
      workspace_id: WORKSPACE_ID,
      endpoint_id: FLOE,
      delivery_id: "del_beta",
      kind: "visible_output",
      payload_json: JSON.stringify({ runtime_turn_id: "rt_b", delivery_id: "del_beta", text: "BETA-STREAM" }),
      created_at: "2024-06-02T10:00:01.000Z"
    }];

    await bootApp(page, world);
    await page.locator('[data-testid="context-list-item"][data-context-id="ctx_a"]').click();
    await page.waitForTimeout(400);

    await expect(page.locator(".channel-body")).toContainText("ALPHA-REPLY");
    await expect(page.locator(".channel-body")).not.toContainText("BETA-STREAM");
  });

  test("activity telemetry from another context is not attached to the selected conversation", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_a",
      first_message_preview: "alpha topic",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:03.000Z"
    }));
    world.contexts.push(makeContext({
      context_id: "ctx_b",
      first_message_preview: "beta topic",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-02T10:00:00.000Z",
      last_event_at: "2024-06-02T10:00:03.000Z"
    }));
    world.eventsByContext["ctx_a"] = [
      makeMessage({ context_id: "ctx_a", source_endpoint_id: OPERATOR, created_at: "2024-06-01T10:00:00.000Z", content: { text: "ALPHA-USER" } }),
      makeMessage({
        context_id: "ctx_a",
        source_endpoint_id: FLOE,
        created_at: "2024-06-01T10:00:03.000Z",
        content: { text: "ALPHA-REPLY", data: { runtime_turn_id: "rt_a" } },
        metadata: { runtime_turn_id: "rt_a" }
      })
    ];
    world.eventsByContext["ctx_b"] = [
      makeMessage({ context_id: "ctx_b", source_endpoint_id: OPERATOR, created_at: "2024-06-02T10:00:00.000Z", content: { text: "BETA-USER" } }),
      makeMessage({
        context_id: "ctx_b",
        source_endpoint_id: FLOE,
        created_at: "2024-06-02T10:00:03.000Z",
        content: { text: "BETA-REPLY", data: { runtime_turn_id: "rt_b" } },
        metadata: { runtime_turn_id: "rt_b" }
      })
    ];
    world.telemetry = [{
      telemetry_id: "tel_beta_emit",
      workspace_id: WORKSPACE_ID,
      endpoint_id: FLOE,
      delivery_id: "del_beta",
      kind: "AfterToolUse",
      payload_json: JSON.stringify({
        runtime_turn_id: "rt_b",
        delivery_id: "del_beta",
        context_id: "ctx_b",
        toolCallId: "tool_beta",
        toolName: "emit"
      }),
      created_at: "2024-06-01T10:00:01.000Z"
    }];

    await bootApp(page, world);
    await page.locator('[data-testid="context-list-item"][data-context-id="ctx_a"]').click();
    await page.waitForTimeout(400);

    const body = page.locator(".channel-body");
    await expect(body).toContainText("ALPHA-REPLY");
    await expect(body).not.toContainText("Activity");
    await expect(body).not.toContainText("sent message");
  });

  test("rendering does not client-side filter by source_endpoint_id (negative test)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_mixed";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "mixed sources",
      participants: [OPERATOR, FLOE, REVIEWER],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:03.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({
        context_id: ctxId,
        source_endpoint_id: OPERATOR,
        created_at: "2024-06-01T10:00:00.000Z",
        content: { text: "FROM-OPERATOR" }
      }),
      makeMessage({
        context_id: ctxId,
        source_endpoint_id: REVIEWER,
        created_at: "2024-06-01T10:00:01.000Z",
        content: { text: "FROM-REVIEWER" }
      }),
      makeMessage({
        context_id: ctxId,
        source_endpoint_id: FLOE,
        created_at: "2024-06-01T10:00:02.000Z",
        content: { text: "FROM-FLOE" }
      })
    ];
    await bootApp(page, world);

    await page.locator('[data-testid="context-list-item"]').first().click();
    await page.waitForTimeout(400);

    const body = page.locator(".channel-body");
    await expect(body).toContainText("FROM-OPERATOR");
    await expect(body).toContainText("FROM-REVIEWER");
    await expect(body).toContainText("FROM-FLOE");
  });

  test("label fallback: pulse-only context labels as 'Pulse: <name>'", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_pulse";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: null,
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:00.000Z"
    }));
    world.eventsByContext[ctxId] = [
      {
        event_id: "ev_p",
        type: "pulse.fired",
        workspace_id: WORKSPACE_ID,
        context_id: ctxId,
        source_endpoint_id: null,
        destination_json: { kind: "endpoint", endpoint_id: FLOE },
        content: { data: { pulse_id: "p1" } },
        metadata: { trigger_kind: "pulse", pulse_name: "morning_check" },
        created_at: "2024-06-01T10:00:00.000Z"
      }
    ];
    await bootApp(page, world);

    await expect(page.locator('[data-testid="context-list-item"]').first()).toContainText("Pulse: morning_check");
  });

  test("pulse.fired context events render as reminder cards, not actor messages", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_reminder";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: null,
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:30.000Z"
    }));
    world.eventsByContext[ctxId] = [{
      event_id: "evt_pulse_reminder",
      type: "pulse.fired",
      workspace_id: WORKSPACE_ID,
      context_id: ctxId,
      source_endpoint_id: null,
      destination_json: { kind: "context", context_id: ctxId },
      content: { text: "Check email.", data: { pulse_id: "pulse_reminder" } },
      metadata: { trigger_kind: "pulse", pulse_id: "pulse_reminder", pulse_name: "email reminder" },
      created_at: "2024-06-01T10:00:30.000Z"
    }];

    await bootApp(page, world);

    const card = page.getByTestId("pulse-event-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Scheduled reminder");
    await expect(card).toContainText("Check email.");
    await expect(card).not.toContainText(FLOE);
    await expect(card).not.toContainText(OPERATOR);
    await expect(card).not.toContainText(/actor_type|human|agent|bot|user/i);
    await expect(page.locator(".channel-message")).toHaveCount(0);
  });

  test("conversation list orders by recent meaningful activity, not stale default pinning", async ({ page }) => {
    const world = makeWorld();
    // Older operator↔agent context — should be pinned as default
    world.contexts.push(makeContext({
      context_id: "ctx_default",
      first_message_preview: "very first chat",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T00:00:00.000Z",
      last_event_at: "2024-06-01T00:00:00.000Z"
    }));
    // Newer operator↔agent context with more recent activity
    world.contexts.push(makeContext({
      context_id: "ctx_recent",
      first_message_preview: "fresh activity",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-05T00:00:00.000Z",
      last_event_at: "2024-06-05T10:00:00.000Z"
    }));
    await bootApp(page, world);

    const items = page.locator('[data-testid="context-list-item"]');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText("fresh activity");
    await expect(items.nth(1)).toContainText("very first chat");
  });

  test("conversation rows expose preview, timestamp, and active state", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_recent",
      first_message_preview: "implementation decisions",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-05T00:00:00.000Z",
      last_event_at: "2024-06-05T10:30:00.000Z"
    }));
    await bootApp(page, world);

    const row = page.locator('[data-testid="context-list-item"]').first();
    await expect(row).toContainText("implementation decisions");
    await expect(row.locator('[data-testid="context-list-item-time"]')).not.toHaveText("");
    await expect(row).toHaveAttribute("aria-current", "true");
  });

  test("delete conversation confirms, hard-deletes it from the bus, and removes active chat", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_delete",
      first_message_preview: "delete this conversation",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-06T00:00:00.000Z",
      last_event_at: "2024-06-06T10:00:00.000Z"
    }));
    world.contexts.push(makeContext({
      context_id: "ctx_keep",
      first_message_preview: "keep this conversation",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-05T00:00:00.000Z",
      last_event_at: "2024-06-05T10:00:00.000Z"
    }));
    world.eventsByContext["ctx_delete"] = [
      makeMessage({ context_id: "ctx_delete", created_at: "2024-06-06T10:00:00.000Z", content: { text: "DELETE-MSG" } })
    ];
    world.eventsByContext["ctx_keep"] = [
      makeMessage({ context_id: "ctx_keep", created_at: "2024-06-05T10:00:00.000Z", content: { text: "KEEP-MSG" } })
    ];
    const nativeDialogs: string[] = [];
    page.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await bootApp(page, world);

    await expect(page.locator(".channel-body")).toContainText("DELETE-MSG");

    await page.getByLabel("Delete conversation delete this conversation").click();
    const dialog = page.getByRole("dialog", { name: "Delete conversation" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toContainText("delete this conversation");
    await expect(dialog).toContainText("permanently deletes");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(page.locator('[data-testid="context-list-item"][data-context-id="ctx_delete"]')).toHaveCount(0);
    expect(world.deleteContextCalls).toEqual(["ctx_delete"]);
    await expect(page.locator('[data-testid="context-list-item"][data-context-id="ctx_keep"]')).toBeVisible();
    await expect(page.locator(".channel-body")).not.toContainText("DELETE-MSG");
    expect(nativeDialogs).toEqual([]);
  });

  test("dismissed conversation delete confirmation does not call the bus", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_cancel",
      first_message_preview: "keep after cancel",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-06T00:00:00.000Z",
      last_event_at: "2024-06-06T10:00:00.000Z"
    }));
    await bootApp(page, world);

    await page.getByLabel("Delete conversation keep after cancel").click();
    const dialog = page.getByRole("dialog", { name: "Delete conversation" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator('[data-testid="context-list-item"][data-context-id="ctx_cancel"]')).toBeVisible();
    expect(world.deleteContextCalls).toEqual([]);
  });

  test("conversation delete dialog traps keyboard focus", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_focus",
      first_message_preview: "focus stays inside",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-06T00:00:00.000Z",
      last_event_at: "2024-06-06T10:00:00.000Z"
    }));
    await bootApp(page, world);

    await page.getByLabel("Delete conversation focus stays inside").click();
    const dialog = page.getByRole("dialog", { name: "Delete conversation" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();

    expect(world.deleteContextCalls).toEqual([]);
  });

  test("failed conversation delete stays open and shows an inline dialog error", async ({ page }) => {
    const world = makeWorld({
      deleteContextFailure: { status: 500, body: { error: "delete_failed" } }
    });
    world.contexts.push(makeContext({
      context_id: "ctx_fail",
      first_message_preview: "delete fails",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-06T00:00:00.000Z",
      last_event_at: "2024-06-06T10:00:00.000Z"
    }));
    await bootApp(page, world);

    await page.getByLabel("Delete conversation delete fails").click();
    const dialog = page.getByRole("dialog", { name: "Delete conversation" });
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(dialog.getByRole("alert")).toContainText("500");
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="context-list-item"][data-context-id="ctx_fail"]')).toBeVisible();
    expect(world.deleteContextCalls).toEqual(["ctx_fail"]);
  });

  test("conversation delete dialog supports Escape and backdrop cancel with focus return", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_escape",
      first_message_preview: "escape keeps this",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-06T00:00:00.000Z",
      last_event_at: "2024-06-06T10:00:00.000Z"
    }));
    await bootApp(page, world);

    const trigger = page.getByLabel("Delete conversation escape keeps this");
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Delete conversation" });
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.locator('[data-testid="context-list-item"][data-context-id="ctx_escape"]')).toBeVisible();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId("dialog-backdrop").click({ position: { x: 12, y: 12 } });
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(world.deleteContextCalls).toEqual([]);
  });

  test("actor conversation panel does not create horizontal overflow on mobile or tablet", async ({ page }) => {
    const world = makeWorld();
    await page.setViewportSize({ width: 390, height: 844 });
    await bootApp(page, world);
    const mobileMetrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.clientWidth);

    await page.setViewportSize({ width: 768, height: 900 });
    await page.waitForTimeout(200);
    const tabletMetrics = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(tabletMetrics.scrollWidth).toBeLessThanOrEqual(tabletMetrics.clientWidth);
  });

  test("key actor conversation controls have accessible labels", async ({ page }) => {
    const world = makeWorld();
    await bootApp(page, world);

    await expect(page.getByLabel("Message Floe")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close actor conversation panel" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start new conversation with Floe" })).toBeVisible();
  });

  test("active conversation header identifies the selected existing context and draft state", async ({ page }) => {
    const world = makeWorld();
    world.contexts.push(makeContext({
      context_id: "ctx_old",
      first_message_preview: "old planning thread",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-01T00:00:00.000Z",
      last_event_at: "2024-06-01T00:00:00.000Z"
    }));
    world.contexts.push(makeContext({
      context_id: "ctx_recent",
      first_message_preview: "fresh implementation thread",
      participants: [OPERATOR, FLOE],
      created_at: "2024-06-05T00:00:00.000Z",
      last_event_at: "2024-06-05T10:00:00.000Z"
    }));
    world.eventsByContext["ctx_recent"] = [
      makeMessage({ context_id: "ctx_recent", created_at: "2024-06-05T10:00:00.000Z", content: { text: "fresh implementation thread" } })
    ];
    await bootApp(page, world);

    const header = page.locator('[data-testid="active-conversation-header"]');
    await expect(header).toBeVisible();
    await expect(header).toContainText("Floe");
    await expect(header).toContainText("fresh implementation thread");
    await expect(header).toContainText("Existing conversation");

    await page.locator('[data-testid="new-conversation-button"]').click();
    await expect(header).toContainText("New conversation with Floe");
    await expect(header).toContainText("Draft");
  });

  test("'New conversation' enters draft state and makes no API call until first send (User Story 19)", async ({ page }) => {
    const world = makeWorld();
    const ctxId = "ctx_old";
    world.contexts.push(makeContext({
      context_id: ctxId,
      first_message_preview: "old chat",
      created_at: "2024-06-01T10:00:00.000Z",
      last_event_at: "2024-06-01T10:00:00.000Z"
    }));
    world.eventsByContext[ctxId] = [
      makeMessage({ context_id: ctxId, created_at: "2024-06-01T10:00:00.000Z", content: { text: "old chat" } })
    ];
    await bootApp(page, world);

    const callsBefore = world.emitCalls.length;
    const ctxsBefore = world.contexts.length;

    await page.locator('[data-testid="new-conversation-button"]').click();
    await page.waitForTimeout(300);

    // Composer is enabled but no API call was made
    expect(world.emitCalls.length).toBe(callsBefore);
    expect(world.contexts.length).toBe(ctxsBefore);

    await page.locator(".channel-composer input").fill("draft send");
    await page.locator('.channel-composer .icon-button[title="Send"]').click();
    await page.waitForTimeout(500);

    expect(world.emitCalls.length).toBe(1);
    expect(world.emitCalls[0] as Record<string, unknown>).not.toHaveProperty("context_id");
    expect(world.contexts.length).toBe(ctxsBefore + 1);
  });
});
